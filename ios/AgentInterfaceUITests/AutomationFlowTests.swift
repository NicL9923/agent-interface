import XCTest

@MainActor final class AutomationFlowTests: XCTestCase {
  private func launch(_ options: [String] = []) -> XCUIApplication {
    let app = XCUIApplication()
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
  @discardableResult private func setSwitch(
    _ row: XCUIElement, to enabled: Bool, expectedFinalValue: Bool? = nil,
    afterGesture: () -> Bool = { true }, file: StaticString = #filePath, line: UInt = #line
  ) -> Bool {
    guard row.waitForExistence(timeout: 5), row.wait(until: "enabled == true"), row.waitUntilHittable() else {
      XCTFail("The switch row must be enabled and hittable.\n\(row.debugDescription)", file: file, line: line)
      return false
    }
    guard row.wait(until: "value == %@", enabled ? "0" : "1") else {
      XCTFail("The switch must start \(enabled ? "off" : "on").\n\(row.debugDescription)", file: file, line: line)
      return false
    }
    let control = row.switches.firstMatch
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
  func testInterruptedGoalRequiresReviewThenResumesAndPauses() {
    let app = launch(["INTERRUPTED"])
    app.selectSettingsTab("Work")
    let form = app.collectionViews["automation.work"]
    let resume = app.buttons["Resume goal"]
    XCTAssertTrue(resume.waitForExistence(timeout: 10))
    XCTAssertFalse(resume.isEnabled)
    let review = app.switches["automation.reviewedInterruption"]
    XCTAssertTrue(review.exists)
    reveal(review, in: form)
    guard setSwitch(review, to: true) else { return }
    XCTAssertTrue(resume.wait(until: "enabled == true"))
    reveal(resume, in: form)
    capture(app, "Native interrupted goal review")
    resume.tapWhenReady()
    let pause = app.buttons["Pause goal"]
    XCTAssertTrue(pause.waitForExistence(timeout: 10), app.debugDescription)
    XCTAssertTrue(pause.wait(until: "enabled == true"))
    XCTAssertFalse(review.exists)
    reveal(pause, in: form)
    capture(app, "Native accepted goal continuation")
    pause.tapWhenReady()
    XCTAssertTrue(resume.waitForExistence(timeout: 10))
    XCTAssertTrue(resume.wait(until: "enabled == true"))
    capture(app, "Native goal paused")
  }
  func testRejectedResumeShowsItsReasonAndKeepsGoalPaused() {
    let app = launch(["REJECT_RESUME"])
    app.selectSettingsTab("Work")
    let resume = app.buttons["Resume goal"]
    XCTAssertTrue(resume.wait(until: "enabled == true"))
    resume.tapWhenReady()
    XCTAssertTrue(text("Fixture continuation refused. The goal remains paused.", app: app).waitForExistence(timeout: 10))
    XCTAssertTrue(resume.wait(until: "enabled == true"))
    XCTAssertFalse(app.buttons["Pause goal"].exists)
    XCTAssertFalse(app.staticTexts["Saved in Hermes."].exists)
    capture(app, "Native rejected continuation stays paused")
  }
  func testTaskCreationStaysBlockedUntilExplicitStart() {
    let app = launch()
    app.selectSettingsTab("Work")
    let form = app.collectionViews["automation.work"]
    let create = app.buttons["New task"]
    reveal(create, in: form); create.tapWhenReady()
    XCTAssertTrue(app.collectionViews["automation.taskEditor"].waitForExistence(timeout: 10),
      "New task must remain presented over assistant settings")
    let title = app.textFields["automation.taskTitle"]
    guard title.waitForExistence(timeout: 10), title.waitUntilHittable() else {
      XCTFail("The new task's title field must be ready for typing.\n\(app.debugDescription)")
      return
    }
    title.typeWhenFocused("Inspect fixture gate")
    let save = app.buttons["automation.saveTask"]
    XCTAssertTrue(save.wait(until: "enabled == true")); save.tapWhenReady()
    let blocked = app.buttons["Blocked (1)"]
    XCTAssertTrue(blocked.waitForExistence(timeout: 10))
    reveal(blocked, in: form); blocked.tapWhenReady()
    let row = app.buttons["automation.task.fixture-task-1"]
    reveal(row, in: form); row.tapWhenReady()
    let status = app.descendants(matching: .any).matching(identifier: "automation.taskStatus").firstMatch
    XCTAssertTrue(status.wait(until: "value == %@", "blocked"))
    capture(app, "Native new task remains blocked")
    let start = app.buttons["Start task"]
    reveal(start, in: app.collectionViews["automation.taskDetail"]); start.tapWhenReady()
    XCTAssertTrue(status.wait(until: "value == %@", "ready"))
    reveal(status, in: app.collectionViews["automation.taskDetail"], downward: true)
    capture(app, "Native explicit task start")
  }
  func testLearningUsesLoadedDiffRevisionWithReadOnlyPolicy() {
    let app = launch(["READONLY_POLICY"])
    app.selectSettingsTab("Learning")
    let policy = app.switches["automation.learningPolicy"]
    XCTAssertTrue(policy.waitForExistence(timeout: 10)); XCTAssertFalse(policy.isEnabled)
    XCTAssertTrue(text("Only an integration administrator can change the skill write policy.", app: app).exists)
    let pending = app.buttons["automation.pendingSkill.deadbeef"]
    reveal(pending, in: app.collectionViews["automation.learning"]); pending.tapWhenReady()
    let approve = app.buttons["automation.approveSkill"]
    XCTAssertTrue(approve.wait(until: "enabled == true"))
    XCTAssertTrue(text("+Check the north gate before opening the pasture.", app: app).exists)
    reveal(approve, in: app.collectionViews.firstMatch)
    capture(app, "Native skill diff ready for review")
    approve.tapWhenReady()
    XCTAssertTrue(app.staticTexts["No skill changes waiting for review."].waitForExistence(timeout: 10), "The fixture accepts only the detail's revision")
    let installed = app.buttons["automation.installedSkill.ranch/fences"]
    reveal(installed, in: app.collectionViews["automation.learning"]); installed.tapWhenReady()
    XCTAssertTrue(text("# Fixture fence inspection", app: app).waitForExistence(timeout: 10))
    capture(app, "Native installed skill content")
  }
  func testTriggerEditorStaysPresentedDuringKeyboardInputAndCancel() {
    let app = launch()
    app.selectSettingsTab("Work")
    let form = app.collectionViews["automation.work"]
    let create = app.buttons["New event trigger"]
    reveal(create, in: form)
    XCTAssertTrue(create.wait(until: "enabled == true"))
    create.tapWhenReady()
    let editor = app.collectionViews["automation.triggerEditor"]
    XCTAssertTrue(editor.waitForExistence(timeout: 10), "The trigger editor stays over assistant settings")
    let id = app.textFields["automation.triggerID"]
    guard id.waitForExistence(timeout: 10), id.waitUntilHittable() else {
      XCTFail("The trigger ID must be ready for typing.\n\(app.debugDescription)")
      return
    }
    id.typeWhenFocused("fixture-gate")
    XCTAssertTrue(id.wait(until: "value == %@", "fixture-gate"))
    XCTAssertTrue(editor.exists)
    capture(app, "Native trigger editor keeps keyboard input")
    app.buttons["Cancel"].tapWhenReady()
    XCTAssertTrue(editor.waitForDisappearance(timeout: 10))
    XCTAssertTrue(form.waitForExistence(timeout: 10))
    XCTAssertEqual(app.buttons["settingsMore"].value as? String, "Work")
    reveal(create, in: form)
    XCTAssertTrue(create.isEnabled)
    capture(app, "Native trigger editor returns to Work")
  }
  func testPolicyFailureRequiresStatusRefreshBeforeAnotherChange() {
    let app = launch(["POLICY_FAILURE"])
    app.selectSettingsTab("Learning")
    let policy = app.switches["automation.learningPolicy"]
    let message = text("Nothing will be sent again automatically.", app: app)
    // This server-confirmed toggle stays on while confirmation is pending and after a failed save.
    // The confirmation and error prove the off gesture reached the binding without optimistic state.
    guard setSwitch(policy, to: false, expectedFinalValue: true, afterGesture: {
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
    let app = launch()
    app.selectSettingsTab("Routines")
    let edit = app.buttons["Edit"].firstMatch
    reveal(edit, in: app.collectionViews.firstMatch); edit.tapWhenReady()
    let form = app.collectionViews["routineEditorForm"]
    let advanced = app.buttons["Advanced"]
    reveal(advanced, in: form); advanced.tapWhenReady()
    let inherit = app.buttons["Use assistant model and provider"]
    reveal(inherit, in: form); inherit.tapWhenReady()
    let scriptOnly = app.switches["routine.runScriptWithoutModel"]
    reveal(scriptOnly, in: form, downward: true)
    guard setSwitch(scriptOnly, to: true) else { return }
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
