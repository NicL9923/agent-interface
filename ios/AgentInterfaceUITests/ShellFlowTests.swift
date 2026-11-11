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
    XCTAssertTrue(app.staticTexts["1 decision waiting"].waitForExistence(timeout: 15), app.debugDescription)
    XCTAssertTrue(app.descendants(matching: .any)["statusDock"].exists, "It sits in the dock above the composer")
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

  func testGroupRowsSitBesideAssistantsAndOpenLikeAConversation() throws {
    let app = launch(["GROUP"], home: true)
    let row = app.buttons["room.fixture-room"]
    XCTAssertTrue(row.waitForExistence(timeout: 15), app.debugDescription)
    XCTAssertTrue(app.buttons["bot.ranch"].exists, "Assistants and rooms share home")
    XCTAssertTrue(row.label.contains("Supper planning"), row.label)
    XCTAssertTrue(row.label.contains("Kitchen companion: Brisket, if the smoker is free."), "The row previews the last message and who said it: \(row.label)")
    XCTAssertFalse(app.buttons["openGroups"].exists, "There is no separate Group chats link")
    try capture("05a-home-with-group")
    row.tapWhenReady()
    XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "groupComposer").firstMatch.waitForExistence(timeout: 10), app.debugDescription)
    // Back returns to home, as from a conversation.
    let back = app.navigationBars.buttons.matching(identifier: "Your assistants").firstMatch
    if back.waitForExistence(timeout: 3) { back.tap(); XCTAssertTrue(row.waitForExistence(timeout: 5)) }
  }

  func testARoomAnotherMemberMadeAppearsOnHomeFromTheStreamNotice() throws {
    let app = launch(["GROUP", "GROUP_NOTICE"], home: true)
    XCTAssertTrue(app.buttons["room.fixture-room"].waitForExistence(timeout: 15), app.debugDescription)
    // The household stream's `groups` notice brings it, well before the 5-minute fallback poll.
    let added = app.buttons["room.fixture-notice-room"]
    XCTAssertTrue(added.waitForExistence(timeout: 15), app.debugDescription)
    XCTAssertTrue(added.label.contains("Garden crew"), added.label)
  }

  func testGroupChatNamesSendersSuggestsMentionsAndUpdatesLive() throws {
    let app = launch(["GROUP"], home: true)
    // The room is a row on home beside the assistants.
    app.buttons["room.fixture-room"].tapWhenReady(timeout: 15)
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
    // The group names your own message "You" and another member's by name, as the web's thread does.
    XCTAssertTrue(app.staticTexts["You"].waitForExistence(timeout: 10), "Your message says it is yours: \(app.debugDescription)")
    XCTAssertTrue(app.staticTexts["Ask @kitchen to check the pantry"].exists)
    XCTAssertFalse(app.staticTexts["Local test member"].exists, "Your own name is not shown on your own message")
    // The reply arrives by the stream's notice, well before the 30-second fallback poll.
    XCTAssertTrue(app.staticTexts["Fixture live reply: the smoker is free Sunday."].waitForExistence(timeout: 15), app.debugDescription)
    try capture("06-group-live")
  }

  func testGroupShowsWhoIsWorkingAndSavesItsPurposeFromSettings() throws {
    let app = launch(["GROUP", "GROUP_WORKING"], home: true)
    app.buttons["room.fixture-room"].tapWhenReady(timeout: 15)
    // Simple presentation names who works, without tools or rounds.
    let kitchen = app.descendants(matching: .any).matching(identifier: "groupActivity.kitchen").firstMatch
    XCTAssertTrue(kitchen.waitForExistence(timeout: 10), app.debugDescription)
    XCTAssertTrue(kitchen.label.contains("Kitchen companion is working..."), kitchen.label)
    XCTAssertFalse(app.staticTexts["Assistants are discussing…"].exists)
    // A routine's post reads as the routine, not as a household member.
    XCTAssertTrue(app.staticTexts["Morning brief"].waitForExistence(timeout: 5), app.debugDescription)
    XCTAssertTrue(app.staticTexts["Routine"].exists)
    try capture("06a-group-activity")
    app.buttons["groupSettings"].tapWhenReady()
    let purpose = app.descendants(matching: .any).matching(identifier: "groupPurpose").firstMatch
    purpose.typeWhenFocused("Plan Sunday supper")
    app.buttons["saveGroupSettings"].tapWhenReady()
    XCTAssertTrue(app.staticTexts["Plan Sunday supper"].waitForExistence(timeout: 10), "The saved purpose shows under the members: \(app.debugDescription)")
  }

  func testComputerOpensInTheAppAndTakesOverThenHandsBack() throws {
    let app = launch(home: true)
    app.openSettingsFromProfileMenu(timeout: 15)
    let row = app.descendants(matching: .any)["sharedComputer"]
    XCTAssertTrue(row.waitForExistence(timeout: 10))
    row.tapWhenReady()
    let status = app.descendants(matching: .any)["computerStatus"]
    XCTAssertTrue(status.waitForExistence(timeout: 10), app.debugDescription)
    XCTAssertTrue(status.wait(until: "label CONTAINS %@", "Ranch hand is using the computer"), status.label)
    let control = app.buttons["computerControl"]
    XCTAssertTrue(control.wait(until: "enabled == true", timeout: 15), "The fixture viewer connects: \(app.debugDescription)")
    XCTAssertEqual(control.label, "Take over")
    XCTAssertTrue(app.buttons["computerTerminal"].exists, "The terminal opens in the app")
    try capture("07-computer-watching")
    control.tap()
    XCTAssertTrue(control.wait(until: "label == %@", "Hand back"), control.label)
    XCTAssertTrue(status.wait(until: "label CONTAINS %@", "You have control"), status.label)
    try capture("08-computer-control")
    // The keyboard types straight into the desktop, and the row above it adds keys it lacks. The
    // input is the focused text view; typing into it works with a software or hardware keyboard.
    let keyboardButton = app.buttons["computerKeyboard"]
    keyboardButton.tapWhenReady()
    let input = app.textViews.matching(NSPredicate(format: "hasKeyboardFocus == true")).firstMatch
    XCTAssertTrue(input.waitForExistence(timeout: 10), "The desktop keyboard takes focus: \(app.debugDescription)")
    // Typing can hide and restore the software keyboard; the key row moves with it, so taps on
    // its keys wait for it to settle.
    let escape = app.buttons["desktopKey.escape"]
    input.typeWhenFocused("hi")
    escape.waitForKeyboardLayout()
    escape.tapWhenReady()
    app.buttons["desktopKey.control"].tapWhenReady()
    input.typeWhenFocused("l")
    XCTAssertTrue(app.staticTexts["Typed: hi[escape][ctrl+l]"].waitForExistence(timeout: 10), app.debugDescription)
    // Tapping the desktop to pick a field keeps the keyboard up for it.
    app.descendants(matching: .any)["computerScreen"].tapWhenReady()
    XCTAssertTrue(input.waitForKeyboardFocus(), "The desktop keyboard keeps focus after a tap on the desktop")
    input.typeWhenFocused("x")
    XCTAssertTrue(app.staticTexts["Typed: hi[escape][ctrl+l]x"].waitForExistence(timeout: 10), app.debugDescription)
    try capture("08b-computer-keyboard")
    XCTAssertEqual(keyboardButton.label, "Hide keyboard")
    escape.waitForKeyboardLayout()
    keyboardButton.tapWhenReady()
    XCTAssertTrue(escape.waitForDisappearance(), "The keyboard button puts the keyboard away")
    // The clipboard button copies the desktop's clipboard to this device.
    app.buttons["computerClipboard"].tapWhenReady()
    app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Copy to ")).firstMatch.tapWhenReady()
    let info = app.descendants(matching: .any)["computerInfo"]
    XCTAssertTrue(info.wait(until: "label BEGINSWITH %@", "Copied the desktop's clipboard"), app.debugDescription)
    // The ⋯ menu switches trackpad mode, which the viewer page follows.
    // A menu's toggle is a button or a switch, depending on the system version.
    func trackpadItem() -> XCUIElement {
      let button = app.buttons["Trackpad mode"]
      return button.waitForExistence(timeout: 5) ? button : app.switches["Trackpad mode"]
    }
    app.buttons["computerMore"].tapWhenReady()
    trackpadItem().tapWhenReady()
    XCTAssertTrue(app.staticTexts["Fixture desktop · You have control · Trackpad"].waitForExistence(timeout: 10), app.debugDescription)
    app.buttons["computerMore"].tapWhenReady()
    trackpadItem().tapWhenReady()
    XCTAssertTrue(app.staticTexts["Fixture desktop · You have control"].waitForExistence(timeout: 10), app.debugDescription)
    // ? explains the touch controls.
    app.buttons["computerHelp"].tapWhenReady()
    XCTAssertTrue(app.staticTexts["Using the computer"].waitForExistence(timeout: 10), app.debugDescription)
    try capture("08c-computer-help")
    app.buttons["computerHelpClose"].tapWhenReady()
    XCTAssertTrue(app.staticTexts["Using the computer"].waitForDisappearance(), "The help sheet closes")
    control.tapWhenReady()
    XCTAssertTrue(control.wait(until: "label == %@", "Take over"), control.label)
    XCTAssertFalse(app.buttons["computerKeyboard"].exists, "Watching offers no keyboard")
  }

  func testTerminalConfirmsThenTypesIntoAShellAndEndsIt() throws {
    let app = launch(home: true)
    app.openSettingsFromProfileMenu(timeout: 15)
    app.descendants(matching: .any)["sharedComputer"].tapWhenReady()
    app.buttons["computerTerminal"].tapWhenReady()
    // The sign-in is older than the terminal's 2-hour window, so confirming comes first.
    let confirm = app.buttons["terminalConfirm"]
    XCTAssertTrue(confirm.waitForExistence(timeout: 15), app.debugDescription)
    XCTAssertTrue(app.staticTexts["Confirm it's you"].exists)
    XCTAssertFalse(app.descendants(matching: .any)["terminalScreen"].exists, "No shell before the confirmation")
    try capture("10-terminal-confirm")
    confirm.tapWhenReady()
    let status = app.descendants(matching: .any)["terminalStatus"]
    XCTAssertTrue(status.waitForExistence(timeout: 15), app.debugDescription)
    XCTAssertTrue(status.wait(until: "label CONTAINS %@", "Your system terminal"), status.label)
    XCTAssertTrue(status.label.contains("wildbots@fixture-host"), status.label)
    XCTAssertTrue(app.staticTexts["Fixture terminal"].waitForExistence(timeout: 10), app.debugDescription)
    try capture("11-terminal-shell")
    // Tapping the terminal raises the native keyboard, which types straight into the shell.
    app.descendants(matching: .any)["terminalScreen"].tapWhenReady()
    let input = app.textViews.matching(NSPredicate(format: "hasKeyboardFocus == true")).firstMatch
    XCTAssertTrue(input.waitForExistence(timeout: 10), "The terminal keyboard takes focus: \(app.debugDescription)")
    input.typeWhenFocused("ls")
    let control = app.buttons["desktopKey.control"]
    control.waitForKeyboardLayout()
    control.tapWhenReady()
    input.typeWhenFocused("c")
    XCTAssertTrue(app.staticTexts["Typed: ls[ctrl+c]"].waitForExistence(timeout: 10), "Ctrl+C reaches the shell as Control plus c: \(app.debugDescription)")
    try capture("12-terminal-typing")
    // End shell asks first; tapping away from the question changes nothing.
    app.buttons["terminalKeyboard"].tapWhenReady()
    app.buttons["terminalEnd"].tapWhenReady()
    // The question's own End shell button, not the toolbar's.
    let sure = app.popovers.buttons["End shell"]
    XCTAssertTrue(sure.waitForExistence(timeout: 5), app.debugDescription)
    app.otherElements["PopoverDismissRegion"].tap()
    XCTAssertTrue(sure.waitForDisappearance(), "Dismissing the question leaves the shell running")
    XCTAssertTrue(status.label.contains("Your system terminal"), status.label)
    app.buttons["terminalEnd"].tapWhenReady()
    sure.tapWhenReady()
    let start = app.buttons["terminalStart"]
    XCTAssertTrue(start.waitForExistence(timeout: 10), "An ended shell offers a new one: \(app.debugDescription)")
    XCTAssertTrue(app.staticTexts["Your shell has ended"].exists)
    try capture("13-terminal-ended")
    start.tapWhenReady()
    XCTAssertTrue(status.wait(until: "label CONTAINS %@", "Your system terminal"), status.label)
    XCTAssertTrue(app.staticTexts["Fixture terminal"].waitForExistence(timeout: 10), "A new shell connects")
  }

  func testTerminalSaysWhyAnotherMemberCannotOpenIt() throws {
    let app = launch(["TERMINAL_UNAVAILABLE"], home: true)
    app.openSettingsFromProfileMenu(timeout: 15)
    app.descendants(matching: .any)["sharedComputer"].tapWhenReady()
    app.buttons["computerTerminal"].tapWhenReady()
    let refused = app.descendants(matching: .any)["terminalUnavailable"]
    XCTAssertTrue(refused.waitForExistence(timeout: 15), app.debugDescription)
    XCTAssertTrue(refused.label.contains("limited to household administrators"), refused.label)
    XCTAssertFalse(app.buttons["terminalConfirm"].exists); XCTAssertFalse(app.descendants(matching: .any)["terminalScreen"].exists)
    try capture("14-terminal-unavailable")
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
