import XCTest

@testable import WildBotsMacCore

final class ActionRequestTests: XCTestCase {
  /// Every guard, fed the input it rejects, with the reason it must give.
  func testRejectsBadArgumentsWithTheReason() {
    let tooLong = String(repeating: "a", count: 16385)
    let big = String(repeating: "a", count: 1_048_577)
    let bigBase64 = Data(count: 1_048_577).base64EncodedString()
    let cases: [(String, [String: JSONValue], ErrorCode, String)] = [
      ("run", [:], .invalidArguments, "command is required"),
      ("run", ["command": ""], .invalidArguments, "command must not be empty"),
      ("run", ["command": 5], .invalidArguments, "command must be a string"),
      ("run", ["command": .string(tooLong)], .invalidArguments, "1 to 16384"),
      ("run", ["command": "echo \u{0}"], .invalidArguments, "NUL"),
      ("run", ["command": "ls", "timeoutSeconds": 0], .invalidArguments, "timeoutSeconds must be 1 to 600"),
      ("run", ["command": "ls", "timeoutSeconds": 601], .invalidArguments, "timeoutSeconds must be 1 to 600"),
      ("run", ["command": "ls", "timeoutSeconds": .number(1.5)], .invalidArguments, "timeoutSeconds must be an integer"),
      ("run", ["command": "ls", "timeoutSeconds": "60"], .invalidArguments, "timeoutSeconds must be an integer"),
      ("run", ["command": "ls", "timeoutSeconds": true], .invalidArguments, "timeoutSeconds must be an integer"),
      ("run", ["command": "ls", "timeout": 5], .invalidArguments, "Unknown argument timeout"),
      ("run", ["command": "ls", "cwd": ""], .invalidArguments, "cwd must not be empty"),
      ("read_file", [:], .invalidArguments, "path is required"),
      ("read_file", ["path": .string("/" + String(repeating: "a", count: 4096))], .invalidArguments, "at most 4096"),
      ("read_file", ["path": "a", "offset": -1], .invalidArguments, "offset must be 0 or more"),
      ("read_file", ["path": "a", "length": 0], .invalidArguments, "length must be 1 to 1048576"),
      ("read_file", ["path": "a", "length": 1_048_577], .invalidArguments, "length must be 1 to 1048576"),
      ("write_file", ["path": "a"], .invalidArguments, "content is required"),
      ("write_file", ["path": "a", "content": .string(big)], .tooLarge, "larger than 1 MiB"),
      ("write_file", ["path": "a", "content": .string(bigBase64), "encoding": "base64"], .tooLarge, "larger than 1 MiB"),
      ("write_file", ["path": "a", "content": "%%%", "encoding": "base64"], .invalidArguments, "not valid base64"),
      ("write_file", ["path": "a", "content": "x", "encoding": "latin1"], .invalidArguments, "utf8 or base64"),
      ("write_file", ["path": "a", "content": "x", "expectedSha256": "abc"], .invalidArguments, "64 hexadecimal"),
      (
        "write_file",
        ["path": "a", "content": "x", "createOnly": true, "expectedSha256": .string(String(repeating: "0", count: 64))],
        .invalidArguments, "cannot be combined"
      ),
      ("write_file", ["path": "a", "content": "x", "createOnly": "yes"], .invalidArguments, "createOnly must be true or false"),
      ("list_dir", ["limit": 0], .invalidArguments, "limit must be 1 to 500"),
      ("list_dir", ["limit": 501], .invalidArguments, "limit must be 1 to 500"),
      ("list_dir", ["offset": -3], .invalidArguments, "offset must be 0 or more"),
      ("screenshot", ["display": 2], .invalidArguments, "Unknown argument display"),
      ("format_disk", [:], .invalidArguments, "Unknown action format_disk"),
    ]
    for (action, args, code, reason) in cases {
      switch ActionRequest.parse(action: action, args: args) {
      case .success(let request): XCTFail("\(action) \(args.keys.sorted()) was accepted as \(request)")
      case .failure(let error):
        XCTAssertEqual(error.code, code, "\(action): \(error.message)")
        XCTAssertTrue(error.message.contains(reason), "\(action): \"\(error.message)\" lacks \"\(reason)\"")
      }
    }
  }

