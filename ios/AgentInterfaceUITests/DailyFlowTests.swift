import XCTest

@MainActor final class DailyFlowTests: XCTestCase {
  private func launch(missingTarget: Bool = false) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchEnvironment["AGENT_INTERFACE_UI_FIXTURE"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_RESET"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_SCOPE"] = UUID().uuidString.lowercased()
    if missingTarget { app.launchEnvironment["AGENT_INTERFACE_UI_MISSING_SEARCH_TARGET"] = "1" }
    app.launch()
    return app
  }
  private func capture(_ app: XCUIApplication, _ name: String) throws {
    let screenshot = app.screenshot()
    let attachment = XCTAttachment(screenshot: screenshot); attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    if let directory = ProcessInfo.processInfo.environment["AGENT_INTERFACE_SCREENSHOT_DIR"] {
      try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
      try screenshot.pngRepresentation.write(to: URL(fileURLWithPath: directory).appendingPathComponent(name + ".png"))
    }
  }
  func testTabsKeepDraftAndFindOpensMessageActions() throws {
    let app = launch()
    let composer = app.textViews["messageComposer"]
    XCTAssertTrue(composer.waitForExistence(timeout: 15), app.debugDescription)
    composer.tap(); composer.typeText("Keep this draft")
    app.tabBars.buttons["Today"].tap()
    XCTAssertTrue(app.staticTexts["Needs your attention"].waitForExistence(timeout: 5))
    try capture(app, "daily-today")
    app.tabBars.buttons["Search"].tap()
    XCTAssertTrue(app.textFields["Search conversations"].waitForExistence(timeout: 5))
    app.textFields["Search conversations"].tap(); app.textFields["Search conversations"].typeText("Retain this query")
    XCUIDevice.shared.orientation = .landscapeLeft
    XCTAssertTrue(app.tabBars.buttons["Search"].waitForExistence(timeout: 5))
    XCTAssertEqual(app.textFields["Search conversations"].value as? String, "Retain this query")
    XCUIDevice.shared.orientation = .portrait
    app.tabBars.buttons["Assistants"].tap()
    XCTAssertEqual(composer.value as? String, "Keep this draft")
    app.buttons["Conversation actions"].tap(); app.buttons["Find in conversation"].tap()
    let find = app.textFields["findConversation"]
    XCTAssertTrue(find.waitForExistence(timeout: 5)); find.tap(); find.typeText("household assistant")
    XCTAssertTrue(app.staticTexts["1 of 1"].waitForExistence(timeout: 5))
    try capture(app, "daily-find")
    app.buttons["Close find"].tap()
    app.staticTexts["Your household assistant"].press(forDuration: 1)
    XCTAssertTrue(app.buttons["Copy answer"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["Share answer"].exists)
    XCTAssertTrue(app.buttons["Save reply"].exists)
    try capture(app, "daily-reply-actions")
    app.buttons["Save reply"].tap()
    XCTAssertTrue(composer.waitForExistence(timeout: 5))
  }
  func testInterruptedVoiceCanBeTranscribedAfterReturning() throws {
    let app = launch()
    XCTAssertTrue(app.buttons["Record voice"].waitForExistence(timeout: 15)); app.buttons["Record voice"].tap()
    XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Stop recording")).firstMatch.waitForExistence(timeout: 5))
    XCUIDevice.shared.press(.home)
    app.activate()
    let transcribe = app.buttons["Transcribe recording"]
    XCTAssertTrue(transcribe.waitForExistence(timeout: 10), app.debugDescription)
    try capture(app, "daily-voice-kept")
    transcribe.tap()
    XCTAssertTrue(app.staticTexts["Added to your draft. Review it before sending."].waitForExistence(timeout: 5))
    XCTAssertEqual(app.textViews["messageComposer"].value as? String, "Fixture transcript: check the north gate.")
  }
  func testSearchOpensTheMatchingReply() throws {
    let app = launch()
    XCTAssertTrue(app.tabBars.buttons["Search"].waitForExistence(timeout: 15)); app.tabBars.buttons["Search"].tap()
    let query = app.textFields["Search conversations"]
    XCTAssertTrue(query.waitForExistence(timeout: 5)); query.tap(); query.typeText("brisket")
    app.buttons["nativeSearchSubmit"].tap()
    app.buttons["nativeSearchResult-history-1"].tap()
    let reply = app.staticTexts["Fixture saved reply: brisket on Sunday."]
    expectation(for: NSPredicate(format: "hittable == true"), evaluatedWith: reply)
    waitForExpectations(timeout: 10)
    try capture(app, "daily-search-match")
  }
  func testRetiredSearchTargetStillOpensItsConversation() throws {
    let app = launch(missingTarget: true)
    XCTAssertTrue(app.tabBars.buttons["Search"].waitForExistence(timeout: 15)); app.tabBars.buttons["Search"].tap()
    let query = app.textFields["Search conversations"]
    XCTAssertTrue(query.waitForExistence(timeout: 5)); query.tap(); query.typeText("brisket")
    app.buttons["nativeSearchSubmit"].tap()
    app.buttons["nativeSearchResult-history-1"].tap()
    XCTAssertTrue(app.staticTexts["Fixture: five easy dinners."].waitForExistence(timeout: 10), app.debugDescription)
  }

}
