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
    // Each turn folds its work into one row; opened, the groups show as before.
    app.expandWork()
    for group in ["Bot messages", "Scheduled jobs", "Subagents", "Background processes", "Diagnostics"] {
      XCTAssertTrue(app.buttons[group].exists, "Missing activity group: " + group)
    }
    let scheduled = app.buttons["Scheduled jobs"]
    for _ in 0..<4 { if scheduled.canTap { break }; app.swipeUp() }
    scheduled.tap()
    app.buttons["Bunny care"].tapWhenReady()
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
    address.typeWhenFocused("http://remote.example")
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
    composer.typeWhenFocused("Remember the fence inspection")
    app.buttons["sendMessage"].tap()
    XCTAssertTrue(app.staticTexts["Remember the fence inspection"].waitForExistence(timeout: 10))
    app.openAssistantSettings("Ranch hand")
    selectSettingsTab(app, "Profile")
    XCTAssertTrue(app.textFields["Name"].waitForExistence(timeout: 5))
    selectSettingsTab(app, "Behavior")
    let web = app.switches.matching(NSPredicate(format: "label BEGINSWITH %@", "Web search")).firstMatch
    XCTAssertTrue(web.waitForExistence(timeout: 5))
    let save = app.buttons["saveChanges"]
    XCTAssertTrue(save.exists); XCTAssertFalse(save.isEnabled, "Nothing to save yet")
    web.switches.firstMatch.tapWhenReady()
    XCTAssertTrue(save.wait(until: "enabled == true"), "A tool change enables Save changes")
    save.tap()
    XCTAssertTrue(app.staticTexts["settingsNotice"].wait(until: "label == %@", "Saved"), "Only the tools were sent")
    app.buttons["Close"].tap()
    let back = app.navigationBars.buttons.matching(identifier: "Your assistants").firstMatch
    if back.exists { back.tap() } else { app.navigationBars.buttons.firstMatch.tap() }
    XCTAssertTrue(app.buttons["bot.kitchen"].waitForExistence(timeout: 5))
    app.buttons["bot.kitchen"].tap()
    XCTAssertTrue(app.chatHeader("Kitchen companion").waitForExistence(timeout: 5))
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
    XCTAssertTrue(app.chatHeader("Ranch hand").waitForExistence(timeout: 10))
    app.openAssistantSettings("Ranch hand")
    selectSettingsTab(app, "Tools")
    XCTAssertTrue(app.buttons["Retry loading tools"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.buttons["saveChanges"].isEnabled)
    XCTAssertFalse(app.staticTexts["No tools were reported by Hermes."].exists)
  }
  func testSeasonalAvatarChoicesSaveAndRemainSelected() {
    let app = app()
    XCTAssertTrue(app.chatHeader("Ranch hand").waitForExistence(timeout: 10))
    app.openAssistantSettings("Ranch hand")
    selectSettingsTab(app, "Profile")
    app.buttons["Mascot"].tapWhenReady()
    let form = app.collectionViews["settings.profile"]
    // Accessibility hit tests see through the sticky preview and Save bars, so a tile under
    // either reads as tappable while a real tap lands on the bar.
    func clear(_ button: XCUIElement) -> Bool {
      guard button.exists, button.canTap else { return false }
      let top = app.descendants(matching: .any)["avatarPreviewBar"], bottom = app.descendants(matching: .any)["saveBar"]
      return (!top.exists || button.frame.minY >= top.frame.maxY) && (!bottom.exists || button.frame.maxY <= bottom.frame.minY)
    }
    func scrollTo(_ button: XCUIElement, up: Bool) {
      for _ in 0..<12 {
        if clear(button) { return }
        if up { form.swipeUp(velocity: .slow) } else { form.swipeDown(velocity: .slow) }
      }
      XCTAssertTrue(clear(button), "\(button) is clear of the sticky bars")
    }
    // The UI tests cannot see app types; SettingsParityTests pins this list to AvatarConfig.seasonalFamilies.
    for family in ["leprechaun", "bunny", "eagle", "pumpkin", "bat", "ghost", "turkey", "santa", "rudolph", "snowman"] {
      let choice = app.buttons["avatarTile.family.\(family)"]
      scrollTo(choice, up: true)
      choice.tap()
      XCTAssertTrue(choice.wait(until: "selected == true"), "\(family) is selected")
      // The preview bar stays in view above the form, so the screenshot shows the new look.
      screenshot(app, "Seasonal native \(family)")
      app.buttons["saveChanges"].tapWhenReady()
      XCTAssertTrue(app.staticTexts["settingsNotice"].wait(until: "label == %@", "Saved"))
      app.buttons["Close"].tap()
      app.openAssistantSettings("Ranch hand")
      selectSettingsTab(app, "Profile")
      scrollTo(app.buttons["avatarTile.family.\(family)"], up: true)
      XCTAssertTrue(app.buttons["avatarTile.family.\(family)"].wait(until: "selected == true"), "\(family) stays selected")
    }
  }
  func testSettingsListOpensEachSectionAndProfileKeepsAvatarVisible() {
    let app = app()
    XCTAssertTrue(app.chatHeader("Ranch hand").waitForExistence(timeout: 10))
    app.openAssistantSettings("Ranch hand")
    XCTAssertFalse(app.buttons["settingsMore"].exists, "No overflow menu")
    let sections = [("profile", "Profile", "Shared with your household"), ("behavior", "Behavior", ""),
      ("access", "Access", "Connections and logins"), ("automation", "Automation", "Routines, goals, tasks and triggers"),
      ("memory", "Memory & learning", "What it remembers and learns")]
    for (id, title, summary) in sections {
      app.showSettingsSections()
      let row = app.buttons["settingsSection.\(id)"]
      XCTAssertTrue(row.waitUntilHittable())
      XCTAssertTrue(row.label.contains(title), row.label)
      if !summary.isEmpty { XCTAssertTrue(row.label.contains(summary), row.label) }
      row.tap()
      XCTAssertTrue(app.navigationBars[title].waitForExistence(timeout: 5), "\(title) opens")
      XCTAssertTrue(app.navigationBars[title].buttons["All settings"].exists, "Back returns to all settings")
      screenshot(app, "Native settings \(title)")
    }
    selectSettingsTab(app, "Profile")
    XCTAssertTrue(app.descendants(matching: .any)["avatarPreviewBar"].waitForExistence(timeout: 5))
    for _ in 0..<4 { app.collectionViews["settings.profile"].swipeUp() }
    XCTAssertTrue(app.buttons["avatarPreviewState"].canTap, "The avatar stays in view while scrolling")
    XCTAssertTrue(app.buttons["saveChanges"].exists)
  }
  func testNativeUpgradeQualificationAndUncertainInstallRecovery() {
    let app = app(upgradeUncertain: true)
    XCTAssertTrue(app.chatHeader("Ranch hand").waitForExistence(timeout: 10))
    if !app.profileMenu.exists { app.navigationBars.buttons.firstMatch.tap() }
    app.openSettingsFromProfileMenu()
    for _ in 0..<5 {
      if app.buttons["Hermes updates"].canTap { break }
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
    XCTAssertFalse(app.buttons["chatModel"].exists, "Simple mode keeps the model in settings")
    XCTAssertFalse(app.buttons["composerModel"].exists, "The composer no longer carries a model button")
    app.buttons["composerAttach"].tap()
    XCTAssertTrue(app.buttons["Photo Library"].waitForExistence(timeout: 5), app.debugDescription)
    XCTAssertTrue(app.buttons["Choose Files"].exists)
    app.terminate()
    app = self.app(liveActivity: true)
    let model = app.buttons["chatModel"]
    XCTAssertTrue(model.waitForExistence(timeout: 10))
    XCTAssertTrue(model.isEnabled, "Lean roster bots have no instructions; capability enables the model picker")
    XCTAssertLessThan(model.frame.maxY, app.textViews["messageComposer"].frame.minY, "The chip sits in the header, not in the composer")
    XCTAssertGreaterThanOrEqual(model.frame.height, 44, "The chip's touch target reaches 44 points")
    if UIDevice.current.userInterfaceIdiom == .phone {
      // On a phone it is the provider's mark alone, at the end of the assistant's header row.
      let header = app.buttons["botProfile"]
      XCTAssertTrue(app.navigationBars.buttons["chatModel"].exists, "The mark sits in the header row")
      XCTAssertGreaterThan(model.frame.minX, header.frame.maxX, "It sits after the assistant, at the row's end")
      XCTAssertLessThan(abs(model.frame.midY - header.frame.midY), 24, "It shares the assistant's row")
      XCTAssertLessThanOrEqual(model.frame.width, 60, "Only the mark shows, not the model name; VoiceOver reads the model")
    }
    screenshot(app, "Advanced chat with the model chip")
    model.tap()
    let fast = app.buttons["Fixture fast model"]
    XCTAssertTrue(fast.waitForExistence(timeout: 5), app.debugDescription); fast.tap()
    expectation(for: NSPredicate(format: "label == %@", "Model: fixture-fast"), evaluatedWith: app.buttons["chatModel"])
    waitForExpectations(timeout: 10)
  }
  func testCommandPeriodAsksBeforeStoppingActiveWork() {
    let app = app(liveActivity: true)
    XCTAssertTrue(app.staticTexts["Ranch hand is checking the latest forecast..."].waitForExistence(timeout: 10))
    XCTAssertEqual(app.buttons["sendMessage"].label, "Stop response")
    app.shortcut(".", shows: app.buttons["Stop work"])
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
    // The live row beside the working avatar names the current tool and the latest reasoning line.
    XCTAssertTrue(app.staticTexts["liveReceipt"].waitForExistence(timeout: 5))
    XCTAssertEqual(app.staticTexts["liveReceipt"].label, "Action in progress · web_search")
    XCTAssertTrue(app.staticTexts["liveReasoning"].exists)
    let work = app.buttons["turnWork"]
    XCTAssertTrue(work.waitForExistence(timeout: 5)); XCTAssertTrue(work.label.hasPrefix("Working"), work.label)
    work.tapWhenReady()
    app.buttons["Reasoning"].tapWhenReady()
    XCTAssertTrue(app.staticTexts["Fixture exposed reasoning: current weather needs a fresh forecast."].waitForExistence(timeout: 5))
    app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Tool calls")).firstMatch.tapWhenReady()
    app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "web_search")).firstMatch.tapWhenReady()
    XCTAssertTrue(app.staticTexts["{\"query\":\"Texas ranch weather forecast\"}"].waitForExistence(timeout: 5))
    screenshot(app, "Fixture native live activity and exposed tool details")
  }
  func testNativeConnectionsCheckAndApplePermissionDenial() {
    let app = app()
    XCTAssertTrue(app.chatHeader("Ranch hand").waitForExistence(timeout: 10))
    app.openAssistantSettings("Ranch hand")
    selectSettingsTab(app, "Connections")
    XCTAssertTrue(app.staticTexts["Configured · not checked"].waitForExistence(timeout: 10))
    app.buttons.matching(identifier: "Check connection").firstMatch.tap()
    XCTAssertTrue(app.staticTexts["Connected"].waitForExistence(timeout: 10))
    screenshot(app, "Native integration accounts fixture")
    for _ in 0..<6 {
      if app.buttons["Apple Calendar & Reminders"].canTap { break }
      app.swipeUp()
    }
    app.buttons["Apple Calendar & Reminders"].tap()
    XCTAssertTrue(app.staticTexts["On this iPhone"].waitForExistence(timeout: 5))
    if app.buttons["Allow calendar access"].exists {
      addUIInterruptionMonitor(withDescription: "Calendar permission") { alert in
        let deny = alert.buttons.labeled("Don't Allow")
        if deny.exists { deny.tap(); return true }
        return false
      }
      app.buttons["Allow calendar access"].tap()
      let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
      // iOS 26 writes the label with a typographic apostrophe; `labeled` accepts either.
      let deny = springboard.buttons.labeled("Don't Allow")
      if deny.waitForExistence(timeout: 10) { deny.tap() }
      else { app.tap() }
      XCTAssertTrue(app.staticTexts["Permission denied"].waitForExistence(timeout: 10))
    }
    screenshot(app, "Native Apple data selection and permission status")
    XCTAssertFalse(app.buttons["Share with Ranch hand"].exists)
  }
  func testNativeFailedUpdateOffersGuardedRecovery() {
    let app = app(upgradeFailed: true)
    XCTAssertTrue(app.chatHeader("Ranch hand").waitForExistence(timeout: 10))
    if !app.profileMenu.exists { app.navigationBars.buttons.firstMatch.tap() }
    app.openSettingsFromProfileMenu()
    for _ in 0..<6 { if app.buttons["Hermes updates"].canTap { break }; app.swipeUp() }
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
    app.buttons["Yes, restart Hermes"].tapWhenReady()
    XCTAssertTrue(app.staticTexts["Restoring the connection"].waitForExistence(timeout: 5))
    screenshot(app, "Native service recovery progress fixture")
  }
  func testNativeDisconnectRefreshesAfterTheHermesFlowResponse() {
    let app = app()
    XCTAssertTrue(app.chatHeader("Ranch hand").waitForExistence(timeout: 10))
    app.openAssistantSettings("Ranch hand")
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
