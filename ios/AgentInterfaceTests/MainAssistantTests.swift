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
    var preferences = try JSONDecoder().decode(Preferences.self, from: Data(#"{"presentation":"simple","theme":"system","favorites":["sage","ranch"],"sections":[],"followBots":[],"mainBotId":"sage"}"#.utf8))
    XCTAssertEqual(preferences.mainAssistant(bots)?.id, "sage")
    XCTAssertEqual(preferences.pinnedAssistants(bots).map(\.id), ["ranch"])
    XCTAssertEqual(preferences.assistantGroups(bots).flatMap(\.bots).map(\.id), ["notes"])
    // A main assistant this person can no longer see is not shown.
    preferences.mainBotId = "gone"
    XCTAssertNil(preferences.mainAssistant(bots))
    XCTAssertEqual(preferences.pinnedAssistants(bots).map(\.id), ["sage", "ranch"])
  }

  func testOlderServersPreferencesDecodeWithoutAMainAssistant() throws {
    let preferences = try JSONDecoder().decode(Preferences.self, from: Data(#"{"presentation":"simple","theme":"system","favorites":[],"sections":[],"followBots":[]}"#.utf8))
    XCTAssertNil(preferences.mainBotId)
    XCTAssertNil(preferences.checkIns)
    let current = try JSONDecoder().decode(Preferences.self, from: Data(#"{"presentation":"simple","theme":"system","favorites":[],"sections":[],"followBots":[],"checkIns":{"enabled":true,"everyHours":3,"timezone":"America/Chicago"}}"#.utf8))
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

  /// A refusal that comes after the server saved the change carries what it saved, as when Hermes
  /// hasn't removed a check-in yet; the screen shows that, and the reason still reaches the person.
  func testARefusalAfterTheServerSavedShowsWhatItSavedAndKeepsTheReason() async throws {
    let server = FakeServer()
    let store = AppStore(); store.api = server.api()
    defer {
      if let scope = store.scope {
        for key in UserDefaults.standard.dictionaryRepresentation().keys where key.hasPrefix("native.\(scope).") { UserDefaults.standard.removeObject(forKey: key) }
      }
    }
    let base = #""presentation":"simple","theme":"system","favorites":[],"sections":[],"followBots":[]"#
    store.bootstrap = try JSONDecoder().decode(Bootstrap.self, from: Data(#"""
      {"user":{"id":"main-\#(UUID().uuidString)","name":"Mom","email":"m@example.test"},"household":[],
       "preferences":{\#(base),"mainBotId":"sage","checkIns":{"enabled":true,"everyHours":2,"timezone":"America/Chicago"}},
       "bots":[{"id":"sage","name":"Sage","model":"m","shared":false,"ownerId":"mom","activity":"idle"}],
       "capabilities":{"chat":{"supported":true}},"connection":{"connected":true},"csrfToken":null}
      """#.utf8))
    func refused(_ work: () async throws -> Void) async -> String? {
      do { try await work(); return nil } catch { return error.localizedDescription }
    }
    server.reply = .init(status: 502, body: #"{"error":"Check-ins are off, but Hermes hasn't removed the routine yet.","code":"check_in_removal_pending","preferences":{\#(base),"mainBotId":"sage","checkIns":{"enabled":false,"everyHours":2,"timezone":"America/Chicago"}}}"#)
    let checkInsReason = await refused { try await store.setCheckIns(enabled: false) }
    XCTAssertEqual(checkInsReason, "Check-ins are off, but Hermes hasn't removed the routine yet.")
    XCTAssertEqual(store.bootstrap?.preferences.checkIns?.enabled, false)
    server.reply = .init(status: 502, body: #"{"error":"Your previous main assistant still has a check-in in Hermes.","code":"main_clear_pending","preferences":{\#(base)}}"#)
    let clearReason = await refused { try await store.setMainAssistant(nil) }
    XCTAssertEqual(clearReason, "Your previous main assistant still has a check-in in Hermes.")
    XCTAssertNil(store.bootstrap?.preferences.mainBotId)
    // A refusal that saved nothing changes nothing.
    server.reply = .init(status: 409, body: #"{"error":"Sage can't be your main assistant yet.","code":"main_routine_busy"}"#)
    let busyReason = await refused { try await store.setMainAssistant("sage") }
    XCTAssertEqual(busyReason, "Sage can't be your main assistant yet.")
    XCTAssertNil(store.bootstrap?.preferences.mainBotId)
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
