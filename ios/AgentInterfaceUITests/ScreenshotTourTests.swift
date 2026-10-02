import XCTest

/// Captures a repeatable PNG tour of the Debug fixture for visual before/after review.
/// Skipped unless the runner sets AGENT_INTERFACE_SCREENSHOT_DIR, which xcodebuild forwards
/// from TEST_RUNNER_AGENT_INTERFACE_SCREENSHOT_DIR. Run with .agents/tools/ios-screenshot-tour.sh.
final class ScreenshotTourTests: XCTestCase {
  private var directory: URL!

  override func setUpWithError() throws {
    let path = ProcessInfo.processInfo.environment["AGENT_INTERFACE_SCREENSHOT_DIR"] ?? ""
    try XCTSkipUnless(!path.isEmpty, "Set AGENT_INTERFACE_SCREENSHOT_DIR to capture the tour.")
    directory = URL(fileURLWithPath: path, isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    continueAfterFailure = false
  }

  func testScreenshotTour() throws {
    var app = launch()
    XCTAssertTrue(app.textFields["messageComposer"].waitForExistence(timeout: 15))

    goToAssistantList(app)
    XCTAssertTrue(app.buttons["bot.ranch"].waitForExistence(timeout: 5))
    try capture("01-home")

    for (identifier, name, ready) in [
      ("openToday", "17-today", "todayOverview"), ("openGroups", "18-group-chats", "New group"),
      ("openDiscovery", "19-search", "Search answers, files, or a topic"),
    ] {
      app.buttons[identifier].tap()
      XCTAssertTrue(app.descendants(matching: .any)[ready].waitForExistence(timeout: 10))
      try capture(name)
      goToAssistantList(app)
    }

    openPreferences(app)
    scrollUntilHittable(app, app.descendants(matching: .any)["sharedComputer"])
    try capture("06b-shared-computer")
    app.buttons["Close"].tap()

    app.buttons["bot.ranch"].tap()
    XCTAssertTrue(app.buttons["Configure Ranch hand"].waitForExistence(timeout: 5))
    try capture("02-conversation")

    app.buttons["Configure Ranch hand"].tap()
    XCTAssertTrue(app.buttons["Avatar"].waitForExistence(timeout: 5))
    app.buttons["Avatar"].tap()
    XCTAssertTrue(app.buttons["previewState.idle"].waitForExistence(timeout: 5))
    try capture("04-avatar-editor")
    app.buttons["previewState.done"].tap()
    app.swipeUp()
    try capture("04b-avatar-editor-tiles")
    scrollUntilHittable(app, app.buttons["Save avatar"])
    try capture("05-avatar-editor-controls")
    scrollUntilHittable(app, app.buttons["Mascot"], up: false)
    app.buttons["Mascot"].tap()
    XCTAssertTrue(app.buttons["avatarTile.family.bear"].waitForExistence(timeout: 5))
    try capture("05b-avatar-editor-mascot")
    app.buttons["Close"].tap()

    openPreferences(app)
    try capture("06-preferences")

    openPreferencesLink(app, "Integrations")
    XCTAssertTrue(app.staticTexts["Google Workspace"].waitForExistence(timeout: 10))
    try capture("07-integrations")
    back(app, from: "Integrations")

    openPreferencesLink(app, "Hermes updates")
    XCTAssertTrue(app.buttons["checkHermesUpdate"].waitForExistence(timeout: 10))
    try capture("08-hermes-updates")
    back(app, from: "Hermes updates")

    openPreferencesLink(app, "Avatar specimen")
    XCTAssertTrue(app.switches["Reduced motion"].waitForExistence(timeout: 5))
    try capture("09-specimen-geometric")
    app.swipeUp()
    try capture("10-specimen-shapes")
    app.swipeDown()
    app.buttons["Mascot"].tap()
    try capture("11-specimen-mascot")
    app.buttons["Portrait"].tap()
    try capture("12-specimen-portrait")
    app.buttons["Geometric"].tap()
    app.switches["Reduced motion"].tap()
    try capture("13-specimen-reduced-motion")
    let matrix = app.descendants(matching: .any)["avatarMatrix"]
    scrollUntilHittable(app, matrix)
    // Short drags bring the whole matrix just below the navigation bar.
    for _ in 0..<12 where matrix.frame.minY > 160 {
      app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.7))
        .press(
          forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.6)),
          withVelocity: .slow, thenHoldForDuration: 0.3)
    }
    try capture("16-specimen-matrix")
    back(app, from: "Avatar specimen")

    // Dark mode through the app's own theme preference, which drives preferredColorScheme.
    // The picker's element type varies by iOS release; its label stays stable.
    // Swiping down at the top of the sheet dismisses it, so reopen Preferences at the top instead.
    app.buttons["Close"].tap()
    openPreferences(app)
    let theme = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", "Theme")).firstMatch
    XCTAssertTrue(theme.waitForExistence(timeout: 5) && theme.isHittable, app.debugDescription)
    theme.tap()
    let dark = app.descendants(matching: .any).matching(NSPredicate(
      format: "label == %@ AND elementType IN %@", "Dark",
      [XCUIElement.ElementType.button.rawValue, XCUIElement.ElementType.menuItem.rawValue])).firstMatch
    XCTAssertTrue(dark.waitForExistence(timeout: 5), app.debugDescription)
    dark.tap()
    app.buttons["Save"].tap()
    XCTAssertTrue(app.buttons["Save"].waitForExistence(timeout: 5))
    app.buttons["Close"].tap()
    goToAssistantList(app)
    XCTAssertTrue(app.buttons["bot.ranch"].waitForExistence(timeout: 5))
    try capture("14-home-dark")
    app.buttons["bot.ranch"].tap()
    XCTAssertTrue(app.buttons["Configure Ranch hand"].waitForExistence(timeout: 5))
    try capture("15-conversation-dark")

    // A fresh launch with the working fixture shows the activity avatar and live activity row.
    app.terminate()
    app = launch(liveActivity: true)
    XCTAssertTrue(app.staticTexts["Ranch hand is working"].waitForExistence(timeout: 15))
    try capture("03-conversation-working")
    goToAssistantList(app)
    XCTAssertTrue(app.buttons["bot.ranch"].waitForExistence(timeout: 5))
    try capture("03b-home-working")

    // Without the fixture, a reset launch shows the first-run connection screen.
    app.terminate()
    let fresh = XCUIApplication()
    fresh.launchEnvironment["AGENT_INTERFACE_UI_RESET"] = "1"
    fresh.launch()
    XCTAssertTrue(fresh.textFields["serverAddress"].waitForExistence(timeout: 15))
    try capture("00-sign-in")
  }

  private func launch(liveActivity: Bool = false) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchEnvironment["AGENT_INTERFACE_UI_RESET"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_FIXTURE"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_SCOPE"] = UUID().uuidString.lowercased()
    if liveActivity { app.launchEnvironment["AGENT_INTERFACE_UI_LIVE_ACTIVITY"] = "1" }
    app.launch()
    return app
  }

  private func goToAssistantList(_ app: XCUIApplication) {
    if app.buttons["Your preferences"].exists { return }
    let back = app.navigationBars.buttons.matching(identifier: "Your assistants").firstMatch
    if back.exists { back.tap() } else { app.navigationBars.buttons.firstMatch.tap() }
    XCTAssertTrue(app.buttons["Your preferences"].waitForExistence(timeout: 5))
  }

  private func openPreferences(_ app: XCUIApplication) {
    goToAssistantList(app)
    app.buttons["Your preferences"].tap()
    XCTAssertTrue(app.buttons["Save"].waitForExistence(timeout: 5))
  }

  private func openPreferencesLink(_ app: XCUIApplication, _ title: String) {
    let link = app.buttons[title]
    scrollUntilHittable(app, link)
    link.tap()
    XCTAssertTrue(app.navigationBars[title].waitForExistence(timeout: 5))
  }

  private func back(_ app: XCUIApplication, from title: String) {
    app.navigationBars[title].buttons.firstMatch.tap()
    XCTAssertTrue(app.navigationBars["Your preferences"].waitForExistence(timeout: 5))
  }

  private func scrollUntilHittable(_ app: XCUIApplication, _ element: XCUIElement, up: Bool = true) {
    for _ in 0..<8 {
      if element.exists && element.isHittable { return }
      if up { app.swipeUp() } else { app.swipeDown() }
    }
    XCTAssertTrue(element.isHittable, "\(element) never became hittable")
  }

  /// Waits for transitions to settle, then writes the full-screen PNG and attaches it to the result.
  private func capture(_ name: String) throws {
    Thread.sleep(forTimeInterval: 1.0)
    let screenshot = XCUIScreen.main.screenshot()
    try screenshot.pngRepresentation.write(to: directory.appendingPathComponent("\(name).png"))
    let attachment = XCTAttachment(screenshot: screenshot)
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }
}
