import XCTest

/// The chat shell around the transcript: prompt recall, the status dock, home's undo, live search
/// hits, group chats, the native desktop and the quick switcher. Debug fixtures stand in for the
/// server; they establish native behavior, not Hermes or a real desktop.
@MainActor final class ShellFlowTests: XCTestCase {
  override func setUp() { continueAfterFailure = false }
  private func launch(_ switches: [String] = [], home: Bool = false) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchEnvironment["AGENT_INTERFACE_UI_FIXTURE"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_RESET"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_SCOPE"] = UUID().uuidString.lowercased()
    if home { app.launchEnvironment["AGENT_INTERFACE_UI_HOME"] = "1" }
    for name in switches { app.launchEnvironment["AGENT_INTERFACE_UI_" + name] = "1" }
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
  private func openHome(_ app: XCUIApplication) {
    if app.buttons["openSettings"].waitForExistence(timeout: 5) { return }
    app.navigationBars.buttons.firstMatch.tapWhenReady()
    XCTAssertTrue(app.buttons["openSettings"].waitForExistence(timeout: 10), app.debugDescription)
  }

  func testUpArrowRecallsOwnMessagesNewestFirstAndDownRestoresTheEmptyDraft() throws {
    let app = launch(["RECALL"])
    let composer = app.textViews["messageComposer"]
    XCTAssertTrue(composer.waitForExistence(timeout: 15), app.debugDescription)
    XCTAssertTrue(app.staticTexts["Garden watered."].waitForExistence(timeout: 10))
    composer.tapWhenReady()
    XCTAssertTrue(composer.waitForKeyboardFocus())
    app.typeKey(.upArrow, modifierFlags: [])
    XCTAssertTrue(composer.wait(until: "value == %@", "Fixture second note: water the garden"), "\(composer.value ?? "")")
    app.typeKey(.upArrow, modifierFlags: [])
    // Another member's message in this shared chat is skipped.
    XCTAssertTrue(composer.wait(until: "value == %@", "Fixture first note: check the hay"), "\(composer.value ?? "")")
    try capture("01-recall")
    app.typeKey(.downArrow, modifierFlags: [])
    XCTAssertTrue(composer.wait(until: "value == %@", "Fixture second note: water the garden"), "\(composer.value ?? "")")
    app.typeKey(.downArrow, modifierFlags: [])
    XCTAssertTrue(composer.wait(until: "value == nil OR value == %@", ""), "Down past the newest restores the empty draft: \(composer.value ?? "")")
    // A typed draft keeps Up for the cursor.
    composer.typeWhenFocused("Keep this")
    app.typeKey(.upArrow, modifierFlags: [])
    XCTAssertTrue(composer.wait(until: "value == %@", "Keep this"), "\(composer.value ?? "")")
  }

  func testDockCountsWaitingDecisionsAndOffersReview() throws {
    let app = launch(["QUESTION"])
    let dock = app.descendants(matching: .any)["dockDecisions"]
    XCTAssertTrue(dock.waitForExistence(timeout: 15), app.debugDescription)
    XCTAssertTrue(app.staticTexts["1 decision waiting"].exists)
    try capture("02-dock-decisions")
    app.buttons["reviewDecisions"].tapWhenReady()
    XCTAssertTrue(app.staticTexts["Which plan?"].waitForExistence(timeout: 5))
  }

