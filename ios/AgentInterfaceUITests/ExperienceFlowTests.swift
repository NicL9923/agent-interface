import XCTest

final class ExperienceFlowTests: XCTestCase {
  private func launch() -> XCUIApplication {
    let app = XCUIApplication()
    app.launchEnvironment["AGENT_INTERFACE_UI_FIXTURE"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_RESET"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_EXPERIENCE"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_SCOPE"] = UUID().uuidString.lowercased()
    app.launch(); return app
  }
  private func tab(_ name: String, app: XCUIApplication) {
    app.buttons["settingsMore"].tap(); app.buttons[name].tap()
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
    app.buttons["Configure Ranch hand"].tap(); tab("Memory", app: app)
    XCTAssertTrue(app.staticTexts["Hermes profile: default"].waitForExistence(timeout: 5))
    app.buttons["Forget this fact"].tap(); app.buttons["Save Memory"].tap()
    XCTAssertTrue(app.staticTexts["Memory saved in Hermes."].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["No facts saved here."].exists)
    capture(app, name: "Native profile memory")
    tab("Routines", app: app); app.buttons["Add routine"].tap()
    XCTAssertTrue(app.buttons["routineTemplate.morning"].waitForExistence(timeout: 5)); app.buttons["routineTemplate.morning"].tap()
    app.collectionViews["routineEditorForm"].swipeUp()
    app.buttons["Show next run times"].tap()
    XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "America/Chicago")).firstMatch.waitForExistence(timeout: 5))
    app.collectionViews["routineEditorForm"].swipeUp()
    capture(app, name: "Native routine timezone preview")
  }
  func testTodayOpensCanonicalAssistantAndVoiceReviewSheet() {
    let app = launch()
    XCTAssertTrue(app.buttons["Configure Ranch hand"].waitForExistence(timeout: 10))
    if !app.buttons["openToday"].isHittable {
      let back = app.navigationBars.buttons.matching(identifier: "Your assistants").firstMatch
      if back.exists { back.tap() } else { app.navigationBars.buttons.firstMatch.tap() }
    }
    app.buttons["openToday"].tap()
    XCTAssertTrue(app.staticTexts["Since you were away"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["Fixture: pasture inspection finished."].waitForExistence(timeout: 5), app.debugDescription)
    XCTAssertTrue(app.staticTexts["Fixture routine completed"].waitForExistence(timeout: 5))
    capture(app, name: "Native Today overview")
    app.buttons["today.bot.ranch"].tap()
    XCTAssertTrue(app.buttons["Record voice message"].waitForExistence(timeout: 5)); app.buttons["Record voice message"].tap()
    XCTAssertTrue(app.navigationBars["Voice message"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.buttons["Add text to draft"].exists)
    capture(app, name: "Native explicit voice recording")
  }
  func testUncertainRoutineTrialChecksReceiptBeforeFreshRun() {
    let app = launch()
    XCTAssertTrue(app.buttons["Configure Ranch hand"].waitForExistence(timeout: 10))
    app.buttons["Configure Ranch hand"].tap(); tab("Routines", app: app)
    app.buttons["Edit"].tap()
    for _ in 0..<5 { if app.buttons["Try once"].isHittable { break }; app.collectionViews["routineEditorForm"].swipeUp() }
    app.buttons["Try once"].tap(); app.buttons["Run once now"].tap()
    XCTAssertTrue(app.buttons["Check this run"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.buttons["Try once again"].exists)
    app.buttons["Check this run"].tap()
    XCTAssertTrue(app.staticTexts["Fixture first run completed"].waitForExistence(timeout: 5))
    app.buttons["Try once again"].tap(); app.buttons["Run once now"].tap()
    XCTAssertTrue(app.staticTexts["Fixture second run uses a fresh request ID"].waitForExistence(timeout: 5))
    capture(app, name: "Native routine trial recovery")
  }

  func testDeviceReadAloudOffersExplicitStop() {
    let app = launch()
    XCTAssertTrue(app.buttons["Read aloud"].waitForExistence(timeout: 10))
    app.buttons["Read aloud"].tap()
    XCTAssertTrue(app.buttons["Stop speaking"].waitForExistence(timeout: 3))
    app.buttons["Stop speaking"].tap()
    XCTAssertTrue(app.buttons["Read aloud"].waitForExistence(timeout: 3))
  }

  func testTodayAcknowledgesEachReturnedPageWithoutDroppingLateImports() {
    let app = launch()
    XCTAssertTrue(app.buttons["Configure Ranch hand"].waitForExistence(timeout: 10))
    if !app.buttons["openToday"].isHittable {
      let back = app.navigationBars.buttons.matching(identifier: "Your assistants").firstMatch
      if back.exists { back.tap() } else { app.navigationBars.buttons.firstMatch.tap() }
    }
    app.buttons["openToday"].tap()
    XCTAssertTrue(app.staticTexts["Fixture routine completed"].waitForExistence(timeout: 5))
    let marker = app.buttons["markTodaySeen"]
    XCTAssertEqual(marker.label, "Mark page caught up")
    app.collectionViews["todayOverview"].swipeUp(); marker.tap()
    XCTAssertTrue(app.staticTexts["Fixture late imported completion"].waitForExistence(timeout: 5))
    XCTAssertEqual(marker.label, "Mark caught up")
    capture(app, name: "Native Today preserves late imported event")
    marker.tap()
    let cleared = NSPredicate(format: "exists == false")
    expectation(for: cleared, evaluatedWith: app.staticTexts["Fixture late imported completion"])
    waitForExpectations(timeout: 5)
  }

}
