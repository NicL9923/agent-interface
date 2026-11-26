import XCTest
@testable import AgentInterface

/// Live reply growth and `?inflight=3` turn placement against the web's src/shared/inflight.ts,
/// through the shared vectors both clients read: Vectors/inflight-delta.json and
/// Vectors/turn-events.json.
@MainActor final class InflightDeltaTests: XCTestCase {
  private struct Vectors: Decodable {
    struct Case: Decodable { var name: String; var held: Inflight?; var delta: InflightDelta; var result: Inflight? }
    var cases: [Case]
  }
  private struct TurnVectors: Decodable {
    struct CompareCase: Decodable { var name: String; var a: String?; var b: String?; var sign: Int? }
    struct BootCase: Decodable { var name: String; var version: String?; var boot: String? }
    struct PlaceCase: Decodable { var name: String; var messages: [Message]; var turn: TurnRows; var result: [Message]? }
    struct WithTurnCase: Decodable { var name: String; var conversation: Conversation; var turn: TurnEvent; var result: Conversation? }
    var compareVersions: [CompareCase]
    var versionBoot: [BootCase]
    var placeTurn: [PlaceCase]
    var withTurn: [WithTurnCase]
  }
  private func vectors() throws -> [Vectors.Case] {
    let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Vectors/inflight-delta.json")
    return try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url)).cases
  }
  private func turnVectors() throws -> TurnVectors {
    let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Vectors/turn-events.json")
    return try JSONDecoder().decode(TurnVectors.self, from: Data(contentsOf: url))
  }

  func testGrowthNoticesMatchTheSharedVectors() throws {
    let cases = try vectors()
    XCTAssertFalse(cases.isEmpty)
    for vector in cases {
      let next = vector.held?.extended(by: vector.delta)
      XCTAssertEqual(next, vector.result, vector.name)
      // Code unit for code unit, as JavaScript sees it: Swift's == would also accept a differently
      // composed text.
      XCTAssertEqual(next.map { Array($0.message.text.utf16) }, vector.result.map { Array($0.message.text.utf16) }, vector.name)
      XCTAssertEqual(next.map { Array(($0.message.reasoning ?? "").utf16) }, vector.result.map { Array(($0.message.reasoning ?? "").utf16) }, vector.name)
    }
  }

  func testTurnEventsMatchTheSharedVectors() throws {
    let vectors = try turnVectors()
    XCTAssertFalse(vectors.compareVersions.isEmpty)
    XCTAssertFalse(vectors.versionBoot.isEmpty)
    XCTAssertFalse(vectors.placeTurn.isEmpty)
    XCTAssertFalse(vectors.withTurn.isEmpty)
    for vector in vectors.compareVersions {
      let order = ConversationVersion.compare(vector.a, vector.b)
      let sign = order.map { $0 < 0 ? -1 : ($0 > 0 ? 1 : 0) }
      XCTAssertEqual(sign, vector.sign, "compareVersions: \(vector.name)")
    }
    for vector in vectors.versionBoot {
      XCTAssertEqual(ConversationVersion.boot(vector.version), vector.boot, "versionBoot: \(vector.name)")
    }
    for vector in vectors.placeTurn {
      XCTAssertEqual(Conversation.placeTurn(vector.messages, turn: vector.turn), vector.result, "placeTurn: \(vector.name)")
    }
    for vector in vectors.withTurn {
      XCTAssertEqual(vector.conversation.applying(turn: vector.turn), vector.result, "withTurn: \(vector.name)")
    }
  }

  func testTurnAnchorDistinguishesAbsentNullAndString() throws {
    let base = #""botId":"bot","version":"b:1:1","messages":[],"message":{"id":"sid-inflight","role":"assistant","text":"Hi"},"activity":{"state":"thinking","runId":"run"},"toolCalls":[]"#
    let absent = try JSONDecoder().decode(TurnEvent.self, from: Data("{\(base)}".utf8))
    let start = try JSONDecoder().decode(TurnEvent.self, from: Data("{\(base),\"after\":null}".utf8))
    let after = try JSONDecoder().decode(TurnEvent.self, from: Data("{\(base),\"after\":\"u1\"}".utf8))
    XCTAssertNil(absent.after)
    XCTAssertEqual(start.after, .start)
    XCTAssertEqual(after.after, .after("u1"))
    // Round-trip preserves the distinction between absent and explicit null.
    let reAbsent = try JSONDecoder().decode(TurnEvent.self, from: try JSONEncoder().encode(absent))
    let reStart = try JSONDecoder().decode(TurnEvent.self, from: try JSONEncoder().encode(start))
    let reAfter = try JSONDecoder().decode(TurnEvent.self, from: try JSONEncoder().encode(after))
    XCTAssertNil(reAbsent.after)
    XCTAssertEqual(reStart.after, .start)
    XCTAssertEqual(reAfter.after, .after("u1"))
  }

  func testVersionedInflightAppliesOnlyBesideMatchingConversationVersion() {
    let base = Conversation(
      botId: "bot",
      messages: [Message(id: "u1", role: "user", text: "Hi")],
      activity: Activity(state: .thinking, runId: "run"),
      approvals: [],
      files: [],
      version: "b:1:5"
    )
    let legacy = Inflight(
      botId: "bot",
      message: Message(id: "sid-inflight", role: "assistant", text: "Legacy"),
      activity: Activity(state: .thinking, runId: "run"),
      toolCalls: []
    )
    XCTAssertEqual(legacy.applying(to: base).messages.last?.text, "Legacy", "Unversioned legacy inflight still applies")
    let matching = Inflight(
      botId: "bot",
      message: Message(id: "sid-inflight", role: "assistant", text: "Matching"),
      activity: Activity(state: .thinking, runId: "run"),
      toolCalls: [],
      version: "b:1:5"
    )
    XCTAssertEqual(matching.applying(to: base).messages.last?.text, "Matching")
    for mismatch in ["b:1:4", "b:1:6", "other:1:5", nil] as [String?] {
      var conversation = base
      conversation.version = mismatch
      XCTAssertEqual(matching.applying(to: conversation), conversation, "Versioned live reply skips version \(mismatch ?? "nil")")
    }
  }

  func testConversationVersionCompareHandlesExtremeIntValuesWithoutOverflow() {
    XCTAssertEqual(ConversationVersion.compare("b:\(Int.max):0", "b:\(Int.min):0"), 1)
    XCTAssertEqual(ConversationVersion.compare("b:\(Int.min):0", "b:\(Int.max):0"), -1)
    XCTAssertEqual(ConversationVersion.compare("b:1:\(Int.max)", "b:1:\(Int.min)"), 1)
    XCTAssertEqual(ConversationVersion.compare("b:1:\(Int.min)", "b:1:\(Int.max)"), -1)
    XCTAssertEqual(ConversationVersion.compare("b:\(Int.max):\(Int.min)", "b:\(Int.max):\(Int.min)"), 0)
  }
}
