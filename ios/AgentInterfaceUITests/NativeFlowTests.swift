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
    let botMessages = app.buttons["botMessages"]
    XCTAssertTrue(botMessages.waitForExistence(timeout: 5), app.debugDescription)
    XCTAssertEqual(botMessages.value as? String, "Collapsed")
    XCTAssertTrue(botMessages.label.contains("3 bot messages"), botMessages.label)
    XCTAssertTrue(botMessages.label.contains("1 failed"), botMessages.label)
    XCTAssertFalse(app.staticTexts["Thanks, I will check the gate."].exists)
    botMessages.revealAboveComposer()
    botMessages.tapWhenReady()
    XCTAssertTrue(app.staticTexts["Thanks, I will check the gate."].waitForExistence(timeout: 5))
    let exchange = XCTAttachment(screenshot: app.screenshot())
    exchange.name = "Bot exchange routes expanded"
    exchange.lifetime = .keepAlways
    add(exchange)
    botMessages.tapWhenReady()
    XCTAssertFalse(app.staticTexts["Thanks, I will check the gate."].exists)
    // Each turn folds its work into one row; opened, the groups show as before.
    app.expandWork()
    for group in ["Scheduled jobs", "Subagents", "Background processes", "Diagnostics"] {
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
    app.openBotProfile("Ranch hand")
    app.buttons["profileFind"].tapWhenReady()
    app.textFields["findConversation"].typeWhenFocused("Thanks, I will check the gate.")
    XCTAssertTrue(app.staticTexts["findStatus"].wait(until: "label == %@", "1 of 1"))
    XCTAssertTrue(app.staticTexts["Thanks, I will check the gate."].waitUntilHittable(timeout: 15), "Find reveals the collapsed bot message")
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
  func testShapeChoicesFromEachGroupSaveAndRemainSelected() {
    let app = app()
    XCTAssertTrue(app.chatHeader("Ranch hand").waitForExistence(timeout: 10))
    app.openAssistantSettings("Ranch hand")
    selectSettingsTab(app, "Profile")
    XCTAssertTrue(app.buttons["Character"].wait(until: "selected == true"))
    let form = app.collectionViews["settings.profile"]
    // Accessibility hit tests see through the sticky preview and Save bars, so a tile under
    // either reads as tappable while a real tap lands on the bar.
    func clear(_ button: XCUIElement) -> Bool {
      guard button.hasFrame else { return false }
      let top = app.descendants(matching: .any)["avatarPreviewBar"], bottom = app.descendants(matching: .any)["saveBar"]
      return (!top.exists || button.frame.minY >= top.frame.maxY) && (!bottom.exists || button.frame.maxY <= bottom.frame.minY)
    }
    func scrollTo(_ button: XCUIElement, up: Bool) {
      // The shape picker holds 54 tiles, so a seasonal one is many short drags down.
      for _ in 0..<40 {
        if clear(button) { return }
        let top = app.descendants(matching: .any)["avatarPreviewBar"]
        let bottom = app.descendants(matching: .any)["saveBar"]
        let upper = max(form.frame.minY, top.exists ? top.frame.maxY : form.frame.minY) + 8
        let lower = min(form.frame.maxY, bottom.exists ? bottom.frame.minY : form.frame.maxY) - 8
        let upward = button.hasFrame ? button.frame.maxY > lower : up
        // A full swipe can pass the whole tile before it is checked again.
        // Short gutter drags also avoid the controls inside each form row.
        let middle = (upper + lower) / 2
        let distance = min(120, (lower - upper) / 4)
        let start = form.coordinate(withNormalizedOffset: .zero)
          .withOffset(CGVector(dx: 4, dy: middle + (upward ? distance / 2 : -distance / 2) - form.frame.minY))
        start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: upward ? -distance : distance)),
                    withVelocity: .slow, thenHoldForDuration: 0.2)
      }
      XCTAssertTrue(clear(button), "\(button) is clear of the sticky bars")
    }
    // One shape from each group after Classic. The seasonal pumpkin brings its orange, and the
    // shapes on either side keep whatever color is chosen at the time.
    for (shape, color) in [("mug", "#1084FE"), ("pumpkin", "#FF6700"), ("tars", "#FF6700")] {
      let choice = app.buttons["avatarTile.shape.\(shape)"]
      scrollTo(choice, up: true)
      choice.tap()
      XCTAssertTrue(choice.wait(until: "selected == true"), "\(shape) is selected")
      // The preview bar stays in view above the form, so the screenshot shows the new look.
      screenshot(app, "Shape native \(shape)")
      app.buttons["saveChanges"].tapWhenReady()
      XCTAssertTrue(app.staticTexts["settingsNotice"].wait(until: "label == %@", "Saved"))
      app.buttons["Close"].tap()
      app.openAssistantSettings("Ranch hand")
      selectSettingsTab(app, "Profile")
      scrollTo(app.buttons["avatarTile.shape.\(shape)"], up: true)
      XCTAssertTrue(app.buttons["avatarTile.shape.\(shape)"].wait(until: "selected == true"), "\(shape) stays selected")
      let swatch = app.buttons["Color \(color)"]
      scrollTo(swatch, up: true)
      XCTAssertTrue(swatch.wait(until: "selected == true"), "\(shape) saved in \(color)")
    }
  }
  func testSettingsListOpensEachSectionAndProfileKeepsAvatarVisible() {
    let app = app()
    XCTAssertTrue(app.chatHeader("Ranch hand").waitForExistence(timeout: 10))
    app.openAssistantSettings("Ranch hand")
    XCTAssertFalse(app.buttons["settingsMore"].exists, "No overflow menu")
    let sections = [("profile", "Profile", "Shared with your household"), ("behavior", "Behavior", ""),
      ("access", "Access", "Logins and approvals"), ("automation", "Automation", "Scheduled routines"),
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
