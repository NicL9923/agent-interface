import XCTest
import CryptoKit

@MainActor final class AutomationFlowTests: XCTestCase {
  private func launch(_ options: [String] = [], presentation: String? = nil) -> XCUIApplication {
    let app = XCUIApplication()
    if let presentation { app.launchEnvironment["AGENT_INTERFACE_UI_PRESENTATION"] = presentation }
    app.launchEnvironment["AGENT_INTERFACE_UI_FIXTURE"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_RESET"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_EXPERIENCE"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_AUTOMATION"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_SCOPE"] = UUID().uuidString.lowercased()
    for option in options { app.launchEnvironment["AGENT_INTERFACE_UI_AUTOMATION_" + option] = "1" }
    app.launch()
    XCTAssertTrue(app.chatHeader("Ranch hand").waitForExistence(timeout: 15), app.debugDescription)
    app.openAssistantSettings("Ranch hand")
    return app
  }
  private func capture(_ app: XCUIApplication, _ name: String) {
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
  }
  private func reveal(_ element: XCUIElement, in container: XCUIElement, downward: Bool = false) {
    for _ in 0..<8 {
      if element.canTap { return }
      if downward { container.swipeDown() } else { container.swipeUp() }
    }
    XCTAssertTrue(element.waitForFrame(timeout: 5), "The form shows \(element)")
  }
  private func text(_ fragment: String, app: XCUIApplication) -> XCUIElement {
    app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", fragment)).firstMatch
  }
  /// One native thumb drag. The labelled row supplies the state; its inner UISwitch supplies
  /// the gesture bounds. A failed precondition or result fails the test without another gesture.
  /// It scrolls `container` until the inner UISwitch can be tapped. A row at the edge of a form
  /// can show a sliver below the navigation bar, which makes the row hittable while the switch
  /// stays covered.
  @discardableResult private func setSwitch(
    _ row: XCUIElement, in container: XCUIElement, downward: Bool = false, to enabled: Bool,
    expectedFinalValue: Bool? = nil, afterGesture: () -> Bool = { true },
    file: StaticString = #filePath, line: UInt = #line
  ) -> Bool {
    // A form lists only the rows near the screen, so the row may not exist before this scroll.
    let control = row.switches.firstMatch
    reveal(control, in: container, downward: downward)
    guard row.waitForExistence(timeout: 5), row.wait(until: "enabled == true") else {
      XCTFail("The switch row must be enabled.\n\(row.debugDescription)", file: file, line: line)
      return false
    }
    guard row.wait(until: "value == %@", enabled ? "0" : "1") else {
      XCTFail("The switch must start \(enabled ? "off" : "on").\n\(row.debugDescription)", file: file, line: line)
      return false
    }
    guard control.waitForExistence(timeout: 5), control.wait(until: "enabled == true"), control.waitUntilHittable() else {
      XCTFail("The row must contain an enabled, hittable UISwitch.\n\(row.debugDescription)", file: file, line: line)
      return false
    }
    let start = control.coordinate(withNormalizedOffset: CGVector(dx: enabled ? 0.2 : 0.8, dy: 0.5))
    let end = control.coordinate(withNormalizedOffset: CGVector(dx: enabled ? 0.8 : 0.2, dy: 0.5))
    start.press(forDuration: 0.1, thenDragTo: end)
    guard afterGesture() else { return false }
    let expected = expectedFinalValue ?? enabled
    let changed = row.wait(until: "value == %@", expected ? "1" : "0")
    XCTAssertTrue(changed, "The switch must finish \(expected ? "on" : "off") after the thumb drag and any confirmation.\n\(row.debugDescription)", file: file, line: line)
    return changed
  }
  func testLearningUsesLoadedDiffRevisionWithReadOnlyPolicy() {
    let app = launch(["READONLY_POLICY"], presentation: "advanced")
    app.selectSettingsTab("Learning")
    let policy = app.switches["automation.learningPolicy"]
    XCTAssertTrue(policy.waitForExistence(timeout: 10)); XCTAssertFalse(policy.isEnabled)
    XCTAssertTrue(text("Only an integration administrator can change the skill write policy.", app: app).exists)
    XCTAssertFalse(app.staticTexts["Installed skills"].exists, "Installed skills moved to Behavior")
    let pending = app.buttons["automation.pendingSkill.deadbeef"]
    reveal(pending, in: app.collectionViews["automation.learning"]); pending.tapWhenReady()
    let approve = app.buttons["automation.approveSkill"]
    XCTAssertTrue(approve.wait(until: "enabled == true"))
    XCTAssertTrue(text("+Check the north gate before opening the pasture.", app: app).exists)
    reveal(approve, in: app.collectionViews.firstMatch)
    capture(app, "Native skill diff ready for review")
    approve.tapWhenReady()
    XCTAssertTrue(app.staticTexts["No skill changes waiting for review."].waitForExistence(timeout: 10), "The fixture accepts only the detail's revision")
    app.selectSettingsTab("Skills")
    let behavior = app.collectionViews["settings.behavior"]
    let lock = app.buttons["skill.lock.ranch/fences"]
    reveal(lock, in: behavior)
    XCTAssertTrue(lock.waitForExistence(timeout: 10)); XCTAssertFalse(lock.isEnabled)
    let note = text("Only an integration administrator can lock or unlock skills.", app: app)
    reveal(note, in: behavior)
    let read = app.buttons["skill.read.ranch/fences"]
    reveal(read, in: behavior, downward: true); read.tapWhenReady()
    XCTAssertTrue(text("# Fixture fence inspection", app: app).waitForExistence(timeout: 10))
    let readerLock = app.switches["automation.skillLock"]
    XCTAssertTrue(readerLock.waitForExistence(timeout: 5)); XCTAssertFalse(readerLock.isEnabled)
    capture(app, "Native installed skill content")
  }
  func testBehaviorSkillRowLocksReadsAndUnlocksAnInstalledSkill() {
    let app = launch()
    app.selectSettingsTab("Skills")
    let behavior = app.collectionViews["settings.behavior"]
    let lock = app.buttons["skill.lock.ranch/fences"]
    reveal(lock, in: behavior)
    XCTAssertTrue(lock.wait(until: "enabled == true")); XCTAssertEqual(lock.label, "Lock ranch/fences", "VoiceOver hears which skill")
    XCTAssertFalse(app.descendants(matching: .any)["skill.locked.ranch/fences"].exists)
    lock.tapWhenReady()
    XCTAssertTrue(lock.wait(until: "label == %@", "Unlock ranch/fences"), "The row shows the lock Hermes saved")
    XCTAssertTrue(app.descendants(matching: .any)["skill.locked.ranch/fences"].exists)
    XCTAssertTrue(text("Assistants can't change this skill while it's locked.", app: app).exists)
    XCTAssertTrue(text("Saved in WildBots.", app: app).exists)
    XCTAssertFalse(app.buttons["saveChanges"].isEnabled, "A lock saves at once, not with Save changes")
    capture(app, "Native locked skill row")
    app.buttons["skill.read.ranch/fences"].tapWhenReady()
    XCTAssertTrue(text("# Fixture fence inspection", app: app).waitForExistence(timeout: 10))
    XCTAssertTrue(app.switches["automation.skillLock"].wait(until: "value == %@", "1"))
    app.navigationBars["Installed skill"].buttons["Done"].tapWhenReady()
    lock.tapWhenReady()
    XCTAssertTrue(lock.wait(until: "label == %@", "Lock ranch/fences"))
    XCTAssertFalse(app.descendants(matching: .any)["skill.locked.ranch/fences"].exists)
  }
  /// A skill status that never loaded says why and offers a way back, instead of dropping the lock controls silently.
  func testBehaviorOffersRetryWhenSkillStatusFailsToLoad() {
    let app = launch(["OVERVIEW_FAILURE"])
    app.selectSettingsTab("Skills")
    let behavior = app.collectionViews["settings.behavior"]
    let refresh = app.buttons["skill.refreshStatus"]
    reveal(refresh, in: behavior)
    XCTAssertTrue(refresh.wait(until: "enabled == true"), app.debugDescription)
    XCTAssertTrue(text("Fixture automation status unavailable", app: app).exists)
    XCTAssertFalse(app.buttons["skill.lock.ranch/fences"].exists)
    refresh.tapWhenReady()
    let lock = app.buttons["skill.lock.ranch/fences"]
    reveal(lock, in: behavior)
    XCTAssertTrue(lock.wait(until: "enabled == true"), "The lock controls return once status loads")
    XCTAssertTrue(refresh.waitForDisappearance())
  }
  func testSimplePresentationHidesSkillPolicyAndRoutineOverrides() {
    let app = launch()
    app.selectSettingsTab("Learning")
    XCTAssertTrue(app.buttons["automation.pendingSkill.deadbeef"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.switches["automation.learningPolicy"].exists)
    app.selectSettingsTab("Routines")
    let edit = app.buttons["Edit"].firstMatch
    reveal(edit, in: app.collectionViews["settings.automation"]); edit.tapWhenReady()
    let form = app.collectionViews["routineEditorForm"]
    XCTAssertTrue(form.waitForExistence(timeout: 10))
    for _ in 0..<3 { form.swipeUp() }
    XCTAssertFalse(app.buttons["Advanced"].exists)
    XCTAssertFalse(app.switches["routine.runScriptWithoutModel"].exists)
  }
  func testPolicyFailureRequiresStatusRefreshBeforeAnotherChange() {
    let app = launch(["POLICY_FAILURE"], presentation: "advanced")
    app.selectSettingsTab("Learning")
    let policy = app.switches["automation.learningPolicy"]
    let message = text("Nothing will be sent again automatically.", app: app)
    // This server-confirmed toggle stays on while confirmation is pending and after a failed save.
    // The confirmation and error prove the off gesture reached the binding without optimistic state.
    guard setSwitch(policy, in: app.collectionViews["automation.learning"], to: false, expectedFinalValue: true, afterGesture: {
      let confirm = app.buttons["Allow changes without review"]
      guard confirm.waitForExistence(timeout: 5) else {
        XCTFail("Turning the policy off must ask for confirmation.\n\(app.debugDescription)")
        return false
      }
      confirm.tapWhenReady()
      let failed = message.waitForExistence(timeout: 10)
      XCTAssertTrue(failed, "The failed save must explain that its outcome is unconfirmed")
      return failed
    }) else { return }
    XCTAssertFalse(policy.isEnabled)
    capture(app, "Native policy failure requires refresh")
    app.buttons["automation.refresh"].tapWhenReady()
    XCTAssertTrue(policy.wait(until: "enabled == true"))
    XCTAssertTrue(policy.wait(until: "value == %@", "1"))
    XCTAssertFalse(message.exists)
  }
  func testAdvancedRoutineSavesScriptAndKeepsInheritedModel() {
    let app = launch(presentation: "advanced")
    app.selectSettingsTab("Routines")
    let edit = app.buttons["Edit"].firstMatch
    reveal(edit, in: app.collectionViews.firstMatch); edit.tapWhenReady()
    let form = app.collectionViews["routineEditorForm"]
    let advanced = app.buttons["Advanced"]
    reveal(advanced, in: form); advanced.tapWhenReady()
    let inherit = app.buttons["Use assistant model and provider"]
    reveal(inherit, in: form); inherit.tapWhenReady()
    let scriptOnly = app.switches["routine.runScriptWithoutModel"]
    guard setSwitch(scriptOnly, in: form, downward: true, to: true) else { return }
    guard scriptOnly.wait(until: "value == %@", "1") else {
      XCTFail("The script-only switch did not turn on.\n\(app.debugDescription)")
      return
    }
    XCTAssertFalse(app.buttons["Save routine"].isEnabled, "Script-only mode requires a profile script before saving")
    let script = app.textFields["Profile script, e.g. reports/morning.py"]
    reveal(script, in: form, downward: true); script.typeWhenFocused("reports/inspection.py")
    XCTAssertTrue(scriptOnly.wait(until: "value == %@", "1"))
    capture(app, "Native advanced routine script settings")
    app.buttons["Save routine"].tapWhenReady()
    XCTAssertTrue(edit.waitForExistence(timeout: 10))
    reveal(edit, in: app.collectionViews.firstMatch); edit.tapWhenReady()
    reveal(advanced, in: form); advanced.tapWhenReady()
    XCTAssertTrue(script.wait(until: "value == %@", "reports/inspection.py"))
    XCTAssertTrue(scriptOnly.wait(until: "value == %@", "1"))
    let provider = app.buttons.containing(NSPredicate(format: "label BEGINSWITH %@", "Provider")).firstMatch
    reveal(provider, in: form)
    XCTAssertTrue(text("Use assistant provider", app: app).exists || (provider.value as? String) == "Use assistant provider")
    capture(app, "Native advanced routine saved settings")
  }
}
