import XCTest

/// The main assistant on home, in its card and in a chat. Debug fixtures stand in for the server;
/// they establish native behavior, not Hermes check-in runs or the add-on's hand-off gate.
@MainActor final class MainAssistantFlowTests: XCTestCase {
  override func setUp() { continueAfterFailure = false }
  private func launch(_ main: String, theme: String = "light") -> XCUIApplication {
    let app = XCUIApplication()
    app.launchEnvironment["AGENT_INTERFACE_UI_FIXTURE"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_RESET"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_SCOPE"] = UUID().uuidString.lowercased()
    app.launchEnvironment["AGENT_INTERFACE_UI_HOME"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_MAIN"] = main
    app.launchEnvironment["AGENT_INTERFACE_UI_THEME"] = theme
    app.launch()
    return app
  }
  private func capture(_ name: String) throws {
    let screenshot = XCUIScreen.main.screenshot()
    let attachment = XCTAttachment(screenshot: screenshot); attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    if let directory = ProcessInfo.processInfo.environment["AGENT_INTERFACE_SCREENSHOT_DIR"] {
      try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
      try screenshot.pngRepresentation.write(to: URL(fileURLWithPath: directory).appendingPathComponent(name + ".png"))
    }
  }

  func testChoosingAMainAssistantFromTheHomeSuggestion() throws {
    for theme in ["light", "dark"] {
      let app = launch("suggest", theme: theme)
      XCTAssertTrue(app.descendants(matching: .any)["mainSuggestion"].waitForExistence(timeout: 15), app.debugDescription)
      try capture("ios-home-suggestion-\(theme)")
      app.buttons["chooseMain"].tapWhenReady()
      // Only the member's own personal assistant can be chosen; shared ones say why and offer Make it personal.
      XCTAssertTrue(app.buttons["makeMain.personal"].waitForExistence(timeout: 10), app.debugDescription)
      XCTAssertFalse(app.buttons["makeMain.ranch"].exists)
      XCTAssertTrue(app.buttons["makePersonal.ranch"].exists)
      try capture("ios-main-picker-\(theme)")
      app.buttons["makeMain.personal"].tap()
      XCTAssertTrue(app.buttons["mainBot.personal"].waitForExistence(timeout: 10), app.debugDescription)
      XCTAssertFalse(app.descendants(matching: .any)["mainSuggestion"].exists)
      // It leads home and is not also a regular row.
      XCTAssertFalse(app.buttons["bot.personal"].exists)
      app.terminate()
    }
  }

  func testTheMainAssistantLeadsHomeChecksInAndHandsOff() throws {
    for theme in ["light", "dark"] {
      let app = launch("1", theme: theme)
      let main = app.buttons["mainBot.personal"]
      XCTAssertTrue(main.waitForExistence(timeout: 15), app.debugDescription)
      XCTAssertTrue(main.label.contains("main assistant"), main.label)
      try capture("ios-home-main-\(theme)")
      main.tap()
      // A check-in that found something is a message in the chat.
      XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "dentist moved to 4 PM")).firstMatch.waitForExistence(timeout: 15), app.debugDescription)
      let open = app.buttons["openExchangeChat.ranch"]
      XCTAssertTrue(open.waitForExistence(timeout: 10), app.debugDescription)
      XCTAssertEqual(open.label, "Open Ranch hand's chat")
      try capture("ios-chat-checkin-handoff-\(theme)")
      app.openBotProfile("My assistant")
      let checkIns = app.switches["checkIns"]
      XCTAssertTrue(checkIns.waitForExistence(timeout: 10), app.debugDescription)
      XCTAssertEqual(checkIns.value as? String, "1")
      XCTAssertTrue(app.buttons["checkInFrequency"].exists || app.descendants(matching: .any)["checkInFrequency"].exists)
      try capture("ios-details-checkins-\(theme)")
      if theme == "light" {
        checkIns.tap()
        XCTAssertTrue(checkIns.wait(until: "value == %@", "0"), "Check-ins turn off")
        XCTAssertFalse(app.descendants(matching: .any)["checkInFrequency"].exists)
        app.buttons["closeBotProfile"].tapWhenReady()
        open.tapWhenReady()
        // The handoff opens the other assistant's chat.
        XCTAssertTrue(app.staticTexts["Ranch hand"].waitForExistence(timeout: 10), app.debugDescription)
      }
      app.terminate()
    }
  }
}
