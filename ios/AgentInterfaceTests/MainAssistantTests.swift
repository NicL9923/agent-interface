import XCTest
@testable import AgentInterface

/// The main assistant's rules, mirroring src/shared/main-assistant.ts and tests/main-assistant-ui.test.ts.
@MainActor final class MainAssistantTests: XCTestCase {
  private func bot(_ id: String, shared: Bool = false, owner: String? = "mom") throws -> Bot {
    let ownerField = owner.map { #","ownerId":"\#($0)""# } ?? ""
    return try JSONDecoder().decode(Bot.self, from: Data(#"{"id":"\#(id)","name":"\#(id.capitalized)","model":"m","shared":\#(shared),"activity":"idle"\#(ownerField)}"#.utf8))
  }

  func testOnlyTheMembersOwnPersonalAssistantCanBeMainAndOthersSayWhy() throws {
    XCTAssertTrue(MainAssistant.eligible(try bot("sage"), userId: "mom"))
    XCTAssertFalse(MainAssistant.eligible(try bot("diary", owner: "dad"), userId: "mom"))
    XCTAssertEqual(MainAssistant.ineligibleReason(try bot("ranch", shared: true, owner: nil), userId: "mom"),
      "Shared with the household. Check-ins stay private only on your own personal assistant.")
    XCTAssertEqual(MainAssistant.ineligibleReason(try bot("legacy", owner: nil), userId: "mom"), "Visible to the whole household because it has no recorded owner.")
    XCTAssertNil(MainAssistant.ineligibleReason(try bot("sage"), userId: "mom"))
  }

  func testHomeShowsTheMainAssistantOnlyOnItsOwnRow() throws {
    let bots = try [bot("ranch", shared: true, owner: nil), bot("sage"), bot("notes")]
    var preferences = try JSONDecoder().decode(Preferences.self, from: Data(#"{"favorites":["sage","ranch"],"sections":[],"followBots":[],"mainBotId":"sage"}"#.utf8))
    XCTAssertEqual(preferences.mainAssistant(bots)?.id, "sage")
    XCTAssertEqual(preferences.pinnedAssistants(bots).map(\.id), ["ranch"])
    XCTAssertEqual(preferences.assistantGroups(bots).flatMap(\.bots).map(\.id), ["notes"])
    // A main assistant this person can no longer see is not shown.
    preferences.mainBotId = "gone"
    XCTAssertNil(preferences.mainAssistant(bots))
    XCTAssertEqual(preferences.pinnedAssistants(bots).map(\.id), ["sage", "ranch"])
  }

  func testOlderServersPreferencesDecodeWithoutAMainAssistant() throws {
    let preferences = try JSONDecoder().decode(Preferences.self, from: Data(#"{"favorites":[],"sections":[],"followBots":[]}"#.utf8))
    XCTAssertNil(preferences.mainBotId)
    XCTAssertNil(preferences.checkIns)
    let current = try JSONDecoder().decode(Preferences.self, from: Data(#"{"favorites":[],"sections":[],"followBots":[],"checkIns":{"enabled":true,"everyHours":3,"timezone":"America/Chicago"}}"#.utf8))
    XCTAssertEqual(current.checkIns, CheckInSettings(enabled: true, everyHours: 3, timezone: "America/Chicago"))
  }

  func testClearingTheMainAssistantSendsAnExplicitNull() throws {
    XCTAssertEqual(String(decoding: try JSONEncoder().encode(MainChoice(botId: nil)), as: UTF8.self), #"{"botId":null}"#)
    XCTAssertEqual(String(decoding: try JSONEncoder().encode(MainChoice(botId: "sage")), as: UTF8.self), #"{"botId":"sage"}"#)
  }

  func testReadsHermesIntervalDisplayAndLabelsFrequencies() {
    XCTAssertEqual(MainAssistant.scheduleMinutes("every 120m"), 120)
    XCTAssertEqual(MainAssistant.scheduleMinutes("every 2h"), 120)
    XCTAssertNil(MainAssistant.scheduleMinutes("0 7 * * *"))
    XCTAssertEqual(MainAssistant.hours.map(MainAssistant.frequencyLabel), ["Every hour", "Every 2 hours", "Every 3 hours", "Every 4 hours"])
  }

  func testAHandoffOpensOnlyAnAssistantOnThisPersonsHome() throws {
    let bots = try [bot("sage"), bot("ranch", shared: true, owner: nil)]
    XCTAssertEqual(MainAssistant.exchangePartner(target: "@Ranch", incomingName: nil, bots: bots, currentBotId: "sage")?.id, "ranch")
    XCTAssertEqual(MainAssistant.exchangePartner(target: nil, incomingName: "Ranch", bots: bots, currentBotId: "sage")?.id, "ranch")
    for target in ["dad-diary", "ranch, sage", "sage", ""] {
      XCTAssertNil(MainAssistant.exchangePartner(target: target, incomingName: nil, bots: bots, currentBotId: "sage"), target)
    }
  }

  func testTheSwitcherLeadsWithTheMainAssistantAndAsksItWithTypedWords() throws {
    let bots = try [bot("alpha", shared: true, owner: nil), bot("sage"), bot("ranch", shared: true, owner: nil)]
    XCTAssertEqual(QuickSwitch.entries(query: "", bots: bots, pinned: ["ranch"], main: "sage").prefix(3).map(\.target), [.bot("sage"), .bot("ranch"), .bot("alpha")])
    let asked = QuickSwitch.entries(query: "move dentist", bots: bots, pinned: [], main: "sage")
    XCTAssertEqual(asked.map(\.target), [.ask("sage", "move dentist")])
    XCTAssertEqual(asked.first?.title, "Ask Sage: \u{201C}move dentist\u{201D}")
    XCTAssertFalse(QuickSwitch.entries(query: "move dentist", bots: bots, pinned: []).contains { if case .ask = $0.target { true } else { false } })
  }
}
