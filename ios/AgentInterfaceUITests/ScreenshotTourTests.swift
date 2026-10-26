import XCTest

/// Captures a repeatable PNG tour of the Debug fixture for visual before/after review.
/// Skipped unless the runner sets AGENT_INTERFACE_SCREENSHOT_DIR, which xcodebuild forwards
/// from TEST_RUNNER_AGENT_INTERFACE_SCREENSHOT_DIR. Run with .agents/tools/ios-screenshot-tour.sh.
@MainActor final class ScreenshotTourTests: XCTestCase {
  private var directory: URL!

  override func setUp() async throws {
    let path = ProcessInfo.processInfo.environment["AGENT_INTERFACE_SCREENSHOT_DIR"] ?? ""
    try XCTSkipUnless(!path.isEmpty, "Set AGENT_INTERFACE_SCREENSHOT_DIR to capture the tour.")
    directory = URL(fileURLWithPath: path, isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    continueAfterFailure = false
  }

  /// Focused captures for the screen-by-screen design gate, using the same data as the web.
  func testTodayDesignReview() throws {
    let source = ProcessInfo.processInfo.environment["AGENT_INTERFACE_DESIGN_TODAY_PATH"] ?? ""
    try XCTSkipUnless(!source.isEmpty, "Set AGENT_INTERFACE_DESIGN_TODAY_PATH to the shared design fixture.")
    let fixture = try Data(contentsOf: URL(fileURLWithPath: source))
    let selection = ProcessInfo.processInfo.environment["AGENT_INTERFACE_DESIGN_VARIANT"] ?? ""
    let variants = [
      ("today-loaded", "light", "UICTContentSizeCategoryL", true),
      ("today-dark", "dark", "UICTContentSizeCategoryL", true),
      ("today-large-text", "light", "UICTContentSizeCategoryAccessibilityXL", true),
      ("today-all-clear", "light", "UICTContentSizeCategoryL", false),
      ("today-partial", "light", "UICTContentSizeCategoryL", true),
      ("today-stale-error", "light", "UICTContentSizeCategoryL", true),
      ("today-loading", "light", "UICTContentSizeCategoryL", true),
    ]
    guard selection.isEmpty || variants.contains(where: { $0.0 == selection }) else {
      XCTFail("Unknown Today capture variant: \(selection)"); return
    }
    for (name, theme, size, dense) in variants where selection.isEmpty || selection == name {
      var environment = ["AGENT_INTERFACE_UI_THEME": theme]
      if dense {
        var payload = try XCTUnwrap(JSONSerialization.jsonObject(with: fixture) as? [String: Any])
        if name == "today-partial" {
          var overview = try XCTUnwrap(payload["overview"] as? [String: Any])
          var items = try XCTUnwrap(overview["items"] as? [[String: Any]])
          let index = try XCTUnwrap(items.firstIndex { $0["botId"] as? String == "guide" })
          items[index]["activity"] = ["state": "disconnected"]
          items[index]["error"] = "Could not read this Hermes conversation. Open it to reconnect."
          overview["items"] = items; overview["unavailableBots"] = ["guide"]
          payload["overview"] = overview
        }
        if name == "today-stale-error" { payload["mode"] = "stale" }
        if name == "today-loading" { payload["mode"] = "loading" }
        environment["AGENT_INTERFACE_UI_TODAY_DESIGN"] = String(decoding: try JSONSerialization.data(withJSONObject: payload), as: UTF8.self)
      }
      let app = launch(textSize: size, environment: environment)
      XCTAssertTrue(app.textViews["messageComposer"].waitForExistence(timeout: 15))
      goToAssistantList(app)
      app.buttons["openToday"].tap()
      XCTAssertTrue(app.buttons["refreshToday"].waitForExistence(timeout: 10))
      if name == "today-loading" {
        XCTAssertTrue(app.staticTexts["Checking your assistants…"].waitForExistence(timeout: 5))
      } else {
        XCTAssertTrue(app.buttons[dense ? "today.bot.ranch" : "today.event.fixture-completed"].waitForExistence(timeout: 10))
      }
      if name == "today-stale-error" {
        app.buttons["refreshToday"].tap()
        XCTAssertTrue(app.staticTexts["Fixture connection interrupted. Loaded results may be out of date."].waitForExistence(timeout: 10))
      }
      try capture(name)
      if size.contains("Accessibility") || name == "today-loaded" {
        app.swipeUp(); try capture(name + "-scrolled")
      }
      if name == "today-partial" {
        app.buttons["today.bot.guide"].tap()
        XCTAssertTrue(app.chatHeader("Trail guide").waitForExistence(timeout: 10))
      }
      app.terminate()
    }
  }

  func testHomeDesignReview() throws {
    let source = ProcessInfo.processInfo.environment["AGENT_INTERFACE_DESIGN_HOME_PATH"] ?? ""
    try XCTSkipUnless(!source.isEmpty, "Set AGENT_INTERFACE_DESIGN_HOME_PATH to capture home.")
    let fixture = try String(contentsOfFile: source, encoding: .utf8)
    for (name, theme, size) in [
      ("home-loaded", "light", "UICTContentSizeCategoryL"),
      ("home-dark", "dark", "UICTContentSizeCategoryL"),
      ("home-large-text", "light", "UICTContentSizeCategoryAccessibilityXL"),
    ] {
      let app = launch(textSize: size, environment: ["AGENT_INTERFACE_UI_DESIGN_FIXTURE": fixture,
        "AGENT_INTERFACE_UI_THEME": theme])
      XCTAssertTrue(app.textViews["messageComposer"].waitForExistence(timeout: 15))
      goToAssistantList(app)
      XCTAssertTrue(app.buttons["bot.ranch"].waitForExistence(timeout: 10))
      try capture(name)
      if name == "home-loaded" {
        app.buttons["bot.ranch"].press(forDuration: 1)
        XCTAssertTrue(app.buttons["Unpin"].waitForExistence(timeout: 5))
        try capture("home-menu")
        app.buttons["Move to section"].tap()
        if !app.buttons["None"].waitForExistence(timeout: 2), app.buttons["homeSection"].exists {
          app.buttons["homeSection"].tap()
        }
        XCTAssertTrue(app.buttons["None"].waitForExistence(timeout: 5))
        try capture("home-submenu")
      }
      if size.contains("Accessibility") { app.scrollViews["assistantHome"].swipeUp(); try capture(name + "-scrolled") }
      app.terminate()
    }
  }

  func testConversationDesignReview() throws {
    let source = ProcessInfo.processInfo.environment["AGENT_INTERFACE_DESIGN_CONVERSATION_PATH"] ?? ""
    try XCTSkipUnless(!source.isEmpty, "Set AGENT_INTERFACE_DESIGN_CONVERSATION_PATH to capture conversation.")
    let fixture = try String(contentsOfFile: source, encoding: .utf8)
    let selection = ProcessInfo.processInfo.environment["AGENT_INTERFACE_DESIGN_VARIANT"] ?? ""
    let variants = [
      ("conversation-loaded", "light", "UICTContentSizeCategoryL"),
      ("conversation-dark", "dark", "UICTContentSizeCategoryL"),
      ("conversation-large-text", "light", "UICTContentSizeCategoryAccessibilityXL"),
    ]
    guard selection.isEmpty || variants.contains(where: { $0.0 == selection }) else {
      XCTFail("Unknown conversation capture variant: \(selection)"); return
    }
    for (name, theme, size) in variants where selection.isEmpty || selection == name {
      let app = launch(textSize: size, environment: ["AGENT_INTERFACE_UI_DESIGN_FIXTURE": fixture, "AGENT_INTERFACE_UI_THEME": theme])
      XCTAssertTrue(app.textViews["messageComposer"].waitForExistence(timeout: 15))
      XCTAssertTrue(app.buttons["Copy code"].waitForExistence(timeout: 10))
      try capture(name)
      app.scrollViews["conversationTranscript"].swipeDown(); try capture(name + "-earlier")
      if name == "conversation-loaded" {
        let latest = app.buttons["Jump to latest"]
        if latest.waitForExistence(timeout: 2) { latest.tapWhenReady() }
        app.buttons["Copy code"].tap()
        XCTAssertTrue(app.staticTexts["Code copied."].waitForExistence(timeout: 5))
        try capture("conversation-code-copied")
        app.textViews["messageComposer"].typeWhenFocused("Make the picnic vegetarian. Keep the walk under two miles.")
        XCTAssertTrue(app.buttons["sendMessage"].isEnabled)
        try capture("conversation-draft")
        app.buttons["hideKeyboard"].tap()
      }
      app.terminate()
    }
  }

  func testQuestionsDesignReview() throws {
    let source = ProcessInfo.processInfo.environment["AGENT_INTERFACE_DESIGN_QUESTIONS_PATH"] ?? ""
    try XCTSkipUnless(!source.isEmpty, "Set AGENT_INTERFACE_DESIGN_QUESTIONS_PATH to capture questions.")
    let data = try Data(contentsOf: URL(fileURLWithPath: source))
    let fixture = String(decoding: data, as: UTF8.self)
    let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    let error = try XCTUnwrap(payload["answerError"] as? String)
    let selection = ProcessInfo.processInfo.environment["AGENT_INTERFACE_DESIGN_VARIANT"] ?? ""
    let variants = [
      ("questions-loaded", "light", "UICTContentSizeCategoryL"),
      ("questions-dark", "dark", "UICTContentSizeCategoryL"),
      ("questions-large-text", "light", "UICTContentSizeCategoryAccessibilityXL"),
    ]
    guard selection.isEmpty || variants.contains(where: { $0.0 == selection }) else {
      XCTFail("Unknown questions capture variant: \(selection)"); return
    }
    for (name, theme, size) in variants where selection.isEmpty || selection == name {
      let app = launch(textSize: size, environment: ["AGENT_INTERFACE_UI_DESIGN_FIXTURE": fixture, "AGENT_INTERFACE_UI_THEME": theme])
      XCTAssertTrue(app.buttons["questionOption-plan-0"].waitForExistence(timeout: 15))
      XCTAssertFalse(app.buttons["jumpToLatest"].exists, "Opening at the newest question must not cover it with a jump control.")
      if name != "questions-large-text" {
        XCTAssertGreaterThanOrEqual(app.buttons["questionOption-plan-0"].frame.minY,
          app.navigationBars.firstMatch.frame.maxY - 1, "The first choice must be below the navigation bar.")
        XCTAssertLessThanOrEqual(app.buttons["questionOption-plan-0"].frame.maxY,
          app.scrollViews["conversationTranscript"].frame.maxY + 1, "The first choice must be visible on opening.")
      }
      try capture(name)
      if name != "questions-large-text" {
        app.buttons["questionOption-plan-0"].tapWhenReady()
        try capture(name + "-first-choice")
        XCTAssertFalse(app.buttons["jumpToLatest"].exists, "Moving to the next question must not cover an answer with a jump control.")
      }
      scrollUntilHittable(app, app.buttons["Send answers"], in: app.scrollViews["conversationTranscript"])
      app.scrollViews["conversationTranscript"].swipeUp(); try capture(name + "-bottom")
      if name == "questions-loaded" {
        app.buttons["reviewDecisions"].tapWhenReady()
        let own = app.buttons["questionOwn-plan"]
        scrollUntilHittable(app, own, in: app.scrollViews["conversationTranscript"])
        own.tapWhenReady()
        XCTAssertTrue(own.wait(until: "isSelected == true"))
        let route = app.descendants(matching: .any).matching(identifier: "questionAnswer-plan").firstMatch
        XCTAssertTrue(route.waitForExistence(timeout: 5))
        route.typeWhenFocused("A shaded loop under two miles, with a place to rest.")
        for index in [0, 1] {
          let option = app.buttons["questionOption-extras-\(index)"]
          scrollUntilHittable(app, option, in: app.scrollViews["conversationTranscript"]); option.tapWhenReady()
        }
        let note = app.descendants(matching: .any).matching(identifier: "questionAnswer-note").firstMatch
        scrollUntilHittable(app, note, in: app.scrollViews["conversationTranscript"]); note.typeWhenFocused("One child tires easily. Plan a slow morning.")
        try capture("questions-answers")
        let submit = app.buttons["Send answers"]
        scrollUntilHittable(app, submit, in: app.scrollViews["conversationTranscript"])
        XCTAssertGreaterThanOrEqual(submit.frame.height, 44)
        XCTAssertTrue(submit.isEnabled); submit.tapWhenReady()
        XCTAssertTrue(app.staticTexts[error].waitForExistence(timeout: 10))
        try capture("questions-submit-error")
        XCTAssertEqual(app.descendants(matching: .any).matching(identifier: "questionAnswer-plan").firstMatch.value as? String, "A shaded loop under two miles, with a place to rest.")
        submit.tapWhenReady()
        XCTAssertTrue(app.buttons["questionOption-plan-0"].waitForNonExistence(timeout: 10))
        XCTAssertFalse(app.staticTexts[error].exists)
        try capture("questions-submitted")
      }
      if name == "questions-dark" {
        let transcript = app.scrollViews["conversationTranscript"]
        let extra = app.buttons["questionOption-extras-0"]
        scrollUntilHittable(app, extra, in: transcript); extra.tapWhenReady()
        let note = app.descendants(matching: .any).matching(identifier: "questionAnswer-note").firstMatch
        scrollUntilHittable(app, note, in: transcript); note.typeWhenFocused("Bring water and leave early.")
        let submit = app.buttons["Send answers"]
        scrollUntilHittable(app, submit, in: transcript)
        XCTAssertTrue(submit.isEnabled)
        transcript.swipeUp()
        try capture("questions-dark-enabled")
      }
      app.terminate()
    }
  }

  func testShortQuestionFollowsItsLongReply() throws {
    let source = ProcessInfo.processInfo.environment["AGENT_INTERFACE_DESIGN_QUESTIONS_PATH"] ?? ""
    try XCTSkipUnless(!source.isEmpty, "Set AGENT_INTERFACE_DESIGN_QUESTIONS_PATH to exercise the question fixture.")
    var fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: source))) as? [String: Any])
    var conversation = try XCTUnwrap(fixture["conversation"] as? [String: Any])
    var request = try XCTUnwrap((conversation["attention"] as? [[String: Any]])?.first)
    request["title"] = "Choose a route"
    request["detail"] = "A short question before I prepare the plan."
    request["questions"] = [["id": "plan", "prompt": "Which route?", "options": ["River loop", "Cedar trail"]]]
    conversation["attention"] = [request]
    fixture["conversation"] = conversation
    fixture.removeValue(forKey: "answerError")
    var reply = conversation
    reply["attention"] = []
    reply["activity"] = ["state": "idle"]
    var messages = try XCTUnwrap(conversation["messages"] as? [[String: Any]])
    let paragraph = Array(repeating: "Follow the shaded river path, stop for water at the bench, and turn back whenever the children need a rest.", count: 5).joined(separator: " ")
    messages += (0..<8).map { ["id": "route-detail-\($0)", "role": "assistant", "text": paragraph] }
    messages.append(["id": "route-finished", "role": "assistant", "text": "Your Saturday plan is ready."])
    reply["messages"] = messages
    fixture["afterAnswer"] = reply
    let encoded = String(decoding: try JSONSerialization.data(withJSONObject: fixture), as: UTF8.self)
    let app = launch(environment: ["AGENT_INTERFACE_UI_DESIGN_FIXTURE": encoded])
    let transcript = app.scrollViews["conversationTranscript"]
    app.buttons["questionOption-plan-0"].tapWhenReady()
    XCTAssertFalse(app.buttons["jumpToLatest"].exists)
    try capture("questions-short-loaded")
    app.buttons["Send answers"].tapWhenReady()
    let latest = app.staticTexts["Your Saturday plan is ready."]
    XCTAssertTrue(latest.waitForExistence(timeout: 10))
    XCTAssertTrue(latest.wait(until: "isHittable == true"), "The reply's end must follow into view without a manual jump.")
    XCTAssertGreaterThanOrEqual(latest.frame.minY, transcript.frame.minY - 1)
    XCTAssertLessThanOrEqual(latest.frame.maxY, transcript.frame.maxY + 1)
    XCTAssertFalse(app.buttons["jumpToLatest"].exists)
    try capture("questions-short-long-reply")
  }

  func testApprovalsDesignReview() throws {
    let source = ProcessInfo.processInfo.environment["AGENT_INTERFACE_DESIGN_APPROVALS_PATH"] ?? ""
    try XCTSkipUnless(!source.isEmpty, "Set AGENT_INTERFACE_DESIGN_APPROVALS_PATH to capture approvals.")
    let data = try Data(contentsOf: URL(fileURLWithPath: source))
    let original = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    let error = try XCTUnwrap(original["decisionError"] as? String)
    let stage = ProcessInfo.processInfo.environment["AGENT_INTERFACE_DESIGN_STAGE"] ?? "before"
    guard ["before", "after"].contains(stage) else { XCTFail("Unknown approval capture stage: \(stage)"); return }
    let after = stage == "after"
    let variants = [
      ("approvals-loaded", "light", "UICTContentSizeCategoryL"),
      ("approvals-dark", "dark", "UICTContentSizeCategoryL"),
      ("approvals-large-text", "light", "UICTContentSizeCategoryAccessibilityXL"),
      ("approvals-unsupported", "light", "UICTContentSizeCategoryL"),
      ("approvals-decline", "light", "UICTContentSizeCategoryL"),
      ("approvals-approved-held", "light", "UICTContentSizeCategoryL"),
      ("approvals-denied-held", "light", "UICTContentSizeCategoryL"),
      ("approvals-approved-held-dark", "dark", "UICTContentSizeCategoryL"),
    ]
    let selection = ProcessInfo.processInfo.environment["AGENT_INTERFACE_DESIGN_VARIANT"] ?? ""
    guard selection.isEmpty || variants.contains(where: { $0.0 == selection }) else {
      XCTFail("Unknown approval capture variant: \(selection)"); return
    }
    for (name, theme, size) in variants where selection.isEmpty || selection == name {
      var fixture = original
      if name == "approvals-unsupported" { fixture["approvalSupported"] = false }
      if name.contains("-held") { fixture["holdDecision"] = true; fixture.removeValue(forKey: "decisionError") }
      let encoded = String(decoding: try JSONSerialization.data(withJSONObject: fixture), as: UTF8.self)
      let app = launch(textSize: size, environment: ["AGENT_INTERFACE_UI_DESIGN_FIXTURE": encoded, "AGENT_INTERFACE_UI_THEME": theme])
      let approve = app.buttons["Approve"]
      XCTAssertTrue(approve.waitForExistence(timeout: 15))
      if after {
        let title = app.staticTexts["Add a shared reminder for both of you?"]
        XCTAssertGreaterThanOrEqual(title.frame.minY, app.navigationBars.firstMatch.frame.maxY - 1)
        XCTAssertLessThanOrEqual(title.frame.maxY, app.scrollViews["conversationTranscript"].frame.maxY + 1)
        XCTAssertFalse(app.buttons["jumpToLatest"].exists)
        if name != "approvals-large-text" {
          XCTAssertLessThanOrEqual(app.buttons["Decline"].frame.maxY, app.scrollViews["conversationTranscript"].frame.maxY + 1,
            "The entire approval action must be visible when its card fits in the viewport.")
        }
      }
      try capture(name)
      if name == "approvals-large-text" {
        scrollUntilHittable(app, approve, in: app.scrollViews["conversationTranscript"])
        app.scrollViews["conversationTranscript"].swipeUp()
        try capture(name + "-bottom")
      }
      if name == "approvals-unsupported" {
        XCTAssertFalse(approve.isEnabled)
        if after {
          let reason = app.staticTexts[original["unsupportedReason"] as! String]
          XCTAssertTrue(reason.exists)
          XCTAssertLessThanOrEqual(reason.frame.maxY, app.scrollViews["conversationTranscript"].frame.maxY + 1)
        }
      }
      if name.contains("-held") {
        let denied = name == "approvals-denied-held"
        (denied ? app.buttons["Decline"] : approve).tapWhenReady()
        let confirmation = app.staticTexts[denied ? "Decline sent." : "Approval sent."]
        XCTAssertTrue(confirmation.waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons[denied ? "Declined" : "Approved"].isEnabled)
        scrollUntilHittable(app, confirmation, in: app.scrollViews["conversationTranscript"])
        try capture(name + "-sent")
      }
      if name == "approvals-loaded" || name == "approvals-decline" {
        let decision = name == "approvals-loaded" ? "approved" : "denied"
        let button = name == "approvals-loaded" ? approve : app.buttons["Decline"]
        if after { XCTAssertGreaterThanOrEqual(button.frame.height, 44) }
        button.tapWhenReady()
        XCTAssertTrue(app.staticTexts[error].waitForExistence(timeout: 10))
        try capture(name + "-error")
        button.tapWhenReady()
        let response = original[decision == "approved" ? "afterApproved" : "afterDenied"] as! [String: Any]
        let text = (response["messages"] as! [[String: Any]]).last!["text"] as! String
        XCTAssertTrue(app.staticTexts[text].waitForExistence(timeout: 10))
        if after { XCTAssertFalse(app.staticTexts[error].exists) }
        try capture("approvals-" + decision)
      }
      app.terminate()
    }
  }

  func testRecoveryDesignReview() throws {
    let source = ProcessInfo.processInfo.environment["AGENT_INTERFACE_DESIGN_RECOVERY_PATH"] ?? ""
    try XCTSkipUnless(!source.isEmpty, "Set AGENT_INTERFACE_DESIGN_RECOVERY_PATH to capture recovery.")
    let data = try Data(contentsOf: URL(fileURLWithPath: source))
    let original = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    let stage = ProcessInfo.processInfo.environment["AGENT_INTERFACE_DESIGN_STAGE"] ?? "before"
    guard ["before", "after"].contains(stage) else { XCTFail("Unknown recovery stage: \(stage)"); return }
    let variants = [
      ("recovery-failed", "light", "UICTContentSizeCategoryL"),
      ("recovery-failed-dark", "dark", "UICTContentSizeCategoryL"),
      ("recovery-failed-large-text", "light", "UICTContentSizeCategoryAccessibilityXL"),
      ("recovery-refused", "light", "UICTContentSizeCategoryL"),
      ("recovery-checking", "light", "UICTContentSizeCategoryL"),
      ("recovery-unsupported", "light", "UICTContentSizeCategoryL"),
      ("recovery-interrupted", "light", "UICTContentSizeCategoryL"),
      ("recovery-interrupted-dark", "dark", "UICTContentSizeCategoryL"),
      ("recovery-interrupted-large-text", "light", "UICTContentSizeCategoryAccessibilityXL"),
    ]
    let selection = ProcessInfo.processInfo.environment["AGENT_INTERFACE_DESIGN_VARIANT"] ?? ""
    guard selection.isEmpty || variants.contains(where: { $0.0 == selection }) else { XCTFail("Unknown recovery variant: \(selection)"); return }
    for (name, theme, size) in variants where selection.isEmpty || selection == name {
      var fixture = original
      if name.contains("interrupted") { fixture["conversation"] = original["interrupted"] }
      if name == "recovery-unsupported" { fixture["retrySupported"] = false }
      fixture["retryMode"] = name == "recovery-refused" ? "refused" : (name == "recovery-checking" || name == "recovery-unsupported") ? "checking" : "accepted"
      let encoded = String(decoding: try JSONSerialization.data(withJSONObject: fixture), as: UTF8.self)
      let app = launch(textSize: size, environment: ["AGENT_INTERFACE_UI_DESIGN_FIXTURE": encoded, "AGENT_INTERFACE_UI_THEME": theme])
      let composer = app.textViews["messageComposer"]
      XCTAssertTrue(composer.waitForExistence(timeout: 15))
      if name.contains("interrupted") {
        let review = app.switches[stage == "after" ? "interruptionReview" : "I reviewed the interrupted task and its last actions before continuing."]
        XCTAssertTrue(review.waitForExistence(timeout: 10), app.debugDescription)
        composer.typeWhenFocused("Continue with the east gate.")
        app.buttons["hideKeyboard"].tapWhenReady()
        XCTAssertFalse(app.buttons["sendMessage"].isEnabled)
        try capture(name)
        // Tap below the text itself, in the row's vertical padding and trailing whitespace.
        let caption = review.staticTexts["I've reviewed the task's last actions."].firstMatch
        XCTAssertGreaterThanOrEqual(review.frame.height, 44, "The accessible control includes the padded 44-point target")
        let point = CGVector(dx: review.frame.maxX - 2, dy: caption.frame.maxY + 5)
        print("REVIEW_PADDING row=\(review.frame) text=\(caption.frame) point=\(point)")
        app.coordinate(withNormalizedOffset: .zero).withOffset(point).tap()
        XCTAssertTrue(app.buttons["sendMessage"].wait(until: "isEnabled == true"), "The whole review row must be tappable, including its padding")
        try capture(name + "-reviewed")
      } else {
        let retry = app.buttons["retryTurn"]
        XCTAssertTrue(retry.waitForExistence(timeout: 10))
        if stage == "after" {
          XCTAssertTrue(app.staticTexts["recoveryDetail"].exists)
          XCTAssertGreaterThanOrEqual(retry.frame.height, 44)
        }
        try capture(name)
        if name == "recovery-failed" || name == "recovery-refused" || name == "recovery-checking" || name == "recovery-unsupported" {
          composer.typeWhenFocused("Keep this draft")
          app.buttons["hideKeyboard"].tapWhenReady()
          retry.tapWhenReady()
          if name == "recovery-failed" { XCTAssertTrue(app.staticTexts[original["answer"] as! String].waitForExistence(timeout: 10)) }
          if name == "recovery-refused" { XCTAssertTrue(app.staticTexts["retryRefused"].waitForExistence(timeout: 10)) }
          if name == "recovery-checking" || name == "recovery-unsupported" { XCTAssertTrue(app.staticTexts["retryChecking"].waitForExistence(timeout: 10)) }
          if name == "recovery-unsupported" { XCTAssertFalse(retry.isEnabled) }
          XCTAssertEqual(composer.value as? String, "Keep this draft")
          try capture(name + "-result")
          if name == "recovery-refused" {
            app.buttons["retryPutBack"].tapWhenReady()
            XCTAssertTrue(composer.wait(until: "value == %@", "Keep this draft\n\nIs the north gate closed?"))
          }
        }
      }
      app.terminate()
    }
  }

  func testDetailsDesignReview() throws {
    let source = ProcessInfo.processInfo.environment["AGENT_INTERFACE_DESIGN_DETAILS_PATH"] ?? ""
    try XCTSkipUnless(!source.isEmpty, "Set AGENT_INTERFACE_DESIGN_DETAILS_PATH to capture assistant details.")
    let original = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: source))) as? [String: Any])
    let stage = ProcessInfo.processInfo.environment["AGENT_INTERFACE_DESIGN_STAGE"] ?? "before"
    guard ["before", "after"].contains(stage) else { XCTFail("Unknown details stage: \(stage)"); return }
    let variants = [
      ("details-loaded", "light", "UICTContentSizeCategoryL"),
      ("details-dark", "dark", "UICTContentSizeCategoryL"),
      ("details-large-text", "light", "UICTContentSizeCategoryAccessibilityXL"),
      ("details-empty", "light", "UICTContentSizeCategoryL"),
      ("details-earlier-error", "light", "UICTContentSizeCategoryL"),
    ]
    let selection = ProcessInfo.processInfo.environment["AGENT_INTERFACE_DESIGN_VARIANT"] ?? ""
    guard selection.isEmpty || variants.contains(where: { $0.0 == selection }) else { XCTFail("Unknown details variant: \(selection)"); return }
    for (name, theme, size) in variants where selection.isEmpty || selection == name {
      var fixture = original
      var conversation = fixture["conversation"] as! [String: Any]
      if name == "details-empty" {
        conversation["files"] = [] as [String]
        conversation["messages"] = (conversation["messages"] as! [[String: Any]]).map { message in var value=message;value["files"]=[] as [String];return value }
      }
      if name == "details-earlier-error" { conversation["earlierFiles"] = 1; fixture["earlierFilesError"] = true }
      fixture["conversation"] = conversation
      let encoded = String(decoding: try JSONSerialization.data(withJSONObject: fixture), as: UTF8.self)
      let app = launch(textSize: size, environment: ["AGENT_INTERFACE_UI_DESIGN_FIXTURE": encoded, "AGENT_INTERFACE_UI_THEME": theme])
      XCTAssertTrue(app.textViews["messageComposer"].waitForExistence(timeout: 15))
      app.chatHeader("Ranch hand").tapWhenReady()
      XCTAssertTrue(app.staticTexts["profileRole"].waitForExistence(timeout: 5))
      try capture(name + "-profile")
      let profile = app.descendants(matching: .any)["botProfileList"].firstMatch
      if name == "details-large-text" {
        scrollUntilHittable(app,app.buttons["homeSection"],in:profile);profile.swipeUp()
        try capture(name + "-profile-bottom")
      }
      if name == "details-loaded" {
        let pin = app.buttons["profilePin"]; scrollUntilHittable(app,pin,in:profile); pin.tapWhenReady()
        XCTAssertTrue(pin.wait(until: "label == %@", "Unpin"))
        let follow = app.switches["followBot"]; scrollUntilHittable(app,follow,in:profile)
        follow.coordinate(withNormalizedOffset: CGVector(dx: 0.94, dy: 0.5)).tap()
        XCTAssertTrue(follow.wait(until: "value == %@", "1"))
        try capture("details-profile-pinned-following")
      }
      let files = app.buttons["conversationFiles"]
      for _ in 0..<8 {
        if !files.hasFrame || files.frame.minY < profile.frame.minY + 60 { profile.swipeDown() }
        else if files.frame.maxY > profile.frame.maxY - 8 { profile.swipeUp() }
        else { break }
      }
      XCTAssertGreaterThanOrEqual(files.frame.minY, profile.frame.minY + 60)
      XCTAssertLessThanOrEqual(files.frame.maxY, profile.frame.maxY - 8)
      files.tapWhenReady()
      let list = app.descendants(matching: .any)["artifactsList"].firstMatch
      XCTAssertTrue(list.waitForExistence(timeout: 10))
      if name == "details-empty" { XCTAssertTrue(app.staticTexts["No artifacts yet"].waitForExistence(timeout: 5)) }
      else { XCTAssertTrue(app.buttons["artifact-design-plan"].waitForExistence(timeout: 5)) }
      if name == "details-earlier-error" { XCTAssertTrue(app.staticTexts["earlierFilesFailed"].waitForExistence(timeout: 10)) }
      try capture(name + "-artifacts")
      if name != "details-empty" {
        scrollUntilHittable(app, app.buttons["artifact-design-unavailable"], in: list)
        list.swipeUp()
        try capture(name + "-artifacts-bottom")
      }
      if name == "details-loaded" {
        let search = app.searchFields.firstMatch
        if !search.canTap { list.swipeDown() }
        search.typeWhenFocused("no-matching-file")
        XCTAssertTrue(app.staticTexts["No matching files"].waitForExistence(timeout: 5))
        try capture("details-artifacts-no-results")
        app.buttons["Clear filters"].tapWhenReady()
        XCTAssertTrue(app.navigationBars.buttons["Close"].waitUntilHittable(timeout: 5), "Clearing filters leaves search mode")
        let unavailable = app.buttons["artifact-design-unavailable"]
        scrollUntilHittable(app,unavailable,in:list);list.swipeUp();unavailable.tapWhenReady()
        XCTAssertTrue(app.alerts["Couldn't open file"].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertTrue(app.alerts.staticTexts["This archived file is unavailable."].exists)
        try capture("details-artifacts-unavailable")
        app.alerts.buttons["OK"].tapWhenReady()
        let file = app.buttons["artifact-design-plan"]
        scrollUntilHittable(app,file,up:false,in:list);file.tapWhenReady()
        let previewOpened = app.buttons["Done"].waitForExistence(timeout: 5)
        print("DESIGN_PREVIEW_OPENED \(previewOpened)")
        try capture(previewOpened ? "details-artifacts-preview" : "details-artifacts-preview-attempt")
        if stage == "after" { XCTAssertTrue(previewOpened, app.debugDescription) }
        if previewOpened {
          XCTAssertTrue(app.textViews.matching(NSPredicate(format: "value CONTAINS %@", "Gate battery plan")).firstMatch.waitForExistence(timeout: 5))
          app.buttons["Done"].tapWhenReady()
          XCTAssertTrue(app.buttons["artifact-design-plan"].waitForExistence(timeout: 5))
          app.buttons["Close"].tapWhenReady()
          let chatFile = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "gate-battery-plan.txt,")).firstMatch
          scrollUntilHittable(app,chatFile,up:false,in:app.scrollViews["conversationTranscript"])
          let transcript = app.scrollViews["conversationTranscript"]
          for _ in 0..<4 where chatFile.frame.minY < app.navigationBars.firstMatch.frame.maxY + 8 { transcript.swipeDown() }
          try capture("details-chat-file-before-open")
          chatFile.tapWhenReady()
          XCTAssertTrue(app.buttons["Done"].waitForExistence(timeout: 10), app.debugDescription)
          try capture("details-chat-file-preview")
          app.buttons["Done"].tapWhenReady()
        }
      }
      app.terminate()
    }
  }

  func testScreenshotTour() throws {
    var app = launch()
    XCTAssertTrue(app.textViews["messageComposer"].waitForExistence(timeout: 15))

    goToAssistantList(app)
    XCTAssertTrue(app.buttons["bot.ranch"].waitForExistence(timeout: 5))
    try capture("01-home")

    for (identifier, name, ready) in [
      ("openToday", "17-today", "todayOverview"), ("openGroups", "18-group-chats", "New group"),
      ("openDiscovery", "19-search", "Search conversations"),
    ] {
      app.buttons[identifier].tap()
      XCTAssertTrue(app.descendants(matching: .any)[ready].waitForExistence(timeout: 10))
      try capture(name)
      goToAssistantList(app)
    }
    app.buttons["openDiscovery"].tap()
    XCTAssertTrue(app.buttons["Saved items"].waitForExistence(timeout: 10))
    app.buttons["Saved items"].tap()
    XCTAssertTrue(app.buttons["savedItem-saved-1"].waitForExistence(timeout: 10))
    try capture("19b-search-saved")
    goToAssistantList(app)

    openPreferences(app)
    scrollUntilHittable(app, app.descendants(matching: .any)["sharedComputer"])
    try capture("06b-shared-computer")
    app.buttons["Close"].tap()

    app.buttons["bot.ranch"].tap()
    XCTAssertTrue(app.chatHeader("Ranch hand").waitForExistence(timeout: 5))
    try capture("02-conversation")
    app.textViews["messageComposer"].tap()
    XCTAssertTrue(app.buttons["hideKeyboard"].waitForExistence(timeout: 5))
    try capture("02c-composer-focused")
    app.buttons["hideKeyboard"].tap()

    app.openBotProfile("Ranch hand")
    try capture("02b-assistant-card")
    app.buttons["profileSettings"].tap()
    XCTAssertTrue(app.buttons["Avatar"].waitForExistence(timeout: 5))
    app.buttons["Avatar"].tap()
    XCTAssertTrue(app.buttons["previewState.idle"].waitForExistence(timeout: 5))
    try capture("04-avatar-editor")
    app.buttons["previewState.done"].tap()
    app.swipeUp()
    try capture("04b-avatar-editor-tiles")
    scrollUntilHittable(app, app.buttons["Save avatar"])
    try capture("05-avatar-editor-controls")
    scrollUntilHittable(app, app.buttons["Mascot"], up: false)
    app.buttons["Mascot"].tap()
    XCTAssertTrue(app.buttons["avatarTile.family.bear"].waitForExistence(timeout: 5))
    try capture("05b-avatar-editor-mascot")
    app.buttons["Close"].tap()
    if app.buttons["Discard changes"].waitForExistence(timeout: 2) { app.buttons["Discard changes"].tap() }

    openPreferences(app)
    try capture("06-preferences")

    openPreferencesLink(app, "Integrations")
    XCTAssertTrue(app.staticTexts["Google Workspace"].waitForExistence(timeout: 10))
    try capture("07-integrations")
    back(app, from: "Integrations")

    openPreferencesLink(app, "Hermes updates")
    XCTAssertTrue(app.buttons["checkHermesUpdate"].waitForExistence(timeout: 10))
    try capture("08-hermes-updates")
    back(app, from: "Hermes updates")

    openPreferencesLink(app, "Avatar specimen")
    XCTAssertTrue(app.switches["Reduced motion"].waitForExistence(timeout: 5))
    try capture("09-specimen-geometric")
    app.swipeUp()
    try capture("10-specimen-shapes")
    app.swipeDown()
    app.buttons["Mascot"].tap()
    try capture("11-specimen-mascot")
    app.buttons["Portrait"].tap()
    try capture("12-specimen-portrait")
    app.buttons["Geometric"].tap()
    app.switches["Reduced motion"].tap()
    try capture("13-specimen-reduced-motion")
    let matrix = app.descendants(matching: .any)["avatarMatrix"]
    scrollUntilHittable(app, matrix)
    // Short drags bring the whole matrix just below the navigation bar.
    for _ in 0..<12 where matrix.frame.minY > 160 {
      app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.7))
        .press(
          forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.6)),
          withVelocity: .slow, thenHoldForDuration: 0.3)
    }
    try capture("16-specimen-matrix")
    back(app, from: "Avatar specimen")
    // Back on Settings, scrolled to the bottom where the home sections and About rows sit.
    try capture("06c-preferences-scrolled")
    app.swipeDown()
    try capture("06d-preferences-sections")

    // Dark mode through the app's own theme preference, which drives preferredColorScheme.
    // The picker's element type varies by iOS release; its label stays stable.
    // Swiping down at the top of the sheet dismisses it, so reopen Preferences at the top instead.
    app.buttons["Close"].tap()
    openPreferences(app)
    let theme = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", "Appearance")).firstMatch
    XCTAssertTrue(theme.waitForExistence(timeout: 5) && theme.canTap, app.debugDescription)
    theme.tap()
    let dark = app.descendants(matching: .any).matching(NSPredicate(
      format: "label == %@ AND elementType IN %@", "Dark",
      [XCUIElement.ElementType.button.rawValue, XCUIElement.ElementType.menuItem.rawValue])).firstMatch
    XCTAssertTrue(dark.waitForExistence(timeout: 5), app.debugDescription)
    dark.tap()
    XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 5))
    app.buttons["Close"].tap()
    goToAssistantList(app)
    XCTAssertTrue(app.buttons["bot.ranch"].waitForExistence(timeout: 5))
    try capture("14-home-dark")
    app.buttons["bot.ranch"].tap()
    XCTAssertTrue(app.chatHeader("Ranch hand").waitForExistence(timeout: 5))
    try capture("15-conversation-dark")
    app.openBotProfile("Ranch hand")
    try capture("15b-assistant-card-dark")

    // A fresh launch with the working fixture shows the activity avatar and live activity row.
    app.terminate()
    app = launch(liveActivity: true)
    XCTAssertTrue(app.staticTexts["Ranch hand is checking the latest forecast..."].waitForExistence(timeout: 15))
    try capture("03-conversation-working")
    goToAssistantList(app)
    XCTAssertTrue(app.buttons["bot.ranch"].waitForExistence(timeout: 5))
    try capture("03b-home-working")

    // Transcript states: a finished turn's folded work with a colored code block and a table, the
    // question card, and a failed turn offering Retry.
    for (environment, ready, name) in [
      (["AGENT_INTERFACE_UI_WORK": "1"], "turnWork", "21-conversation-work"),
      (["AGENT_INTERFACE_UI_QUESTION": "2"], "Send answers", "22-question-card"),
      (["AGENT_INTERFACE_UI_RETRY": "1"], "retryTurn", "23-failed-turn-retry"),
    ] {
      app.terminate()
      app = launch(environment: environment)
      XCTAssertTrue(app.buttons[ready].waitForExistence(timeout: 15))
      try capture(name)
    }

    // Without the fixture, a reset launch shows the first-run connection screen.
    app.terminate()
    let fresh = XCUIApplication()
    fresh.launchEnvironment["AGENT_INTERFACE_UI_RESET"] = "1"
    fresh.launch()
    XCTAssertTrue(fresh.textFields["serverAddress"].waitForExistence(timeout: 15))
    try capture("00-sign-in")

    // The chat header and card at a large accessibility text size.
    fresh.terminate()
    app = launch(textSize: "UICTContentSizeCategoryAccessibilityL")
    XCTAssertTrue(app.chatHeader("Ranch hand").waitForExistence(timeout: 15))
    try capture("20-conversation-large-text")
    app.openBotProfile("Ranch hand")
    try capture("20b-assistant-card-large-text")
  }

  private func launch(liveActivity: Bool = false, textSize: String? = nil, environment: [String: String] = [:]) -> XCUIApplication {
    let app = XCUIApplication()
    for (key, value) in environment { app.launchEnvironment[key] = value }
    if let textSize { app.launchArguments += ["-UIPreferredContentSizeCategoryName", textSize] }
    app.launchEnvironment["AGENT_INTERFACE_UI_RESET"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_FIXTURE"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_SCOPE"] = UUID().uuidString.lowercased()
    if liveActivity { app.launchEnvironment["AGENT_INTERFACE_UI_LIVE_ACTIVITY"] = "1" }
    app.launch()
    return app
  }

  private func goToAssistantList(_ app: XCUIApplication) {
    if app.buttons["Settings"].exists { return }
    let back = app.navigationBars.buttons.matching(identifier: "Your assistants").firstMatch
    if back.exists { back.tap() } else { app.navigationBars.buttons.firstMatch.tap() }
    XCTAssertTrue(app.buttons["Settings"].waitForExistence(timeout: 5))
  }

  private func openPreferences(_ app: XCUIApplication) {
    goToAssistantList(app)
    app.buttons["Settings"].tap()
    XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 5))
  }

  private func openPreferencesLink(_ app: XCUIApplication, _ title: String) {
    let link = app.buttons[title]
    scrollUntilHittable(app, link)
    link.tap()
    XCTAssertTrue(app.navigationBars[title].waitForExistence(timeout: 5))
  }

  private func back(_ app: XCUIApplication, from title: String) {
    app.navigationBars[title].buttons.firstMatch.tap()
    XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 5))
  }

  private func scrollUntilHittable(_ app: XCUIApplication, _ element: XCUIElement, up: Bool = true, in scroller: XCUIElement? = nil) {
    let area = scroller ?? app
    for _ in 0..<8 {
      if element.exists && element.canTap { return }
      if up { area.swipeUp() } else { area.swipeDown() }
    }
    XCTAssertTrue(element.canTap, "\(element) never became hittable")
  }

  /// Waits for transitions to settle, then writes the full-screen PNG and attaches it to the result.
  private func capture(_ name: String) throws {
    Thread.sleep(forTimeInterval: 1.0)
    let screenshot = XCUIScreen.main.screenshot()
    try screenshot.pngRepresentation.write(to: directory.appendingPathComponent("\(name).png"))
    let attachment = XCTAttachment(screenshot: screenshot)
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }
}
