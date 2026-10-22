import XCTest

@MainActor final class NativeFlowTests: XCTestCase {
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
  func testCoordinationActivityKeepsScheduledAnswerVisible() {
    let app = XCUIApplication()
    app.launchEnvironment["AGENT_INTERFACE_UI_FIXTURE"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_RESET"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_SCOPE"] = UUID().uuidString.lowercased()
    app.launchEnvironment["AGENT_INTERFACE_UI_COORDINATION"] = "1"
    app.launch()
    XCTAssertTrue(app.staticTexts["Scheduled"].waitForExistence(timeout: 10))
    let handoff = app.staticTexts["Scheduled job handoff: hay, water, and bunny check"]
    XCTAssertFalse(handoff.exists)
    XCTAssertFalse(app.staticTexts["Internal delivery retry details."].exists)
    let collapsed = XCTAttachment(screenshot: app.screenshot())
    collapsed.name = "Scheduled answer with coordination collapsed"
    collapsed.lifetime = .keepAlways
    add(collapsed)
    for group in ["Bot messages", "Scheduled jobs", "Subagents", "Background processes", "Diagnostics"] {
      XCTAssertTrue(app.buttons[group].exists, "Missing activity group: " + group)
    }
    let scheduled = app.buttons["Scheduled jobs"]
    for _ in 0..<4 { if scheduled.isHittable { break }; app.swipeUp() }
    scheduled.tap()
    app.buttons["Bunny care"].tap()
    XCTAssertTrue(handoff.waitForExistence(timeout: 5))
    let expanded = XCTAttachment(screenshot: app.screenshot())
    expanded.name = "Scheduled job details expanded"
    expanded.lifetime = .keepAlways
    add(expanded)
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
    let composer = app.textViews["messageComposer"]
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
      XCTAssertTrue(app.staticTexts["Avatar saved"].waitForExistence(timeout: 5))
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
    if !app.buttons["Settings"].exists { app.navigationBars.buttons.firstMatch.tap() }
    app.buttons["Settings"].tap()
    for _ in 0..<5 {
      if app.buttons["Hermes updates"].isHittable { break }
      app.swipeUp()
    }
    app.buttons["Hermes updates"].tap()
    XCTAssertTrue(app.buttons["checkHermesUpdate"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.buttons["installHermesUpdate"].exists)
    app.buttons["checkHermesUpdate"].tap()
    XCTAssertTrue(app.staticTexts["Testing the update"].waitForExistence(timeout: 5))
    XCTAssertEqual(app.descendants(matching: .any)["upgradeStep.Test in a copy"].label, "Test in a copy: in progress")
    XCTAssertEqual(app.descendants(matching: .any)["upgradeStep.Install"].label, "Install: not started")
    XCTAssertTrue(app.buttons["stopHermesCheck"].exists, "A running check can be stopped without confirmation")
    XCTAssertFalse(app.buttons["cancelHermesUpdate"].exists, "Cancel and retry belong to installs")
    screenshot(app, "Fixture native Hermes qualification")
    XCTAssertTrue(app.buttons["installHermesUpdate"].waitForExistence(timeout: 10))
    screenshot(app, "Fixture native Hermes update ready")
    app.buttons["installHermesUpdate"].tap()
    XCTAssertTrue(app.staticTexts["Update the household's Hermes installation?"].waitForExistence(timeout: 5))
    // The dialog's own button: the one that opened it has the same label and stays in the tree behind it.
    let install = app.sheets.buttons["Install update"]
    XCTAssertTrue(install.waitForExistence(timeout: 5)); install.tap()
    XCTAssertTrue(app.buttons["refreshHermesUpdate"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.buttons["installHermesUpdate"].isEnabled)
    screenshot(app, "Fixture native uncertain Hermes update")
    app.buttons["refreshHermesUpdate"].tap()
    XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label IN %@", ["Installing the update", "Making sure everything works"])).firstMatch.waitForExistence(timeout: 5))
    screenshot(app, "Fixture native Hermes install progress")
    XCTAssertTrue(app.staticTexts["Hermes is up to date"].waitForExistence(timeout: 15))
    XCTAssertFalse(app.buttons["installHermesUpdate"].exists)
    screenshot(app, "Fixture native Hermes verified")
  }
  func testComposerAttachMenuAndAdvancedModelSwitch() {
    var app = app()
    let composer = app.textViews["messageComposer"]
    XCTAssertTrue(composer.waitForExistence(timeout: 10))
    XCTAssertFalse(app.buttons["composerModel"].exists, "Simple mode keeps the model in settings")
    app.buttons["composerAttach"].tap()
    XCTAssertTrue(app.buttons["Photo Library"].waitForExistence(timeout: 5), app.debugDescription)
    XCTAssertTrue(app.buttons["Choose Files"].exists)
    app.terminate()
    app = self.app(liveActivity: true)
    let model = app.buttons["composerModel"]
    XCTAssertTrue(model.waitForExistence(timeout: 10))
    XCTAssertTrue(model.isEnabled, "Lean roster bots have no instructions; capability enables the model picker")
    XCTAssertLessThanOrEqual(model.frame.width, 50, "The composer shows only the model icon, as the web does at phone width")
    model.tap()
    let fast = app.buttons["Fixture fast model"]
    XCTAssertTrue(fast.waitForExistence(timeout: 5), app.debugDescription); fast.tap()
    expectation(for: NSPredicate(format: "label == %@", "Model: fixture-fast"), evaluatedWith: app.buttons["composerModel"])
    waitForExpectations(timeout: 10)
  }
  func testCommandPeriodAsksBeforeStoppingActiveWork() {
    let app = app(liveActivity: true)
    XCTAssertTrue(app.staticTexts["Ranch hand is checking the latest forecast..."].waitForExistence(timeout: 10))
    XCTAssertEqual(app.buttons["sendMessage"].label, "Stop response")
    app.typeKey(".", modifierFlags: .command)
    XCTAssertTrue(app.buttons["Stop work"].waitForExistence(timeout: 5), "The shortcut asks first")
    // Tapping away dismisses the popover (iPad) or sheet (iPhone) without choosing.
    app.coordinate(withNormalizedOffset: CGVector(dx: 0.02, dy: 0.5)).tap()
    expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: app.buttons["Stop work"])
    waitForExpectations(timeout: 5)
    XCTAssertEqual(app.buttons["sendMessage"].label, "Stop response", "Dismissing the question stops nothing")
  }
  func testNativeLiveActivityShowsActualExposedDetails() {
    let app = app(liveActivity: true)
    XCTAssertTrue(app.staticTexts["Ranch hand is checking the latest forecast..."].waitForExistence(timeout: 10))
    XCTAssertEqual(app.buttons["sendMessage"].label, "Stop response")
    XCTAssertFalse(app.buttons["Listen to reply"].exists, "Replies are offered aloud only while idle")
    app.buttons["Reasoning"].tap()
    XCTAssertTrue(app.staticTexts["Fixture exposed reasoning: current weather needs a fresh forecast."].exists)
    app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Tool calls")).firstMatch.tap()
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
    if !app.buttons["Settings"].exists { app.navigationBars.buttons.firstMatch.tap() }
    app.buttons["Settings"].tap()
    for _ in 0..<6 { if app.buttons["Hermes updates"].isHittable { break }; app.swipeUp() }
    app.buttons["Hermes updates"].tap()
    XCTAssertTrue(app.buttons["restartHermesService"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["The update couldn't finish"].exists)
    XCTAssertTrue(app.buttons["retryHermesUpdate"].exists, "Retry is offered for a failed install")
    XCTAssertEqual(app.descendants(matching: .any)["upgradeStep.Install"].label, "Install: stopped")
    for _ in 0..<5 { if app.staticTexts["App compatibility"].exists { break }; app.swipeUp() }
    XCTAssertTrue(app.staticTexts["App compatibility"].exists, "Test details open on their own after a failure")
    screenshot(app, "Native failed update recovery fixture")
    app.buttons["restartHermesService"].tap()
    XCTAssertTrue(app.staticTexts["Restart the Hermes service and check the connection? This may briefly disconnect everyone."].waitForExistence(timeout: 5))
    app.buttons["Yes, restart Hermes"].tap()
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
    let confirm = app.sheets.buttons["Disconnect"]
    XCTAssertTrue(confirm.waitForExistence(timeout: 5)); confirm.tap()
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
  private func selectSettingsTab(_ app: XCUIApplication, _ title: String, line: UInt = #line) {
    app.selectSettingsTab(title, line: line)
  }
}
