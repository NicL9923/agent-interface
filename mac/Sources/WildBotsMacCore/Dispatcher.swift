import Darwin
import Foundation

/// Where this Mac keeps things, resolved to canonical paths.
public struct HostEnvironment: Sendable, Equatable {
  public var home: String
  /// Application Support/dev.agentinterface.mac: policy, journal, activity. Commands cannot touch it.
  public var appDataDir: String
  /// Parent of every command's private temporary folder.
  public var tempRoot: String
  public var developerDir: String?
  public var userName: String

  public init(home: String, appDataDir: String, tempRoot: String, developerDir: String?, userName: String = NSUserName()) {
    self.home = home
    self.appDataDir = appDataDir
    self.tempRoot = tempRoot
    self.developerDir = developerDir
    self.userName = userName
  }

  /// The real locations for the signed-in user. Creates the app's folders with owner-only access.
  public static func current() throws -> HostEnvironment {
    let home = canonical(NSHomeDirectory())
    let support = home + "/Library/Application Support/" + ProtectedPaths.appSupportName
    try FileManager.default.createDirectory(atPath: support, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let temp = canonical(NSTemporaryDirectory()) + "/" + ProtectedPaths.appSupportName + ".commands"
    try FileManager.default.createDirectory(atPath: temp, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    chmod(temp, 0o700)
    return HostEnvironment(home: home, appDataDir: canonical(support), tempRoot: canonical(temp), developerDir: detectDeveloperDir())
  }

  /// The active Xcode or Command Line Tools folder. Its `usr/bin` goes first on PATH, so `git` and
  /// `python3` run directly instead of through the `xcrun` shims, whose cache the sandbox denies.
  public static func detectDeveloperDir() -> String? {
    var candidates: [String] = []
    if let selected = try? FileManager.default.destinationOfSymbolicLink(atPath: "/private/var/db/xcode_select_link") {
      candidates.append(selected)
    }
    candidates += ["/Applications/Xcode.app/Contents/Developer", "/Library/Developer/CommandLineTools"]
    return candidates.first { FileManager.default.isExecutableFile(atPath: $0 + "/usr/bin/git") }.map(canonical)
  }

  public static func canonical(_ path: String) -> String {
    guard let pointer = realpath(path, nil) else { return path.count > 1 && path.hasSuffix("/") ? String(path.dropLast()) : path }
    defer { free(pointer) }
    return String(cString: pointer)
  }

  /// A clean environment: nothing of the app's own environment reaches a command.
  public func commandEnvironment(tempDir: String) -> [String: String] {
    var path: [String] = []
    if let developerDir { path.append(developerDir + "/usr/bin") }
    path += [
      home + "/.local/bin", home + "/.cargo/bin", "/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/bin",
      "/bin", "/usr/sbin", "/sbin",
    ]
    return [
      "HOME": home, "USER": userName, "LOGNAME": userName, "SHELL": "/bin/zsh", "PATH": path.joined(separator: ":"),
      "TMPDIR": tempDir + "/", "LANG": "en_US.UTF-8", "TERM": "dumb", "PAGER": "cat", "GIT_PAGER": "cat",
      "GIT_TERMINAL_PROMPT": "0", "XDG_CACHE_HOME": tempDir + "/cache", "npm_config_cache": tempDir + "/npm-cache",
    ]
  }
}

/// What the dispatcher reads for each invocation. The app replaces it whenever the person
/// changes something, so a request always sees the policy as it is at that moment.
public struct LiveSnapshot: Sendable {
  public var policy: PolicyDocument
  /// Open handles for `policy.folders`, in the same order.
  public var folders: [FolderHandle]
  public var screenLocked: Bool
  public var screenPermission: ScreenPermission
  public init(policy: PolicyDocument, folders: [FolderHandle], screenLocked: Bool = false, screenPermission: ScreenPermission = .unknown) {
    self.policy = policy
    self.folders = folders
    self.screenLocked = screenLocked
    self.screenPermission = screenPermission
  }

  public var macState: MacState {
    MacState(
      paused: policy.paused, screenLocked: screenLocked, screenPermission: screenPermission,
      folders: policy.folders.map { .init(name: $0.name, path: $0.path) },
      grants: policy.grants.map { grant in
        .init(
          assistantId: grant.assistantId, abilities: Ability.allCases.filter { grant.abilities.contains($0) },
          unattended: grant.unattended)
      })
  }
}

public struct Screenshot: Sendable {
  public var png: Data
  public var width: Int
  public var height: Int
  public init(png: Data, width: Int, height: Int) {
    self.png = png
    self.width = width
    self.height = height
  }
}

public protocol ScreenshotProvider: Sendable {
  func capture(maxWidth: Int) async throws -> Screenshot
}

/// Decides whether an invocation may run, before any argument touches the disk.
public enum Authorizer {
  public static func evaluate(_ invocation: Invocation, snapshot: LiveSnapshot) -> Result<ActionRequest, ActionError> {
    guard let ability = ActionRequest.ability(for: invocation.action) else {
      return .failure(ActionError(.invalidArguments, "Unknown action \(invocation.action)."))
    }
    if snapshot.policy.paused {
      return .failure(ActionError(.paused, "Assistants are paused on this Mac."))
    }
    guard let grant = snapshot.policy.grant(for: invocation.assistantId), grant.abilities.contains(ability) else {
      return .failure(ActionError(.notAllowed, "This Mac has not allowed \(invocation.assistantName ?? invocation.assistantId) to \(describe(ability))."))
    }
    if invocation.scheduled && !grant.unattended {
      return .failure(
        ActionError(.unattendedNotAllowed, "This Mac allows \(grant.assistantName) only while someone is in a WildBots chat with it."))
    }
    let request: ActionRequest
    switch ActionRequest.parse(action: invocation.action, args: invocation.args) {
    case .success(let parsed): request = parsed
    case .failure(let error): return .failure(error)
    }
    if case .screenshot = request {
      if snapshot.screenLocked { return .failure(ActionError(.screenLocked, "The Mac's screen is locked.")) }
      if snapshot.screenPermission != .granted {
        return .failure(
          ActionError(.permissionNeeded, "WildBots needs Screen Recording permission in System Settings > Privacy & Security."))
      }
    }
    return .success(request)
  }

  static func describe(_ ability: Ability) -> String {
    switch ability {
    case .filesRead: return "read files"
    case .filesWrite: return "write files"
    case .run: return "run commands"
    case .screenshot: return "take screenshots"
    }
  }
}

public enum DispatchEvent: Sendable {
  case activeCount(Int)
  case recorded(ActivityEntry)
}

/// Answers invocations: journal first, then policy, then the action, at most four at once.
public final class Dispatcher: @unchecked Sendable {
  public static let maxConcurrent = 4

  private let journal: InvocationJournal
  private let activity: ActivityLog
  private let environment: HostEnvironment
  private let runner: CommandRunner
  private let screenshots: ScreenshotProvider?
  private let snapshot: @Sendable () -> LiveSnapshot
  private let onEvent: @Sendable (DispatchEvent) -> Void
  private let maxConcurrent: Int
  private let lock = NSLock()
  private var running: [String: CancellationFlag] = [:]
  /// Bumped by every `cancelAll`. An invocation admitted under a different value than it read
  /// its snapshot under was authorized before a Pause or Unlink, so it does not start.
  private var cancelEpoch = 0
  private var admitting = true

  public init(
    journal: InvocationJournal, activity: ActivityLog, environment: HostEnvironment, runner: CommandRunner = CommandRunner(),
    screenshots: ScreenshotProvider?, maxConcurrent: Int = Dispatcher.maxConcurrent,
    snapshot: @escaping @Sendable () -> LiveSnapshot, onEvent: @escaping @Sendable (DispatchEvent) -> Void = { _ in }
  ) {
    self.journal = journal
    self.activity = activity
    self.environment = environment
    self.runner = runner
    self.screenshots = screenshots
    self.maxConcurrent = maxConcurrent
    self.snapshot = snapshot
    self.onEvent = onEvent
  }

  public var activeCount: Int { lock.withLock { running.count } }

  /// Stops every running action, for Pause and when the link is revoked.
  public func cancelAll() {
    let flags = lock.withLock { () -> [CancellationFlag] in
      cancelEpoch += 1
      return Array(running.values)
    }
    flags.forEach { $0.cancel() }
  }

  /// Unlinking or revocation: stops everything and admits nothing until `open()`. An invocation
  /// already past authorization when this lands is refused at admission, whatever its snapshot said.
  public func close() {
    lock.withLock { admitting = false }
    cancelAll()
  }

  /// Linked again: actions may start.
  public func open() { lock.withLock { admitting = true } }

  static let stoppedBeforeStart = ActionError(
    .paused, "The action did not start because assistants were paused or this Mac was unlinked.")

  /// The result to send for an `invoke` or a malformed one; nil for any other message.
  public func handle(_ message: InboundMessage) async -> (id: String, outcome: ActionOutcome)? {
    switch message {
    case .invoke(let invocation):
      return (invocation.id, await handle(invocation))
    case .malformedInvoke(let malformed):
      if let early = begin(id: malformed.id, fingerprint: malformed.fingerprint) { return (malformed.id, early) }
      let entry = ActivityEntry(
        id: malformed.id, at: Date(), assistantId: malformed.assistantId ?? "unknown", assistantName: nil, scheduled: false,
        action: "invalid", detail: "", outcome: malformed.error.code.rawValue, note: malformed.error.message)
      return (malformed.id, record(id: malformed.id, outcome: .failure(malformed.error), entry: entry))
    default:
      return nil
    }
  }

  /// Journals the ID before anything else happens. Returns the answer when the ID is not new.
  private func begin(id: String, fingerprint: String) -> ActionOutcome? {
    let lookup: InvocationJournal.Lookup
    do {
      lookup = try journal.begin(id: id, fingerprint: fingerprint)
    } catch {
      // Without a durable record the action could run twice, so it does not run at all.
      return .failure(ActionError(.failed, "This Mac could not record the action, so it did not run."))
    }
    switch lookup {
    case .mismatch:
      return .failure(ActionError(.invalidArguments, "Invocation \(id) was already used with different arguments."))
    case .inProgress:
      return .failure(ActionError(.inProgress, "This action is still running."))
    case .finished(let outcome):
      return outcome
    case .started:
      return nil
    }
  }

  public func handle(_ invocation: Invocation) async -> ActionOutcome {
    if let early = begin(id: invocation.id, fingerprint: invocation.fingerprint) { return early }
    let started = Date()
    // Read before the snapshot: a Pause that lands after this changes it, whatever the snapshot says.
    let epoch = lock.withLock { cancelEpoch }
    let current = snapshot()
    let request: ActionRequest
    switch Authorizer.evaluate(invocation, snapshot: current) {
    case .failure(let error):
      return finish(invocation, request: nil, outcome: .failure(error), started: started)
    case .success(let parsed):
      request = parsed
    }

    let flag = CancellationFlag()
    let refusal: ActionError? = lock.withLock {
      guard admitting, cancelEpoch == epoch else { return Self.stoppedBeforeStart }
      guard running.count < maxConcurrent else {
        return ActionError(.busy, "This Mac is already running \(maxConcurrent) actions. Try again shortly.")
      }
      running[invocation.id] = flag
      return nil
    }
    if let refusal {
      return finish(invocation, request: request, outcome: .failure(refusal), started: started)
    }
    onEvent(.activeCount(activeCount))
    var outcome = await perform(request, snapshot: current, cancel: flag)
    lock.withLock { running[invocation.id] = nil }
    // What a read gathered never leaves after Pause or Unlink. A write or command that already
    // finished reports what it did, because it did it.
    if case .success = outcome, flag.isCancelled, request.revealsOnly {
      outcome = .failure(SafeFiles.stopped)
    }
    onEvent(.activeCount(activeCount))
    if case .success = outcome, LinkCodec.result(id: invocation.id, outcome: outcome).utf8.count > maxFrameBytes - 4096 {
      outcome = .failure(ActionError(.tooLarge, "The result is larger than the link can carry."))
    }
    return finish(invocation, request: request, outcome: outcome, started: started)
  }

  private func finish(_ invocation: Invocation, request: ActionRequest?, outcome: ActionOutcome, started: Date) -> ActionOutcome {
    var note: String?
    switch outcome {
    case .failure(let error): note = error.message
    case .success(let value):
      if let code = value["exitCode"]?.intValue {
        note = value["timedOut"]?.boolValue == true ? "timed out" : "exit code \(code)"
      }
    }
    let entry = ActivityEntry(
      id: invocation.id, at: started, assistantId: invocation.assistantId, assistantName: invocation.assistantName,
      scheduled: invocation.scheduled, action: invocation.action, detail: request?.summary ?? "",
      outcome: outcome.errorCode?.rawValue ?? "ok", note: note, durationMs: Int(Date().timeIntervalSince(started) * 1000))
    return record(id: invocation.id, outcome: outcome, entry: entry)
  }

  private func record(id: String, outcome: ActionOutcome, entry: ActivityEntry) -> ActionOutcome {
    try? journal.finish(id: id, outcome: outcome)
    activity.append(entry)
    onEvent(.recorded(entry))
    return outcome
  }

  // MARK: Actions

  private func perform(_ request: ActionRequest, snapshot: LiveSnapshot, cancel: CancellationFlag) async -> ActionOutcome {
    do {
      switch request {
      case .screenshot:
        guard let screenshots else { throw ActionError(.permissionNeeded, "Screenshots are not available.") }
        // Capture cannot be interrupted; the fence after `perform` keeps a paused one from leaving.
        let shot = try await screenshots.capture(maxWidth: 1920)
        return .success([
          "pngBase64": .string(shot.png.base64EncodedString()), "width": .int(shot.width), "height": .int(shot.height),
        ])
      case .run(let command, let cwd, let timeout):
        return try await background { try self.run(command: command, cwd: cwd, timeout: timeout, snapshot: snapshot, cancel: cancel) }
      case .readFile(let path, let offset, let length):
        return try await background {
          let (folder, resolved) = try PathResolver.resolve(path, folders: snapshot.folders, home: self.environment.home)
          return .success(try SafeFiles.readFile(folder: folder, path: resolved, offset: offset, length: length, cancel: cancel))
        }
      case .writeFile(let path, let content, let expected, let createOnly):
        return try await background {
          let (folder, resolved) = try PathResolver.resolve(path, folders: snapshot.folders, home: self.environment.home)
          return .success(
            try SafeFiles.writeFile(
              folder: folder, path: resolved, content: content, expectedSha256: expected, createOnly: createOnly, cancel: cancel))
        }
      case .listDir(let path, let offset, let limit):
        return try await background {
          let (folder, resolved) = try PathResolver.resolve(
            path ?? snapshot.folders.first?.path ?? "", folders: snapshot.folders, home: self.environment.home)
          return .success(try SafeFiles.listDir(folder: folder, path: resolved, offset: offset, limit: limit, cancel: cancel))
        }
      }
    } catch let error as ActionError {
      return .failure(error)
    } catch {
      return .failure(ActionError(.failed, error.localizedDescription))
    }
  }

  private func background(_ work: @escaping @Sendable () throws -> ActionOutcome) async throws -> ActionOutcome {
    try await withCheckedThrowingContinuation { continuation in
      DispatchQueue.global(qos: .userInitiated).async {
        continuation.resume(with: Result { try work() })
      }
    }
  }

  private func run(command: String, cwd: String?, timeout: Int, snapshot: LiveSnapshot, cancel: CancellationFlag) throws -> ActionOutcome {
    guard let first = snapshot.folders.first else {
      throw ActionError(.outsideFolders, "No folders are shared with assistants on this Mac.")
    }
    let (folder, resolved) = try PathResolver.resolve(cwd ?? first.path, folders: snapshot.folders, home: environment.home)
    try folder.verify()
    // Walk the folder's descriptor to prove the working folder holds no symbolic link.
    if let name = resolved.relative.last {
      let parent = try SafeFiles.openParent(folder, resolved)
      defer { close(parent) }
      close(try SafeFiles.openDirectory(parent, name, display: resolved.absolute))
    }
    let tempDir = environment.tempRoot + "/" + UUID().uuidString
    guard mkdir(tempDir, 0o700) == 0 else {
      throw ActionError(.failed, "The command's temporary folder could not be created.")
    }
    defer { try? FileManager.default.removeItem(atPath: tempDir) }
    let policy = SandboxPolicy.build(
      SandboxConfig(
        home: environment.home, grantedFolders: snapshot.folders.map(\.path), tempDir: tempDir,
        appDataDir: environment.appDataDir, developerDir: environment.developerDir))
    let output = try runner.run(
      command: command, cwd: resolved.absolute, policy: policy, environment: environment.commandEnvironment(tempDir: tempDir),
      timeout: TimeInterval(timeout), cancel: cancel)
    if output.cancelled {
      return .failure(ActionError(.paused, "The command was stopped because assistants were paused or this Mac was unlinked."))
    }
    return .success([
      "exitCode": .int(output.exitCode), "timedOut": .bool(output.timedOut), "stdout": .string(output.stdout),
      "stderr": .string(output.stderr), "stdoutTruncated": .bool(output.stdoutTruncated),
      "stderrTruncated": .bool(output.stderrTruncated), "durationMs": .int(output.durationMs), "cwd": .string(resolved.absolute),
    ])
  }
}
