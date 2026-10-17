import XCTest
import UIKit

/// Exercises parity behavior against the Debug-only transport, never a household server.
final class ParityFlowTests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
    if UIDevice.current.userInterfaceIdiom == .pad { XCUIDevice.shared.orientation = .landscapeLeft }
  }
  private func launch(home: Bool = false) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchEnvironment["AGENT_INTERFACE_UI_FIXTURE"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_RESET"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_SCOPE"] = UUID().uuidString.lowercased()
    if home { app.launchEnvironment["AGENT_INTERFACE_UI_HOME"] = "1" }
    app.launch()
    return app
  }
  private func home(_ app: XCUIApplication) {
    if app.buttons["openSettings"].isHittable { return }
    if app.buttons["Show Sidebar"].exists { app.buttons["Show Sidebar"].tap() }
    else { app.navigationBars.buttons.firstMatch.tap() }
    XCTAssertTrue(app.buttons["openSettings"].waitForExistence(timeout: 5))
  }
  private func capture(_ name: String) throws {
    let screenshot = XCUIScreen.main.screenshot()
    let attachment = XCTAttachment(screenshot: screenshot); attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    if let directory = ProcessInfo.processInfo.environment["AGENT_INTERFACE_SCREENSHOT_DIR"] {
      try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
      try screenshot.pngRepresentation.write(to: URL(fileURLWithPath: directory).appendingPathComponent(name + ".png"))
    }
  }
  private func scroll(_ app: XCUIApplication, to element: XCUIElement, up: Bool = true) {
    let surface = app.collectionViews.firstMatch
    for _ in 0..<8 {
      if element.exists && element.isHittable { return }
      if surface.exists { if up { surface.swipeUp() } else { surface.swipeDown() } }
      else { if up { app.swipeUp() } else { app.swipeDown() } }
    }
    XCTAssertTrue(element.isHittable, app.debugDescription)
  }
  private func closeSettings(_ app: XCUIApplication) {
    let close = app.buttons["Close"]
    expectation(for: NSPredicate(format: "enabled == true"), evaluatedWith: close)
    waitForExpectations(timeout: 10)
    close.tap()
  }
  func testHomePinsSettingsAutosaveAndAdvancedComposer() throws {
    let app = launch(home: true)
    XCTAssertTrue(app.buttons["openSettings"].waitForExistence(timeout: 15))
    XCTAssertTrue(app.buttons["bot.ranch"].exists)
    XCTAssertTrue(app.staticTexts["The north gate battery needs replacing."].exists)
    try capture("home-light")
    app.buttons["bot.ranch"].press(forDuration: 1.0)
    let pin = app.buttons["Pin to top"]
    expectation(for: NSPredicate(format: "hittable == true"), evaluatedWith: pin)
    waitForExpectations(timeout: 5)
    pin.tap()
    expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: app.staticTexts["The north gate battery needs replacing."])
    waitForExpectations(timeout: 5)
    try capture("home-pinned")
    app.buttons["openSettings"].tap()
    XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 5))
    try capture("settings-light")
    app.switches["advancedDetails"].tap()
    expectation(for: NSPredicate(format: "value == %@", "1"), evaluatedWith: app.switches["advancedDetails"])
    waitForExpectations(timeout: 5)
    let appearance = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Appearance")).firstMatch
    scroll(app, to: appearance); appearance.tap()
    app.buttons["Dark"].tap()
    closeSettings(app)
    app.buttons["openSettings"].tap()
    XCTAssertEqual(app.switches["advancedDetails"].value as? String, "1")
    try capture("settings-dark")
    closeSettings(app)
    try capture("home-dark")
    app.buttons["bot.ranch"].tap()
    XCTAssertTrue(app.buttons["composerModel"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.buttons["Unpin assistant"].exists)
    try capture("conversation-dark")
    app.buttons["composerModel"].tap()
    XCTAssertTrue(app.textFields["modelSearch"].waitForExistence(timeout: 10))
    try capture("model-dark")
    let speed = app.buttons["inferenceSpeed"]
    scroll(app, to: speed); speed.tap(); app.buttons["Fast"].tap()
    let favorite = app.buttons["Add Fixture fast model to favorites"]
    scroll(app, to: favorite); favorite.tap()
    XCTAssertTrue(app.buttons["Remove Fixture fast model from favorites"].waitForExistence(timeout: 5))
    let search = app.textFields["modelSearch"]
    search.tap(); search.typeText("Fixture fast")
    let choice = app.buttons["Fixture fast model"].firstMatch
    XCTAssertTrue(choice.waitForExistence(timeout: 5)); choice.tap()
    XCTAssertTrue(app.buttons["composerModel"].waitForExistence(timeout: 10))
    XCTAssertEqual(app.buttons["composerModel"].label, "Model: fixture-fast")
    let composer = app.textFields["messageComposer"]
    composer.tap(); composer.typeText("Check the fence")
    XCTAssertTrue(app.buttons["sendMessage"].isEnabled)
    XCTAssertGreaterThan(composer.frame.width, 240, "Advanced tools must not squeeze the input")
    try capture("composer-typing")
  }
  func testAssistantCatalogAndUnsavedChangesAreProtected() throws {
    let app = launch()
    XCTAssertTrue(app.buttons["Configure Ranch hand"].waitForExistence(timeout: 10))
    app.buttons["Configure Ranch hand"].tap()
    let name = app.textFields["Name"]
    name.tap(); name.typeText(" edited")
    app.buttons["Close"].tap()
    XCTAssertTrue(app.buttons["Discard changes"].waitForExistence(timeout: 5))
    app.buttons["Discard changes"].tap()
    XCTAssertTrue(app.buttons["Configure Ranch hand"].waitForExistence(timeout: 5))
    app.buttons["Configure Ranch hand"].tap()
    XCTAssertTrue(app.textFields["Name"].waitForExistence(timeout: 5))
    XCTAssertEqual(app.textFields["Name"].value as? String, "Ranch hand")
    XCTAssertFalse(app.textFields["modelSearch"].exists, "The catalog opens from the collapsed model row")
    scroll(app, to: app.buttons["assistantModel"])
    XCTAssertEqual(app.buttons["assistantModel"].label, "configured-model, OpenRouter")
    app.buttons["assistantModel"].tap()
    let search = app.textFields["modelSearch"]
    XCTAssertTrue(search.waitForExistence(timeout: 5))
    search.tap(); search.typeText("Fixture fast")
    XCTAssertTrue(app.buttons["Fixture fast model"].waitForExistence(timeout: 5))
    try capture("assistant-model-catalog")
  }
  func testComputerRowReportsWhoHasControlAndDisablesWhenUnavailable() throws {
    for unavailable in [false, true] {
      let app = XCUIApplication()
      app.launchEnvironment["AGENT_INTERFACE_UI_FIXTURE"] = "1"
      app.launchEnvironment["AGENT_INTERFACE_UI_RESET"] = "1"
      app.launchEnvironment["AGENT_INTERFACE_UI_HOME"] = "1"
      app.launchEnvironment["AGENT_INTERFACE_UI_SCOPE"] = UUID().uuidString.lowercased()
      if unavailable { app.launchEnvironment["AGENT_INTERFACE_UI_COMPUTER_UNAVAILABLE"] = "1" }
      app.launch()
      XCTAssertTrue(app.buttons["openSettings"].waitForExistence(timeout: 10)); app.buttons["openSettings"].tap()
      let row = app.descendants(matching: .any)["sharedComputer"]
      XCTAssertTrue(row.waitForExistence(timeout: 10))
      let detail = unavailable ? "The fixture desktop is stopped." : "Ranch hand is using the computer"
      expectation(for: NSPredicate(format: "label CONTAINS %@", detail), evaluatedWith: row); waitForExpectations(timeout: 10)
      XCTAssertEqual(row.isEnabled, !unavailable)
      app.terminate()
    }
  }
  func testSettingsFailureCanRetryAfterDismissingTheError() throws {
    let app = XCUIApplication()
    app.launchEnvironment["AGENT_INTERFACE_UI_FIXTURE"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_RESET"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_HOME"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_SCOPE"] = UUID().uuidString.lowercased()
    app.launchEnvironment["AGENT_INTERFACE_UI_PREFERENCES_FAILURE"] = "1"
    app.launch()
    XCTAssertTrue(app.buttons["openSettings"].waitForExistence(timeout: 10)); app.buttons["openSettings"].tap()
    app.switches["advancedDetails"].tap()
    let retry = app.buttons["Retry saving settings"]
    XCTAssertTrue(retry.waitForExistence(timeout: 5))
    let dismissError = app.collectionViews.buttons["Dismiss error"].firstMatch
    scroll(app, to: dismissError, up: false); dismissError.tap()
    XCTAssertTrue(retry.exists)
    retry.tap()
    expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: retry); waitForExpectations(timeout: 5)
    closeSettings(app)
    app.buttons["openSettings"].tap()
    XCTAssertEqual(app.switches["advancedDetails"].value as? String, "1")
    try capture("settings-save-recovered")
  }
  func testMixedReplyShowsTextOnceAndToolOnlyInsideActivity() {
    let app = XCUIApplication()
    app.launchEnvironment["AGENT_INTERFACE_UI_FIXTURE"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_RESET"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_SCOPE"] = UUID().uuidString.lowercased()
    app.launchEnvironment["AGENT_INTERFACE_UI_MIXED_TOOL"] = "1"
    app.launch()
    let reply = app.staticTexts["Fixture single visible reply"]
    XCTAssertTrue(reply.waitForExistence(timeout: 10))
    XCTAssertEqual(app.staticTexts.matching(identifier: "Fixture single visible reply").count, 1)
    XCTAssertFalse(app.staticTexts["Fixture tool result"].exists)
    XCTAssertTrue(app.buttons["Fixture output.txt"].exists)
    XCTAssertFalse(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "fixture_file_tool")).firstMatch.exists)
    app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Tool calls")).firstMatch.tap()
    app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "fixture_search")).firstMatch.tap()
    XCTAssertTrue(app.staticTexts["Fixture tool result"].waitForExistence(timeout: 5))
    XCTAssertEqual(app.staticTexts.matching(identifier: "Fixture single visible reply").count, 1)
  }
  /// Like the web, a chat opens at its latest message, pages in earlier turns near the top, and
  /// the jump control returns to the end.
  func testLongChatOpensAtLatestPagesEarlierAndJumpsBack() {
    let app = XCUIApplication()
    app.launchEnvironment["AGENT_INTERFACE_UI_FIXTURE"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_RESET"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_SCOPE"] = UUID().uuidString.lowercased()
    app.launchEnvironment["AGENT_INTERFACE_UI_LONG_HISTORY"] = "1"
    app.launch()
    let latest = app.staticTexts["Fixture answer 60."]
    expectation(for: NSPredicate(format: "hittable == true"), evaluatedWith: latest)
    waitForExpectations(timeout: 10)
    let jump = app.buttons["Jump to latest"]
    XCTAssertFalse(jump.exists)
    // The first page holds turns 41 to 60; reading back past it loads turn 40 and earlier.
    let earlier = app.staticTexts["Fixture question 35"]
    for _ in 0..<40 where !earlier.exists { app.swipeDown(velocity: .fast) }
    XCTAssertTrue(earlier.exists, "Earlier history did not load while scrolling up")
    XCTAssertTrue(jump.waitForExistence(timeout: 5))
    jump.tap()
    expectation(for: NSPredicate(format: "hittable == true"), evaluatedWith: latest)
    expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: jump)
    waitForExpectations(timeout: 10)
  }
  func testTodayAndTabletLayout() throws {
    let app = launch(home: true)
    XCTAssertTrue(app.buttons["openToday"].waitForExistence(timeout: 10))
    app.buttons["openToday"].tap()
    XCTAssertTrue(app.staticTexts["Needs your attention"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["Since you were away"].exists)
    try capture("today")
    home(app)
    app.buttons["bot.ranch"].tap()
    XCTAssertTrue(app.textFields["messageComposer"].waitForExistence(timeout: 10))
    try capture("conversation-light")
    app.buttons["conversationFiles"].tap()
    XCTAssertTrue(app.staticTexts["No artifacts yet"].waitForExistence(timeout: 5))
    try capture("artifacts-empty")
    app.buttons["Close"].tap()
    XCUIDevice.shared.orientation = .landscapeLeft
    try capture("landscape")
    XCUIDevice.shared.orientation = .portrait
  }
}
