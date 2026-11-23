import XCTest

/// The chat shell around the transcript: prompt recall, the status dock, home's undo, live search
/// hits, group chats, the native desktop and the quick switcher. Debug fixtures stand in for the
/// server; they establish native behavior, not Hermes or a real desktop.
@MainActor final class ShellFlowTests: XCTestCase {
  override func setUp() { continueAfterFailure = false }
  private func launch(_ switches: [String] = [], values: [String: String] = [:], home: Bool = false) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchEnvironment["AGENT_INTERFACE_UI_FIXTURE"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_RESET"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_SCOPE"] = UUID().uuidString.lowercased()
    if home { app.launchEnvironment["AGENT_INTERFACE_UI_HOME"] = "1" }
    for name in switches { app.launchEnvironment["AGENT_INTERFACE_UI_" + name] = "1" }
    for (name, value) in values { app.launchEnvironment["AGENT_INTERFACE_UI_" + name] = value }
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

  func testANoSenderMessageIsLabeledInASharedChatAndNotInAPrivateOne() throws {
    // Ranch hand is shared, so a message with no sender could be any member's.
    let shared = launch(["UNKNOWN_SENDER"])
    XCTAssertTrue(shared.staticTexts["Noted your note."].waitForExistence(timeout: 15), shared.debugDescription)
    XCTAssertTrue(shared.staticTexts["Household member"].exists, "The native client's message is not drawn as this person's own")
    XCTAssertEqual(shared.staticTexts.matching(NSPredicate(format: "label == %@", "Household member")).count, 1, "Only the row with no sender")
    XCTAssertFalse(shared.staticTexts["Local test member"].exists, "This person's own message names no one")
    shared.terminate()
    // My assistant is private to this person, the only member who can write in it.
    let privateChat = launch(["UNKNOWN_SENDER"], home: true)
    privateChat.buttons["bot.personal"].tapWhenReady()
    XCTAssertTrue(privateChat.staticTexts["Noted your note."].waitForExistence(timeout: 15), privateChat.debugDescription)
    XCTAssertTrue(privateChat.staticTexts["Fixture note from a native client"].exists)
    XCTAssertFalse(privateChat.staticTexts["Household member"].exists, "Nobody else can have written in a private chat")
  }

