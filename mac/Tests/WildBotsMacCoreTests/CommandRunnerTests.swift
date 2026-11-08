import Darwin
import XCTest

@testable import WildBotsMacCore

final class CommandRunnerTests: XCTestCase {
  var box: Sandbox!
  override func setUpWithError() throws { box = try Sandbox() }

  func run(_ command: String, timeout: TimeInterval = 30, runner: CommandRunner = CommandRunner(), policy: String? = nil,
    cancel: CancellationFlag = CancellationFlag()) throws -> CommandOutput
  {
    let temp = box.tempRoot + "/" + UUID().uuidString
    mkdir(temp, 0o700)
    let generated = SandboxPolicy.build(
      SandboxConfig(home: box.home, grantedFolders: [box.granted], tempDir: temp, appDataDir: box.appData,
        developerDir: box.environment.developerDir))
    var env = box.environment.commandEnvironment(tempDir: temp)
    env["G"] = box.granted
    return try runner.run(
      command: command, cwd: box.granted, policy: policy ?? generated, environment: env, timeout: timeout, cancel: cancel)
  }

  func pidIsAlive(_ path: String) -> Bool {
    guard let text = box.read(path)?.trimmingCharacters(in: .whitespacesAndNewlines), let pid = Int32(text) else { return false }
    return kill(pid, 0) == 0
  }

  func testReportsExitCodeAndBothStreams() throws {
    let output = try run("echo out; echo err >&2; exit 3")
    XCTAssertEqual(output.exitCode, 3)
    XCTAssertEqual(output.stdout, "out\n")
    XCTAssertEqual(output.stderr, "err\n")
    XCTAssertFalse(output.timedOut)
  }

  func testKeepsTheLast64KiBOfEachStream() throws {
    let output = try run("head -c 70000 /dev/zero | tr '\\0' a; printf END")
    XCTAssertEqual(output.stdout.utf8.count, 65_536)
    XCTAssertTrue(output.stdout.hasSuffix("aEND"))
    XCTAssertTrue(output.stdoutTruncated)
    XCTAssertFalse(output.stderrTruncated)
    let exact = try run("head -c 65536 /dev/zero | tr '\\0' b")
    XCTAssertEqual(exact.stdout.utf8.count, 65_536)
    XCTAssertFalse(exact.stdoutTruncated, "exactly 64 KiB is not truncated")
  }

  func testATimeoutEndsTheWholeProcessGroup() throws {
    let started = Date()
    let output = try run(#"sleep 60 & echo $! > "$G/child.pid"; sleep 60"#, timeout: 1)
    XCTAssertTrue(output.timedOut)
    XCTAssertEqual(output.exitCode, 128 + Int(SIGTERM))
    XCTAssertLessThan(Date().timeIntervalSince(started), 10)
    usleep(300_000)
    XCTAssertFalse(pidIsAlive(box.granted + "/child.pid"), "a background child outlived the timeout")
  }

  func testLeftoverBackgroundProcessesEndWithTheCommand() throws {
    let started = Date()
    let output = try run(#"sleep 60 & echo $! > "$G/child.pid"; echo done"#)
    XCTAssertEqual(output.stdout, "done\n")
    XCTAssertFalse(output.timedOut)
    XCTAssertLessThan(Date().timeIntervalSince(started), 10, "waited on a background child holding the pipe")
    usleep(300_000)
    XCTAssertFalse(pidIsAlive(box.granted + "/child.pid"))
  }

  func testCancelStopsARunningCommand() throws {
    let flag = CancellationFlag()
    DispatchQueue.global().asyncAfter(deadline: .now() + 0.5) { flag.cancel() }
    let started = Date()
    let output = try run("sleep 60", cancel: flag)
    XCTAssertTrue(output.cancelled)
    XCTAssertLessThan(Date().timeIntervalSince(started), 10)
  }

  func testAMissingSandboxExecMeansTheCommandDoesNotRun() throws {
    assertActionError(.sandboxUnavailable, containing: "cannot be confined") {
      try run(#"touch "$G/ran""#, runner: CommandRunner(sandboxExec: box.root + "/no-sandbox-exec"))
    }
    XCTAssertFalse(FileManager.default.fileExists(atPath: box.granted + "/ran"))
  }

  func testAPolicyThatDoesNotCompileMeansTheCommandDoesNotRun() throws {
    assertActionError(.sandboxUnavailable, containing: "could not start") {
      try run(#"touch "$G/ran""#, policy: "(version 1)\n(allow no-such-operation)\n")
    }
    XCTAssertFalse(FileManager.default.fileExists(atPath: box.granted + "/ran"))
  }

  func testTheEnvironmentIsCleanAndNoAppDescriptorLeaks() throws {
    setenv("WILDBOTS_TEST_SECRET", "app-environment-secret", 1)
    defer { unsetenv("WILDBOTS_TEST_SECRET") }
    let opened = open(box.granted, O_RDONLY)
    // A high number that neither the shell nor ls would pick for itself.
    let leaked = fcntl(opened, F_DUPFD, 77)
    close(opened)
    defer { close(leaked) }
    let output = try run("env; ls /dev/fd")
    XCTAssertFalse(output.stdout.contains("app-environment-secret"))
    let fds = output.stdout.split(separator: "\n").compactMap { Int($0) }
    XCTAssertGreaterThanOrEqual(leaked, 77)
    XCTAssertFalse(fds.contains(Int(leaked)), "descriptor \(leaked) leaked: \(fds)")
  }
}
