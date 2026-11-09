import XCTest

/// Live Talk against the fixture's scripted voice: the person asks one question, the assistant's
/// answer from the fixture server is spoken back, and End releases the microphone.
@MainActor final class TalkFlowTests: XCTestCase {
  private func launch(liveVoice: Bool = true) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchEnvironment["AGENT_INTERFACE_UI_FIXTURE"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_RESET"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_SCOPE"] = UUID().uuidString.lowercased()
    if !liveVoice { app.launchEnvironment["AGENT_INTERFACE_UI_LIVE_VOICE"] = "off" }
    app.launch()
    return app
  }
  private func capture(_ app: XCUIApplication, _ name: String) {
    let attachment = XCTAttachment(screenshot: app.screenshot()); attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
  }
  private func element(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
    app.descendants(matching: .any).matching(identifier: identifier).firstMatch
  }

  func testTalkAsksTheAssistantAndSpeaksItsAnswer() {
    let app = launch()
    let talk = app.buttons["talkButton"]
    XCTAssertTrue(talk.waitForExistence(timeout: 15), app.debugDescription)
    XCTAssertEqual(talk.label, "Talk live with Ranch hand")
    talk.tapWhenReady()
    let captions = element(app, "talkCaptions")
    XCTAssertTrue(captions.wait(until: "label CONTAINS %@", "The north gate is closed."), captions.debugDescription)
    XCTAssertTrue(captions.label.contains("Is the north gate closed?"), captions.label)
    XCTAssertTrue(element(app, "talkStatus").wait(until: "label == %@", "Listening"))
    // Talk owns the microphone: no recording while it runs.
    XCTAssertFalse(app.buttons["Record voice"].isEnabled)
    capture(app, "talk-live")
    app.buttons["End talk"].firstMatch.tapWhenReady()
    XCTAssertTrue(element(app, "talkStatus").waitForDisappearance())
    XCTAssertTrue(app.buttons["Record voice"].wait(until: "enabled == true"))
    XCTAssertEqual(app.buttons["talkButton"].label, "Talk live with Ranch hand")
  }

  func testTalkLinkStartsLiveTalkFromHome() {
    let app = launch()
    XCTAssertTrue(app.textViews["messageComposer"].waitForExistence(timeout: 15))
    let back = app.navigationBars.buttons.matching(identifier: "Your assistants").firstMatch
    if back.exists { back.tap() } else { app.navigationBars.buttons.firstMatch.tap() }
    XCTAssertTrue(app.buttons["openSettings"].waitForExistence(timeout: 5))
    app.open(DeepLinkFixture.talk("ranch"))
    XCTAssertTrue(element(app, "talkCaptions").wait(until: "label CONTAINS %@", "The north gate is closed."), app.debugDescription)
    XCTAssertFalse(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Stop recording")).firstMatch.exists,
      "With live Talk the control talks instead of recording")
  }

  func testUnavailableTalkSaysWhyWithoutStarting() {
    let app = launch(liveVoice: false)
    let talk = app.buttons["talkButton"]
    XCTAssertTrue(talk.waitForExistence(timeout: 15), app.debugDescription)
    talk.tapWhenReady()
    let message = element(app, "talkMessage")
    XCTAssertTrue(message.waitForExistence(timeout: 5))
    XCTAssertEqual(message.label, "Enable the wildbots-voice plugin in Hermes.")
    XCTAssertFalse(element(app, "talkStatus").exists)
    app.buttons["Dismiss"].firstMatch.tapWhenReady()
    XCTAssertTrue(message.waitForDisappearance())
  }
}
