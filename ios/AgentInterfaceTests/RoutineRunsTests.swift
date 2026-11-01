import XCTest
@testable import AgentInterface

/// Routine runs in the conversation: decoding, the loaded window, delivered runs and placement,
/// matching the web's tests/routine-runs.test.ts.
@MainActor final class RoutineRunsTests: XCTestCase {
  private func run(_ id: String, _ startedAt: String?, routine routineId: String = "brief", name: String = "Morning brief",
    finishedAt: String? = nil, status: RoutineRunStatus = .succeeded) -> RoutineRun {
    RoutineRun(id: id, routineId: routineId, routineName: name, startedAt: startedAt, finishedAt: finishedAt ?? startedAt, status: status)
  }

  func testDecodesStatusesAndReadsMissingOrNewerOnesAsUnknown() throws {
    let json = #"""
    {"runs":[
      {"id":"a","routineId":"brief","routineName":"Morning brief","startedAt":"2026-10-02T07:00:00.123456+00:00","finishedAt":"2026-10-02T07:01:00+00:00","status":"succeeded","deliveryFailed":true,"previewOnly":false},
      {"id":"b","routineId":"cert","routineName":"Certificate check","status":"failed","error":"Expired","previewOnly":true},
      {"id":"c","routineId":"cert","routineName":"Certificate check","status":"queued_for_review","previewOnly":true},
      {"id":"d","routineId":"cert","routineName":"Certificate check","previewOnly":false}
    ],"unavailable":["broken"]}
    """#
    let page = try JSONDecoder().decode(RoutineRunPage.self, from: Data(json.utf8))
    XCTAssertEqual(page.runs.map(\.status), [.succeeded, .failed, .unknown, .unknown])
    XCTAssertEqual(page.unavailable, ["broken"])
    XCTAssertNotNil(RoutineRunRules.time(page.runs[0]), "Hermes's microsecond timestamps parse")
    XCTAssertEqual(RoutineRunRules.label(page.runs[0]), "Finished, not delivered")
    XCTAssertTrue(RoutineRunRules.flagged(page.runs[0]))
    XCTAssertEqual(RoutineRunRules.label(page.runs[1]), "Failed")
    XCTAssertEqual(RoutineRunRules.label(page.runs[3]), "Status unknown")
    XCTAssertFalse(RoutineRunRules.flagged(page.runs[3]))
    XCTAssertNotEqual(page.runs[1].key, page.runs[2].key)
  }

  func testPreferencesKeepHiddenRoutinesAndOlderServersOmitThem() throws {
    let old = try JSONDecoder().decode(Preferences.self, from: Data(#"{"presentation":"simple","theme":"system","favorites":[],"sections":[],"followBots":[]}"#.utf8))
    XCTAssertNil(old.hiddenRoutineRuns)
    XCTAssertFalse(RoutineRunRules.hidden(old, botId: "ranch", routineId: "cert"))
    let hidden = RoutineRunRules.withShown(old, botId: "ranch", routineId: "cert", shown: false)
    XCTAssertTrue(RoutineRunRules.hidden(hidden, botId: "ranch", routineId: "cert"))
    XCTAssertFalse(RoutineRunRules.hidden(hidden, botId: "planner", routineId: "cert"))
    let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(hidden)) as! [String: Any]
    XCTAssertEqual(encoded["hiddenRoutineRuns"] as? [[String: String]], [["botId": "ranch", "routineId": "cert"]])
    let shown = RoutineRunRules.withShown(RoutineRunRules.withShown(hidden, botId: "ranch", routineId: "cert", shown: false), botId: "ranch", routineId: "cert", shown: true)
    XCTAssertEqual(shown.hiddenRoutineRuns, [])
  }

  func testWindowShowsRunsFromTheOldestLoadedMessageUntilHistoryReachesTheStart() {
    let runs = [run("old", "2026-10-01T07:00:00Z"), run("new", "2026-10-03T07:00:00Z"), run("undated", nil), run("cert", "2026-10-03T08:00:00Z", routine: "cert", name: "Certificates")]
    let ids: (String?, Bool, Set<String>) -> [String] = { oldest, complete, hidden in
      RoutineRunRules.inWindow(runs, oldest: oldest, complete: complete, hidden: hidden).map(\.id)
    }
    XCTAssertEqual(ids("2026-10-02T00:00:00Z", false, []), ["new", "cert"])
    XCTAssertEqual(ids("2026-10-02T00:00:00Z", true, []), ["old", "new", "cert"])
    XCTAssertEqual(ids(nil, false, []), [])
    XCTAssertEqual(ids(nil, true, ["cert"]), ["old", "new"])
  }

  func testEachDeliveryClaimsTheClosestRunOfTheRoutineItNames() {
    XCTAssertEqual(RoutineRunRules.deliveredName("[Cronjob \"[bot:ranch] Morning Brief\" output — scheduled job, not the user. Review it.]\n\nRain"), "morning brief")
    XCTAssertEqual(RoutineRunRules.deliveredName("[Cron delivery: Morning brief]\nRain"), "morning brief")
    XCTAssertNil(RoutineRunRules.deliveredName("Morning brief"))
    let runs = [run("monday", "2026-10-05T07:00:00Z", finishedAt: "2026-10-05T07:02:00Z"), run("tuesday", "2026-10-06T07:00:00Z", finishedAt: "2026-10-06T07:02:00Z"),
      run("other", "2026-10-06T07:00:00Z", routine: "cert", name: "Certificates"), run("by-id", "2026-10-06T09:00:00Z", routine: "job-7", name: "Renamed")]
    let message: (String, String?) -> Message = { text, at in Message(id: UUID().uuidString, role: "user", text: text, createdAt: at) }
    let delivered = RoutineRunRules.delivered(runs, messages: [
      message("[Cron delivery: Morning brief]\nRain", "2026-10-06T07:02:10Z"),
      message("[Cron delivery: Morning brief]\nSame again", "2026-10-06T07:03:00Z"),
      message("[Cron delivery: job-7]\nDone", "2026-10-06T09:00:05Z"),
      message("[Cron delivery: Morning brief]\nUndated", nil),
      message("[Cron delivery: Morning brief]\nLate", "2026-10-05T09:00:00Z"),
    ])
    XCTAssertEqual(delivered, ["run:brief:tuesday", "run:job-7:by-id"])
  }

  func testRunsGoBeforeTheFirstTurnThatStartedAfterThem() {
    let slots = RoutineRunRules.place(turnTimes: ["2026-10-02T09:00:00Z", nil, "2026-10-02T12:00:00Z"], runs: [
      run("late", "2026-10-02T13:00:00Z"), run("early", "2026-10-02T08:00:00Z"), run("between", "2026-10-02T10:00:00Z"),
      run("tie", "2026-10-02T12:00:00Z"), run("first", "2026-10-02T07:00:00Z")])
    XCTAssertEqual(slots.map { $0.map(\.id) }, [["first", "early"], [], ["between"], ["tie", "late"]])
    XCTAssertEqual(RoutineRunRules.place(turnTimes: [], runs: [run("a", "2026-10-02T07:00:00Z")]).map(\.count), [1])
  }
}