  func testUpArrowRecallsANoSenderMessageOnlyInAPrivateChat() throws {
    // In the shared chat a no-sender message could be another member's, so recall passes over it.
    let shared = launch(["UNKNOWN_SENDER"])
    let sharedComposer = shared.textViews["messageComposer"]
    XCTAssertTrue(sharedComposer.waitForExistence(timeout: 15), shared.debugDescription)
    XCTAssertTrue(shared.staticTexts["Noted your note."].waitForExistence(timeout: 10))
    sharedComposer.tapWhenReady()
    XCTAssertTrue(sharedComposer.waitForKeyboardFocus())
    shared.typeKey(.upArrow, modifierFlags: [])
    XCTAssertTrue(sharedComposer.wait(until: "value == %@", "Fixture note from me"), "\(sharedComposer.value ?? "")")
    shared.typeKey(.upArrow, modifierFlags: [])
    // The history is only this person's one message: Down past it is the empty draft. Had the older
    // no-sender message been recalled, Up would have shown it and Down would return to this one.
    shared.typeKey(.downArrow, modifierFlags: [])
    XCTAssertTrue(sharedComposer.wait(until: "value == nil OR value == %@", ""), "Not the native client's message: \(sharedComposer.value ?? "")")
    shared.terminate()
    // Nobody else can have written in a private chat, so its no-sender message is this person's own.
    let privateChat = launch(["UNKNOWN_SENDER"], home: true)
    privateChat.buttons["bot.personal"].tapWhenReady()
    let composer = privateChat.textViews["messageComposer"]
    XCTAssertTrue(composer.waitForExistence(timeout: 15), privateChat.debugDescription)
    XCTAssertTrue(privateChat.staticTexts["Noted your note."].waitForExistence(timeout: 10))
    composer.tapWhenReady()
    XCTAssertTrue(composer.waitForKeyboardFocus())
    privateChat.typeKey(.upArrow, modifierFlags: [])
    XCTAssertTrue(composer.wait(until: "value == %@", "Fixture note from me"), "\(composer.value ?? "")")
    privateChat.typeKey(.upArrow, modifierFlags: [])
    XCTAssertTrue(composer.wait(until: "value == %@", "Fixture note from a native client"), "\(composer.value ?? "")")
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
    XCTAssertTrue(speaker(app, "Second test member").waitForExistence(timeout: 10), app.debugDescription)
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
    XCTAssertTrue(speaker(app, "You").waitForExistence(timeout: 10), "Your message says it is yours: \(app.debugDescription)")
    XCTAssertTrue(app.staticTexts["Ask @kitchen to check the pantry"].exists)
    XCTAssertFalse(app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Local test member")).firstMatch.exists,
      "Your own name is not shown on your own message")
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
    let routine = speaker(app, "Morning brief")
    XCTAssertTrue(routine.waitForExistence(timeout: 5), app.debugDescription)
    // The tag's own words: "Routine failed" holds "Routine" too.
    XCTAssertTrue(routine.label.components(separatedBy: ", ").contains("Routine"), routine.label)
    try capture("06a-group-activity")
    app.buttons["groupSettings"].tapWhenReady()
    let purpose = app.descendants(matching: .any).matching(identifier: "groupPurpose").firstMatch
    purpose.typeWhenFocused("Plan Sunday supper")
    app.buttons["saveGroupSettings"].tapWhenReady()
    XCTAssertTrue(app.navigationBars["Group settings"].waitForDisappearance(), "Saving returns to the group")
    // The chat keeps its latest messages on screen, while the members and purpose are at the top.
    let savedPurpose = app.staticTexts["Plan Sunday supper"]
    let transcript = app.collectionViews.firstMatch
    for _ in 0..<6 {
      if savedPurpose.exists { break }
      transcript.swipeDown()
    }
    XCTAssertTrue(savedPurpose.waitForExistence(timeout: 10), "The saved purpose shows under the members: \(app.debugDescription)")
  }

