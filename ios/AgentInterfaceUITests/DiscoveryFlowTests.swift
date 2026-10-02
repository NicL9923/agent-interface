import XCTest
final class DiscoveryFlowTests:XCTestCase {
  func testSharedWebpageIsReviewedAndImportedWithoutSending() {
    let app=XCUIApplication();app.launchEnvironment["AGENT_INTERFACE_UI_FIXTURE"]="1";app.launchEnvironment["AGENT_INTERFACE_UI_RESET"]="1";app.launchEnvironment["AGENT_INTERFACE_UI_SHARE"]="1";app.launchEnvironment["AGENT_INTERFACE_UI_SCOPE"]=UUID().uuidString;app.launch()
    XCTAssertTrue(app.navigationBars["Review shared content"].waitForExistence(timeout:10),app.debugDescription)
    XCTAssertTrue(app.buttons["Add to draft"].exists)
    let attachment=XCTAttachment(screenshot:app.screenshot());attachment.name="Native shared draft review";attachment.lifetime = .keepAlways;add(attachment)
    app.buttons["Add to draft"].tap()
    let composer=app.textFields["messageComposer"];XCTAssertTrue(composer.waitForExistence(timeout:5),app.debugDescription)
    XCTAssertTrue((composer.value as? String)?.contains("https://example.invalid/shared-page") == true,app.debugDescription)
  }
  func testSearchSavedItemsAutomationAndEditableStarter() {
    let app=XCUIApplication();app.launchEnvironment["AGENT_INTERFACE_UI_FIXTURE"]="1";app.launchEnvironment["AGENT_INTERFACE_UI_RESET"]="1";app.launchEnvironment["AGENT_INTERFACE_UI_SCOPE"]=UUID().uuidString;app.launch()
    if !app.buttons["openDiscovery"].waitForExistence(timeout:3) { app.navigationBars.buttons.firstMatch.tap() }
    app.buttons["openDiscovery"].tap()
    XCTAssertTrue(app.textFields["Search answers, files, or a topic"].waitForExistence(timeout:5),app.debugDescription)
    app.textFields["Search answers, files, or a topic"].tap();app.textFields["Search answers, files, or a topic"].typeText("dinners")
    app.buttons["nativeSearchSubmit"].tap()
    XCTAssertTrue(app.buttons["nativeSearchResult-history-1"].waitForExistence(timeout:5));app.buttons["nativeSearchResult-history-1"].tap()
    XCTAssertTrue(app.staticTexts["Fixture: five easy dinners."].waitForExistence(timeout:5));app.buttons["Save conversation"].tap()
    XCTAssertTrue(app.staticTexts["Saved."].waitForExistence(timeout:5));app.buttons["Back to results"].tap()
    app.buttons["Saved"].tap();XCTAssertTrue(app.buttons["Saved conversation"].waitForExistence(timeout:5))
    app.buttons["Automations"].tap();XCTAssertTrue(app.staticTexts["Morning report"].waitForExistence(timeout:5));XCTAssertTrue(app.buttons["Pause"].exists)
    let attachment=XCTAttachment(screenshot:app.screenshot());attachment.name="Native automation oversight";attachment.lifetime = .keepAlways;add(attachment)
  }
}
