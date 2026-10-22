import XCTest

/// Settings' home sections and follow lists, the two-step New assistant flow, and Hermes release
/// dates, against the Debug-only transport. Set AGENT_INTERFACE_SCREENSHOT_DIR to keep PNGs.
@MainActor final class SettingsPolishTests: XCTestCase {
  override func setUp() async throws { continueAfterFailure = false }
  private func launch(_ switches: [String] = []) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchEnvironment["AGENT_INTERFACE_UI_FIXTURE"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_RESET"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_HOME"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_SCOPE"] = UUID().uuidString.lowercased()
    for name in switches { app.launchEnvironment["AGENT_INTERFACE_UI_" + name] = "1" }
    app.launch()
    XCTAssertTrue(app.buttons["openSettings"].waitForExistence(timeout: 15))
    return app
  }
  private func capture(_ name: String) throws {
    Thread.sleep(forTimeInterval: 0.8)
    let screenshot = XCUIScreen.main.screenshot()
    let attachment = XCTAttachment(screenshot: screenshot); attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    if let directory = ProcessInfo.processInfo.environment["AGENT_INTERFACE_SCREENSHOT_DIR"] {
      try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
      try screenshot.pngRepresentation.write(to: URL(fileURLWithPath: directory).appendingPathComponent(name + ".png"))
    }
  }
  private func reveal(_ app: XCUIApplication, _ element: XCUIElement, up: Bool = true) {
    for _ in 0..<10 {
      if element.exists && element.isHittable { return }
      let surface = app.collectionViews.firstMatch
      if up { surface.swipeUp(velocity: .slow) } else { surface.swipeDown(velocity: .slow) }
    }
    XCTAssertTrue(element.isHittable, "\(element) never became hittable")
  }
  private func waitFor(_ format: String, _ element: XCUIElement, timeout: TimeInterval = 5) {
    expectation(for: NSPredicate(format: format), evaluatedWith: element)
    waitForExpectations(timeout: timeout)
  }
  private func section(_ app: XCUIApplication, _ name: String) -> XCUIElement {
    app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label BEGINSWITH %@", "homeSection.", name)).firstMatch
  }
  private func openSettings(_ app: XCUIApplication) {
    app.buttons["openSettings"].tap()
    XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 5))
  }
  private func back(_ app: XCUIApplication) {
    app.navigationBars.buttons.firstMatch.tap()
    XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 5))
  }

  func testFollowAndHomeSectionsUseOneListEach() throws {
    let app = launch()
    openSettings(app)
    let follow = app.buttons["followedAssistants"]
    reveal(app, follow)
    XCTAssertTrue(follow.label.contains("Not following any assistants"), follow.label)
    // The add row is an action, never a dimmed control: Add only appears with a name to add.
    let name = app.textFields["newSectionName"]
    reveal(app, name)
    XCTAssertFalse(app.buttons["addSection"].exists)
    try capture("after-settings-home")
    follow.tap()
    app.buttons["assistantCheck.ranch"].tap()
    waitFor("selected == true", app.buttons["assistantCheck.ranch"])
    app.buttons["assistantCheck.kitchen"].tap()
    try capture("after-follow-list")
    back(app)
    waitFor("label CONTAINS 'Following 2 assistants'", follow)
    XCTAssertTrue(follow.label.contains("Following 2 assistants"), follow.label)

    reveal(app, name)
    name.tap()
    name.typeText("Around the house")
    XCTAssertTrue(app.buttons["addSection"].waitForExistence(timeout: 3))
    try capture("after-section-typed")
    app.buttons["addSection"].tap()
    XCTAssertTrue(section(app, "Around the house").waitForExistence(timeout: 5))
    // Return adds too.
    name.tap()
    name.typeText("Kids\n")
    XCTAssertTrue(section(app, "Kids").waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["reorderSections"].exists)

    section(app, "Around the house").tap()
    XCTAssertTrue(app.textFields["sectionName"].waitForExistence(timeout: 5))
    app.buttons["assistantCheck.ranch"].tap()
    app.buttons["assistantCheck.kitchen"].tap()
    waitFor("selected == true", app.buttons["assistantCheck.kitchen"])
    back(app)
    reveal(app, section(app, "Kids"))
    XCTAssertTrue(section(app, "Around the house").label.contains("2 assistants"), section(app, "Around the house").label)

    // Choosing an assistant that is already elsewhere moves it; it is never in two sections.
    section(app, "Kids").tap()
    let ranch = app.buttons["assistantCheck.ranch"]
    XCTAssertTrue(ranch.waitForExistence(timeout: 5))
    XCTAssertTrue(ranch.label.contains("In Around the house"), ranch.label)
    try capture("after-section-detail")
    ranch.tap()
    waitFor("selected == true", ranch)
    back(app)
    reveal(app, section(app, "Kids"))
    XCTAssertTrue(section(app, "Around the house").label.contains("1 assistant"), section(app, "Around the house").label)
    XCTAssertTrue(section(app, "Kids").label.contains("1 assistant"), section(app, "Kids").label)
    try capture("after-settings-sections")

    app.buttons["Close"].tap()
    XCTAssertTrue(app.staticTexts["Around the house"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["Kids"].exists)
    try capture("after-home-sections")
  }

  func testCreationIsNameAndLookThenRoleAndSavesTheChosenAvatar() throws {
    let app = launch()
    app.buttons["New assistant"].tap()
    XCTAssertTrue(app.descendants(matching: .any)["creationStep"].waitForExistence(timeout: 5))
    // Tabs that need an existing assistant are not offered while creating.
    XCTAssertFalse(app.buttons["settingsMore"].exists)
    XCTAssertFalse(app.buttons["Portrait"].exists)
    XCTAssertFalse(app.buttons["creationNext"].isEnabled)
    let name = app.textFields["Name"]
    name.tap()
    name.typeText("Barn cat\n")
    app.buttons["Mascot"].tap()
    let fox = app.buttons["avatarTile.family.fox"]
    reveal(app, fox)
    fox.tap()
    for _ in 0..<3 { app.collectionViews.firstMatch.swipeDown() }
    try capture("after-create-look")
    app.buttons["creationNext"].tap()
    XCTAssertTrue(app.buttons["creationCreate"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["creationBack"].exists)
    XCTAssertTrue(app.staticTexts["Step 2 of 2"].isHittable || app.descendants(matching: .any)["creationStep"].isHittable, "Step 2 opens at its top")
    try capture("after-create-role")
    app.buttons["creationCreate"].tap()
    let created = app.buttons["bot.created-1"]
    XCTAssertTrue(created.waitForExistence(timeout: 10), app.debugDescription)
    try capture("after-create-home")
    created.tap()
    app.openAssistantSettings("Barn cat")
    XCTAssertTrue(app.buttons["Avatar"].waitForExistence(timeout: 5))
    app.buttons["Avatar"].tap()
    let savedFox = app.buttons["avatarTile.family.fox"]
    reveal(app, savedFox)
    XCTAssertTrue(savedFox.isSelected, "The look chosen while creating is the saved avatar")
  }

  func testAFailedAvatarSaveKeepsTheNewAssistantOpenWithRetry() throws {
    let app = launch(["AVATAR_FAILURE"])
    app.buttons["New assistant"].tap()
    let name = app.textFields["Name"]
    XCTAssertTrue(name.waitForExistence(timeout: 5))
    name.tap()
    name.typeText("Feed tracker")
    app.buttons["Mascot"].tap()
    app.buttons["creationNext"].tap()
    app.buttons["creationCreate"].tap()
    let failure = app.staticTexts["Feed tracker was created, but its avatar wasn't saved yet."]
    XCTAssertTrue(failure.waitForExistence(timeout: 10), app.debugDescription)
    XCTAssertTrue(app.staticTexts["Fixture avatar save failed"].exists, "The server's reason is shown too")
    // The sheet now edits the created assistant, its chosen look intact.
    XCTAssertTrue(app.navigationBars["Feed tracker"].exists)
    XCTAssertTrue(app.buttons["settingsMore"].exists)
    XCTAssertTrue(app.buttons["Mascot"].isSelected)
    try capture("after-create-avatar-failed")
    app.buttons["retryAvatar"].tap()
    XCTAssertTrue(app.buttons["bot.created-1"].waitForExistence(timeout: 10), app.debugDescription)
  }

  func testHermesShowsReleaseDatesWithTheHashAsDetail() throws {
    let app = launch()
    openSettings(app)
    XCTAssertTrue(app.buttons["Hermes updates"].label.contains("Hermes released Oct 14, 2026"), app.buttons["Hermes updates"].label)
    let footer = app.staticTexts["Hermes released Oct 14, 2026"]
    reveal(app, footer)
    XCTAssertTrue(app.staticTexts["3f9c2a7"].exists)
    try capture("after-settings-footer")
    reveal(app, app.buttons["Hermes updates"], up: false)
    app.buttons["Hermes updates"].tap()
    XCTAssertTrue(app.buttons["checkHermesUpdate"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Released Oct 14, 2026")).firstMatch.exists, app.debugDescription)
    try capture("after-hermes-updates")
    app.buttons["checkHermesUpdate"].tap()
    XCTAssertTrue(app.buttons["installHermesUpdate"].waitForExistence(timeout: 20))
    XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Released Oct 20, 2026")).firstMatch.exists, app.debugDescription)
    XCTAssertFalse(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "8e1d4c7b2a9f")).firstMatch.exists)
    try capture("after-hermes-ready")
  }
}