  /// A group message's speaker line in Bubbles, the default style: one element whose label starts with the name.
  private func speaker(_ app: XCUIApplication, _ name: String) -> XCUIElement {
    app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label BEGINSWITH %@", "groupSpeaker-", name)).firstMatch
  }
  /// Opens the group fixture that holds every kind of speaker in the chat style the environment sets. The app opens the
  /// room itself, so this works where home's row is out of reach, as on an iPad or at an accessibility text size.
  private func openStyledGroup(_ environment: [String: String], arguments: [String] = []) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchEnvironment["AGENT_INTERFACE_UI_FIXTURE"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_RESET"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_SCOPE"] = UUID().uuidString.lowercased()
    app.launchEnvironment["AGENT_INTERFACE_UI_GROUP"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_GROUP_BUBBLES"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_CAPTURE_GROUP"] = "1"
    for (key, value) in environment { app.launchEnvironment[key] = value }
    app.launchArguments += arguments
    app.launch()
    XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "groupComposer").firstMatch.waitForExistence(timeout: 15), app.debugDescription)
    // The latest message, which the room opens at.
    app.staticTexts["Then the trailer fits through."].revealInGroup(app)
    return app
  }

  /// In Bubbles the person's own messages and their speaker line sit at the trailing edge, and everyone else's,
  /// another member's, an assistant's and a routine's, at the leading edge. Classic keeps every message flat at the
  /// leading edge. Positions are compared with each other, so the list's margins on each device do not matter.
  func testGroupBubblesSeatThePersonAtTheTrailingEdgeAndEveryoneElseAtTheLeading() throws {
    let others = ["What should we cook on Sunday?", "Brisket, if the smoker is free.", "Fixture routine post: the smoker is free Sunday.",
      "Here is the plan so far:"]
    // One that wraps on a phone and one that does not, so a shared trailing edge cannot be a coincidence of length.
    let own = ["I can light the smoker at six. Who brings the rub?", "Then the trailer fits through."]
    for style in ["bubbles", "classic"] {
      let app = openStyledGroup(["AGENT_INTERFACE_UI_CHAT_STYLE": style])
      func frame(_ element: XCUIElement) -> CGRect { element.revealInGroup(app); return element.frame }
      func starting(_ label: String) -> XCUIElement { app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", label)).firstMatch }
      let othersFrames = others.map { frame(app.staticTexts[$0]) }
      let ownFrames = own.map { frame(app.staticTexts[$0]) }
      let leading = othersFrames.map(\.minX).min()!
      for (text, value) in zip(others, othersFrames) {
        XCTAssertEqual(value.minX, leading, accuracy: 4, "\(style): \(text) speaks from the leading edge: \(othersFrames)")
      }
      let table = frame(app.scrollViews.matching(NSPredicate(format: "label == %@", "Table")).firstMatch)
      let trailing = ownFrames.map(\.maxX).max()!
      for (text, value) in zip(own, ownFrames) {
        if style == "bubbles" {
          XCTAssertGreaterThan(value.minX, leading + 20, "Bubbles: your \(text) leaves the leading edge: \(value)")
          XCTAssertEqual(value.maxX, trailing, accuracy: 4, "Bubbles: your \(text) ends at the trailing edge: \(ownFrames)")
        } else {
          XCTAssertEqual(value.minX, leading, accuracy: 4, "Classic: your \(text) stays flat at the leading edge: \(value)")
        }
      }
      if style == "bubbles" { XCTAssertGreaterThanOrEqual(table.maxX, trailing - 2, "A table keeps the column's width: \(table)") }
      // Bubbles makes each speaker line one element; Classic keeps the name as its own text.
      func speaker(_ event: String, _ name: String) -> XCUIElement {
        style == "bubbles" ? app.descendants(matching: .any)["groupSpeaker-" + event] : app.staticTexts[name].firstMatch
      }
      let yours = speaker("group-own-2", "You")
      let you = frame(yours), line = yours.label
      // An assistant's name also fills a table cell, so Classic is checked on the routine's, which no cell repeats.
      let routine = frame(speaker("cron-post:2", "Morning brief"))
      XCTAssertLessThan(routine.minX, leading + 40, "\(style): the routine's name stays at the leading edge: \(routine)")
      if style == "bubbles" {
        let kitchen = frame(speaker("group-2", "Kitchen companion"))
        XCTAssertLessThan(kitchen.minX, leading + 40, "Bubbles: the assistant's name stays at the leading edge: \(kitchen)")
      }
      if style == "bubbles" {
        XCTAssertGreaterThan(you.minX, leading + 20, "Bubbles: your name moves to the trailing edge: \(you)")
        XCTAssertGreaterThanOrEqual(you.maxX, trailing - 2, "Bubbles: your name ends at the trailing edge: \(you)")
        XCTAssertTrue(line.hasPrefix("You") && line != "You", "Bubbles reads the name with its time, as one stop before the message: \(line)")
        // A long thread line wraps across the row on a phone, so it is held to the trailing edge, not off the leading one.
        XCTAssertEqual(frame(starting("In thread with")).maxX, you.maxX, accuracy: 4, "Your thread line follows your message")
      }
      XCTAssertLessThanOrEqual(table.minX, leading + 2, "\(style): the table starts at the column's edge: \(table)")
      app.terminate()
    }
  }

  /// The group in each chat style for review: Classic and Bubbles in light and dark.
  /// Runs only when screenshots are written. Each capture's accessibility tree is written beside it, so a change to
  /// Classic's shows in a diff.
  func testGroupChatStyleScreens() throws {
    try captureGroups([
      ("classic-light", ["AGENT_INTERFACE_UI_CHAT_STYLE": "classic", "AGENT_INTERFACE_UI_THEME": "light"], []),
      ("classic-dark", ["AGENT_INTERFACE_UI_CHAT_STYLE": "classic", "AGENT_INTERFACE_UI_THEME": "dark"], []),
      ("bubbles-light", ["AGENT_INTERFACE_UI_CHAT_STYLE": "bubbles", "AGENT_INTERFACE_UI_THEME": "light"], []),
      ("bubbles-dark", ["AGENT_INTERFACE_UI_CHAT_STYLE": "bubbles", "AGENT_INTERFACE_UI_THEME": "dark"], []),
    ])
  }
  /// The group's Solid and Increase Contrast captures, apart from the rest so each stays within the time allowance on a
  /// shared Mac. Runs only when screenshots are written.
  func testGroupSolidAndContrastScreens() throws {
    try captureGroups([
      ("bubbles-solid-dark", ["AGENT_INTERFACE_UI_CHAT_STYLE": "bubbles", "AGENT_INTERFACE_UI_OWN_BUBBLE": "solid", "AGENT_INTERFACE_UI_THEME": "dark"], []),
      ("bubbles-solid-light", ["AGENT_INTERFACE_UI_CHAT_STYLE": "bubbles", "AGENT_INTERFACE_UI_OWN_BUBBLE": "solid", "AGENT_INTERFACE_UI_THEME": "light"], []),
      ("bubbles-solid-contrast-dark", ["AGENT_INTERFACE_UI_CHAT_STYLE": "bubbles", "AGENT_INTERFACE_UI_OWN_BUBBLE": "solid",
        "AGENT_INTERFACE_UI_THEME": "dark", "AGENT_INTERFACE_UI_INCREASE_CONTRAST": "1"], []),
      ("bubbles-contrast-light", ["AGENT_INTERFACE_UI_CHAT_STYLE": "bubbles", "AGENT_INTERFACE_UI_THEME": "light", "AGENT_INTERFACE_UI_INCREASE_CONTRAST": "1"], []),
    ])
  }
  /// A link, inline code and task boxes in the person's bubble, tinted and solid, which draw in colors of their own
  /// elsewhere. Runs only when screenshots are written.
  func testGroupInkScreens() throws {
    try XCTSkipIf(ProcessInfo.processInfo.environment["AGENT_INTERFACE_SCREENSHOT_DIR"] == nil, "Set AGENT_INTERFACE_SCREENSHOT_DIR to capture")
    for (own, theme) in [("solid", "light"), ("solid", "dark"), ("tint", "light"), ("tint", "dark")] {
      let app = launch(["GROUP", "GROUP_INK", "CAPTURE_GROUP"], values: ["CHAT_STYLE": "bubbles", "OWN_BUBBLE": own, "THEME": theme])
      let text = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", "See the plan")).firstMatch
      XCTAssertTrue(text.waitForExistence(timeout: 15), app.debugDescription)
      try capture("group-ink-\(own)-\(theme)")
      app.terminate()
    }
  }
  /// The group in Bubbles at the largest accessibility text size, tinted and solid, where the person's quote holding
  /// nested lists has the least room. A test of its own, since scrolling at this size takes most of the time allowance.
  func testGroupLargeTextScreens() throws {
    let large = ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
    try captureGroups([
      ("bubbles-large-light", ["AGENT_INTERFACE_UI_CHAT_STYLE": "bubbles", "AGENT_INTERFACE_UI_THEME": "light"], large),
      ("bubbles-solid-large-dark", ["AGENT_INTERFACE_UI_CHAT_STYLE": "bubbles", "AGENT_INTERFACE_UI_OWN_BUBBLE": "solid", "AGENT_INTERFACE_UI_THEME": "dark"], large),
    ])
  }
  private func captureGroups(_ variants: [(String, [String: String], [String])]) throws {
    try XCTSkipIf(ProcessInfo.processInfo.environment["AGENT_INTERFACE_SCREENSHOT_DIR"] == nil, "Set AGENT_INTERFACE_SCREENSHOT_DIR to capture")
    let directory = URL(fileURLWithPath: ProcessInfo.processInfo.environment["AGENT_INTERFACE_SCREENSHOT_DIR"]!)
    for (name, environment, arguments) in variants {
      let app = openStyledGroup(environment, arguments: arguments)
      let device = app.frame.width > 700 ? "ipad" : app.frame.width < 380 ? "iphone-small" : "iphone"
      // The latest message, the quote holding nested lists, is on screen.
      try capture("group-\(device)-\(name)-end")
      // At the largest size the quote scrolls off above the message's last line, so its top is captured too.
      if name.contains("large") {
        app.staticTexts["Gates"].revealInGroup(app)
        try capture("group-\(device)-\(name)-quote")
      }
      // The tree gives VoiceOver's reading order and labels.
      try app.debugDescription.write(to: directory.appendingPathComponent("group-\(device)-\(name)-tree.txt"), atomically: true, encoding: .utf8)
      app.staticTexts["What should we cook on Sunday?"].revealInGroup(app)
      try capture("group-\(device)-\(name)-start")
      // The audit's findings are written down rather than failed on, so Classic's before and after can be compared;
      // AccessibilityAuditTests holds the gating audits. It runs last, since it can leave the room's elements stale.
      var findings: [String] = []
      try app.performAccessibilityAudit { issue in
        findings.append("\(issue.auditType.rawValue) \(issue.compactDescription): \(issue.element?.label ?? "no element") \(issue.element?.identifier ?? "")")
        return true
      }
      try findings.joined(separator: "\n").write(to: directory.appendingPathComponent("group-\(device)-\(name)-audit.txt"), atomically: true, encoding: .utf8)
      app.terminate()
    }
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

extension XCUIApplication {
  /// The part of the group's messages between the navigation bar and the message box.
  var groupViewport: ClosedRange<CGFloat> {
    let box = descendants(matching: .any).matching(identifier: "groupComposer").firstMatch
    return navigationBars.firstMatch.frame.maxY...(box.frame.minY - 12)
  }
  /// Drags the group's messages by `distance` points, down toward the first message when positive, slowly and with a
  /// hold at the end so the list does not coast past.
  func scrollGroup(by distance: CGFloat) {
    let box = descendants(matching: .any).matching(identifier: "groupComposer").firstMatch
    let viewport = groupViewport
    let step = min(abs(distance), viewport.upperBound - viewport.lowerBound - 40)
    let startY = distance > 0 ? viewport.upperBound - 10 - step : viewport.upperBound - 10
    let start = coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: box.frame.midX, dy: startY))
    start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: distance > 0 ? step : -step)),
      withVelocity: .slow, thenHoldForDuration: 0.3)
  }
  func scrollGroup(down: Bool) { scrollGroup(by: down ? 10_000 : -10_000) }
}

extension XCUIElement {
  /// Scrolls the group's messages until this element is on screen above the message box, or, when it is taller than
  /// that space, until its top is. The list builds rows only near the screen, so a row not built yet is looked for
  /// toward the latest message first, then toward the first.
  func revealInGroup(_ app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
    for attempt in 0..<40 where !exists { app.scrollGroup(down: attempt >= 20) }
    for _ in 0..<8 {
      guard exists else { break }
      let viewport = app.groupViewport, box = frame
      if box.minY < viewport.lowerBound { app.scrollGroup(by: viewport.lowerBound - box.minY + 16) }
      else if box.maxY > viewport.upperBound && box.height < viewport.upperBound - viewport.lowerBound {
        app.scrollGroup(by: viewport.upperBound - box.maxY - 16)
      } else if box.minY > viewport.upperBound { app.scrollGroup(by: viewport.lowerBound - box.minY + 16) }
      else { return }
    }
    XCTFail("\(self) shows in the group: \(app.debugDescription)", file: file, line: line)
  }
}