  func testAcceptsEachLimitsInclusiveEdgeAndAppliesDefaults() throws {
    let longest = String(repeating: "a", count: 16384)
    XCTAssertEqual(
      try ActionRequest.parse(action: "run", args: ["command": .string(longest), "timeoutSeconds": 600]).get(),
      .run(command: longest, cwd: nil, timeoutSeconds: 600))
    XCTAssertEqual(
      try ActionRequest.parse(action: "run", args: ["command": "ls", "timeoutSeconds": 1, "cwd": nil]).get(),
      .run(command: "ls", cwd: nil, timeoutSeconds: 1))
    XCTAssertEqual(try ActionRequest.parse(action: "run", args: ["command": "ls"]).get(), .run(command: "ls", cwd: nil, timeoutSeconds: 120))
    XCTAssertEqual(
      try ActionRequest.parse(action: "read_file", args: ["path": "a", "length": 1_048_576]).get(),
      .readFile(path: "a", offset: 0, length: 1_048_576))
    XCTAssertEqual(try ActionRequest.parse(action: "read_file", args: ["path": "a"]).get(), .readFile(path: "a", offset: 0, length: 262_144))
    XCTAssertEqual(try ActionRequest.parse(action: "list_dir", args: ["limit": 500]).get(), .listDir(path: nil, offset: 0, limit: 500))
    XCTAssertEqual(try ActionRequest.parse(action: "list_dir", args: [:]).get(), .listDir(path: nil, offset: 0, limit: 200))
    let exactly = Data(count: 1_048_576)
    XCTAssertEqual(
      try ActionRequest.parse(action: "write_file", args: ["path": "a", "content": .string(exactly.base64EncodedString()), "encoding": "base64"]).get(),
      .writeFile(path: "a", content: exactly, expectedSha256: nil, createOnly: false))
    XCTAssertEqual(
      try ActionRequest.parse(action: "write_file", args: ["path": "a", "content": ""]).get(),
      .writeFile(path: "a", content: Data(), expectedSha256: nil, createOnly: false))
    let upper = String(repeating: "AB", count: 32)
    XCTAssertEqual(
      try ActionRequest.parse(action: "write_file", args: ["path": "a", "content": "x", "expectedSha256": .string(upper)]).get(),
      .writeFile(path: "a", content: Data("x".utf8), expectedSha256: upper.lowercased(), createOnly: false))
  }
}

final class AuthorizerTests: XCTestCase {
  func snapshot(paused: Bool = false, unattended: Bool = false, abilities: Set<Ability> = [.run, .screenshot], locked: Bool = false,
    permission: ScreenPermission = .granted) -> LiveSnapshot
  {
    var policy = PolicyDocument()
    policy.paused = paused
    policy.grants = [Grant(assistantId: "patch", assistantName: "Patch", abilities: abilities, unattended: unattended)]
    return LiveSnapshot(policy: policy, folders: [], screenLocked: locked, screenPermission: permission)
  }

  func invocation(_ action: String = "run", assistant: String = "patch", scheduled: Bool = false, args: [String: JSONValue] = ["command": "ls"]) -> Invocation {
    Invocation(id: "i", assistantId: assistant, assistantName: nil, scheduled: scheduled, action: action, args: args)
  }

  func testRefusalsInOrderWithTheirReason() {
    let cases: [(Invocation, LiveSnapshot, ErrorCode, String)] = [
      (invocation("delete_everything"), snapshot(paused: true), .invalidArguments, "Unknown action"),
      (invocation(), snapshot(paused: true), .paused, "paused"),
      (invocation(assistant: "stranger"), snapshot(), .notAllowed, "stranger to run commands"),
      (invocation("read_file", args: ["path": "a"]), snapshot(), .notAllowed, "patch to read files"),
      (invocation(scheduled: true), snapshot(unattended: false), .unattendedNotAllowed, "only while someone is in a WildBots chat"),
      (invocation(args: [:]), snapshot(), .invalidArguments, "command is required"),
      (invocation("screenshot", args: [:]), snapshot(locked: true), .screenLocked, "locked"),
      (invocation("screenshot", args: [:]), snapshot(permission: .unknown), .permissionNeeded, "Screen Recording"),
      (invocation("screenshot", args: [:]), snapshot(permission: .denied), .permissionNeeded, "Screen Recording"),
    ]
    for (invocation, snapshot, code, reason) in cases {
      switch Authorizer.evaluate(invocation, snapshot: snapshot) {
      case .success(let request): XCTFail("\(invocation.action) allowed as \(request)")
      case .failure(let error):
        XCTAssertEqual(error.code, code, error.message)
        XCTAssertTrue(error.message.contains(reason), "\"\(error.message)\" lacks \"\(reason)\"")
      }
    }
  }

  func testAllowsGrantedAbilitiesIncludingUnattendedWhenSwitchedOn() {
    XCTAssertEqual(try Authorizer.evaluate(invocation(), snapshot: snapshot()).get(), .run(command: "ls", cwd: nil, timeoutSeconds: 120))
    XCTAssertNoThrow(try Authorizer.evaluate(invocation(scheduled: true), snapshot: snapshot(unattended: true)).get())
    XCTAssertEqual(try Authorizer.evaluate(invocation("screenshot", args: [:]), snapshot: snapshot()).get(), .screenshot)
  }
}
