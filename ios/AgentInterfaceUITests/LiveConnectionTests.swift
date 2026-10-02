import XCTest

// Opt in with SWIFT_ACTIVE_COMPILATION_CONDITIONS="DEBUG LIVE_HERMES_UI_TESTS".
// Requires the marked isolated Hermes browser fixture and its app server at :3004.
// The ordinary test scheme never makes real server requests through this suite.
#if LIVE_HERMES_UI_TESTS
  final class LiveConnectionTests: XCTestCase {
    func testRealHostSignInConversationAndConfiguration() throws {
      let app = XCUIApplication()
      app.launchEnvironment["AGENT_INTERFACE_UI_RESET"] = "1"
      app.launch()
      let address = app.textFields["serverAddress"]
      XCTAssertTrue(address.waitForExistence(timeout: 10))
      address.tap()
      address.typeText("http://127.0.0.1:3004")
      app.buttons["connectServer"].tap()
      let signIn = app.buttons["householdSignIn"]
      XCTAssertTrue(signIn.waitForExistence(timeout: 15))
      capture(app, "Native connection to the real isolated server")
      signIn.tap()

      let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
      if springboard.buttons["Continue"].waitForExistence(timeout: 2) {
        springboard.buttons["Continue"].tap()
      }
      let localMember = app.webViews.buttons["Sign in as local member one"]
      XCTAssertTrue(
        localMember.waitForExistence(timeout: 20),
        "The system browser must load the real host sign-in page.")
      localMember.tap()

      let composer = app.textFields["messageComposer"]
      XCTAssertTrue(
        composer.waitForExistence(timeout: 25),
        "The PKCE handoff must open a canonical conversation.")
      // A new canonical session makes an old formatting reply impossible to match.
      // Create and delete through the product UI, using the existing local provider.
      let checkID = String(UUID().uuidString.prefix(8))
      let botName = "Native check \(checkID)"
      app.navigationBars.buttons.matching(identifier: "Your assistants").firstMatch.tap()
      app.buttons["Create assistant"].tap()
      let name = app.textFields["Name"]
      XCTAssertTrue(name.waitForExistence(timeout: 10))
      name.tap()
      name.typeText(botName)
      let create = app.collectionViews.buttons["Create assistant"]
      reveal(create, in: app, direction: .up)
      create.tap()
      let newBot = app.buttons.containing(.staticText, identifier: botName).firstMatch
      XCTAssertTrue(newBot.waitForExistence(timeout: 20))
      newBot.tap()
      let welcome = app.staticTexts[
        "Ask \(botName) a question. This conversation stays with your assistant."]
      XCTAssertTrue(welcome.waitForExistence(timeout: 15))
      XCTAssertTrue(
        welcome.isHittable, "The empty welcome must be visible without manually scrolling.")
      capture(app, "Empty canonical conversation after switching from a long chat")
      let heading = app.staticTexts["A quieter start to the day"]
      XCTAssertFalse(heading.exists, "The test must start with an empty canonical conversation.")
      let prompt = "Native iOS connection check \(checkID). Show a markdown formatting example."
      composer.tap()
      composer.typeText(prompt)
      app.buttons["sendMessage"].tap()
      XCTAssertTrue(app.staticTexts[prompt].waitForExistence(timeout: 20))
      // The final paragraph proves the current canonical response is complete.
      let finalParagraph = app.staticTexts[
        "This is a synthetic formatting example from the local test provider."]
      XCTAssertTrue(finalParagraph.waitForExistence(timeout: 40))
      XCTAssertTrue(app.staticTexts["Done"].waitForExistence(timeout: 15))
      XCTAssertFalse(
        app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "unreadable response"))
          .firstMatch.exists)
      reveal(heading, in: app, direction: .down)
      XCTAssertTrue(heading.isHittable)
      capture(app, "Current canonical reply, opening and task list")
      reveal(finalParagraph, in: app, direction: .up)
      XCTAssertTrue(finalParagraph.isHittable)
      capture(app, "Current canonical reply, table and code")

      let configure = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Configure "))
        .firstMatch
      configure.tap()
      XCTAssertTrue(app.textFields["Name"].waitForExistence(timeout: 10))
      app.buttons["settingsMore"].tap()
      app.buttons["Tools"].tap()
      // The full Hermes catalog extends beyond the viewport. Its first switch
      // proves the catalog loaded without relying on a lazily rendered footer.
      let firstTool = app.switches.firstMatch
      XCTAssertTrue(firstTool.waitForExistence(timeout: 20))
      let loaded = XCTNSPredicateExpectation(
        predicate: NSPredicate(format: "enabled == true"), object: firstTool)
      XCTAssertEqual(
        XCTWaiter.wait(for: [loaded], timeout: 20), .completed,
        "The real Hermes tool catalog must finish loading.")
      capture(app, "Native configuration with the real Hermes tool catalog")
      app.buttons["Avatar"].tap()
      capture(app, "Native avatar configuration")
      app.buttons["Details"].tap()
      reveal(app.buttons["Delete assistant"], in: app, direction: .up)
      app.buttons["Delete assistant"].tap()
      let deletion = app.buttons.matching(identifier: "Delete assistant")
      deletion.element(boundBy: deletion.count - 1).tap()
      let dismissed = XCTNSPredicateExpectation(
        predicate: NSPredicate(format: "exists == false"), object: app.textFields["Name"])
      XCTAssertEqual(XCTWaiter.wait(for: [dismissed], timeout: 20), .completed)
      let back = app.navigationBars.buttons.matching(identifier: "Your assistants").firstMatch
      if back.exists { back.tap() }
      XCTAssertTrue(
        app.buttons["Create assistant"].waitForExistence(timeout: 20),
        "Remove the test-owned assistant after capture.")
      XCTAssertFalse(newBot.exists)
    }

    private enum Direction { case up, down }

    private func reveal(_ element: XCUIElement, in app: XCUIApplication, direction: Direction) {
      for _ in 0..<8 {
        if element.exists && element.isHittable { return }
        if direction == .up { app.swipeUp() } else { app.swipeDown() }
      }
      XCTAssertTrue(
        element.exists && element.isHittable,
        "The expected current reply or control must be visible.")
    }

    private func capture(_ app: XCUIApplication, _ name: String) {
      let attachment = XCTAttachment(screenshot: app.screenshot())
      attachment.name = name
      attachment.lifetime = .keepAlways
      add(attachment)
    }
  }
#endif
