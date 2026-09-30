import XCTest

final class NativeFlowTests: XCTestCase {
  private func app(fixture: Bool = true, catalogFailure: Bool = false, upgradeUncertain: Bool = false, liveActivity: Bool = false) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchEnvironment["AGENT_INTERFACE_UI_RESET"] = "1"
    if fixture {
      app.launchEnvironment["AGENT_INTERFACE_UI_FIXTURE"] = "1"
      app.launchEnvironment["AGENT_INTERFACE_UI_SCOPE"] = UUID().uuidString.lowercased()
    }
    if catalogFailure { app.launchEnvironment["AGENT_INTERFACE_UI_CATALOG_FAILURE"] = "1" }
    if upgradeUncertain { app.launchEnvironment["AGENT_INTERFACE_UI_UPGRADE_UNCERTAIN"] = "1" }
    if liveActivity { app.launchEnvironment["AGENT_INTERFACE_UI_LIVE_ACTIVITY"] = "1" }
    app.launch()
    return app
  }
  func testOnboardingValidatesAddressWithoutDroppingEnteredText() {
    let app = app(fixture: false)
    let address = app.textFields["serverAddress"]
    XCTAssertTrue(address.waitForExistence(timeout: 10))
    address.tap()
    address.typeText("http://remote.example")
    app.buttons["connectServer"].tap()
    XCTAssertTrue(
      app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "HTTP is supported only"))
        .firstMatch.waitForExistence(timeout: 5))
    XCTAssertEqual(address.value as? String, "http://remote.example")
    XCTAssertTrue(app.buttons["connectServer"].isEnabled)
  }
  func testPhoneListConversationSendAndConfiguration() {
    let app = app()
    let composer = app.textFields["messageComposer"]
    XCTAssertTrue(composer.waitForExistence(timeout: 10))
    composer.tap()
    composer.typeText("Remember the fence inspection")
    app.buttons["sendMessage"].tap()
    XCTAssertTrue(app.staticTexts["Remember the fence inspection"].waitForExistence(timeout: 10))
    app.buttons["Configure Ranch hand"].tap()
    XCTAssertTrue(app.textFields["Name"].waitForExistence(timeout: 5))
    app.buttons["Tools"].tap()
    XCTAssertTrue(
      app.switches.matching(NSPredicate(format: "label BEGINSWITH %@", "Web search")).firstMatch
        .waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["Save tools"].isEnabled)
    app.buttons["Avatar"].tap()
    for _ in 0..<4 {
      if app.buttons["Save avatar"].exists { break }
      app.swipeUp()
    }
    XCTAssertTrue(app.buttons["Save avatar"].waitForExistence(timeout: 5))
    app.buttons["Close"].tap()
    let back = app.navigationBars.buttons.matching(identifier: "Your assistants").firstMatch
    if back.exists { back.tap() } else { app.navigationBars.buttons.firstMatch.tap() }
    XCTAssertTrue(app.buttons["bot.kitchen"].waitForExistence(timeout: 5))
    app.buttons["bot.kitchen"].tap()
    XCTAssertTrue(app.buttons["Configure Kitchen companion"].waitForExistence(timeout: 5))
    XCTAssertFalse(
      app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "unreadable response"))
        .firstMatch.exists)
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = "Native phone conversation"
    attachment.lifetime = .keepAlways
    add(attachment)
  }
  func testFailedCapabilityCatalogCannotDisableExistingTools() {
    let app = app(catalogFailure: true)
    XCTAssertTrue(app.buttons["Configure Ranch hand"].waitForExistence(timeout: 10))
    app.buttons["Configure Ranch hand"].tap()
    app.buttons["Tools"].tap()
    XCTAssertTrue(app.buttons["Retry loading tools"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.buttons["Save tools"].isEnabled)
    XCTAssertFalse(app.staticTexts["No tools were reported by Hermes."].exists)
  }
  func testNativeUpgradeQualificationAndUncertainInstallRecovery() {
    let app = app(upgradeUncertain: true)
    XCTAssertTrue(app.buttons["Configure Ranch hand"].waitForExistence(timeout: 10))
    if !app.buttons["Your preferences"].exists { app.navigationBars.buttons.firstMatch.tap() }
    app.buttons["Your preferences"].tap()
    for _ in 0..<5 {
      if app.buttons["Hermes updates"].isHittable { break }
      app.swipeUp()
    }
    app.buttons["Hermes updates"].tap()
    XCTAssertTrue(app.buttons["checkHermesUpdate"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.buttons["installHermesUpdate"].exists)
    app.buttons["checkHermesUpdate"].tap()
    XCTAssertTrue(app.staticTexts["Checking compatibility"].waitForExistence(timeout: 5))
    screenshot(app, "Fixture native Hermes qualification")
    XCTAssertTrue(app.buttons["installHermesUpdate"].waitForExistence(timeout: 10))
    screenshot(app, "Fixture native Hermes update ready")
    app.buttons["installHermesUpdate"].tap()
    XCTAssertTrue(app.staticTexts["Update the household's Hermes installation?"].waitForExistence(timeout: 5))
    app.buttons.matching(identifier: "Update Hermes").allElementsBoundByIndex.last?.tap()
    XCTAssertTrue(app.buttons["refreshHermesUpdate"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.buttons["installHermesUpdate"].isEnabled)
    screenshot(app, "Fixture native uncertain Hermes update")
    app.buttons["refreshHermesUpdate"].tap()
    XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label IN %@", ["Updating Hermes", "Verifying Hermes"])).firstMatch.waitForExistence(timeout: 5))
    screenshot(app, "Fixture native Hermes install progress")
    XCTAssertTrue(app.staticTexts["Hermes is up to date"].waitForExistence(timeout: 15))
    XCTAssertFalse(app.buttons["installHermesUpdate"].exists)
    screenshot(app, "Fixture native Hermes verified")
  }
  func testNativeLiveActivityShowsActualExposedDetails() {
    let app = app(liveActivity: true)
    XCTAssertTrue(app.staticTexts["Ranch hand is working"].waitForExistence(timeout: 10))
    app.buttons["Reasoning"].tap()
    XCTAssertTrue(app.staticTexts["Fixture exposed reasoning: current weather needs a fresh forecast."].exists)
    app.buttons["Activity details"].tap()
    app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "web_search")).firstMatch.tap()
    XCTAssertTrue(app.staticTexts["{\"query\":\"Texas ranch weather forecast\"}"].waitForExistence(timeout: 5))
    screenshot(app, "Fixture native live activity and exposed tool details")
  }
  private func screenshot(_ app: XCUIApplication, _ name: String) {
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }
}
