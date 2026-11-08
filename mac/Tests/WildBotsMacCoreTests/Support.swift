import Foundation
import XCTest

@testable import WildBotsMacCore

/// A throwaway directory tree with a fake home, so no test touches the real home folder.
/// Paths are canonical (`/private/var/...`), as the sandbox and folder handles expect.
final class Sandbox {
  let root: String
  let home: String
  let granted: String
  let outside: String
  let appData: String
  let tempRoot: String

  init() throws {
    let base = FileManager.default.temporaryDirectory.appendingPathComponent("wbtest-\(UUID().uuidString.prefix(8))").path
    try FileManager.default.createDirectory(atPath: base, withIntermediateDirectories: true)
    root = HostEnvironment.canonical(base)
    home = root + "/home"
    granted = home + "/dev"
    outside = root + "/outside"
    appData = home + "/Library/Application Support/" + ProtectedPaths.appSupportName
    tempRoot = root + "/commands"
    for path in [granted, outside, appData, tempRoot, home + "/Library/LaunchAgents", home + "/Library/Keychains"] {
      try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
    }
  }

  deinit {
    _ = try? FileManager.default.removeItem(atPath: root)
  }

  func write(_ path: String, _ text: String) {
    try! FileManager.default.createDirectory(
      atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    try! text.write(toFile: path, atomically: false, encoding: .utf8)
  }

  func read(_ path: String) -> String? { try? String(contentsOfFile: path, encoding: .utf8) }

  var environment: HostEnvironment {
    HostEnvironment(
      home: home, appDataDir: appData, tempRoot: tempRoot, developerDir: HostEnvironment.detectDeveloperDir(), userName: NSUserName())
  }

  func folder(_ path: String? = nil, name: String = "dev") throws -> FolderHandle {
    try FolderHandle(name: name, path: path ?? granted)
  }
}

func assertActionError<T>(
  _ code: ErrorCode, containing fragment: String? = nil, file: StaticString = #filePath, line: UInt = #line,
  _ body: () throws -> T
) {
  do {
    let value = try body()
    XCTFail("expected \(code.rawValue), got \(value)", file: file, line: line)
  } catch let error as ActionError {
    XCTAssertEqual(error.code, code, error.message, file: file, line: line)
    if let fragment {
      XCTAssertTrue(error.message.contains(fragment), "\"\(error.message)\" lacks \"\(fragment)\"", file: file, line: line)
    }
  } catch {
    XCTFail("unexpected error \(error)", file: file, line: line)
  }
}

func assertFailure(
  _ outcome: ActionOutcome, _ code: ErrorCode, containing fragment: String? = nil, file: StaticString = #filePath,
  line: UInt = #line
) {
  guard case .failure(let error) = outcome else {
    return XCTFail("expected \(code.rawValue), got \(outcome)", file: file, line: line)
  }
  XCTAssertEqual(error.code, code, error.message, file: file, line: line)
  if let fragment {
    XCTAssertTrue(error.message.contains(fragment), "\"\(error.message)\" lacks \"\(fragment)\"", file: file, line: line)
  }
}

extension ActionOutcome {
  var value: JSONValue? { if case .success(let value) = self { return value }; return nil }
}
