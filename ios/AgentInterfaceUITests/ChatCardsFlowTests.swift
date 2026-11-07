import XCTest

/// A T3 Code thread launch, an email draft and a form in one fixture conversation. Sending the
/// form goes through the fixture's ordinary message route, which adds the answers to the chat.
@MainActor final class ChatCardsFlowTests: XCTestCase {
  private func launch() -> XCUIApplication {
    let app = XCUIApplication()
    app.launchEnvironment["AGENT_INTERFACE_UI_FIXTURE"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_RESET"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_CHAT_CARDS"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_SCOPE"] = UUID().uuidString.lowercased()
    app.launch(); return app
  }
  private func element(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
    app.descendants(matching: .any).matching(identifier: identifier).firstMatch
  }
  private func capture(_ app: XCUIApplication, name: String) {
    let attachment = XCTAttachment(screenshot: app.screenshot()); attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
  }
  private func reveal(_ target: XCUIElement, in app: XCUIApplication) {
    for _ in 0..<8 where !(target.exists && target.isHittable) { app.swipeUp() }
  }
  func testThreadCardEmailDraftAndFormSend() {
    let app = launch()
    let open = element(app, "t3ThreadOpen.launch-1")
    // The conversation opens at its end; the thread card is near the top.
    for _ in 0..<8 where !open.exists { app.swipeDown() }
    XCTAssertTrue(open.waitForExistence(timeout: 15), app.debugDescription)
    XCTAssertTrue(app.staticTexts["Fix the north gate sensor"].exists)
    XCTAssertTrue(app.staticTexts["Claude Opus 5.5 · New worktree on fix/north-gate-sensor"].exists)
    capture(app, name: "Native T3 Code thread card")

    let mail = element(app, "emailMail.sam")
    reveal(mail, in: app)
    XCTAssertTrue(mail.waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["Saturday hay delivery"].exists)
    element(app, "emailCopy.sam").tap()
    XCTAssertTrue(app.buttons["Copied"].waitForExistence(timeout: 5))
    capture(app, name: "Native email draft card")

    let send = element(app, "formSend.trip")
    reveal(send, in: app)
    XCTAssertTrue(send.waitForExistence(timeout: 10))
    // A required field left empty is named, and nothing is sent.
    send.tap()
    XCTAssertTrue(app.staticTexts["This one needs an answer."].waitForExistence(timeout: 5))
    capture(app, name: "Native form required answer")
    let destination = element(app, "form.trip.city").textFields.firstMatch
    destination.tap(); destination.typeText("Marfa")
    element(app, "form.trip.lodging.Cabin outside town").tap()
    reveal(send, in: app)
    send.tap()
    XCTAssertTrue(element(app, "formSent.trip").waitForExistence(timeout: 10), app.debugDescription)
    let sent = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "My answers to \"Marfa weekend\"")).firstMatch
    XCTAssertTrue(sent.waitForExistence(timeout: 10))
    capture(app, name: "Native form sent")
  }
}
