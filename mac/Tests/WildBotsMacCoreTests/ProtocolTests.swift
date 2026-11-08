import XCTest

@testable import WildBotsMacCore

final class ProtocolTests: XCTestCase {
  /// The server stores and shows at most 2000 characters (UTF-16, as JavaScript counts them).
  func testErrorMessagesAreCappedAt2000CharactersHoweverTheyAreSet() {
    let long = String(repeating: "🙂", count: 1500)
    let error = ActionError(.failed, long)
    XCTAssertLessThanOrEqual(error.message.utf16.count, ActionError.maxMessageLength)
    XCTAssertTrue(error.message.hasSuffix("🙂…"), "cut between characters, with an ellipsis")
    var changed = ActionError(.failed, "short")
    changed.message = long
    XCTAssertLessThanOrEqual(changed.message.utf16.count, ActionError.maxMessageLength)
    XCTAssertEqual(ActionError(.failed, "short").message, "short")
  }

  func testIgnoresFramesThatAreNotUsableMessages() {
    let cases: [(String, String)] = [
      ("not json", "not a JSON object"),
      ("[1,2]", "not a JSON object"),
      (#"{"id":"x"}"#, "without a type"),
      (#"{"type":"surprise"}"#, "unknown message type surprise"),
      (#"{"type":"ack"}"#, "ack without an id"),
      (#"{"type":"welcome"}"#, "welcome without a protocol"),
      (#"{"type":"invoke","assistantId":"patch","scheduled":false,"action":"run"}"#, "invoke without a usable id"),
      (#"{"type":"invoke","id":"","assistantId":"patch"}"#, "invoke without a usable id"),
    ]
    for (frame, reason) in cases {
      guard case .ignored(let actual) = LinkCodec.decode(frame) else {
        XCTFail("\(frame) was not ignored")
        continue
      }
      XCTAssertTrue(actual.contains(reason), "\(frame): \(actual)")
    }
    let huge = #"{"type":"ack","id":""# + String(repeating: "a", count: maxFrameBytes) + #""}"#
    XCTAssertEqual(LinkCodec.decode(huge), .ignored(reason: "frame larger than 8 MiB"))
  }

  func testMalformedInvokeKeepsItsIdAndTheReason() {
    let cases: [(String, String)] = [
      (#""scheduled":false,"action":"run""#, "no assistantId"),
      (#""assistantId":"patch","action":"run""#, "no scheduled flag"),
      (#""assistantId":"patch","scheduled":"no","action":"run""#, "no scheduled flag"),
      (#""assistantId":"patch","scheduled":false"#, "no action"),
      (#""assistantId":"patch","scheduled":false,"action":"run","args":[1]"#, "args must be an object"),
      (#""assistantId":"patch","scheduled":false,"action":"run","timeoutMs":-5"#, "timeoutMs must be a positive integer"),
    ]
    for (fields, reason) in cases {
      let frame = #"{"type":"invoke","id":"inv-1","# + fields + "}"
      guard case .malformedInvoke(let malformed) = LinkCodec.decode(frame) else {
        XCTFail("\(fields) was not malformed")
        continue
      }
      XCTAssertEqual(malformed.id, "inv-1")
      XCTAssertEqual(malformed.error.code, .invalidArguments)
      XCTAssertTrue(malformed.error.message.contains(reason), "\(fields): \(malformed.error.message)")
    }
  }

  func testDecodesAWellFormedInvoke() {
    let frame = #"{"type":"invoke","id":"i1","assistantId":"patch","assistantName":"Patch","scheduled":true,"action":"read_file","args":{"path":"a.txt"},"timeoutMs":130000}"#
    guard case .invoke(let invocation) = LinkCodec.decode(frame) else { return XCTFail("not an invoke") }
    XCTAssertEqual(invocation.id, "i1")
    XCTAssertEqual(invocation.assistantName, "Patch")
    XCTAssertTrue(invocation.scheduled)
    XCTAssertEqual(invocation.args["path"], "a.txt")
    XCTAssertEqual(invocation.timeoutMs, 130000)
  }

  func testFingerprintCoversWhatWasAskedButNotDisplayFields() {
    func fingerprint(_ fields: String) -> String {
      guard case .invoke(let invocation) = LinkCodec.decode(#"{"type":"invoke","id":"i","# + fields + "}") else { return "" }
      return invocation.fingerprint
    }
    let base = fingerprint(#""assistantId":"patch","scheduled":false,"action":"run","args":{"command":"ls"}"#)
    XCTAssertEqual(
      base,
      fingerprint(#""args":{"command":"ls"},"action":"run","scheduled":false,"assistantId":"patch","assistantName":"P","timeoutMs":5"#))
    XCTAssertNotEqual(base, fingerprint(#""assistantId":"patch","scheduled":false,"action":"run","args":{"command":"ls -a"}"#))
    XCTAssertNotEqual(base, fingerprint(#""assistantId":"patch","scheduled":true,"action":"run","args":{"command":"ls"}"#))
    XCTAssertNotEqual(base, fingerprint(#""assistantId":"kit","scheduled":false,"action":"run","args":{"command":"ls"}"#))
  }

  func testOutboundMessagesMatchTheContract() throws {
    let state = MacState(
      paused: false, screenLocked: true, screenPermission: .denied, folders: [.init(name: "dev", path: "/Users/nic/dev")],
      grants: [.init(assistantId: "patch", abilities: [.filesRead, .run], unattended: true)])
    let hello = try JSONValue.parse(LinkCodec.hello(appVersion: "1.0", state: state))
    XCTAssertEqual(hello["type"], "hello")
    XCTAssertEqual(hello["protocol"], 1)
    XCTAssertEqual(hello["state"]?["screenPermission"], "denied")
    XCTAssertEqual(hello["state"]?["grants"]?.arrayValue?.first?["abilities"], ["files_read", "run"])
    XCTAssertEqual(hello["state"]?["folders"], [["name": "dev", "path": "/Users/nic/dev"]])

    let failure = try JSONValue.parse(LinkCodec.result(id: "i1", outcome: .failure(ActionError(.busy, "full"))))
    XCTAssertEqual(failure, ["type": "result", "id": "i1", "ok": false, "error": ["code": "busy", "message": "full"]])
    let success = try JSONValue.parse(LinkCodec.result(id: "i2", outcome: .success(["n": 1])))
    XCTAssertEqual(success, ["type": "result", "id": "i2", "ok": true, "value": ["n": 1]])
  }

  func testSerializedJSONEscapesControlCharactersAndRoundTrips() throws {
    let value: JSONValue = ["text": "line\n\"quoted\"\\ \u{1}\u{2028}", "n": .number(1.5), "big": .int(1_048_576)]
    XCTAssertEqual(try JSONValue.parse(value.serialized), value)
    XCTAssertFalse(value.serialized.contains("\n"))
  }

  func testOutcomeRoundTripsThroughJSONAndRejectsUnknownCodes() {
    let outcome = ActionOutcome.failure(ActionError(.hardLink, "two names"))
    XCTAssertEqual(ActionOutcome(json: outcome.json), outcome)
    XCTAssertNil(ActionOutcome(json: ["ok": false, "error": ["code": "made_up"]]))
    XCTAssertNil(ActionOutcome(json: ["value": 1]))
  }
}
