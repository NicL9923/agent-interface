import UIKit
import XCTest

final class TabletPresentationTests: XCTestCase {
  private func fixture() -> XCUIApplication {
    let app = XCUIApplication()
    app.launchEnvironment["AGENT_INTERFACE_UI_FIXTURE"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_SCOPE"] = UUID().uuidString.lowercased()
    app.launch()
    return app
  }
  private func screenshot(_ app: XCUIApplication, _ name: String) {
    let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }
  func testIPadSplitNavigationSettingsAndAvatarStates() throws {
    guard UIDevice.current.userInterfaceIdiom == .pad else {
      throw XCTSkip("Tablet visual acceptance requires an iPad simulator.")
    }
    let app = fixture()
    XCTAssertTrue(app.textFields["messageComposer"].waitForExistence(timeout: 10))
    XCUIDevice.shared.orientation = .landscapeLeft
    if !app.buttons["bot.kitchen"].exists, app.buttons["Show Sidebar"].exists {
      app.buttons["Show Sidebar"].tap()
    }
    XCTAssertTrue(app.buttons["bot.kitchen"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.textFields["messageComposer"].exists)
    screenshot(app, "Fixture iPad landscape split view")
    app.buttons["bot.kitchen"].tap()
    XCTAssertTrue(app.buttons["Configure Kitchen companion"].waitForExistence(timeout: 5))
    app.buttons["Configure Kitchen companion"].tap()
    XCTAssertTrue(app.textFields["Name"].waitForExistence(timeout: 5))
    screenshot(app, "Fixture iPad native assistant settings")
    app.buttons["Close"].tap()
    if !app.buttons["Your preferences"].exists, app.buttons["Show Sidebar"].exists {
      app.buttons["Show Sidebar"].tap()
    }
    app.buttons["Your preferences"].tap()
    XCTAssertTrue(app.buttons["Save"].waitForExistence(timeout: 5))
    screenshot(app, "Fixture iPad personal preferences")
    let specimen = app.buttons["Avatar specimen"]
    for _ in 0..<8 {
      if specimen.exists { break }
      app.swipeUp()
    }
    XCTAssertTrue(specimen.exists)
    specimen.tap()
    XCTAssertTrue(app.switches["Reduced motion"].waitForExistence(timeout: 5))
    screenshot(app, "Fixture iPad nine avatar states")
    app.switches["Reduced motion"].tap()
    screenshot(app, "Fixture iPad reduced motion avatar states")
    XCUIDevice.shared.orientation = .portrait
    screenshot(app, "Fixture iPad portrait avatar states")
    XCTAssertFalse(
      app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "unreadable response"))
        .firstMatch.exists)
  }
}
