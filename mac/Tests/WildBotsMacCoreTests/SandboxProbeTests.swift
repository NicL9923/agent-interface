import Darwin
import XCTest

@testable import WildBotsMacCore

/// Adversarial probes against the real `sandbox-exec` with the real generated policy. These are
/// the merge gate for the command sandbox: each one fails if the policy regresses. The home
/// folder is a fake one inside a temporary directory, so nothing touches the real home.
final class SandboxProbeTests: XCTestCase {
  var box: Sandbox!
  var extraFolders: [String] = []

  override func setUpWithError() throws {
    box = try Sandbox()
    extraFolders = []
  }

  @discardableResult
  func sandboxed(_ command: String, cwd: String? = nil, timeout: TimeInterval = 30, file: StaticString = #filePath, line: UInt = #line)
    throws -> CommandOutput
  {
    let temp = box.tempRoot + "/" + UUID().uuidString
    XCTAssertEqual(mkdir(temp, 0o700), 0)
    let environment = box.environment
    let policy = SandboxPolicy.build(
      SandboxConfig(
        home: box.home, grantedFolders: [box.granted] + extraFolders, tempDir: temp, appDataDir: box.appData,
        developerDir: environment.developerDir))
    var env = environment.commandEnvironment(tempDir: temp)
    env["G"] = box.granted
    env["OUT"] = box.outside
    env["APPDATA"] = box.appData
    env["ROOT"] = box.root
    return try CommandRunner().run(
      command: command, cwd: cwd ?? box.granted, policy: policy, environment: env, timeout: timeout, cancel: CancellationFlag())
  }

  func assertDenied(_ command: String, leaking secret: String? = nil, file: StaticString = #filePath, line: UInt = #line) throws {
    let output = try sandboxed(command)
    XCTAssertNotEqual(output.exitCode, 0, "allowed: \(command)\n\(output.stdout)", file: file, line: line)
    if let secret {
      XCTAssertFalse(output.stdout.contains(secret) || output.stderr.contains(secret), "leaked by: \(command)", file: file, line: line)
    }
  }

  // MARK: Folders

  func testWritesInsideAGrantedFolderSucceed() throws {
    let output = try sandboxed(#"echo inside > "$G/w.txt" && mkdir -p "$G/a/b" && mv "$G/w.txt" "$G/a/b/" && cat "$G/a/b/w.txt""#)
    XCTAssertEqual(output.exitCode, 0, output.stderr)
    XCTAssertEqual(output.stdout, "inside\n")
  }

  func testWritesOutsideGrantedFoldersFail() throws {
    try assertDenied(#"echo x > "$OUT/w.txt""#)
    try assertDenied(#"echo x > "$HOME/w.txt""#)
    try assertDenied(#"mkdir "$HOME/newdir""#)
    XCTAssertNil(box.read(box.outside + "/w.txt"))
    XCTAssertNil(box.read(box.home + "/w.txt"))
  }

  func testReadsOfTheRestOfHomeFail() throws {
    box.write(box.home + "/secret.txt", "home-secret-value")
    box.write(box.home + "/Documents/private.txt", "documents-secret-value")
    try assertDenied(#"cat "$HOME/secret.txt""#, leaking: "home-secret-value")
    try assertDenied(#"cat "$HOME/Documents/private.txt""#, leaking: "documents-secret-value")
    try assertDenied(#"ls "$HOME""#, leaking: "secret.txt")
  }

  func testProtectedPathsInsideAGrantedFolderAreDenied() throws {
    box.write(box.granted + "/.ssh/id_ed25519", "ssh-private-key")
    box.write(box.granted + "/project/.aws/credentials", "aws-secret-key")
    box.write(box.granted + "/project/.config/gh/hosts.yml", "gh-token")
    try assertDenied("cat .ssh/id_ed25519", leaking: "ssh-private-key")
    // APFS is case-insensitive: another spelling opens the same file.
    try assertDenied("cat .SSH/id_ed25519", leaking: "ssh-private-key")
    try assertDenied("ls .ssh", leaking: "id_ed25519")
    try assertDenied("cat project/.aws/credentials", leaking: "aws-secret-key")
    try assertDenied("cat project/.config/gh/hosts.yml", leaking: "gh-token")
    try assertDenied("echo planted >> .ssh/authorized_keys")
    try assertDenied("mkdir -p other/.gnupg")
    XCTAssertNil(box.read(box.granted + "/.ssh/authorized_keys"))
  }

  func testSymbolicLinksOutOfAGrantedFolderCannotBeFollowed() throws {
    box.write(box.outside + "/secret.txt", "outside-secret-value")
    try FileManager.default.createSymbolicLink(atPath: box.granted + "/planted", withDestinationPath: box.outside + "/secret.txt")
    try assertDenied("cat planted", leaking: "outside-secret-value")
    try assertDenied(#"ln -s "$OUT" escape && cat escape/secret.txt"#, leaking: "outside-secret-value")
    try assertDenied(#"ln -sf "$HOME" h && echo x > h/written.txt"#)
    XCTAssertNil(box.read(box.home + "/written.txt"))
  }

  func testRenamingAGrantedFolderOrItsAncestorsFails() throws {
    box.write(box.granted + "/keep.txt", "k")
    try assertDenied(#"mv "$G" "$HOME/moved""#)
    try assertDenied(#"mv "$HOME" "$ROOT/home-moved""#)
    try assertDenied(#"mv "$G/keep.txt" "$OUT/keep.txt""#)
    try assertDenied(#"cp "$G/keep.txt" "$OUT/copy.txt""#)
    XCTAssertEqual(box.read(box.granted + "/keep.txt"), "k")
    XCTAssertNil(box.read(box.outside + "/copy.txt"))
  }

  // MARK: The app's own data

  func testTheAppsOwnDataKeychainsAndLaunchAgentsAreOffLimits() throws {
    box.write(box.appData + "/journal.jsonl", "journal-secret")
    box.write(box.home + "/Library/Keychains/login.keychain-db", "keychain-bytes")
    try assertDenied(#"cat "$APPDATA/journal.jsonl""#, leaking: "journal-secret")
    try assertDenied(#"echo '{"grants":[]}' > "$APPDATA/policy.json""#)
    try assertDenied(#"cat "$HOME/Library/Keychains/login.keychain-db""#, leaking: "keychain-bytes")
    try assertDenied(#"echo '<plist/>' > "$HOME/Library/LaunchAgents/evil.plist""#)
    XCTAssertNil(box.read(box.appData + "/policy.json"))
    XCTAssertNil(box.read(box.home + "/Library/LaunchAgents/evil.plist"))
  }

  // MARK: Other apps and services

  func testAppleEventsToOtherAppsFail() throws {
    let output = try sandboxed(#"osascript -e 'tell application "Finder" to get name of startup disk'"#, timeout: 20)
    XCTAssertTrue(output.exitCode != 0 || output.timedOut, "osascript succeeded")
    XCTAssertEqual(output.stdout.trimmingCharacters(in: .whitespacesAndNewlines), "", "osascript returned data")
  }

  func testOpeningAnotherAppFails() throws {
    let output = try sandboxed("open -a TextEdit", timeout: 20)
    XCTAssertTrue(output.exitCode != 0 || output.timedOut, "open -a TextEdit succeeded")
  }

  func testLaunchdJobsCannotBeSubmittedOrBootstrapped() throws {
    let label = "dev.agentinterface.probe.\(UUID().uuidString.prefix(8))"
    let plist = """
      <?xml version="1.0" encoding="UTF-8"?>
      <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
      <plist version="1.0"><dict><key>Label</key><string>\(label)-b</string>
      <key>ProgramArguments</key><array><string>/usr/bin/true</string></array></dict></plist>
      """
    box.write(box.granted + "/agent.plist", plist)
    defer {
      // Clean up if a regression ever let either through.
      _ = try? CommandRunner().spawnAndWait(
        arguments: ["/bin/launchctl", "remove", label], environment: [:], cwd: "/", timeout: 10, cancel: CancellationFlag())
      _ = try? CommandRunner().spawnAndWait(
        arguments: ["/bin/launchctl", "remove", label + "-b"], environment: [:], cwd: "/", timeout: 10, cancel: CancellationFlag())
    }
    try assertDenied("launchctl submit -l \(label) -- /usr/bin/true")
    try assertDenied(#"launchctl bootstrap gui/$(id -u) "$G/agent.plist""#)
    for job in [label, label + "-b"] {
      let listed = try CommandRunner().spawnAndWait(
        arguments: ["/bin/launchctl", "list", job], environment: [:], cwd: "/", timeout: 10, cancel: CancellationFlag())
      XCTAssertNotEqual(listed.exitCode, 0, "\(job) was loaded into launchd")
    }
  }

  func testUnixSocketsStayClosed() throws {
    // Unix socket paths are limited to 104 bytes, so this folder sits directly in /private/tmp.
    let short = "/private/tmp/wb\(UUID().uuidString.prefix(6))"
    try FileManager.default.createDirectory(atPath: short, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(atPath: short) }
    extraFolders = [short]
    let path = short + "/s"
    let listener = socket(AF_UNIX, SOCK_STREAM, 0)
    defer { close(listener) }
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    withUnsafeMutableBytes(of: &address.sun_path) { buffer in
      path.utf8CString.withUnsafeBytes { buffer.copyMemory(from: $0) }
    }
    let bound = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(listener, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
    }
    XCTAssertEqual(bound, 0)
    XCTAssertEqual(listen(listener, 1), 0)
    let connect = #"python3 -c "import socket,sys; s=socket.socket(socket.AF_UNIX); s.connect(sys.argv[1]); print('connected')" "#
    let output = try sandboxed(connect + path)
    XCTAssertNotEqual(output.exitCode, 0)
    XCTAssertFalse(output.stdout.contains("connected"), "a sandboxed command reached a local Unix socket")
  }

  // MARK: What must keep working

  func testNetworkWorks() throws {
    let output = try sandboxed("curl -sS -o /dev/null -w '%{http_code}' --max-time 20 https://example.com", timeout: 40)
    XCTAssertEqual(output.exitCode, 0, output.stderr)
    XCTAssertEqual(output.stdout, "200")
  }

  func testDeveloperToolsWork() throws {
    let output = try sandboxed(
      #"git --version && python3 -c 'print(1)' && git init -q repo && cd repo && git -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m first && git log --oneline | wc -l | tr -d ' '"#)
    XCTAssertEqual(output.exitCode, 0, output.stderr)
    let lines = output.stdout.split(separator: "\n")
    XCTAssertTrue(lines.first?.hasPrefix("git version") == true, output.stdout)
    XCTAssertEqual(lines.dropFirst().first, "1")
    XCTAssertEqual(lines.last, "1")
    XCTAssertFalse(output.stderr.contains("xcrun_db"), "the xcrun shim ran: \(output.stderr)")
  }

  func testTemporaryFilesLandInThePrivateTemporaryFolder() throws {
    let output = try sandboxed(
      #"echo t > "$TMPDIR/a" && cat "$TMPDIR/a" && python3 -c 'import tempfile; print(tempfile.mkstemp()[1])' && echo "$TMPDIR""#)
    XCTAssertEqual(output.exitCode, 0, output.stderr)
    let lines = output.stdout.split(separator: "\n").map(String.init)
    XCTAssertEqual(lines.first, "t")
    let tempDir = lines.last ?? ""
    XCTAssertTrue(tempDir.hasPrefix(box.tempRoot + "/"), tempDir)
    XCTAssertTrue(lines.dropFirst().first?.hasPrefix(tempDir) == true, output.stdout)
    // The shared /tmp is not writable; only the private folder is.
    let marker = "/private/tmp/wildbots-probe-\(UUID().uuidString)"
    try assertDenied("echo x > \(marker)")
    XCTAssertFalse(FileManager.default.fileExists(atPath: marker))
  }
}
