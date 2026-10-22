import XCTest
@MainActor final class DiscoveryFlowTests: XCTestCase {
  func testSharedWebpageIsReviewedAndImportedWithoutSending() {
    let app=XCUIApplication();app.launchEnvironment["AGENT_INTERFACE_UI_FIXTURE"]="1";app.launchEnvironment["AGENT_INTERFACE_UI_RESET"]="1";app.launchEnvironment["AGENT_INTERFACE_UI_SHARE"]="1";app.launchEnvironment["AGENT_INTERFACE_UI_SCOPE"]=UUID().uuidString;app.launch()
    XCTAssertTrue(app.navigationBars["Review shared content"].waitForExistence(timeout:10),app.debugDescription)
    XCTAssertTrue(app.buttons["Add to draft"].exists)
    let attachment=XCTAttachment(screenshot:app.screenshot());attachment.name="Native shared draft review";attachment.lifetime = .keepAlways;add(attachment)
    app.buttons["Add to draft"].tap()
    let composer=app.textViews["messageComposer"];XCTAssertTrue(composer.waitForExistence(timeout:5),app.debugDescription)
    XCTAssertTrue((composer.value as? String)?.contains("https://example.invalid/shared-page") == true,app.debugDescription)
  }
  /// As the web's history view: a saved reply opens highlighted and in view, a person's text is
  /// not Markdown, and an assistant's exchange shows as its card.
  func testSavedReplyOpensHighlightedAndScrolledIntoView() {
    let app=XCUIApplication();app.launchEnvironment["AGENT_INTERFACE_UI_FIXTURE"]="1";app.launchEnvironment["AGENT_INTERFACE_UI_RESET"]="1";app.launchEnvironment["AGENT_INTERFACE_UI_SCOPE"]=UUID().uuidString;app.launch()
    if !app.buttons["openDiscovery"].waitForExistence(timeout:3) { app.navigationBars.buttons.firstMatch.tap() }
    app.buttons["openDiscovery"].tapWhenReady()
    XCTAssertTrue(app.buttons["Saved items"].waitForExistence(timeout:5));app.buttons["Saved items"].tap()
    XCTAssertTrue(app.buttons["savedItem-saved-2"].waitForExistence(timeout:5));app.buttons["savedItem-saved-2"].tap()
    let saved=app.staticTexts["Fixture saved reply: brisket on Sunday."]
    expectation(for:NSPredicate(format:"hittable == true"),evaluatedWith:saved);waitForExpectations(timeout:10)
    XCTAssertTrue(app.descendants(matching:.any)["savedReplyMarker-history-saved"].exists,app.debugDescription)
    XCTAssertEqual(app.descendants(matching:.any).matching(NSPredicate(format:"identifier BEGINSWITH %@","savedReplyMarker-")).count,1)
    for _ in 0..<20 where !app.staticTexts["Fixture: five easy dinners."].isHittable { app.swipeDown() }
    XCTAssertTrue(app.staticTexts["Use **only** pantry staples"].exists,app.debugDescription)
    XCTAssertTrue(app.staticTexts["Kitchen companion → Ranch hand"].exists,app.debugDescription)
    let attachment=XCTAttachment(screenshot:app.screenshot());attachment.name="Native saved reply history";attachment.lifetime = .keepAlways;add(attachment)
  }
  func testSearchSavedItemsAutomationAndEditableStarter() {
    let app=XCUIApplication();app.launchEnvironment["AGENT_INTERFACE_UI_FIXTURE"]="1";app.launchEnvironment["AGENT_INTERFACE_UI_RESET"]="1";app.launchEnvironment["AGENT_INTERFACE_UI_SCOPE"]=UUID().uuidString;app.launch()
    if !app.buttons["openDiscovery"].waitForExistence(timeout:3) { app.navigationBars.buttons.firstMatch.tap() }
    app.buttons["openDiscovery"].tapWhenReady()
    XCTAssertTrue(app.textFields["Search conversations"].waitForExistence(timeout:5),app.debugDescription)
    app.textFields["Search conversations"].typeWhenFocused("dinners")
    app.buttons["nativeSearchSubmit"].tapWhenReady()
    XCTAssertTrue(app.buttons["nativeSearchResult-history-1"].waitForExistence(timeout:5));app.buttons["nativeSearchResult-history-1"].tap()
    // The hit opens at its matching reply, below the fold; saving the conversation is at the top.
    let match=app.staticTexts["Fixture saved reply: brisket on Sunday."]
    expectation(for:NSPredicate(format:"hittable == true"),evaluatedWith:match);waitForExpectations(timeout:10)
    for _ in 0..<20 where !app.buttons["Save conversation"].isHittable { app.swipeDown() }
    XCTAssertTrue(app.staticTexts["Fixture: five easy dinners."].exists,app.debugDescription);app.buttons["Save conversation"].tap()
    XCTAssertTrue(app.staticTexts["Saved. Find it in Saved items."].waitForExistence(timeout:5));app.buttons["Back to results"].tap()
    app.buttons["Saved items"].tap();XCTAssertTrue(app.buttons["savedItem-saved-1"].waitForExistence(timeout:5))
    XCTAssertTrue(app.buttons["savedItem-saved-1"].label.hasSuffix("· Conversation"),app.buttons["savedItem-saved-1"].label);XCTAssertTrue(app.buttons["Remove Saved conversation"].exists)
    app.buttons["Automations"].tap();XCTAssertTrue(app.staticTexts["Morning report"].waitForExistence(timeout:5));XCTAssertTrue(app.buttons["Pause"].exists)
    XCTAssertTrue(app.buttons["refreshAutomations"].exists);XCTAssertTrue(app.staticTexts["Upcoming work, recent failures and who receives results."].exists)
    let attachment=XCTAttachment(screenshot:app.screenshot());attachment.name="Native automation oversight";attachment.lifetime = .keepAlways;add(attachment)
  }
}
