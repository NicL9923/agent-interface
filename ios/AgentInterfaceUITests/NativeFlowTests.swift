import XCTest

final class NativeFlowTests: XCTestCase {
  private func app(fixture: Bool = true, catalogFailure: Bool = false, upgradeUncertain: Bool = false, liveActivity: Bool = false, upgradeFailed: Bool = false) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchEnvironment["AGENT_INTERFACE_UI_RESET"] = "1"
    if fixture {
      app.launchEnvironment["AGENT_INTERFACE_UI_FIXTURE"] = "1"
      app.launchEnvironment["AGENT_INTERFACE_UI_SCOPE"] = UUID().uuidString.lowercased()
    }
    if catalogFailure { app.launchEnvironment["AGENT_INTERFACE_UI_CATALOG_FAILURE"] = "1" }
    if upgradeUncertain { app.launchEnvironment["AGENT_INTERFACE_UI_UPGRADE_UNCERTAIN"] = "1" }
    if upgradeFailed { app.launchEnvironment["AGENT_INTERFACE_UI_UPGRADE_FAILED"] = "1" }
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
    selectSettingsTab(app, "Tools")
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
    selectSettingsTab(app, "Tools")
    XCTAssertTrue(app.buttons["Retry loading tools"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.buttons["Save tools"].isEnabled)
    XCTAssertFalse(app.staticTexts["No tools were reported by Hermes."].exists)
  }
  func testSeasonalAvatarChoicesSaveAndRemainSelected() {
    let app = app()
    XCTAssertTrue(app.buttons["Configure Ranch hand"].waitForExistence(timeout: 10))
    app.buttons["Configure Ranch hand"].tap()
    app.buttons["Avatar"].tap()
    app.buttons["Mascot"].tap()
    func scrollTo(_ button: XCUIElement, up: Bool) {
      for _ in 0..<8 {
        if button.exists && button.isHittable { return }
        if up { app.swipeUp() } else { app.swipeDown() }
      }
      XCTAssertTrue(button.isHittable)
    }
    for family in ["pumpkin", "santa", "rudolph", "turkey", "bunny"] {
      let choice = app.buttons["avatarTile.family.\(family)"]
      scrollTo(choice, up: true)
      choice.tap()
      XCTAssertTrue(choice.isSelected)
      scrollTo(app.buttons["previewState.idle"], up: false)
      screenshot(app, "Seasonal native \(family)")
      scrollTo(app.buttons["Save avatar"], up: true)
      app.buttons["Save avatar"].tap()
      XCTAssertTrue(app.staticTexts["Avatar saved."].waitForExistence(timeout: 5))
      app.buttons["Close"].tap()
      app.buttons["Configure Ranch hand"].tap()
      app.buttons["Avatar"].tap()
      scrollTo(app.buttons["avatarTile.family.\(family)"], up: true)
      XCTAssertTrue(app.buttons["avatarTile.family.\(family)"].isSelected)
    }
  }
  func testSettingsOverflowSelectsEverySectionAndKeepsAvatarVisible() {
    let app = app()
    XCTAssertTrue(app.buttons["Configure Ranch hand"].waitForExistence(timeout: 10))
    app.buttons["Configure Ranch hand"].tap()
    let more = app.buttons["settingsMore"]
    for title in ["Connections", "Tools", "Skills", "Routines"] {
      XCTAssertTrue(app.buttons["Details"].isHittable)
      XCTAssertTrue(app.buttons["Avatar"].isHittable)
      selectSettingsTab(app, title)
      XCTAssertEqual(more.value as? String, title)
      XCTAssertGreaterThanOrEqual(more.frame.minX, 0)
      XCTAssertLessThanOrEqual(more.frame.maxX, app.frame.maxX)
      screenshot(app, "Native settings \(title) selected")
      app.buttons["Avatar"].tap()
      XCTAssertTrue(app.buttons["previewState.idle"].waitForExistence(timeout: 5))
      XCTAssertTrue((more.value as? String ?? "").isEmpty)
    }
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
  func testNativeConnectionsCheckAndApplePermissionDenial() {
    let app = app()
    XCTAssertTrue(app.buttons["Configure Ranch hand"].waitForExistence(timeout: 10))
    app.buttons["Configure Ranch hand"].tap()
    selectSettingsTab(app, "Connections")
    XCTAssertTrue(app.staticTexts["Configured · not checked"].waitForExistence(timeout: 10))
    app.buttons.matching(identifier: "Check connection").firstMatch.tap()
    XCTAssertTrue(app.staticTexts["Connected"].waitForExistence(timeout: 10))
    screenshot(app, "Native integration accounts fixture")
    for _ in 0..<6 {
      if app.buttons["Apple Calendar & Reminders"].isHittable { break }
      app.swipeUp()
    }
    app.buttons["Apple Calendar & Reminders"].tap()
    XCTAssertTrue(app.staticTexts["On this iPhone"].waitForExistence(timeout: 5))
    if app.buttons["Allow calendar access"].exists {
      addUIInterruptionMonitor(withDescription: "Calendar permission") { alert in
        if alert.buttons["Don't Allow"].exists { alert.buttons["Don't Allow"].tap(); return true }
        return false
      }
      app.buttons["Allow calendar access"].tap()
      let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
      let deny = springboard.buttons["Don't Allow"]
      if deny.waitForExistence(timeout: 10) { deny.tap() }
      else { app.tap() }
      XCTAssertTrue(app.staticTexts["Permission denied"].waitForExistence(timeout: 10))
    }
    screenshot(app, "Native Apple data selection and permission status")
    XCTAssertFalse(app.buttons["Share with Ranch hand"].exists)
  }
  func testNativeFailedUpdateOffersGuardedRecovery() {
    let app = app(upgradeFailed: true)
    XCTAssertTrue(app.buttons["Configure Ranch hand"].waitForExistence(timeout: 10))
    if !app.buttons["Your preferences"].exists { app.navigationBars.buttons.firstMatch.tap() }
    app.buttons["Your preferences"].tap()
    for _ in 0..<6 { if app.buttons["Hermes updates"].isHittable { break }; app.swipeUp() }
    app.buttons["Hermes updates"].tap()
    XCTAssertTrue(app.buttons["restartHermesService"].waitForExistence(timeout: 10))
    screenshot(app, "Native failed update recovery fixture")
    app.buttons["restartHermesService"].tap()
    XCTAssertTrue(app.staticTexts["Restart Hermes and check the connection?"].waitForExistence(timeout: 5))
    app.buttons.matching(identifier: "Restart Hermes").allElementsBoundByIndex.last?.tap()
    XCTAssertTrue(app.staticTexts["Restoring the connection"].waitForExistence(timeout: 5))
    screenshot(app, "Native service recovery progress fixture")
  }
  func testNativeDisconnectRefreshesAfterTheHermesFlowResponse() {
    let app = app()
    XCTAssertTrue(app.buttons["Configure Ranch hand"].waitForExistence(timeout: 10))
    app.buttons["Configure Ranch hand"].tap()
    selectSettingsTab(app, "Connections")
    XCTAssertTrue(app.buttons["Disconnect"].waitForExistence(timeout: 10))
    app.buttons["Disconnect"].tap()
    let confirm = app.buttons.matching(identifier: "Disconnect").allElementsBoundByIndex.last
    XCTAssertNotNil(confirm)
    confirm?.tap()
    XCTAssertTrue(app.staticTexts["Not connected"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.staticTexts["The connection change may have reached Hermes"].exists)
    screenshot(app, "Native connection removed after confirmation")
  }
  private func screenshot(_ app: XCUIApplication, _ name: String) {
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }
  private func selectSettingsTab(_ app: XCUIApplication, _ title: String) {
    app.buttons["settingsMore"].tap()
    XCTAssertTrue(app.buttons[title].waitForExistence(timeout: 5))
    app.buttons[title].tap()
  }
}
