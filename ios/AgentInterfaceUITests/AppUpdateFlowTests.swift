import XCTest

final class AppUpdateFlowTests: XCTestCase {
  private func launch(update: Bool) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchEnvironment["AGENT_INTERFACE_UI_RESET"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_FIXTURE"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_SCOPE"] = UUID().uuidString.lowercased()
    if update { app.launchEnvironment["AGENT_INTERFACE_UI_APP_UPDATE"] = "1" }
    app.launch()
    return app
  }
  func testBannerOffersTheUpdateOnHomeAndInPreferences() {
    let app = launch(update: true)
    XCTAssertTrue(app.textViews["messageComposer"].waitForExistence(timeout: 15))
    XCTAssertTrue(app.staticTexts["A new version of WildBots is available"].exists)
    XCTAssertTrue(app.buttons["appUpdateButton"].isHittable)
    // Home keeps the banner too.
    if !app.buttons["Settings"].exists { app.navigationBars.buttons.firstMatch.tap() }
    XCTAssertTrue(app.buttons["Settings"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["appUpdateButton"].isHittable)
    let home = XCTAttachment(screenshot: app.screenshot())
    home.name = "Update banner on home"
    home.lifetime = .keepAlways
    add(home)
    app.buttons["Settings"].tap()
    let update = app.buttons["preferencesUpdateButton"]
    for _ in 0..<8 where !update.isHittable { app.swipeUp() }
    XCTAssertTrue(update.isHittable)
    XCTAssertTrue(app.staticTexts["Update available"].exists)
  }
  func testNoBannerWithoutANewerBuild() {
    let app = launch(update: false)
    XCTAssertTrue(app.textViews["messageComposer"].waitForExistence(timeout: 15))
    XCTAssertFalse(app.buttons["appUpdateButton"].exists)
  }
}
