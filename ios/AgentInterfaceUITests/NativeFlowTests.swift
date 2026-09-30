import XCTest

final class NativeFlowTests: XCTestCase {
  private func app(fixture: Bool = true, catalogFailure: Bool = false) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchEnvironment["AGENT_INTERFACE_UI_RESET"] = "1"
    if fixture {
      app.launchEnvironment["AGENT_INTERFACE_UI_FIXTURE"] = "1"
      app.launchEnvironment["AGENT_INTERFACE_UI_SCOPE"] = UUID().uuidString.lowercased()
    }
    if catalogFailure { app.launchEnvironment["AGENT_INTERFACE_UI_CATALOG_FAILURE"] = "1" }
    app.launch()
    return app
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
    let composer = app.textFields["messageComposer"]
    XCTAssertTrue(composer.waitForExistence(timeout: 10))
    composer.tap()
    composer.typeText("Remember the fence inspection")
    app.buttons["sendMessage"].tap()
    XCTAssertTrue(app.staticTexts["Remember the fence inspection"].waitForExistence(timeout: 10))
    app.buttons["Configure Ranch hand"].tap()
    XCTAssertTrue(app.textFields["Name"].waitForExistence(timeout: 5))
    app.buttons["Tools"].tap()
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
    app.buttons["Tools"].tap()
    XCTAssertTrue(app.buttons["Retry loading tools"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.buttons["Save tools"].isEnabled)
    XCTAssertFalse(app.staticTexts["No tools were reported by Hermes."].exists)
  }
}
