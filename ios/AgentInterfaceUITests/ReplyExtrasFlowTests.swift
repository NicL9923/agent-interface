import XCTest

/// A reply's file chips opening the artifacts sheet on one file, and a revised email draft with its
/// changes shown and hidden, in one fixture conversation.
@MainActor final class ReplyExtrasFlowTests: XCTestCase {
  private func launch() -> XCUIApplication {
    let app = XCUIApplication()
    app.launchEnvironment["AGENT_INTERFACE_UI_FIXTURE"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_RESET"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_REPLY_EXTRAS"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_SCOPE"] = UUID().uuidString.lowercased()
    app.launch(); return app
  }
  private func element(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
    app.descendants(matching: .any).matching(identifier: identifier).firstMatch
  }
  private func capture(_ app: XCUIApplication, name: String) {
    let attachment = XCTAttachment(screenshot: app.screenshot()); attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
  }
  private func center(_ target: XCUIElement, in app: XCUIApplication) {
    let height = app.frame.height
    for _ in 0..<20 {
      let middle = target.frame.midY
      guard middle < height * 0.25 || middle > height * 0.7 else { return }
      let (from, to) = middle > height * 0.7 ? (0.7, 0.45) : (0.35, 0.6)
      app.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: from))
        .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: to)))
    }
  }
  func testReplyFileChipsOpenTheArtifactsSheetOnTheirFile() {
    let app = launch()
    let chip = element(app, "replyFile-pasture-map")
    for _ in 0..<8 where !chip.exists { app.swipeDown() }
    XCTAssertTrue(chip.waitForExistence(timeout: 15), app.debugDescription)
    center(chip, in: app)
    // Four chips, the tool's files first, then "+2 more"; the person's message carries none.
    for id in ["fence-chart", "fence-csv", "pasture-map", "repair-notes"] { XCTAssertTrue(element(app, "replyFile-" + id).exists, id) }
    XCTAssertFalse(element(app, "replyFile-supply-quote").exists)
    XCTAssertTrue(element(app, "replyFilesMore").exists)
    capture(app, name: "Native reply file chips")
    chip.tap()
    let row = element(app, "artifact-pasture-map")
    XCTAssertTrue(row.waitForExistence(timeout: 5))
    XCTAssertEqual(row.value as? String, "From the reply")
    XCTAssertTrue(row.isSelected)
    capture(app, name: "Native artifacts sheet focused from a chip")
    app.buttons["Close"].tap()
    element(app, "replyFilesMore").tap()
    XCTAssertTrue(element(app, "artifact-supply-quote").waitForExistence(timeout: 5))
    XCTAssertNotEqual(element(app, "artifact-pasture-map").value as? String, "From the reply")
    app.buttons["Close"].tap()
  }
  func testARevisedDraftShowsAndHidesItsChanges() {
    let app = launch()
    let toggle = element(app, "emailChanges.sam2")
    XCTAssertTrue(toggle.waitForExistence(timeout: 15), app.debugDescription)
    center(element(app, "emailBody.sam2"), in: app)
    XCTAssertTrue(app.staticTexts["Revises “Fence help”"].exists)
    // The earlier draft revises nothing, so it has no toggle.
    XCTAssertFalse(element(app, "emailChanges.sam1").exists)
    let body = element(app, "emailBody.sam2")
    let flat = { body.label.replacingOccurrences(of: "\n", with: " / ") }
    XCTAssertTrue(body.label.contains("removed: Saturday"), "\(body.elementType.rawValue): " + flat())
    XCTAssertTrue(body.label.contains("added: Sunday"), flat())
    capture(app, name: "Native revised email draft with changes")
    toggle.tap()
    XCTAssertTrue(app.buttons["Show changes"].waitForExistence(timeout: 5))
    XCTAssertFalse(body.label.contains("removed:"), flat())
    capture(app, name: "Native revised email draft without changes")
  }
}
