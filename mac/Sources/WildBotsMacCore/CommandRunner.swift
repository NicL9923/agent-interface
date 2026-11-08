import Darwin
import Foundation

/// The last `capacity` bytes written to a stream, and whether anything earlier was dropped.
struct TailBuffer {
  let capacity: Int
  private(set) var data = Data()
  private(set) var truncated = false
  init(capacity: Int) { self.capacity = capacity }
  mutating func append(_ chunk: Data) {
    data.append(chunk)
    if data.count > capacity {
      data.removeFirst(data.count - capacity)
      truncated = true
    }
  }
}

public struct CommandOutput: Equatable, Sendable {
  public var exitCode: Int
  public var timedOut: Bool
  public var cancelled: Bool
  public var stdout: String
  public var stderr: String
  public var stdoutTruncated: Bool
  public var stderrTruncated: Bool
  public var durationMs: Int
}

/// Stops a running command from another task, for Pause and Unlink.
public final class CancellationFlag: @unchecked Sendable {
  private let lock = NSLock()
  private var cancelled = false
  private var handlers: [() -> Void] = []
  public init() {}
  public var isCancelled: Bool { lock.withLock { cancelled } }
  public func cancel() {
    let run: [() -> Void] = lock.withLock {
      guard !cancelled else { return [] }
      cancelled = true
      defer { handlers = [] }
      return handlers
    }
    run.forEach { $0() }
  }
  /// Runs `handler` on cancel, or at once when already cancelled.
  func onCancel(_ handler: @escaping () -> Void) {
    let now: Bool = lock.withLock {
      if cancelled { return true }
      handlers.append(handler)
      return false
    }
    if now { handler() }
  }
}

/// Runs one shell command under `sandbox-exec`, fail-closed: a missing `sandbox-exec` or a
/// profile it rejects means the command does not run.
public struct CommandRunner: Sendable {
  public var sandboxExec: String
  public var shell = "/bin/zsh"
  /// How long a process group gets after SIGTERM before SIGKILL.
  public var killGrace: TimeInterval = 2
  public init(sandboxExec: String = "/usr/bin/sandbox-exec") { self.sandboxExec = sandboxExec }

  /// Confirms `sandbox-exec` exists and compiles `policy` by running `/usr/bin/true` under it.
  public func checkSandbox(policy: String) throws {
    guard FileManager.default.isExecutableFile(atPath: sandboxExec) else {
      throw ActionError(.sandboxUnavailable, "\(sandboxExec) is missing, so commands cannot be confined and do not run.")
    }
    let probe = try spawnAndWait(
      arguments: [sandboxExec, "-p", policy, "/usr/bin/true"], environment: [:], cwd: "/", timeout: 20,
      cancel: CancellationFlag())
    guard probe.exitCode == 0, !probe.timedOut else {
      let reason = probe.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
      throw ActionError(.sandboxUnavailable, "The command sandbox could not start\(reason.isEmpty ? "" : ": \(reason)"). The command did not run.")
    }
  }

  public func run(
    command: String, cwd: String, policy: String, environment: [String: String], timeout: TimeInterval,
    cancel: CancellationFlag
  ) throws -> CommandOutput {
    try checkSandbox(policy: policy)
    return try spawnAndWait(
      arguments: [sandboxExec, "-p", policy, shell, "-f", "-c", command], environment: environment, cwd: cwd,
      timeout: timeout, cancel: cancel)
  }

  /// Spawns `arguments` in a new process group with only stdin, stdout and stderr inherited,
  /// keeps each stream's last 64 KiB, and ends the whole group on timeout, cancel or exit.
  func spawnAndWait(
    arguments: [String], environment: [String: String], cwd: String, timeout: TimeInterval, cancel: CancellationFlag
  ) throws -> CommandOutput {
    let started = Date()
    var outPipe: [Int32] = [0, 0]
    var errPipe: [Int32] = [0, 0]
    guard pipe(&outPipe) == 0 else { throw ActionError(.failed, "Could not create an output pipe.") }
    guard pipe(&errPipe) == 0 else {
      close(outPipe[0]); close(outPipe[1])
      throw ActionError(.failed, "Could not create an output pipe.")
    }

    var actions: posix_spawn_file_actions_t?
    posix_spawn_file_actions_init(&actions)
    defer { posix_spawn_file_actions_destroy(&actions) }
    posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0)
    posix_spawn_file_actions_adddup2(&actions, outPipe[1], 1)
    posix_spawn_file_actions_adddup2(&actions, errPipe[1], 2)
    posix_spawn_file_actions_addchdir_np(&actions, cwd)

