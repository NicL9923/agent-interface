import XCTest

@MainActor final class ExperienceFlowTests: XCTestCase {
  func testInlineHtmlRunsLocalControlsAndResets() {
    let app = XCUIApplication()
    app.launchEnvironment["AGENT_INTERFACE_UI_FIXTURE"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_RESET"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_INLINE_UI"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_SCOPE"] = UUID().uuidString.lowercased()
    app.launch()
    let compare = app.webViews.buttons["Compare supply"]
    // A web view's first load on CI's simulator can take well over 15 seconds.
    XCTAssertTrue(compare.waitForExistence(timeout: 40), app.debugDescription)
    compare.tap()
    XCTAssertTrue(app.webViews.staticTexts["40 days"].waitForExistence(timeout: 5))
    capture(app, name: "Native inline UI expanded")
    app.buttons["Reset view"].tap()
    XCTAssertTrue(app.webViews.staticTexts["24 days"].waitForExistence(timeout: 5))
  }
  private func launch() -> XCUIApplication {
    let app = XCUIApplication()
    app.launchEnvironment["AGENT_INTERFACE_UI_FIXTURE"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_RESET"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_EXPERIENCE"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_SCOPE"] = UUID().uuidString.lowercased()
    app.launch(); return app
  }
  private func tab(_ name: String, app: XCUIApplication) {
    app.selectSettingsTab(name)
  }
  private func capture(_ app: XCUIApplication, name: String) {
    let attachment = XCTAttachment(screenshot: app.screenshot()); attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
  }
  func testInteractiveChecklistMemoryAndRoutineSchedulePreview() {
    let app = launch()
    XCTAssertTrue(app.staticTexts["Grocery checklist"].waitForExistence(timeout: 10))
    let milk = app.buttons["checklist.groceries.milk"]
    XCTAssertTrue(milk.waitForExistence(timeout: 5)); XCTAssertTrue(milk.isEnabled)
    milk.tap(); XCTAssertTrue(milk.waitForExistence(timeout: 5));
    let checked = NSPredicate(format: "value == %@", "Checked")
    expectation(for: checked, evaluatedWith: milk); waitForExpectations(timeout: 5)
    capture(app, name: "Native interactive checklist")
    app.openAssistantSettings("Ranch hand"); tab("Memory", app: app)
    XCTAssertTrue(app.staticTexts["What Hermes remembers"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Profile: default.")).firstMatch.exists)
    app.buttons["Forget…"].tap(); app.buttons["Forget entry"].tapWhenReady()
    XCTAssertTrue(app.staticTexts["Saved in Hermes."].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["Nothing saved here yet."].exists)
    XCTAssertFalse(app.buttons["Save memories"].isEnabled)
    app.buttons["Add memory"].tap()
    let fact = app.descendants(matching: .any).matching(identifier: "memoryEntry.1").firstMatch; fact.typeWhenFocused("Prefers the south pasture")
    app.buttons["Discard edits"].tapWhenReady()
    XCTAssertTrue(app.staticTexts["Nothing saved here yet."].waitForExistence(timeout: 5))
    app.buttons["Add memory"].tap()
    fact.typeWhenFocused("Prefers the south pasture")
    app.buttons["Save memories"].tapWhenReady()
    XCTAssertTrue(app.staticTexts["Saved in Hermes."].waitForExistence(timeout: 5))
    XCTAssertTrue(fact.exists); XCTAssertFalse(app.buttons["Discard edits"].exists)
    XCTAssertFalse(app.staticTexts["Nothing saved here yet."].exists)
    capture(app, name: "Native profile memory")
    tab("Routines", app: app)
    XCTAssertTrue(app.buttons["routineTemplate.morning"].waitForExistence(timeout: 5)); app.buttons["routineTemplate.morning"].tap()
    app.collectionViews["routineEditorForm"].buttons["Preview schedule"].tapWhenReady()
    XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "America/Chicago")).firstMatch.waitForExistence(timeout: 5))
    app.collectionViews["routineEditorForm"].swipeUp()
    capture(app, name: "Native routine timezone preview")
  }
  func testTodayOpensCanonicalAssistantAndVoiceTranscribesIntoTheDraft() {
    let app = launch()
    XCTAssertTrue(app.chatHeader("Ranch hand").waitForExistence(timeout: 10))
    if !app.buttons["openToday"].isHittable {
      let back = app.navigationBars.buttons.matching(identifier: "Your assistants").firstMatch
      if back.exists { back.tap() } else { app.navigationBars.buttons.firstMatch.tap() }
    }
    app.buttons["openToday"].tap()
    XCTAssertTrue(app.staticTexts["Since you were away"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["Fixture routine completed"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["refreshToday"].exists)
    XCTAssertTrue(app.staticTexts["Your assistants, at a glance"].exists)
    capture(app, name: "Native Today overview")
    app.buttons["today.event.fixture-completed"].tap()
    XCTAssertTrue(app.buttons["Record voice"].waitForExistence(timeout: 5)); app.buttons["Record voice"].tap()
    let stop = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Stop recording")).firstMatch
    XCTAssertTrue(stop.waitForExistence(timeout: 5)); XCTAssertTrue(app.buttons["Cancel voice"].exists)
    capture(app, name: "Native voice recording")
    stop.tap()
    // As on the web, stopping transcribes at once and the text joins the draft, with no review step.
    XCTAssertTrue(app.staticTexts["Added to your draft. Review it before sending."].waitForExistence(timeout: 5))
    let composer = app.textViews["messageComposer"]
    composer.wait(until: "value == %@", "Fixture transcript: check the north gate.")
    XCTAssertEqual(composer.value as? String, "Fixture transcript: check the north gate.")
    XCTAssertTrue(app.buttons["Record voice"].exists)
  }
  func testUncertainRoutineTrialChecksReceiptBeforeFreshRun() {
    let app = launch()
    XCTAssertTrue(app.chatHeader("Ranch hand").waitForExistence(timeout: 10))
    app.openAssistantSettings("Ranch hand"); tab("Routines", app: app)
    let message = { (text: String) in app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", text)).firstMatch }
    for _ in 0..<5 { if app.buttons["Try once"].isHittable { break }; app.collectionViews.firstMatch.swipeUp() }
    app.buttons["Try once"].tap()
    XCTAssertTrue(app.buttons["Check run status"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.buttons["Try once"].exists)
    app.buttons["Check run status"].tap()
    XCTAssertTrue(message("Trial run completed. Fixture first run completed").waitForExistence(timeout: 5))
    app.buttons["Try once"].tap()
    XCTAssertTrue(message("Fixture second run uses a fresh request ID").waitForExistence(timeout: 5))
    capture(app, name: "Native routine trial recovery")
  }

  func testListenToReplyPlaysServerAudioWithAnExplicitStop() {
    let app = launch()
    XCTAssertTrue(app.buttons["Listen to reply"].waitForExistence(timeout: 10))
    app.buttons["Listen to reply"].tap()
    XCTAssertTrue(app.buttons["Stop speaking"].waitForExistence(timeout: 3))
    app.buttons["Stop speaking"].tap()
    XCTAssertTrue(app.buttons["Listen to reply"].waitForExistence(timeout: 3))
  }
  func testRoutineResultsAndGroupCreationMessaging() {
    var app = launch()
    XCTAssertTrue(app.chatHeader("Ranch hand").waitForExistence(timeout: 10))
    app.openAssistantSettings("Ranch hand"); tab("Routines", app: app)
    app.buttons["View results"].firstMatch.tapWhenReady()
    XCTAssertTrue(app.staticTexts["Fixture saved routine output: the pasture gate is closed."].waitForExistence(timeout: 5))
    capture(app, name: "Native routine saved output")
    app.terminate(); app = launch()
    XCTAssertTrue(app.chatHeader("Ranch hand").waitForExistence(timeout: 10))
    if !app.buttons["openGroups"].isHittable { app.navigationBars.buttons.firstMatch.tap() }
    app.buttons["openGroups"].tap()
    let newGroup = app.buttons["New group"]
    XCTAssertTrue(newGroup.waitForExistence(timeout: 5))
    expectation(for: NSPredicate(format: "enabled == true"), evaluatedWith: newGroup); waitForExpectations(timeout: 5)
    newGroup.tap()
    XCTAssertTrue(app.textFields["Group name"].waitForExistence(timeout: 5), app.debugDescription)
    app.textFields["Group name"].typeWhenFocused("Gate planning")
    app.switches["Ranch hand"].switches.firstMatch.tap(); app.switches["Kitchen companion"].switches.firstMatch.tap()
    XCTAssertTrue(app.switches["Ranch hand"].wait(until: "value == %@", "1"), "Ranch hand joins the group")
    XCTAssertTrue(app.switches["Kitchen companion"].wait(until: "value == %@", "1"), "Kitchen companion joins the group")
    XCTAssertTrue(app.buttons["Create group"].wait(until: "enabled == true"))
    app.buttons["Create group"].tap()
    // The new room opens by itself, as on the web.
    let composer = app.descendants(matching: .any).matching(identifier: "groupComposer").firstMatch
    XCTAssertTrue(composer.waitForExistence(timeout: 5), app.debugDescription); composer.typeWhenFocused("Check the gate together")
    app.buttons["Send to group"].tap()
    XCTAssertTrue(app.staticTexts["Check the gate together"].waitForExistence(timeout: 5))
    capture(app, name: "Native group discussion")
  }

  func testTodayAcknowledgesEachReturnedPageWithoutDroppingLateImports() {
    let app = launch()
    XCTAssertTrue(app.chatHeader("Ranch hand").waitForExistence(timeout: 10))
    if !app.buttons["openToday"].isHittable {
      let back = app.navigationBars.buttons.matching(identifier: "Your assistants").firstMatch
      if back.exists { back.tap() } else { app.navigationBars.buttons.firstMatch.tap() }
    }
    app.buttons["openToday"].tap()
    XCTAssertTrue(app.staticTexts["Fixture routine completed"].waitForExistence(timeout: 5))
    let marker = app.buttons["markTodaySeen"]
    XCTAssertEqual(marker.label, "Mark this page caught up")
    XCTAssertTrue(app.staticTexts["More recorded results are waiting. Mark this page caught up to load the next page."].exists)
    app.collectionViews["todayOverview"].swipeUp(); marker.tap()
    XCTAssertTrue(app.staticTexts["Fixture late imported completion"].waitForExistence(timeout: 5))
    XCTAssertTrue(marker.wait(until: "label == %@", "Mark caught up"), marker.label)
    capture(app, name: "Native Today preserves late imported event")
    marker.tap()
    let cleared = NSPredicate(format: "exists == false")
    expectation(for: cleared, evaluatedWith: app.staticTexts["Fixture late imported completion"])
    waitForExpectations(timeout: 5)
  }

}