  func testPinningFromHomeShowsUndoThatPutsItBack() throws {
    let app = launch(home: true)
    let row = app.buttons["bot.kitchen"]
    XCTAssertTrue(row.waitForExistence(timeout: 15), app.debugDescription)
    row.press(forDuration: 1.0)
    app.buttons["Pin to top"].tapWhenReady()
    let toast = app.descendants(matching: .any)["undoToast"]
    XCTAssertTrue(toast.waitForExistence(timeout: 5), app.debugDescription)
    XCTAssertTrue(app.staticTexts["Pinned Kitchen companion"].exists)
    try capture("03-undo-toast")
    app.buttons["undoToastAction"].tapWhenReady()
    XCTAssertTrue(toast.waitForDisappearance(timeout: 5))
    app.buttons["bot.kitchen"].press(forDuration: 1.0)
    XCTAssertTrue(app.buttons["Pin to top"].waitForExistence(timeout: 5), "Undo unpinned it again")
    app.buttons["Pin to top"].tapWhenReady()
    // Left alone, the toast goes after five seconds and the pin stays.
    XCTAssertTrue(app.descendants(matching: .any)["undoToast"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.descendants(matching: .any)["undoToast"].waitForDisappearance(timeout: 12))
    app.buttons["bot.kitchen"].press(forDuration: 1.0)
    XCTAssertTrue(app.buttons["Unpin"].waitForExistence(timeout: 5), app.debugDescription)
  }

  func testSearchRunsAsYouTypeAndOpensACurrentHitInTheLiveChat() throws {
    let app = launch(home: true)
    app.buttons["openDiscovery"].tapWhenReady(timeout: 15)
    let field = app.textFields["Search conversations"]
    XCTAssertTrue(field.waitForExistence(timeout: 5))
    // No Search tap: results follow typing.
    field.typeWhenFocused("house")
    let live = app.buttons["nativeSearchResult-ranch-canonical"]
    XCTAssertTrue(live.waitForExistence(timeout: 10), app.debugDescription)
    try capture("04-search-live")
    live.tapWhenReady()
    XCTAssertTrue(app.chatHeader("Ranch hand").waitForExistence(timeout: 10), "The live conversation opens, not a read-only history")
    XCTAssertTrue(app.textViews["messageComposer"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.buttons["Back to results"].exists)
  }

  func testGroupChatNamesSendersSuggestsMentionsAndUpdatesLive() throws {
    let app = launch(["GROUP"], home: true)
    app.buttons["openGroups"].tapWhenReady(timeout: 15)
    app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Supper planning")).firstMatch.tapWhenReady()
    XCTAssertTrue(app.staticTexts["Second test member"].waitForExistence(timeout: 10), app.debugDescription)
    let composer = app.descendants(matching: .any).matching(identifier: "groupComposer").firstMatch
    composer.typeWhenFocused("Ask @kit")
    let mention = app.buttons["mention.kitchen"]
    XCTAssertTrue(mention.waitForExistence(timeout: 5), app.debugDescription)
    try capture("05-group-mention")
    mention.tapWhenReady()
    XCTAssertTrue(composer.wait(until: "value == %@", "Ask @kitchen "), "\(composer.value ?? "")")
    composer.typeWhenFocused("to check the pantry")
    app.buttons["Send to group"].tapWhenReady()
    XCTAssertTrue(app.staticTexts["Local test member"].waitForExistence(timeout: 10), "Your message names you")
    // The reply arrives by the stream's notice, well before the 30-second fallback poll.
    XCTAssertTrue(app.staticTexts["Fixture live reply: the smoker is free Sunday."].waitForExistence(timeout: 15), app.debugDescription)
    try capture("06-group-live")
  }

  func testComputerOpensInTheAppAndTakesOverThenHandsBack() throws {
    let app = launch(home: true)
    app.buttons["openSettings"].tapWhenReady(timeout: 15)
    let row = app.descendants(matching: .any)["sharedComputer"]
    XCTAssertTrue(row.waitForExistence(timeout: 10))
    row.tapWhenReady()
    let status = app.descendants(matching: .any)["computerStatus"]
    XCTAssertTrue(status.waitForExistence(timeout: 10), app.debugDescription)
    XCTAssertTrue(status.wait(until: "label CONTAINS %@", "Ranch hand is using the computer"), status.label)
    let control = app.buttons["computerControl"]
    XCTAssertTrue(control.wait(until: "enabled == true", timeout: 15), "The fixture viewer connects: \(app.debugDescription)")
    XCTAssertEqual(control.label, "Take over")
    XCTAssertTrue(app.links["computerTerminal"].exists || app.buttons["computerTerminal"].exists, "The terminal stays a Safari link")
    try capture("07-computer-watching")
    control.tap()
    XCTAssertTrue(control.wait(until: "label == %@", "Hand back"), control.label)
    XCTAssertTrue(status.wait(until: "label CONTAINS %@", "You have control"), status.label)
    try capture("08-computer-control")
    control.tapWhenReady()
    XCTAssertTrue(control.wait(until: "label == %@", "Take over"), control.label)
  }

  func testCommandKOpensTheQuickSwitcherAndGoesWhereChosen() throws {
    let app = launch(home: true)
    XCTAssertTrue(app.buttons["openSettings"].waitForExistence(timeout: 15))
    let field = app.textFields["quickSwitcherField"]
    app.shortcut("k", shows: field)
    XCTAssertTrue(field.waitForKeyboardFocus(), "The field is ready to type")
    field.typeText("kitch")
    XCTAssertTrue(app.buttons["quickSwitch.kitchen"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.buttons["quickSwitch.ranch"].exists)
    try capture("09-quick-switcher")
    field.typeText("\n")
    XCTAssertTrue(app.chatHeader("Kitchen companion").waitForExistence(timeout: 10), app.debugDescription)
    app.shortcut("k", shows: field)
    field.typeText("today\n")
    XCTAssertTrue(app.buttons["Mark caught up"].waitForExistence(timeout: 10) || app.navigationBars["Today"].exists, app.debugDescription)
  }

  func testAssistantCardShowsRoleModelAndLastActivity() throws {
    let app = launch()
    app.openBotProfile("Ranch hand")
    XCTAssertTrue(app.staticTexts["Everyday household help"].exists)
    XCTAssertTrue(app.descendants(matching: .any)["profileModel"].exists)
    XCTAssertTrue(app.descendants(matching: .any)["profileLastActivity"].exists)
    XCTAssertTrue(app.buttons["profileFind"].exists)
    try capture("10-assistant-card")
    app.buttons["profileFind"].tapWhenReady()
    XCTAssertTrue(app.textFields["findConversation"].waitForExistence(timeout: 5))
  }
}