    var attributes: posix_spawnattr_t?
    posix_spawnattr_init(&attributes)
    defer { posix_spawnattr_destroy(&attributes) }
    // A new process group so a timeout can end every process the command started, and
    // CLOEXEC_DEFAULT so no descriptor of this app (folders, journal, the link) leaks in.
    posix_spawnattr_setflags(
      &attributes, Int16(POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK))
    posix_spawnattr_setpgroup(&attributes, 0)
    var noSignals = sigset_t()
    sigemptyset(&noSignals)
    posix_spawnattr_setsigmask(&attributes, &noSignals)
    var defaults = sigset_t()
    sigfillset(&defaults)
    posix_spawnattr_setsigdefault(&attributes, &defaults)

    let argv = arguments.map { strdup($0) } + [nil]
    let envp = environment.sorted { $0.key < $1.key }.map { strdup("\($0.key)=\($0.value)") } + [nil]
    defer {
      argv.forEach { free($0) }
      envp.forEach { free($0) }
    }
    var pid: pid_t = 0
    let spawned = posix_spawn(&pid, arguments[0], &actions, &attributes, argv, envp)
    close(outPipe[1])
    close(errPipe[1])
    guard spawned == 0 else {
      close(outPipe[0]); close(errPipe[0])
      throw ActionError(.failed, "The command could not start: \(String(cString: strerror(spawned))).")
    }

    let capture = StreamCapture()
    let group = DispatchGroup()
    for (fd, isError) in [(outPipe[0], false), (errPipe[0], true)] {
      group.enter()
      // Each reader closes its own end. One that a process in its own session keeps open stays
      // behind until that process exits; the result does not wait for it.
      Thread.detachNewThread {
        defer {
          close(fd)
          group.leave()
        }
        var buffer = [UInt8](repeating: 0, count: 16384)
        while true {
          let count = read(fd, &buffer, buffer.count)
          if count < 0, errno == EINTR { continue }
          if count <= 0 { break }
          capture.append(Data(buffer[0..<count]), error: isError)
        }
      }
    }

    let state = KillState()
    let grace = killGrace
    let child = pid
    let signalGroup: @Sendable (Int32) -> Void = { signal in if !state.reaped { kill(-child, signal) } }
    let terminate: @Sendable () -> Void = {
      signalGroup(SIGTERM)
      DispatchQueue.global().asyncAfter(deadline: .now() + grace) { signalGroup(SIGKILL) }
    }
    let timer = DispatchSource.makeTimerSource(queue: .global())
    timer.schedule(deadline: .now() + timeout)
    timer.setEventHandler {
      state.timedOut = true
      terminate()
    }
    timer.resume()
    cancel.onCancel {
      state.cancelled = true
      terminate()
    }

    var status: Int32 = 0
    while waitpid(pid, &status, 0) < 0 && errno == EINTR {}
    timer.cancel()
    // Whatever the shell left running in its group ends with it. The group ID cannot be reused
    // while any member lives, so this signal cannot reach an unrelated process.
    kill(-pid, SIGKILL)
    state.reaped = true
    _ = group.wait(timeout: .now() + 2)

    let exitCode: Int
    let signal = status & 0x7f
    if signal == 0 {
      exitCode = Int((status >> 8) & 0xff)
    } else {
      exitCode = 128 + Int(signal)
    }
    let (out, err) = capture.snapshot()
    return CommandOutput(
      exitCode: exitCode, timedOut: state.timedOut, cancelled: state.cancelled,
      stdout: String(decoding: out.data, as: UTF8.self), stderr: String(decoding: err.data, as: UTF8.self),
      stdoutTruncated: out.truncated, stderrTruncated: err.truncated,
      durationMs: Int(Date().timeIntervalSince(started) * 1000))
  }
}

private final class StreamCapture: @unchecked Sendable {
  private let lock = NSLock()
  private var stdout = TailBuffer(capacity: ActionLimits.streamTail)
  private var stderr = TailBuffer(capacity: ActionLimits.streamTail)
  func append(_ chunk: Data, error: Bool) {
    lock.withLock {
      if error { stderr.append(chunk) } else { stdout.append(chunk) }
    }
  }
  func snapshot() -> (TailBuffer, TailBuffer) { lock.withLock { (stdout, stderr) } }
}

private final class KillState: @unchecked Sendable {
  private let lock = NSLock()
  private var _timedOut = false
  private var _cancelled = false
  private var _reaped = false
  var reaped: Bool {
    get { lock.withLock { _reaped } }
    set { lock.withLock { _reaped = newValue } }
  }
  var timedOut: Bool {
    get { lock.withLock { _timedOut } }
    set { lock.withLock { _timedOut = newValue } }
  }
  var cancelled: Bool {
    get { lock.withLock { _cancelled } }
    set { lock.withLock { _cancelled = newValue } }
  }
}
