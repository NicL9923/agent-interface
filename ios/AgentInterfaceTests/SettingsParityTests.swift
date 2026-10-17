import XCTest
@testable import AgentInterface

final class SettingsParityTests: XCTestCase {
  func testMcpServerFieldKeepsOnlyNamedIdsLikeTheWebField() {
    XCTAssertEqual(BotInput.serverIds(" github, ,calendar ,, "), ["github", "calendar"])
    XCTAssertEqual(BotInput.serverIds(""), [])
  }
  func testNewMemoryEntriesAreSavedWithoutAnIdAndExistingOnesKeepTheirs() throws {
    let document = MemoryDocument(target: "memory", label: "Memory", revision: "r1", enabled: true, entries: [MemoryEntry(id: String(repeating: "a", count: 64), text: "Old")], charLimit: 2200, charCount: 3)
    var drafts = document.drafts()
    XCTAssertFalse(document.isChanged(drafts))
    var added = MemoryDraft(); added.text = "New"
    drafts.append(added)
    XCTAssertTrue(document.isChanged(drafts))
    let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(MemorySave(revision: "r1", drafts: drafts))) as? [String: Any]
    let entries = try XCTUnwrap(json?["entries"] as? [[String: Any]])
    XCTAssertEqual(entries[0]["id"] as? String, String(repeating: "a", count: 64))
    XCTAssertNil(entries[1]["id"])
    XCTAssertEqual(entries[1]["text"] as? String, "New")
  }
  func testTrialSummaryMatchesWebStatusCopyAndAppendsHermesMessage() {
    func receipt(_ status: String, _ message: String?) -> RoutineRunReceipt {
      RoutineRunReceipt(requestId: "r", routineId: "x", botId: "b", status: status, message: message, startedAt: "2026-10-01T12:00:00Z")
    }
    XCTAssertEqual(receipt("completed", "Done.").summary, "Trial run completed. Done.")
    XCTAssertEqual(receipt("accepted", nil).summary, "Trial run started. Hermes will finish it even if you close this screen.")
    XCTAssertEqual(receipt("uncertain", "").summary, "The run's outcome is unknown. Review its result before starting another.")
    XCTAssertTrue(receipt("failed", nil).finished)
    XCTAssertFalse(receipt("accepted", nil).finished)
  }
  func testSchedulePreviewShowsFullRunTimesInTheHermesTimezone() {
    let en = Locale(identifier: "en_US")
    let chicago = SchedulePreview(botId: "b", schedule: "0 7 * * *", timezone: "America/Chicago", nextRuns: [], kind: "cron")
    XCTAssertEqual(chicago.label("2027-01-04T13:00:00Z", locale: en), "1/4/2027, 7:00:00\u{202F}AM")
    let unknown = SchedulePreview(botId: "b", schedule: "0 7 * * *", timezone: "Not/AZone", nextRuns: [], kind: "cron")
    XCTAssertEqual(unknown.label("2027-01-04T13:00:00Z", locale: en), "1/4/2027, 1:00:00\u{202F}PM UTC")
  }
}
