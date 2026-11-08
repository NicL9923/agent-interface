import XCTest

@testable import WildBotsMacCore

final class FolderValidatorTests: XCTestCase {
  let home = "/Users/nic"

  func testRefusesHomeSystemAndCredentialLocationsWithTheReason() {
    let cases: [(String, FolderValidator.Refusal)] = [
      ("/", .containsHome),
      ("/Users", .containsHome),
      ("/Users/nic", .homeFolder),
      ("/Users/nic/Library", .library),
      ("/Users/nic/library/Mobile Documents", .library),
      ("/Applications", .systemLocation("/Applications")),
      ("/Applications/Utilities", .systemLocation("/Applications")),
      ("/System/Volumes/Data", .systemLocation("/System")),
      ("/Library/Fonts", .systemLocation("/Library")),
      ("/Library/LaunchDaemons", .protected("Library/LaunchDaemons")),
      ("/usr/local/bin", .systemLocation("/usr")),
      ("/private/etc", .systemLocation("/private")),
      ("/opt/homebrew", .systemLocation("/opt")),
      ("/Volumes/DevSSD", .volumeRoot),
      ("/Users/nic/.ssh", .protected(".ssh")),
      ("/Users/nic/dev/.config/gh", .protected(".config/gh")),
      ("/Volumes/Backup/Users/nic/Library/Keychains", .protected("Keychains")),
      ("/Users/nic/dev/\"x\"", .unsupportedCharacters),
      ("/Users/nic/dev/a\nb", .unsupportedCharacters),
    ]
    for (path, refusal) in cases {
      XCTAssertEqual(FolderValidator.check(path, home: home), .failure(refusal), path)
    }
  }

  func testAcceptsOrdinaryFolders() {
    for path in ["/Users/nic/dev", "/Users/nic/Documents/Taxes", "/Volumes/DevSSD/dev", "/Users/Shared/Projects"] {
      XCTAssertEqual(FolderValidator.check(path, home: home), .success(path))
    }
  }

  func testValidateResolvesSymbolicLinksBeforeChecking() throws {
    let box = try Sandbox()
    let link = box.home + "/looks-harmless"
    try FileManager.default.createSymbolicLink(atPath: link, withDestinationPath: box.home + "/Library")
    XCTAssertEqual(FolderValidator.validate(link, home: box.home), .failure(.library))
    XCTAssertEqual(FolderValidator.validate(box.granted, home: box.home), .success(box.granted))
    box.write(box.home + "/file.txt", "x")
    XCTAssertEqual(FolderValidator.validate(box.home + "/file.txt", home: box.home), .failure(.notADirectory(box.home + "/file.txt")))
    XCTAssertEqual(FolderValidator.validate(box.home + "/missing", home: box.home), .failure(.notADirectory(box.home + "/missing")))
  }

  func testProtectedMatchIgnoresCaseAndNeedsWholeComponents() {
    XCTAssertEqual(ProtectedPaths.match(["Users", "nic", "dev", ".SSH", "id"]), [".ssh"])
    XCTAssertEqual(ProtectedPaths.match(["a", ".Config", "GH", "hosts.yml"]), [".config", "gh"])
    XCTAssertNil(ProtectedPaths.match(["a", ".sshd", "x"]))
    XCTAssertNil(ProtectedPaths.match(["a", ".config", "ghost"]))
  }

  func testPolicyDocumentToleratesMissingKeysAndKeepsGrants() throws {
    let box = try Sandbox()
    let url = URL(fileURLWithPath: box.appData + "/policy.json")
    try Data(#"{"grants":[{"assistantId":"patch","assistantName":"Patch","abilities":["run"],"unattended":true}]}"#.utf8).write(to: url)
    let loaded = PolicyDocument.load(from: url)
    XCTAssertEqual(loaded.grants.first?.abilities, [.run])
    XCTAssertEqual(loaded.folders, [])
    XCTAssertFalse(loaded.paused)
    try Data("garbage".utf8).write(to: url)
    // A corrupt file allows nothing rather than guessing.
    XCTAssertEqual(PolicyDocument.load(from: url), PolicyDocument())
  }
}
