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
  /// Back to home, the root of the iPhone's one navigation stack.
  private func home(_ app: XCUIApplication) {
    if app.buttons["openSettings"].canTap { return }
    let back = app.navigationBars.buttons.matching(identifier: "Your assistants").firstMatch
    if back.exists { back.tap() } else { app.navigationBars.buttons.firstMatch.tap() }
    XCTAssertTrue(app.buttons["openSettings"].waitForExistence(timeout: 5))
  }
  func testKeyboardHidesFromItsButtonAndFromATapOnTheTranscript() throws {
    let app = launch()
    let composer = app.textViews["messageComposer"]
    XCTAssertTrue(composer.waitForExistence(timeout: 15), app.debugDescription)
    XCTAssertFalse(app.buttons["hideKeyboard"].exists, "The control shows only while typing")
    composer.typeWhenFocused("Short chat")
    try capture(app, "daily-keyboard-control")
    app.buttons["hideKeyboard"].tapWhenReady()
    XCTAssertTrue(composer.waitForKeyboardFocus(false))
    XCTAssertTrue(app.buttons["hideKeyboard"].waitForDisappearance())
    // The fixture chat is too short to drag, so a plain tap on it must be enough.
    composer.tap(); XCTAssertTrue(composer.waitForKeyboardFocus(true))
    app.scrollViews["conversationTranscript"].coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.9)).tap()
    XCTAssertTrue(composer.waitForKeyboardFocus(false))
    XCTAssertEqual(composer.value as? String, "Short chat")
  }
  func testHomePushesKeepDraftAndFindOpensMessageActions() throws {
    let app = launch()
    let composer = app.textViews["messageComposer"]
    XCTAssertTrue(composer.waitForExistence(timeout: 15), app.debugDescription)
    composer.typeWhenFocused("Keep this draft")
    home(app)
    app.buttons["openToday"].tap()
    XCTAssertTrue(app.staticTexts["Needs your attention"].waitForExistence(timeout: 5))
    try capture(app, "daily-today")
    home(app)
    app.buttons["openDiscovery"].tap()
    XCTAssertTrue(app.textFields["Search conversations"].waitForExistence(timeout: 5))
    app.textFields["Search conversations"].typeWhenFocused("Retain this query")
    XCUIDevice.shared.orientation = .landscapeLeft
    XCTAssertTrue(app.textFields["Search conversations"].waitForExistence(timeout: 5))
    XCTAssertEqual(app.textFields["Search conversations"].value as? String, "Retain this query")
    XCUIDevice.shared.orientation = .portrait
    home(app)
    app.buttons["bot.ranch"].tap()
    XCTAssertTrue(composer.waitForExistence(timeout: 5))
    XCTAssertEqual(composer.value as? String, "Keep this draft")
    app.openBotProfile("Ranch hand")
    app.buttons["profileFind"].tap()
    let find = app.textFields["findConversation"]
    XCTAssertTrue(find.waitForExistence(timeout: 5)); find.typeWhenFocused("household assistant")
    XCTAssertTrue(app.staticTexts["1 of 1"].waitForExistence(timeout: 5))
    try capture(app, "daily-find")
    app.buttons["Close find"].tap()
    app.staticTexts["Your household assistant"].press(forDuration: 1)
    XCTAssertTrue(app.buttons["Copy answer"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["Share answer"].exists)
    XCTAssertTrue(app.buttons["Save reply"].exists)
    try capture(app, "daily-reply-actions")
    app.buttons["Save reply"].tapWhenReady()
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
    let composer = app.textViews["messageComposer"]
    composer.wait(until: "value == %@", "Fixture transcript: check the north gate.")
    XCTAssertEqual(composer.value as? String, "Fixture transcript: check the north gate.")
  }
  func testSearchOpensTheMatchingReply() throws {
    let app = launch()
    XCTAssertTrue(app.textViews["messageComposer"].waitForExistence(timeout: 15)); home(app); app.buttons["openDiscovery"].tap()
    let query = app.textFields["Search conversations"]
    XCTAssertTrue(query.waitForExistence(timeout: 5)); query.typeWhenFocused("brisket")
    app.buttons["nativeSearchSubmit"].tapWhenReady()
    app.buttons["nativeSearchResult-history-1"].tapWhenReady()
    let reply = app.staticTexts["Fixture saved reply: brisket on Sunday."]
    expectation(for: NSPredicate(format: "hittable == true"), evaluatedWith: reply)
    waitForExpectations(timeout: 10)
    try capture(app, "daily-search-match")
  }
  func testRetiredSearchTargetStillOpensItsConversation() throws {
    let app = launch(missingTarget: true)
    XCTAssertTrue(app.textViews["messageComposer"].waitForExistence(timeout: 15)); home(app); app.buttons["openDiscovery"].tap()
    let query = app.textFields["Search conversations"]
    XCTAssertTrue(query.waitForExistence(timeout: 5)); query.typeWhenFocused("brisket")
    app.buttons["nativeSearchSubmit"].tapWhenReady()
    app.buttons["nativeSearchResult-history-1"].tapWhenReady()
    XCTAssertTrue(app.staticTexts["Fixture: five easy dinners."].waitForExistence(timeout: 10), app.debugDescription)
  }

}
