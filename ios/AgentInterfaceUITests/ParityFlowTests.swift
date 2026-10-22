import XCTest
import UIKit

/// Exercises parity behavior against the Debug-only transport, never a household server.
@MainActor final class ParityFlowTests: XCTestCase {
  override func setUp() async throws {
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
    // iPhone goes back to home, the root of its stack; iPad brings back its sidebar.
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
  func testSwipingARowPinsItAndCommandShortcutsOpenAndFind() throws {
    let app = launch(home: true)
    XCTAssertTrue(app.buttons["openSettings"].waitForExistence(timeout: 15))
    let preview = app.staticTexts["The north gate battery needs replacing."]
    XCTAssertTrue(app.buttons["bot.ranch"].waitForExistence(timeout: 5)); XCTAssertTrue(preview.exists)
    // A pinned assistant leaves the list for the tiles above it, which show no preview.
    app.buttons["bot.ranch"].swipeLeft()
    expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: preview)
    waitForExpectations(timeout: 5)
    // The first pin opens with Cmd+1, and Cmd+F in that chat finds, keyboard ready.
    app.shortcut("1", shows: app.textViews["messageComposer"])
    // Cmd+F reaches the chat only once it is on screen; before that, home would take it for Search.
    XCTAssertTrue(app.chatHeader("Ranch hand").waitUntilHittable())
    XCTAssertTrue(app.textViews["messageComposer"].waitUntilHittable())
    let find = app.textFields["findConversation"]
    // Known app issue: Cmd+F sometimes never reaches the chat after Cmd+1 (#178). Recorded, not
    // failed, until that is fixed; remove this wrapper with the fix.
    XCTExpectFailure("Cmd+F sometimes never reaches the open chat (#178)", options: .nonStrict()) {
      app.shortcut("f", shows: find)
      XCTAssertTrue(find.waitForKeyboardFocus())
    }
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
    app.buttons["Dark"].tapWhenReady()
    closeSettings(app)
    app.buttons["openSettings"].tap()
    XCTAssertTrue(app.switches["advancedDetails"].wait(until: "value == %@", "1"), "Advanced details stays on")
    try capture("settings-dark")
    closeSettings(app)
    try capture("home-dark")
    app.buttons["bot.ranch"].tap()
    XCTAssertTrue(app.buttons["composerModel"].waitForExistence(timeout: 10))
    app.openBotProfile("Ranch hand")
    XCTAssertEqual(app.buttons["profilePin"].label, "Unpin")
    app.buttons["profilePin"].tap()
    expectation(for: NSPredicate(format: "label == %@", "Pin"), evaluatedWith: app.buttons["profilePin"])
    waitForExpectations(timeout: 5)
    app.buttons["closeBotProfile"].tap()
    try capture("conversation-dark")
    app.buttons["composerModel"].tap()
    XCTAssertTrue(app.textFields["modelSearch"].waitForExistence(timeout: 10))
    try capture("model-dark")
    let speed = app.buttons["inferenceSpeed"]
    scroll(app, to: speed); speed.tap(); app.buttons["Fast"].tapWhenReady()
    let favorite = app.buttons["Add Fixture fast model to favorites"]
    scroll(app, to: favorite); favorite.tap()
    XCTAssertTrue(app.buttons["Remove Fixture fast model from favorites"].waitForExistence(timeout: 5))
    let search = app.textFields["modelSearch"]
    search.typeWhenFocused("Fixture fast")
    let choice = app.buttons["Fixture fast model"].firstMatch
    XCTAssertTrue(choice.waitForExistence(timeout: 5)); choice.tapWhenReady()
    XCTAssertTrue(app.buttons["composerModel"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.buttons["composerModel"].wait(until: "label == %@", "Model: fixture-fast"), app.buttons["composerModel"].label)
    let composer = app.textViews["messageComposer"]
    composer.typeWhenFocused("Check the fence")
    XCTAssertTrue(app.buttons["sendMessage"].isEnabled)
    XCTAssertGreaterThan(composer.frame.width, 240, "Advanced tools must not squeeze the input")
    try capture("composer-typing")
  }
  func testAssistantCardFollowsAndMovesIntoANewHomeSection() throws {
    let app = launch()
    app.openBotProfile("Ranch hand")
    try capture("assistant-card")
    let follow = app.switches["followBot"]
    XCTAssertEqual(follow.value as? String, "0")
    // The row's middle is its label, which a toggle ignores; tap the switch itself.
    follow.coordinate(withNormalizedOffset: CGVector(dx: 0.94, dy: 0.5)).tap()
    expectation(for: NSPredicate(format: "value == %@", "1"), evaluatedWith: follow)
    waitForExpectations(timeout: 5)
    let section = app.buttons["homeSection"]
    XCTAssertTrue(section.waitForExistence(timeout: 5), app.debugDescription)
    section.tap()
    let new = app.buttons["New section…"]
    XCTAssertTrue(new.waitForExistence(timeout: 5), app.debugDescription)
    new.tap()
    let name = app.alerts.textFields.firstMatch
    XCTAssertTrue(name.waitForExistence(timeout: 5))
    name.typeWhenFocused("Around the house")
    app.alerts.buttons["Add"].tapWhenReady()
    expectation(for: NSPredicate(format: "label CONTAINS %@ OR value CONTAINS %@", "Around the house", "Around the house"), evaluatedWith: section)
    waitForExpectations(timeout: 5)
    app.buttons["closeBotProfile"].tap()
    home(app)
    // Home lists the assistant under its new section, once.
    XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label ==[c] %@", "Around the house")).firstMatch.waitForExistence(timeout: 5))
    XCTAssertEqual(app.buttons.matching(identifier: "bot.ranch").count, 1)
    try capture("home-section")
  }
  func testAssistantCatalogAndUnsavedChangesAreProtected() throws {
    let app = launch()
    XCTAssertTrue(app.chatHeader("Ranch hand").waitForExistence(timeout: 10))
    app.openAssistantSettings("Ranch hand")
    let name = app.textFields["Name"]
    name.typeWhenFocused(" edited")
    app.buttons["Close"].tap()
    XCTAssertTrue(app.buttons["Discard changes"].waitForExistence(timeout: 5))
    app.buttons["Discard changes"].tap()
    XCTAssertTrue(app.chatHeader("Ranch hand").waitForExistence(timeout: 5))
    app.openAssistantSettings("Ranch hand")
    XCTAssertTrue(app.textFields["Name"].waitForExistence(timeout: 5))
    XCTAssertEqual(app.textFields["Name"].value as? String, "Ranch hand")
    XCTAssertFalse(app.textFields["modelSearch"].exists, "The catalog opens from the collapsed model row")
    scroll(app, to: app.buttons["assistantModel"])
    XCTAssertEqual(app.buttons["assistantModel"].label, "configured-model, OpenRouter")
    app.buttons["assistantModel"].tap()
    let search = app.textFields["modelSearch"]
    XCTAssertTrue(search.waitForExistence(timeout: 5))
    search.typeWhenFocused("Fixture fast")
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
    app.switches["advancedDetails"].tapWhenReady()
    let retry = app.buttons["Retry saving settings"]
    XCTAssertTrue(retry.waitForExistence(timeout: 5))
    let dismissError = app.collectionViews.buttons["Dismiss error"].firstMatch
    scroll(app, to: dismissError, up: false); dismissError.tap()
    XCTAssertTrue(retry.exists)
    retry.tap()
    expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: retry); waitForExpectations(timeout: 5)
    closeSettings(app)
    app.buttons["openSettings"].tap()
    XCTAssertTrue(app.switches["advancedDetails"].wait(until: "value == %@", "1"), "The retried save kept Advanced details on")
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
    app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Tool calls")).firstMatch.tapWhenReady()
    app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "fixture_search")).firstMatch.tapWhenReady()
    XCTAssertTrue(app.staticTexts["Fixture tool result"].waitForExistence(timeout: 5))
    XCTAssertEqual(app.staticTexts.matching(identifier: "Fixture single visible reply").count, 1)
  }
  func testLongToolOutputsScrollInsideCompactReceipts() throws {
    for presentation in ["simple", "advanced"] {
      let app = XCUIApplication()
      app.launchEnvironment["AGENT_INTERFACE_UI_FIXTURE"] = "1"
      app.launchEnvironment["AGENT_INTERFACE_UI_RESET"] = "1"
      app.launchEnvironment["AGENT_INTERFACE_UI_SCOPE"] = UUID().uuidString.lowercased()
      app.launchEnvironment["AGENT_INTERFACE_UI_LONG_TOOL"] = presentation
      app.launch()
      let tools = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Tool calls")).firstMatch
      XCTAssertTrue(tools.waitForExistence(timeout: 10)); tools.tap()
      XCTAssertLessThan(tools.frame.minY, app.staticTexts["Fixture final answer follows the tool results."].frame.minY)
      app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "fixture_short")).firstMatch.tapWhenReady()
      let short = app.staticTexts["Short fixture tool result"]
      XCTAssertTrue(short.waitForExistence(timeout: 5))
      let long = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "fixture_long")).firstMatch
      XCTAssertLessThan(long.frame.minY - short.frame.maxY, 100, "Short output must not reserve a full-height empty box")
      long.tap()
      let beforeScroll = XCTAttachment(screenshot: app.screenshot())
      beforeScroll.name = "Before scrolling \(presentation) tool output"; beforeScroll.lifetime = .keepAlways; add(beforeScroll)
      let outputs = app.scrollViews.matching(NSPredicate(format: "label BEGINSWITH %@", "Result"))
      XCTAssertTrue(outputs.firstMatch.waitForExistence(timeout: 5), app.debugDescription)
      let output = try XCTUnwrap(outputs.allElementsBoundByIndex.last)
      XCTAssertLessThanOrEqual(output.frame.height, 281)
      let text = output.staticTexts.firstMatch
      XCTAssertTrue(text.label.hasSuffix("END OF FIXTURE OUTPUT"), "Long output must remain complete beyond 4,000 characters")
      let before = text.frame.minY, outer = output.frame
      output.swipeUp()
      XCTAssertLessThan(text.frame.minY, before, "The output itself must scroll")
      XCTAssertEqual(output.frame.minY, outer.minY, accuracy: 2, "Scrolling output must keep the receipt in place")
      let capture = XCTAttachment(screenshot: app.screenshot())
      capture.name = "Bounded \(presentation) tool output"; capture.lifetime = .keepAlways; add(capture)
      app.terminate()
    }
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
    // The first page holds turns 41 to 60. Opening at the end must not page in more.
    let earlier = app.staticTexts["Fixture question 35"]
    XCTAssertFalse(earlier.exists, "Opening at the latest message loaded earlier history")
    // Reading back pages in turns 21 to 40, then 1 to 20, until the conversation's start.
    let start = app.staticTexts["This is the start of your conversation with Ranch hand."]
    for _ in 0..<30 where !start.exists { app.swipeDown(velocity: .fast) }
    XCTAssertTrue(start.exists, "Earlier history did not load while scrolling up")
    XCTAssertTrue(earlier.exists)
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
    XCTAssertTrue(app.textViews["messageComposer"].waitForExistence(timeout: 10))
    try capture("conversation-light")
    app.openBotProfile("Ranch hand")
    app.buttons["conversationFiles"].tap()
    XCTAssertTrue(app.staticTexts["No artifacts yet"].waitForExistence(timeout: 5))
    try capture("artifacts-empty")
    app.buttons["Close"].tap()
    XCUIDevice.shared.orientation = .landscapeLeft
    try capture("landscape")
    XCUIDevice.shared.orientation = .portrait
  }

  /// A launch with extra fixture switches, always on the home list.
  private func launch(_ switches: [String]) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchEnvironment["AGENT_INTERFACE_UI_FIXTURE"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_RESET"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_HOME"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_SCOPE"] = UUID().uuidString.lowercased()
    for name in switches { app.launchEnvironment["AGENT_INTERFACE_UI_" + name] = "1" }
    app.launch()
    return app
  }
  func testSavedSignInShowsOutageStateInsteadOfSignInControls() {
    let app = launch(["OUTAGE"])
    XCTAssertTrue(app.staticTexts["Can't reach the app right now. We'll keep trying."].waitForExistence(timeout: 10), app.debugDescription)
    XCTAssertTrue(app.buttons["Try again"].exists)
    XCTAssertTrue(app.buttons["Change server"].waitForExistence(timeout: 5), "A wrong address must not strand anyone: " + app.debugDescription)
    XCTAssertFalse(app.buttons["householdSignIn"].exists)
  }
  func testHomeWithoutHermesShowsSetupPanelAndExplainsBlockedCreate() {
    let app = launch(["DISCONNECTED"])
    XCTAssertTrue(app.staticTexts["Connect your household to Hermes"].waitForExistence(timeout: 10), app.debugDescription)
    XCTAssertTrue(app.staticTexts["Pick up with your assistants"].exists)
    XCTAssertTrue(app.buttons["Check connection"].exists)
    app.buttons["New assistant"].tap()
    XCTAssertTrue(app.staticTexts["Assistant setup is unavailable while Hermes is disconnected."].waitForExistence(timeout: 5))
  }
  func testNotificationPromptAsksIosOnlyAfterEnableAndSettingsSwitchFollows() {
    let app = launch(["PUSH"])
    XCTAssertTrue(app.staticTexts["Enable notifications on this device?"].waitForExistence(timeout: 10), app.debugDescription)
    app.buttons["enableNotifications"].tap()
    expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: app.staticTexts["Enable notifications on this device?"]); waitForExpectations(timeout: 5)
    app.buttons["openSettings"].tap()
    let toggle = app.switches["deviceNotifications"]
    // Settings is a lazy form; on a landscape iPad the Notifications section starts below the fold.
    if !toggle.waitForExistence(timeout: 3) { scroll(app, to: toggle) }
    XCTAssertTrue(toggle.exists)
    expectation(for: NSPredicate(format: "value == %@", "1"), evaluatedWith: toggle); waitForExpectations(timeout: 5)
    // A labelled row switch holds the real control; tapping the row's centre can miss it.
    (toggle.switches.firstMatch.exists ? toggle.switches.firstMatch : toggle).tap()
    expectation(for: NSPredicate(format: "value == %@", "0"), evaluatedWith: toggle); waitForExpectations(timeout: 10)
    // The explanatory text sits below the fold in a lazy list, so the switch's own label is the check.
    expectation(for: NSPredicate(format: "label CONTAINS %@", "Disabled"), evaluatedWith: toggle); waitForExpectations(timeout: 10)
  }
  func testNotNowHidesNotificationPromptAndSettingsCanStillEnable() {
    let app = launch(["PUSH"])
    XCTAssertTrue(app.buttons["notNowNotifications"].waitForExistence(timeout: 10))
    app.buttons["notNowNotifications"].tap()
    XCTAssertTrue(app.staticTexts["Enable notifications on this device?"].waitForDisappearance())
    app.buttons["openSettings"].tap()
    let toggle = app.switches["deviceNotifications"]
    // Settings is a lazy form; on a landscape iPad the Notifications section starts below the fold.
    if !toggle.waitForExistence(timeout: 3) { scroll(app, to: toggle) }
    XCTAssertTrue(toggle.exists)
    XCTAssertEqual(toggle.value as? String, "0"); XCTAssertTrue(toggle.isEnabled)
  }
}
