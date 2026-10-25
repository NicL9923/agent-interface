import XCTest

/// The transcript's chat UX catch-up with the Debug fixture: the question card, Retry, find in chat
/// across unloaded history, folded work, code and tables, quoting, and holding a sent message at the top.
@MainActor final class TranscriptFlowTests: XCTestCase {
  private func launch(_ environment: [String: String] = [:]) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchEnvironment["AGENT_INTERFACE_UI_FIXTURE"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_RESET"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_SCOPE"] = UUID().uuidString.lowercased()
    for (key, value) in environment { app.launchEnvironment[key] = value }
    app.launch()
    return app
  }
  /// Attaches a screenshot, and writes it where AGENT_INTERFACE_SCREENSHOT_DIR points.
  private func capture(_ app: XCUIApplication, _ name: String) throws {
    let screenshot = app.screenshot()
    let attachment = XCTAttachment(screenshot: screenshot); attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    if let directory = ProcessInfo.processInfo.environment["AGENT_INTERFACE_SCREENSHOT_DIR"] {
      try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
      try screenshot.pngRepresentation.write(to: URL(fileURLWithPath: directory).appendingPathComponent(name + ".png"))
    }
  }
  /// Waits until `condition` holds, for values a predicate on the element cannot read, such as its frame.
  private func waitFor(_ timeout: TimeInterval = 10, _ condition: @escaping () -> Bool) -> Bool {
    let expectation = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in condition() }, object: nil)
    return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
  }

  func testQuestionOptionsAdvanceAndSendEveryAnswer() throws {
    let app = launch(["AGENT_INTERFACE_UI_QUESTION": "2"])
    let send = app.buttons["Send answers"]
    XCTAssertTrue(send.waitForExistence(timeout: 10))
    XCTAssertFalse(send.isEnabled)
    try capture(app, "question-options")
    let second = app.buttons["questionOption-plan-1"]
    second.tapWhenReady()
    XCTAssertTrue(second.wait(until: "isSelected == true"), "VoiceOver reads the chosen option as selected")
    XCTAssertFalse(app.buttons["questionOption-plan-0"].isSelected)
    // Several choices toggle and stay on the question.
    app.buttons["questionOption-extras-0"].tapWhenReady()
    app.buttons["questionOption-extras-2"].tapWhenReady()
    app.buttons["questionOption-extras-1"].tapWhenReady()
    app.buttons["questionOption-extras-1"].tapWhenReady()
    XCTAssertTrue(app.buttons["questionOption-extras-2"].wait(until: "isSelected == true"))
    XCTAssertTrue(app.buttons["questionOption-extras-1"].wait(until: "isSelected == false"))
    XCTAssertFalse(send.isEnabled, "The written question still needs an answer")
    app.descendants(matching: .any).matching(identifier: "questionAnswer-note").firstMatch.typeWhenFocused("Bring gloves")
    try capture(app, "question-answered")
    if !send.canTap { app.scrollViews["conversationTranscript"].swipeUp() }
    XCTAssertTrue(send.wait(until: "isEnabled == true"))
    send.tapWhenReady()
    XCTAssertTrue(app.staticTexts["extras: Hay, Feed; note: Bring gloves; plan: Second"].waitForExistence(timeout: 10))
  }

  func testAFailedTurnRetriesAndLeavesTheDraftAlone() throws {
    let app = launch(["AGENT_INTERFACE_UI_RETRY": "1"])
    let retry = app.buttons["retryTurn"]
    XCTAssertTrue(retry.waitForExistence(timeout: 15), app.debugDescription)
    let composer = app.textViews["messageComposer"]
    composer.typeWhenFocused("Keep this draft")
    app.buttons["hideKeyboard"].tapWhenReady()
    XCTAssertTrue(composer.waitForKeyboardFocus(false))
    try capture(app, "retry-offered")
    retry.tapWhenReady()
    XCTAssertTrue(app.staticTexts["Retried retry-prompt: the north gate is closed and the battery reads 80%."].waitForExistence(timeout: 10))
    XCTAssertTrue(retry.waitForDisappearance(), "An answered turn offers no Retry")
    XCTAssertEqual(composer.value as? String, "Keep this draft", "Retry never touches the draft")
    try capture(app, "retry-answered")
  }

  func testARefusedRetryExplainsItselfAndPutsTheMessageBackOnRequest() throws {
    let app = launch(["AGENT_INTERFACE_UI_RETRY": "refused"])
    let retry = app.buttons["retryTurn"]
    XCTAssertTrue(retry.waitForExistence(timeout: 15), app.debugDescription)
    let composer = app.textViews["messageComposer"]
    composer.typeWhenFocused("My note")
    app.buttons["hideKeyboard"].tapWhenReady()
    XCTAssertTrue(composer.waitForKeyboardFocus(false))
    retry.tapWhenReady()
    let refused = app.staticTexts["retryRefused"]
    XCTAssertTrue(refused.waitForExistence(timeout: 10))
    XCTAssertEqual(refused.label, "Hermes didn't take the retry. The gate service is offline.")
    XCTAssertTrue(retry.waitForDisappearance(), "A refused retry stays refused")
    XCTAssertEqual(composer.value as? String, "My note", "Nothing changes the draft by itself")
    try capture(app, "retry-refused")
    app.buttons["retryPutBack"].tapWhenReady()
    XCTAssertTrue(composer.wait(until: "value == %@", "My note\n\nIs the north gate closed?"), String(describing: composer.value))
  }

  func testFindCountsUnloadedHistoryAndOpensTheChatThere() throws {
    let app = launch(["AGENT_INTERFACE_UI_LONG_HISTORY": "1"])
    XCTAssertTrue(app.staticTexts["Fixture answer 60."].waitForExistence(timeout: 15))
    app.openBotProfile("Ranch hand")
    app.buttons["profileFind"].tapWhenReady()
    let find = app.textFields["findConversation"]
    XCTAssertTrue(find.waitForExistence(timeout: 5))
    // Turns 41 to 60 are loaded, so nothing matches at once; the server finds 3 and 30 to 39.
    find.typeWhenFocused("question 3")
    let status = app.staticTexts["findStatus"]
    XCTAssertTrue(status.wait(until: "label == %@", "11 matches"), status.label)
    XCTAssertFalse(app.staticTexts["Fixture question 30"].exists, "Turn 30 is not loaded yet")
    try capture(app, "find-merged")
    app.buttons["Next match"].tapWhenReady()
    let three = app.staticTexts["Fixture question 3"]
    XCTAssertTrue(three.waitUntilHittable(timeout: 15), "The chat reloads at the unloaded match and shows it")
    XCTAssertTrue(status.wait(until: "label == %@", "1 of 11"), status.label)
    try capture(app, "find-opened-earlier")
    // Loaded from turn 3 on, the next match is already there.
    app.buttons["Next match"].tapWhenReady()
    XCTAssertTrue(status.wait(until: "label == %@", "2 of 11"), status.label)
    XCTAssertTrue(app.staticTexts["Fixture question 30"].waitUntilHittable(timeout: 10))
  }

  func testFinishedWorkFoldsAndCodeAndTablesOfferTheirCopies() throws {
    let app = launch(["AGENT_INTERFACE_UI_WORK": "1"])
    let work = app.buttons["turnWork"]
    XCTAssertTrue(work.waitForExistence(timeout: 15), app.debugDescription)
    XCTAssertEqual(work.label, "Worked for 2m 14s · 1 tool call, 1 subagent")
    XCTAssertEqual(work.value as? String, "Collapsed")
    XCTAssertFalse(app.buttons["Tool calls"].exists, "Tool calls stay inside the fold")
    XCTAssertTrue(app.buttons["Copy code"].exists)
    try capture(app, "work-folded")
    work.tapWhenReady()
    XCTAssertTrue(app.buttons["Tool calls"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["Subagents"].exists)
    XCTAssertTrue(work.wait(until: "value == %@", "Expanded"))
    try capture(app, "work-expanded")
    let cell = app.staticTexts["North"]
    for _ in 0..<4 where !cell.canTap { app.swipeUp() }
    cell.press(forDuration: 1)
    XCTAssertTrue(app.buttons["Copy as Markdown"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["Copy as CSV"].exists)
    try capture(app, "table-copy-menu")
    app.buttons["Copy as CSV"].tapWhenReady()
    XCTAssertTrue(app.buttons["Copy as CSV"].waitForDisappearance())
  }

  func testAdvancedWorkKeepsReasoningInsideTheFold() throws {
    let app = launch(["AGENT_INTERFACE_UI_WORK": "1", "AGENT_INTERFACE_UI_WORK_PRESENTATION": "advanced"])
    let work = app.buttons["turnWork"]
    XCTAssertTrue(work.waitForExistence(timeout: 15), app.debugDescription)
    XCTAssertFalse(app.buttons["Reasoning"].exists, "Reasoning folds with the rest of the work")
    try capture(app, "work-advanced")
    work.tapWhenReady()
    app.buttons["Reasoning"].tapWhenReady()
    XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH %@", "The gate log shows a low battery.")).firstMatch
      .waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["Tool calls"].exists)
  }

  func testTheRunningTurnShowsOneLiveRowBesideTheAvatar() throws {
    let app = launch(["AGENT_INTERFACE_UI_LIVE_ACTIVITY": "1"])
    XCTAssertTrue(app.staticTexts["Ranch hand is checking the latest forecast..."].waitForExistence(timeout: 15))
    XCTAssertTrue(app.staticTexts["liveReceipt"].waitForExistence(timeout: 5))
    XCTAssertEqual(app.staticTexts["liveReasoning"].label, "Fixture exposed reasoning: current weather needs a fresh forecast.")
    XCTAssertFalse(app.buttons["Tool calls"].exists, "The running turn's tool calls stay in its fold")
    XCTAssertFalse(app.buttons["retryTurn"].exists, "Work in progress offers no Retry")
    try capture(app, "working-live")
  }

  func testQuoteInReplyAddsTheReplyToTheDraft() throws {
    let app = launch()
    let composer = app.textViews["messageComposer"]
    XCTAssertTrue(composer.waitForExistence(timeout: 15))
    app.staticTexts["Your household assistant"].press(forDuration: 1)
    app.buttons["Quote in reply"].tapWhenReady()
    XCTAssertTrue(composer.wait(until: "value BEGINSWITH %@", "> # Your household assistant\n>\n> I can help"), String(describing: composer.value))
    try capture(app, "quote-in-draft")
  }

  func testASentMessageStaysNearTheTopWhileItsReplyGrows() throws {
    let app = launch(["AGENT_INTERFACE_UI_LONG_HISTORY": "1"])
    XCTAssertTrue(app.staticTexts["Fixture answer 60."].waitForExistence(timeout: 15))
    let composer = app.textViews["messageComposer"]
    composer.typeWhenFocused("Anchor this message")
    app.buttons["sendMessage"].tapWhenReady()
    app.buttons["hideKeyboard"].tapWhenReady()
    let sent = app.staticTexts["Anchor this message"]
    XCTAssertTrue(sent.waitForExistence(timeout: 10))
    let transcript = app.scrollViews["conversationTranscript"]
    XCTAssertTrue(waitFor { sent.hasFrame && sent.frame.minY < transcript.frame.minY + transcript.frame.height * 0.3 },
      "The sent message sits near the top: \(sent.frame) in \(transcript.frame)")
    XCTAssertFalse(app.buttons["Jump to latest"].exists, "Nothing is below it to jump to")
    try capture(app, "send-anchored")
    // Reading back stops following; returning to the end follows again.
    transcript.swipeDown()
    XCTAssertTrue(app.buttons["Jump to latest"].waitForExistence(timeout: 5))
    app.buttons["Jump to latest"].tapWhenReady()
    XCTAssertTrue(app.buttons["Jump to latest"].waitForDisappearance())
  }
}

extension XCUIApplication {
  /// Opens every folded work row in the transcript, scrolling to each one in turn.
  func expandWork(file: StaticString = #filePath, line: UInt = #line) {
    let folds = buttons.matching(identifier: "turnWork")
    XCTAssertTrue(folds.firstMatch.waitForExistence(timeout: 10), "The transcript has folded work", file: file, line: line)
    for _ in 0..<12 {
      guard let fold = folds.allElementsBoundByIndex.first(where: { $0.value as? String == "Collapsed" }) else { return }
      for _ in 0..<4 where !fold.canTap { swipeUp() }
      fold.tapWhenReady(file: file, line: line)
      fold.wait(until: "value == %@", "Expanded")
    }
  }
}
