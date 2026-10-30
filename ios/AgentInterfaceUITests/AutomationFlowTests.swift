import XCTest
import CryptoKit

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
  func testGoalPresentersStayOverSettings() {
    continueAfterFailure = false
    for cycle in 1...3 {
      let app = launch()
      defer { app.terminate() }
      app.selectSettingsTab("Work")
      let form = app.collectionViews["automation.work"]
      func remainsPresented(_ element: XCUIElement, _ name: String) -> Bool {
        guard element.waitForExistence(timeout: 5) else {
          capture(app, "Goal presenter missing")
          XCTFail("\(name) must open over settings, cycle \(cycle).\n\(app.debugDescription)")
          return false
        }
        let disappears = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: element)
        disappears.isInverted = true
        guard XCTWaiter.wait(for: [disappears], timeout: 2) == .completed else {
          capture(app, "Goal presenter disappeared")
          XCTFail("\(name) must remain over settings for two seconds, cycle \(cycle).\n\(app.debugDescription)")
          return false
        }
        return true
      }
      let replace = app.buttons["Replace goal"]
      reveal(replace, in: form); replace.tapWhenReady()
      let editor = app.navigationBars["Replace goal"]
      guard remainsPresented(editor, "Replace goal editor") else { return }
      capture(app, "Native goal editor remains presented")
      editor.buttons["Cancel"].tapWhenReady()
      XCTAssertTrue(editor.waitForDisappearance(timeout: 5), "Cancel closes only the goal editor, cycle \(cycle)")
      XCTAssertTrue(form.waitForExistence(timeout: 5))
      reveal(replace, in: form); replace.tapWhenReady()
      guard remainsPresented(editor, "Replace goal editor reopened") else { return }
      let objective = app.descendants(matching: .any).matching(identifier: "automation.goal.objective").firstMatch
      XCTAssertTrue(objective.waitUntilHittable()); objective.tapWhenReady()
      XCTAssertTrue(objective.waitForKeyboardFocus()); objective.waitForKeyboardLayout()
      let suffix = " replacement \(cycle)"
      objective.typeWhenFocused(suffix)
      editor.buttons["Replace goal"].tapWhenReady()
      let replacement = app.staticTexts["Replace this standing goal?"]
      guard remainsPresented(replacement, "Replace goal confirmation") else { return }
      let keepEditing = app.buttons["confirmationKeep"]
      XCTAssertEqual(keepEditing.label, "Keep editing"); keepEditing.tapWhenReady()
      XCTAssertTrue(replacement.waitForDisappearance(timeout: 5))
      guard remainsPresented(editor, "Keep editing preserves the goal editor") else { return }
      XCTAssertTrue((objective.value as? String)?.contains(suffix) == true, "Keep editing preserves the draft")
      editor.buttons["Replace goal"].tapWhenReady()
      guard remainsPresented(replacement, "Replace goal confirmation reopened") else { return }
      app.buttons["confirmationAccept"].tapWhenReady()
      XCTAssertTrue(editor.waitForDisappearance(timeout: 10), "Replace closes only the goal editor, cycle \(cycle)")
      XCTAssertTrue(text(suffix, app: app).waitForExistence(timeout: 10), "Replacement reconciles the edited title")
      XCTAssertTrue(form.waitForExistence(timeout: 5))
      XCTAssertEqual(app.buttons["settingsMore"].value as? String, "Work")
      let clear = app.buttons["automation.goal.clear"]
      reveal(clear, in: form); clear.tapWhenReady()
      let prompt = app.staticTexts["Clear this standing goal?"]
      guard remainsPresented(prompt, "Clear goal confirmation") else { return }
      let keep = app.buttons["confirmationKeep"]
      XCTAssertTrue(keep.waitForExistence(timeout: 5)); XCTAssertEqual(keep.label, "Keep goal")
      keep.tapWhenReady()
      XCTAssertTrue(prompt.wait(until: "exists == false"))
      XCTAssertTrue(form.exists)
      XCTAssertEqual(app.buttons["settingsMore"].value as? String, "Work")
      let resume = app.buttons["Resume goal"]
      // Resume precedes Clear, whose opener was just scrolled into view.
      reveal(resume, in: form, downward: true)
      XCTAssertTrue(resume.waitForExistence(timeout: 5), "Keeping the goal preserves it")
      app.selectSettingsTab("Learning"); app.selectSettingsTab("Work")
      XCTAssertTrue(text(suffix, app: app).waitForExistence(timeout: 10), "The replacement remains after a fresh read")
      reveal(clear, in: form); clear.tapWhenReady()
      guard remainsPresented(prompt, "Clear goal confirmation reopened") else { return }
      let accept = app.buttons["confirmationAccept"]
      XCTAssertTrue(accept.waitForExistence(timeout: 5)); XCTAssertEqual(accept.label, "Clear goal")
      accept.tapWhenReady()
      XCTAssertTrue(text("No standing goal.", app: app).waitForExistence(timeout: 10), "Clear reconciles to an empty goal")
      XCTAssertTrue(app.buttons["Set a goal"].exists)
      print("GOAL_PRESENTATION_CYCLE \(cycle) PASSED")
    }
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
    guard setSwitch(review, in: form, to: true) else { return }
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
    reveal(blocked, in: form)
    let row = app.buttons["automation.task.fixture-task-1"]
    reveal(row, in: form); row.tapWhenReady()
    let status = app.descendants(matching: .any).matching(identifier: "automation.taskStatus").firstMatch
    XCTAssertTrue(status.wait(until: "value == %@", "Blocked"))
    capture(app, "Native new task remains blocked")
    let start = app.buttons["Start task"]
    reveal(start, in: app.collectionViews["automation.taskDetail"]); start.tapWhenReady()
    XCTAssertTrue(status.wait(until: "value == %@", "Ready"))
    reveal(status, in: app.collectionViews["automation.taskDetail"], downward: true)
    capture(app, "Native explicit task start")
  }
  func testTaskEditRefusalRefreshesRunningState() throws {
    let source = ProcessInfo.processInfo.environment["AGENT_INTERFACE_DESIGN_WORK_TASKS_PATH"] ?? ""
    try XCTSkipUnless(!source.isEmpty, "Set AGENT_INTERFACE_DESIGN_WORK_TASKS_PATH to the W2 fixture.")
    var fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: source))) as? [String: Any])
    XCTAssertEqual((fixture["workFixture"] as? [String: Any])?["gate"] as? String, "W2-tasks")
    fixture["mode"] = "task-edit-refreshed-running"
    let app = XCUIApplication()
    app.launchEnvironment["AGENT_INTERFACE_UI_FIXTURE"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_RESET"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_EXPERIENCE"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_SCOPE"] = UUID().uuidString.lowercased()
    app.launchEnvironment["AGENT_INTERFACE_UI_DESIGN_FIXTURE"] = String(decoding: try JSONSerialization.data(withJSONObject: fixture), as: UTF8.self)
    app.launch()
    XCTAssertTrue(app.chatHeader("Ranch hand").waitForExistence(timeout: 15))
    app.openAssistantSettings("Ranch hand"); app.selectSettingsTab("Work")
    let board = app.collectionViews["automation.work"]
    let row = board.buttons["automation.task.t_00000005"]
    reveal(row, in: board); XCTAssertTrue(row.waitForExistence(timeout: 10)); row.tapWhenReady()
    let detail = app.collectionViews["automation.taskDetail"]
    let edit = detail.buttons["Edit task"]; reveal(edit, in: detail); edit.tapWhenReady()
    let editor = app.collectionViews["automation.taskEditor"]
    XCTAssertTrue(editor.waitForExistence(timeout: 10))
    let save = app.buttons["automation.saveTask"]; XCTAssertTrue(save.wait(until: "enabled == true")); save.tapWhenReady()
    XCTAssertTrue(editor.staticTexts["A Hermes worker is running this task. You can change it after the run finishes."].waitForExistence(timeout: 10))
    XCTAssertTrue(save.waitForExistence(timeout: 5)); XCTAssertTrue(save.wait(until: "enabled == false"))
    XCTAssertTrue(editor.descendants(matching: .any).matching(identifier: "automation.taskFeedback").firstMatch.exists)
    XCTAssertFalse(editor.buttons["automation.refresh"].exists)
    app.navigationBars["Edit task"].buttons["Cancel"].tapWhenReady()
    app.navigationBars["Task details"].buttons["Done"].tapWhenReady()
    let create = board.buttons["New task"]; reveal(create, in: board)
    XCTAssertTrue(create.wait(until: "enabled == true"))
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
  func testTriggerSecretRequiresShowBeforeAcknowledgement() {
    let app = launch()
    defer { app.terminate() }
    app.selectSettingsTab("Work")
    let form = app.collectionViews["automation.work"]
    let create = app.buttons["New event trigger"]; reveal(create, in: form); create.tapWhenReady()
    let editor = app.collectionViews["automation.triggerEditor"]
    XCTAssertTrue(editor.waitForExistence(timeout: 10))
    let id = editor.textFields["automation.triggerID"]
    reveal(id, in: editor); id.tapWhenReady(); id.typeWhenFocused("fixture-gate")
    let events = editor.descendants(matching: .any)["automation.triggerEvents"]
    reveal(events, in: editor); events.tapWhenReady(); events.typeWhenFocused("fixture.event")
    let submit = app.navigationBars["New trigger"].buttons["Create"]
    XCTAssertTrue(submit.wait(until: "enabled == true")); submit.tapWhenReady()
    XCTAssertTrue(editor.waitForDisappearance(timeout: 10))
    let acknowledgement = app.buttons["I've saved it"]; reveal(acknowledgement, in: form)
    XCTAssertTrue(acknowledgement.waitForExistence(timeout: 10)); XCTAssertFalse(acknowledgement.isEnabled)
    let show = app.buttons["Show secret"]; reveal(show, in: form); show.tapWhenReady()
    reveal(acknowledgement, in: form); XCTAssertTrue(acknowledgement.isEnabled)
    acknowledgement.tapWhenReady(); XCTAssertFalse(show.exists)
  }
  // W3 diagnostics stay in the private result bundle. They are not design evidence.
  // XCTest imports record(_:) as nonisolated. Its main-actor closure captures only Sendable values,
  // so the test case and the issue never cross isolation. An issue recorded off the main thread goes
  // to super without diagnostics. W3 assertions all run on the main thread.
  private struct W3Diagnostic: Sendable { let name: String; let type: String; let data: Data }
  private static var w3DiagnosticsOwner: ObjectIdentifier?
  private static var w3DiagnosticsApp: XCUIApplication?
  private static var w3RecordingIssue = false

  nonisolated override func record(_ issue: XCTIssue) {
    guard Thread.isMainThread else { super.record(issue); return }
    let owner = ObjectIdentifier(self)
    let diagnostics = MainActor.assumeIsolated { AutomationFlowTests.w3Capture(owner, "failure") }
    var enriched = issue
    for attachment in AutomationFlowTests.w3Attachments(diagnostics) { enriched.add(attachment) }
    super.record(enriched)
  }

  private static func w3Capture(_ owner: ObjectIdentifier, _ name: String) -> [W3Diagnostic] {
    guard let app = w3DiagnosticsApp, !w3RecordingIssue, app.state == .runningForeground, w3DiagnosticsOwner == owner else { return [] }
    w3RecordingIssue = true
    defer { w3RecordingIssue = false }
    let editor = app.collectionViews["automation.triggerEditor"]
    let form = app.collectionViews["automation.work"]
    let targets: [(String, XCUIElement)] = [
      ("editor", editor), ("work", form), ("keyboard", app.keyboards.firstMatch),
      ("picker", editor.buttons.matching(identifier: "automation.triggerRoutine").firstMatch),
      ("hideKeyboard", app.buttons.matching(identifier: "automation.triggerEditor.hideKeyboard").firstMatch),
      ("deleteNotice", form.staticTexts.matching(identifier: "automation.triggerFeedback.deleted").firstMatch),
    ]
    let rows = targets.map { name, target in
      target.hasFrame ? "\(name) type=\(target.elementType.rawValue) frame=\(target.frame) canTap=\(target.canTap)" : "\(name) exists=\(target.exists) noFrame"
    }
    let navigationBottom = app.navigationBars.allElementsBoundByIndex.filter { $0.hasFrame }.map { $0.frame.maxY }.max()
    let geometry = (rows + ["navigationBottom=\(String(describing: navigationBottom))"]).joined(separator: "\n")
    let prefix = "synthetic-W3-diagnostic-\(name)-"
    return [
      W3Diagnostic(name: prefix + "screenshot", type: "public.png", data: app.screenshot().pngRepresentation),
      W3Diagnostic(name: prefix + "hierarchy", type: "public.plain-text", data: Data(app.debugDescription.utf8)),
      W3Diagnostic(name: prefix + "geometry", type: "public.plain-text", data: Data(geometry.utf8)),
    ]
  }

  nonisolated private static func w3Attachments(_ diagnostics: [W3Diagnostic]) -> [XCTAttachment] {
    diagnostics.map { diagnostic in
      let attachment = XCTAttachment(data: diagnostic.data, uniformTypeIdentifier: diagnostic.type)
      attachment.name = diagnostic.name; attachment.lifetime = .keepAlways
      return attachment
    }
  }

  private func w3Diagnose(_ name: String) {
    for attachment in Self.w3Attachments(Self.w3Capture(ObjectIdentifier(self), name)) { add(attachment) }
  }

  private func w3Band(_ form: XCUIElement, app: XCUIApplication) -> (top: CGFloat, bottom: CGFloat) {
    let navigationBottom = app.navigationBars.allElementsBoundByIndex
      .filter { $0.hasFrame && $0.frame.intersects(form.frame) }.map { $0.frame.maxY }.max() ?? form.frame.minY
    return (max(form.frame.minY, navigationBottom) + 12, form.frame.maxY - 12)
  }

  private func w3InBand(_ target: XCUIElement, form: XCUIElement, app: XCUIApplication) -> Bool {
    guard target.hasFrame, form.hasFrame else { return false }
    let band = w3Band(form, app: app), frame = target.frame
    return frame.minY >= band.top && frame.maxY <= band.bottom && frame.minX >= form.frame.minX && frame.maxX <= form.frame.maxX
  }

  private func w3RevealInBand(_ target: XCUIElement, form: XCUIElement, app: XCUIApplication, upwardWhenMissing: Bool = true) -> Bool {
    guard !app.keyboards.firstMatch.exists, form.hasFrame else {
      w3Diagnose("band-precondition"); XCTFail("W3 band reveal requires a framed form without a keyboard"); return false
    }
    func cells() -> [String] {
      form.cells.allElementsBoundByIndex.filter { $0.hasFrame && $0.frame.intersects(form.frame) }
        .map { "\($0.label.prefix(64)):\($0.frame)" }
    }
    for attempt in 0...8 {
      if w3InBand(target, form: form, app: app) { return true }
      if attempt == 8 { break }
      let band = w3Band(form, app: app), height = band.bottom - band.top
      guard height.isFinite, height > 0, !target.hasFrame || target.frame.height <= height else {
        w3Diagnose("band-too-small"); XCTFail("W3 target cannot fit in the visible form band"); return false
      }
      let upward = target.hasFrame ? target.frame.maxY > band.bottom : upwardWhenMissing
      let distance = target.hasFrame ? min(height * 0.38, max(12, abs(target.frame.minY - (band.top + (height - target.frame.height) / 2)))) : height * 0.38
      let before = cells()
      let start = form.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: 8, dy: (band.top + height * (upward ? 0.72 : 0.28)) - form.frame.minY))
      start.press(forDuration: 0.3, thenDragTo: start.withOffset(CGVector(dx: 0, dy: distance * (upward ? -1 : 1))), withVelocity: .slow, thenHoldForDuration: 0.2)
      if !before.isEmpty && before == cells() {
        w3Diagnose("band-did-not-move"); XCTFail("W3 form did not move toward its target"); return false
      }
    }
    w3Diagnose("band-target-missing"); XCTFail("W3 target did not fit within the visible form band"); return false
  }

  private struct W3Flow {
    let app: XCUIApplication
    let audit: URL
    let config: [String: Any]
    let messages: [String: String]
    func events() throws -> [[String: Any]] {
      try String(contentsOf: audit, encoding: .utf8).split(separator: "\n").map {
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any])
      }
    }
    func waitForReads(_ count: Int) throws {
      let deadline = Date().addingTimeInterval(10)
      while Date() < deadline {
        if try events().filter({ $0["method"] as? String == "GET" }).count >= count { return }
        usleep(100_000)
      }
      XCTFail("Expected \(count) W3 overview reads")
    }
    func writes(_ method: String) throws -> [[String: Any]] {
      try events().filter { $0["method"] as? String == method }
    }
  }

  /// The runner must supply the exact reviewed fixture and a fresh, existing SSD audit directory.
  private func launchW3Flow(_ name: String, mode: String) throws -> W3Flow {
    let env = ProcessInfo.processInfo.environment
    let required = ["AGENT_INTERFACE_DESIGN_WORK_TRIGGERS_PATH", "AGENT_INTERFACE_W3_FLOW_AUDIT_DIR", "AGENT_INTERFACE_DESIGN_STAGE", "AGENT_INTERFACE_DESIGN_DEVICE"]
    try XCTSkipIf(required.allSatisfy { env[$0] == nil }, "W3 flow tests run only with their explicit fixture and audit environment.")
    let source = try XCTUnwrap(env["AGENT_INTERFACE_DESIGN_WORK_TRIGGERS_PATH"], "W3 flow tests require the reviewed fixture path")
    let directory = try XCTUnwrap(env["AGENT_INTERFACE_W3_FLOW_AUDIT_DIR"], "W3 flow tests require an audit directory")
    guard env["AGENT_INTERFACE_DESIGN_STAGE"] == "after", let device = env["AGENT_INTERFACE_DESIGN_DEVICE"], ["ios", "ipad"].contains(device) else {
      throw NSError(domain: "W3Flow", code: 3, userInfo: [NSLocalizedDescriptionKey: "W3 flow tests require the after stage and an explicit ios or ipad device"])
    }
    let data = try Data(contentsOf: URL(fileURLWithPath: source))
    XCTAssertEqual(SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined(), "5ed79b279e92aec72374303ef45c340560ca753524187cff9e78637f17e97e9d")
    var fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    let config = try XCTUnwrap(fixture["workFixture"] as? [String: Any])
    XCTAssertEqual(config["gate"] as? String, "W3-triggers")
    let messages = try XCTUnwrap(fixture["workMessages"] as? [String: String])
    fixture["mode"] = mode
    let folder = URL(fileURLWithPath: directory, isDirectory: true)
    var isDirectory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: folder.path, isDirectory: &isDirectory), isDirectory.boolValue else {
      throw NSError(domain: "W3Flow", code: 1, userInfo: [NSLocalizedDescriptionKey: "W3 audit directory must already exist"])
    }
    let audit = folder.appendingPathComponent(name + "-requests.jsonl")
    guard !FileManager.default.fileExists(atPath: audit.path), FileManager.default.createFile(atPath: audit.path, contents: Data()) else {
      throw NSError(domain: "W3Flow", code: 2, userInfo: [NSLocalizedDescriptionKey: "W3 audit must be fresh"])
    }
    let app = XCUIApplication()
    app.launchEnvironment["AGENT_INTERFACE_UI_RESET"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_FIXTURE"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_SCOPE"] = UUID().uuidString.lowercased()
    app.launchEnvironment["AGENT_INTERFACE_UI_DESIGN_FIXTURE"] = String(decoding: try JSONSerialization.data(withJSONObject: fixture), as: UTF8.self)
    app.launchEnvironment["AGENT_INTERFACE_UI_WORK_AUDIT_PATH"] = audit.path
    Self.w3DiagnosticsOwner = ObjectIdentifier(self); Self.w3DiagnosticsApp = app; Self.w3RecordingIssue = false
    app.launch()
    XCTAssertTrue(app.chatHeader("Ranch hand").waitForExistence(timeout: 15))
    app.openAssistantSettings("Ranch hand"); app.selectSettingsTab("Work")
    XCTAssertTrue(app.collectionViews["automation.work"].waitForExistence(timeout: 10))
    let flow = W3Flow(app: app, audit: audit, config: config, messages: messages)
    try flow.waitForReads(1)
    XCTAssertEqual(try flow.events().filter { $0["method"] as? String != "GET" }.count, 0)
    return flow
  }

  private func fillW3Trigger(_ flow: W3Flow, id: String) throws -> XCUIElement {
    let app = flow.app, form = app.collectionViews["automation.work"]
    let create = form.buttons["New event trigger"]; reveal(create, in: form)
    XCTAssertTrue(create.wait(until: "enabled == true")); create.tapWhenReady()
    let editor = app.collectionViews["automation.triggerEditor"]
    XCTAssertTrue(editor.waitForExistence(timeout: 10))
    let values: [(String, String)] = [("automation.triggerID", id), ("automation.triggerDescription", "Fixture trigger"), ("automation.triggerEvents", "freezer.door")]
    for (identifier, value) in values {
      let field = editor.descendants(matching: .any)[identifier]
      reveal(field, in: editor); XCTAssertTrue(field.waitUntilHittable()); field.tapWhenReady()
      XCTAssertTrue(field.waitForKeyboardFocus()); field.waitForKeyboardLayout(); field.typeWhenFocused(value)
    }
    let pickers = editor.buttons.matching(identifier: "automation.triggerRoutine")
    let picker = pickers.firstMatch
    w3Diagnose("picker-pre-hide")
    let hide = app.buttons.matching(identifier: "automation.triggerEditor.hideKeyboard")
    XCTAssertTrue(hide.firstMatch.waitUntilHittable()); XCTAssertEqual(hide.count, 1)
    XCTAssertTrue(hide.firstMatch.frame.width >= 44 && hide.firstMatch.frame.height >= 44, "Hide keyboard must have a 44-point target")
    hide.firstMatch.tapWhenReady()
    w3Diagnose("keyboard-gone-precondition")
    XCTAssertTrue(app.keyboards.firstMatch.waitForDisappearance(timeout: 5))
    XCTAssertTrue(editor.exists)
    for (identifier, value) in values {
      let field = editor.descendants(matching: .any)[identifier]
      XCTAssertTrue(field.exists, "Preserved W3 field must exist: \(identifier)")
      XCTAssertEqual(field.value as? String, value)
    }
    XCTAssertEqual(pickers.count, 1)
    guard w3RevealInBand(picker, form: editor, app: app) else { return editor }
    XCTAssertTrue(picker.waitUntilHittable()); picker.tapWhenReady()
    let menu = app.buttons.matching(NSPredicate(format: "label == %@", "Freezer alert check"))
    XCTAssertTrue(menu.firstMatch.waitForExistence(timeout: 5))
    var selected = false
    for _ in 0..<10 {
      let visible = menu.allElementsBoundByIndex.filter { $0.isHittable }
      if visible.count == 1 { visible[0].tapWhenReady(); selected = true; break }
      usleep(100_000)
    }
    XCTAssertTrue(selected, "Expected exactly one hittable routine menu item")
    let submit = app.navigationBars["New trigger"].buttons["Create"]
    XCTAssertTrue(submit.wait(until: "enabled == true")); XCTAssertTrue(submit.waitUntilHittable()); submit.tapWhenReady()
    return editor
  }

  func testW3TriggerDuplicateRefusalLeavesWorkAvailable() throws {
    continueAfterFailure = false
    let flow = try launchW3Flow("duplicate-refusal", mode: "loaded")
    defer { flow.app.terminate() }
    let editor = try fillW3Trigger(flow, id: "freezer-alerts")
    let message = try XCTUnwrap(flow.messages["duplicateTrigger"])
    let feedback = text(message + " Status refreshed.", app: flow.app)
    XCTAssertTrue(feedback.waitForExistence(timeout: 10)); try flow.waitForReads(2)
    XCTAssertTrue(editor.exists); XCTAssertTrue(flow.app.navigationBars["New trigger"].buttons["Cancel"].isEnabled)
    XCTAssertEqual(try flow.writes("POST").count, 1)
    flow.app.navigationBars["New trigger"].buttons["Cancel"].tapWhenReady()
    XCTAssertTrue(editor.waitForDisappearance(timeout: 10))
    let form = flow.app.collectionViews["automation.work"]
    let newTask = form.buttons["New task"]; reveal(newTask, in: form, downward: true)
    XCTAssertTrue(newTask.wait(until: "enabled == true"), "A definite trigger refusal must not lock tasks")
    let replace = form.buttons["Replace goal"]; reveal(replace, in: form, downward: true)
    XCTAssertTrue(replace.wait(until: "enabled == true"), "A definite trigger refusal must not lock the goal")
    XCTAssertEqual(try flow.writes("POST").count, 1)
  }

  func testW3TriggerDeleteKeepAndConfirmSendOnce() throws {
    continueAfterFailure = false
    let flow = try launchW3Flow("delete-confirmation", mode: "loaded")
    defer { flow.app.terminate() }
    let app = flow.app, form = app.collectionViews["automation.work"]
    let row = form.buttons["automation.trigger.gate-left-open"]; reveal(row, in: form)
    XCTAssertTrue(row.waitUntilHittable()); row.tapWhenReady()
    let delete = form.buttons["Delete trigger…"]; reveal(delete, in: form); XCTAssertTrue(delete.waitUntilHittable()); delete.tapWhenReady()
    XCTAssertTrue(app.staticTexts["Delete this event trigger?"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["gate-left-open will be removed. Its routine stays saved."].exists)
    let keep = app.buttons["confirmationKeep"]; XCTAssertTrue(keep.waitUntilHittable()); keep.tapWhenReady()
    XCTAssertTrue(app.staticTexts["Delete this event trigger?"].waitForDisappearance(timeout: 10))
    XCTAssertEqual(try flow.writes("DELETE").count, 0)
    reveal(delete, in: form); XCTAssertTrue(delete.waitUntilHittable()); delete.tapWhenReady()
    let confirm = app.buttons["confirmationAccept"]; XCTAssertTrue(confirm.waitUntilHittable()); confirm.tapWhenReady()
    XCTAssertTrue(app.staticTexts["Delete this event trigger?"].waitForDisappearance(timeout: 10)); try flow.waitForReads(2)
    let deletes = try flow.writes("DELETE")
    XCTAssertEqual(deletes.count, 1); XCTAssertEqual(deletes.first?["path"] as? String, "/triggers/gate-left-open")
    let notices = form.staticTexts.matching(identifier: "automation.triggerFeedback.deleted")
    let feedback = notices.firstMatch
    let appearedWithoutGesture = feedback.waitForExistence(timeout: 10)
    print("W3_DELETE_LANDING exists=\(appearedWithoutGesture) inBand=\(w3InBand(feedback, form: form, app: app))")
    if !appearedWithoutGesture {
      let anchor = form.staticTexts["Run an existing routine when a service sends Hermes a matching event."]
      guard w3RevealInBand(anchor, form: form, app: app, upwardWhenMissing: false) else { return }
      guard feedback.exists else {
        w3Diagnose("delete-notice-absent"); XCTFail("Trigger section visible, delete notice absent"); return
      }
    }
    XCTAssertEqual(notices.count, 1); XCTAssertEqual(feedback.label, "Deleted gate-left-open.")
    guard w3RevealInBand(feedback, form: form, app: app, upwardWhenMissing: false) else { return }
    XCTAssertFalse(row.exists)
    XCTAssertEqual(try flow.writes("DELETE").count, 1)
  }

  func testW3TriggerUncertainCreateRefreshClosesWithoutResend() throws {
    continueAfterFailure = false
    let flow = try launchW3Flow("uncertain-create", mode: "trigger-create-uncertain")
    defer { flow.app.terminate() }
    let draft = try XCTUnwrap(flow.config["newTrigger"] as? [String: Any])
    let id = try XCTUnwrap(draft["id"] as? String)
    let editor = try fillW3Trigger(flow, id: id)
    let uncertain = text("Hermes may have created this trigger.", app: flow.app)
    XCTAssertTrue(uncertain.waitForExistence(timeout: 10)); XCTAssertEqual(try flow.writes("POST").count, 1)
    let refresh = editor.buttons["automation.refresh"]; reveal(refresh, in: editor, downward: true)
    XCTAssertTrue(refresh.waitUntilHittable()); refresh.tapWhenReady(); try flow.waitForReads(2)
    let explanation = text("this app never received its signing secret", app: flow.app)
    XCTAssertTrue(explanation.waitForExistence(timeout: 10))
    let close = flow.app.navigationBars["New trigger"].buttons["Close"]
    XCTAssertTrue(close.wait(until: "enabled == true")); XCTAssertFalse(flow.app.navigationBars["New trigger"].buttons["Create"].exists)
    XCTAssertFalse(editor.descendants(matching: .any)["automation.triggerID"].isEnabled)
    XCTAssertFalse(editor.descendants(matching: .any)["automation.triggerEvents"].isEnabled)
    close.tapWhenReady(); XCTAssertTrue(editor.waitForDisappearance(timeout: 10))
    let form = flow.app.collectionViews["automation.work"]
    let row = form.buttons["automation.trigger.\(id)"]; reveal(row, in: form)
    XCTAssertTrue(row.waitForExistence(timeout: 10)); let enable = form.buttons["Enable trigger"]
    reveal(enable, in: form); XCTAssertTrue(enable.waitForExistence(timeout: 10), "Close expands the matched row")
    let posts = try flow.writes("POST")
    XCTAssertEqual(posts.count, 1); XCTAssertEqual(posts.first?["path"] as? String, "/triggers")
    XCTAssertFalse(form.buttons["Show secret"].exists)
  }

  func testPolicyFailureRequiresStatusRefreshBeforeAnotherChange() {
    let app = launch(["POLICY_FAILURE"])
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
