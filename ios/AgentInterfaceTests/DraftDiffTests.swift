import XCTest
@testable import AgentInterface

/// The revised email draft's word diff and lineage against the web's src/shared/draft-diff.ts, through
/// the vectors both clients read: Vectors/draft-diff.json.
@MainActor final class DraftDiffTests: XCTestCase {
  private struct Vectors: Decodable {
    struct Diff: Decodable { var name: String; var before: String; var after: String; var limit: Int?; var parts: [DiffPart] }
    struct Lineage: Decodable { var name: String; var messages: [Message]; var revises: [String: String] }
    var diff: [Diff]
    var lineage: [Lineage]
  }
  private func vectors() throws -> Vectors {
    let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Vectors/draft-diff.json")
    return try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
  }

  func testTheWordDiffMatchesTheSharedVectors() throws {
    let cases = try vectors().diff
    XCTAssertFalse(cases.isEmpty)
    for vector in cases {
      let parts = DraftDiff.words(vector.before, vector.after, limit: vector.limit ?? DraftDiff.cellLimit)
      XCTAssertEqual(parts, vector.parts, vector.name)
      // Byte for byte, as JavaScript sees it: Swift's == would also accept a differently composed text.
      XCTAssertEqual(parts.filter { $0.kind != .added }.map(\.text).joined().utf16.map { $0 }, vector.before.utf16.map { $0 }, vector.name)
      XCTAssertEqual(parts.filter { $0.kind != .removed }.map(\.text).joined().utf16.map { $0 }, vector.after.utf16.map { $0 }, vector.name)
    }
  }
  func testRevisionLineageMatchesTheSharedVectors() throws {
    for vector in try vectors().lineage {
      let found = DraftDiff.previousDrafts(vector.messages).reduce(into: [String: String]()) { result, entry in
        result[entry.key.replacingOccurrences(of: "\n", with: "/")] = entry.value.body
      }
      XCTAssertEqual(found, vector.revises, vector.name)
    }
  }
  func testComposedAndDecomposedLettersAreDifferentWordsAsOnTheWeb() {
    // "é" written two ways: equal to Swift's ==, different code units to JavaScript.
    XCTAssertEqual(DraftDiff.words("caf\u{E9}", "cafe\u{301}").map(\.kind), [.removed, .added])
  }
  func testLineageLivesInTheIdAndNoOtherEmailFieldIsAccepted() {
    func cards(_ fields: String) -> [ReplyCard] {
      ReplyCards.parseFresh("```agent-ui\n{\"version\":1,\"cards\":[{\"type\":\"email\",\"title\":\"Reply\",\"body\":\"Hi\"\(fields)}]}\n```").flatMap { $0.cards ?? [] }
    }
    XCTAssertEqual(cards(#","id":"b__revises__a""#).map { DraftDiff.lineage($0.id).revises }, ["a"])
    XCTAssertEqual(DraftDiff.lineage("a__revises__a").revises, nil, "A draft cannot revise itself")
    XCTAssertEqual(DraftDiff.lineage("__revises__a").draft, "__revises__a")
    XCTAssertEqual(DraftDiff.lineage("__revises__a__revises__b").revises, "b", "As the web's lazy pattern splits it")
    XCTAssertNil(DraftDiff.lineage("e__revises__").revises)
    // As released clients do, any field beyond the first email shape refuses the card.
    for extra in [#","draftId":"d1""#, #","revises":"d0""#, #","subject":null"#] {
      XCTAssertEqual(cards(#","id":"reply""# + extra).count, 0, extra)
    }
  }
  func testChangesNameEachFieldAndWhetherAnythingChanged() throws {
    let base = ReplyCard(id: "a", type: "email", title: "Reply", to: ["sam@example.com"], subject: "Saturday", body: "See you Saturday.")
    XCTAssertFalse(DraftDiff.changes(from: base, to: base).changed)
    var next = base; next.to = ["sam@example.com", "kim@example.com"]; next.subject = nil
    let changes = DraftDiff.changes(from: base, to: next)
    XCTAssertTrue(changes.changed)
    XCTAssertEqual(changes.to, [AddressPart(kind: .same, address: "sam@example.com"), AddressPart(kind: .added, address: "kim@example.com")])
    XCTAssertEqual(changes.subject, [DiffPart(kind: .removed, text: "Saturday")])
    XCTAssertEqual(EmailDiffText.spoken(changes.to), "sam@example.com, added: kim@example.com")
    XCTAssertEqual(EmailDiffText.spoken(DraftDiff.words("See you Saturday.", "See you Sunday.")), "See you removed: Saturday. added: Sunday.")
    XCTAssertEqual(EmailDiffText.spoken(DraftDiff.words("a\n\nb", "a\nb")), "a removed line break added line break b")
  }
}

/// Which device its person is using, against src/shared/device-activity.ts and docs/native-api.md.
@MainActor final class DeviceActivityTests: XCTestCase {
  private let start = Date(timeIntervalSince1970: 1_800_000_000)
  func testInUseUntilFiveMinutesAfterTheLastInputAndOnlyInTheForeground() {
    let decide = { (foreground: Bool, idle: TimeInterval, reporting: Bool) in
      DeviceActivity.decide(foreground: foreground, lastInput: self.start, now: self.start.addingTimeInterval(idle), reporting: reporting)
    }
    XCTAssertEqual(decide(true, 0, false)?.state, "active")
    XCTAssertEqual(decide(true, 299.999, true)?.idleMs, 299_999)
    XCTAssertEqual(decide(true, 299.9999, true)?.idleMs, 299_999, "Never past what the server accepts")
    XCTAssertEqual(decide(true, 300, true)?.state, "inactive")
    XCTAssertNil(decide(true, 300, false), "Nothing to end when nothing was reported")
    XCTAssertEqual(decide(false, 0, true)?.state, "inactive")
    XCTAssertNil(decide(false, 0, false))
    // A clock that went back never reports a negative idle time.
    XCTAssertEqual(decide(true, -5, false)?.idleMs, 0)
  }
  func testReportsThisInstallInUseAndStopsInTheBackgroundOrAfterSignOut() async throws {
    let server = FakeServer(), store = AppStore()
    store.widgetSnapshotURL = nil
    let activity = DeviceActivity.shared
    var clock = start
    activity.now = { clock }
    activity.store = store
    defer { activity.backgrounded(); activity.store = nil; activity.now = Date.init; FakeExchange.remove(host: server.origin.host!) }
    // Before sign-in finishes nothing goes out, and the next beat tries again.
    activity.foregrounded()
    XCTAssertTrue(server.requests.isEmpty)
    store.api = server.api()
    let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Contract/bootstrap.json")
    let envelope = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: fixture)) as? [String: Any])
    store.bootstrap = try JSONDecoder().decode(Bootstrap.self, from: JSONSerialization.data(withJSONObject: envelope["response"] ?? envelope))
    clock = start.addingTimeInterval(15); activity.update()
    try await until { server.requests.count == 1 }
    XCTAssertEqual(server.lastRequest?.url?.path, "/api/devices/activity")
    XCTAssertEqual(server.lastRequest?.httpMethod, "PUT")
    XCTAssertEqual(try server.lastJSON() as NSDictionary, ["deviceId": NotificationController.shared.deviceId, "state": "active", "idleMs": 15_000] as NSDictionary)
    activity.backgrounded()
    try await until { server.requests.count == 2 }
    XCTAssertEqual(try server.lastJSON()["state"] as? String, "inactive")
    // Signing out: the server ended the old session's activity, and a session-less app sends nothing.
    activity.foregrounded()
    try await until { server.requests.count == 3 }
    store.api?.token = nil
    activity.accountChanged()
    activity.input()
    // Absence: a report would have been sent at once, so a short pause shows none went.
    try await Task.sleep(for: .milliseconds(100))
    XCTAssertEqual(server.requests.count, 3)
    XCTAssertFalse(activity.reporting)
  }
}
