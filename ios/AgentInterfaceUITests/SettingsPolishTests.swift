import XCTest

/// Settings' home sections and follow lists, the two-step New assistant flow, and Hermes release
/// dates, against the Debug-only transport. Set AGENT_INTERFACE_SCREENSHOT_DIR to keep PNGs.
@MainActor final class SettingsPolishTests: XCTestCase {
  override func setUp() async throws { continueAfterFailure = false }
  private func launch(_ switches: [String] = [], presentation: String? = nil, values: [String: String] = [:]) -> XCUIApplication {
    let app = XCUIApplication()
    if let presentation { app.launchEnvironment["AGENT_INTERFACE_UI_PRESENTATION"] = presentation }
    for (name, value) in values { app.launchEnvironment["AGENT_INTERFACE_UI_" + name] = value }
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
      if element.exists && element.canTap { return }
      let surface = app.collectionViews.firstMatch
      if up { surface.swipeUp(velocity: .slow) } else { surface.swipeDown(velocity: .slow) }
    }
    XCTAssertTrue(element.canTap, "\(element) never became hittable")
  }
  private func waitFor(_ format: String, _ element: XCUIElement, timeout: TimeInterval = 5) {
    expectation(for: NSPredicate(format: format), evaluatedWith: element)
    waitForExpectations(timeout: timeout)
  }
  private func section(_ app: XCUIApplication, _ name: String) -> XCUIElement {
    app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label BEGINSWITH %@", "homeSection.", name)).firstMatch
  }
  private func openSettings(_ app: XCUIApplication) {
    app.openSettingsFromProfileMenu()
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
    app.buttons["assistantCheck.ranch"].tapWhenReady()
    waitFor("selected == true", app.buttons["assistantCheck.ranch"])
    app.buttons["assistantCheck.kitchen"].tapWhenReady()
    try capture("after-follow-list")
    back(app)
    waitFor("label CONTAINS 'Following 2 assistants'", follow)
    XCTAssertTrue(follow.label.contains("Following 2 assistants"), follow.label)

    reveal(app, name)
    name.typeWhenFocused("Around the house")
    XCTAssertTrue(app.buttons["addSection"].waitForExistence(timeout: 3))
    try capture("after-section-typed")
    app.buttons["addSection"].tap()
    XCTAssertTrue(section(app, "Around the house").waitForExistence(timeout: 5))
    // Return adds too.
    name.typeWhenFocused("Kids\n")
    XCTAssertTrue(section(app, "Kids").waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["reorderSections"].exists)

    section(app, "Around the house").tap()
    XCTAssertTrue(app.textFields["sectionName"].waitForExistence(timeout: 5))
    app.buttons["assistantCheck.ranch"].tap()
    app.buttons["assistantCheck.kitchen"].tap()
    waitFor("selected == true", app.buttons["assistantCheck.kitchen"])
    back(app)
    reveal(app, section(app, "Kids"))
    waitFor("label CONTAINS '2 assistants'", section(app, "Around the house"))

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
    waitFor("label CONTAINS '1 assistant'", section(app, "Around the house"))
    waitFor("label CONTAINS '1 assistant'", section(app, "Kids"))
    try capture("after-settings-sections")

    app.buttons["Close"].tap()
    XCTAssertTrue(app.staticTexts["Around the house"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["Kids"].exists)
    try capture("after-home-sections")
  }

  func testCreationIsNameAndLookThenRoleAndSavesTheChosenAvatar() throws {
    let app = launch()
    app.tapNewAssistant()
    XCTAssertTrue(app.descendants(matching: .any)["creationStep"].waitForExistence(timeout: 5))
    // Sections that need an existing assistant are not offered while creating.
    XCTAssertFalse(app.collectionViews["settingsSections"].exists)
    XCTAssertFalse(app.descendants(matching: .any)["mcpServer.existing-calendar"].exists)
    XCTAssertFalse(app.buttons["Portrait"].exists)
    XCTAssertFalse(app.buttons["creationNext"].isEnabled)
    let name = app.textFields["Name"]
    name.typeWhenFocused("Barn cat\n")
    app.buttons["Mascot"].tapWhenReady()
    let fox = app.buttons["avatarTile.family.fox"]
    reveal(app, fox)
    fox.tap()
    for _ in 0..<3 { app.collectionViews.firstMatch.swipeDown() }
    try capture("after-create-look")
    app.buttons["creationNext"].tap()
    XCTAssertTrue(app.buttons["creationCreate"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["creationBack"].exists)
    XCTAssertTrue(app.staticTexts["Step 2 of 2"].canTap || app.descendants(matching: .any)["creationStep"].canTap, "Step 2 opens at its top")
    try capture("after-create-role")
    app.buttons["creationCreate"].tap()
    let created = app.buttons["bot.created-1"]
    XCTAssertTrue(created.waitForExistence(timeout: 10), app.debugDescription)
    try capture("after-create-home")
    created.tap()
    app.openAssistantSettings("Barn cat")
    app.selectSettingsTab("Profile")
    let savedFox = app.buttons["avatarTile.family.fox"]
    reveal(app, savedFox)
    XCTAssertTrue(savedFox.wait(until: "selected == true"), "The look chosen while creating is the saved avatar")
  }

  func testAFailedAvatarSaveKeepsTheNewAssistantOpenWithRetry() throws {
    let app = launch(["AVATAR_FAILURE"])
    app.tapNewAssistant()
    let name = app.textFields["Name"]
    XCTAssertTrue(name.waitForExistence(timeout: 5))
    name.typeWhenFocused("Feed tracker")
    app.buttons["Mascot"].tapWhenReady()
    app.buttons["creationNext"].tapWhenReady()
    app.buttons["creationCreate"].tapWhenReady()
    let failure = app.staticTexts["Feed tracker was created, but its avatar wasn't saved yet."]
    XCTAssertTrue(failure.waitForExistence(timeout: 10), app.debugDescription)
    XCTAssertTrue(app.staticTexts["Fixture avatar save failed"].exists, "The server's reason is shown too")
    // The sheet now edits the created assistant on its Profile, its chosen look intact.
    XCTAssertTrue(app.navigationBars["Profile"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.navigationBars["Profile"].buttons["All settings"].exists)
    XCTAssertTrue(app.buttons["Mascot"].isSelected)
    try capture("after-create-avatar-failed")
    app.buttons["retryAvatar"].tap()
    let created = app.buttons["bot.created-1"]
    XCTAssertTrue(created.waitForExistence(timeout: 10), app.debugDescription)
    // Reopening shows what the server holds, so a retry that never sent the avatar fails here.
    created.tap()
    app.openAssistantSettings("Feed tracker")
    app.selectSettingsTab("Profile")
    XCTAssertTrue(app.buttons["Mascot"].wait(until: "selected == true"), "The retried avatar was saved")
  }
  /// A new assistant that keeps the default look still owes its first avatar save after a failure.
  func testRetryingAFailedDefaultAvatarSendsItAgain() throws {
    let app = launch(values: ["AVATAR_FAILURE": "2"])
    app.tapNewAssistant()
    let name = app.textFields["Name"]
    XCTAssertTrue(name.waitForExistence(timeout: 5))
    name.typeWhenFocused("Gate keeper")
    app.buttons["creationNext"].tapWhenReady()
    app.buttons["creationCreate"].tapWhenReady()
    XCTAssertTrue(app.staticTexts["Fixture avatar save failed"].waitForExistence(timeout: 10), app.debugDescription)
    app.buttons["retryAvatar"].tapWhenReady()
    XCTAssertTrue(app.staticTexts["Fixture avatar save failed again"].waitForExistence(timeout: 10), "Retry sent the default avatar")
    app.buttons["retryAvatar"].tapWhenReady()
    XCTAssertTrue(app.buttons["bot.created-1"].waitForExistence(timeout: 10), app.debugDescription)
  }
  /// Retry is a way to save, so it refuses an empty name instead of sending it.
  func testRetryRefusesAnEmptyName() throws {
    let app = launch(["AVATAR_FAILURE"])
    app.tapNewAssistant()
    let name = app.textFields["Name"]
    XCTAssertTrue(name.waitForExistence(timeout: 5))
    name.typeWhenFocused("Hay")
    app.buttons["creationNext"].tapWhenReady()
    app.buttons["creationCreate"].tapWhenReady()
    XCTAssertTrue(app.staticTexts["Fixture avatar save failed"].waitForExistence(timeout: 10), app.debugDescription)
    let field = app.textFields["Name"]
    field.typeWhenFocused(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 3))
    app.buttons["retryAvatar"].tapWhenReady()
    XCTAssertTrue(app.staticTexts["Give your assistant a name."].waitForExistence(timeout: 5), app.debugDescription)
    XCTAssertTrue(app.navigationBars["Profile"].exists, "The sheet stays on Profile")
    field.typeWhenFocused("Hay counter")
    app.buttons["retryAvatar"].tapWhenReady()
    XCTAssertTrue(app.buttons["bot.created-1"].waitForExistence(timeout: 10), app.debugDescription)
  }
  /// A failed settings load keeps its Retry after a visit to a section and back.
  func testSettingsLoadRetrySurvivesNavigation() throws {
    let app = launch(["DETAIL_FAILURE"])
    openRanchSettings(app)
    let retry = app.buttons["Retry settings"]
    XCTAssertTrue(retry.waitForExistence(timeout: 10), app.debugDescription)
    app.buttons["settingsSection.profile"].tapWhenReady()
    app.showSettingsSections()
    XCTAssertTrue(retry.waitForExistence(timeout: 5), "Navigation did not drop the load failure")
    XCTAssertTrue(app.staticTexts["Fixture settings unavailable"].exists)
    retry.tapWhenReady()
    XCTAssertTrue(retry.waitForDisappearance(), "Settings load on retry")
  }

  private func openRanchSettings(_ app: XCUIApplication) {
    app.buttons["bot.ranch"].tapWhenReady()
    app.openAssistantSettings("Ranch hand")
  }
  /// One Save sends the assistant's fields, then its avatar. A failed avatar keeps the saved name, and
  /// the next Save sends only the avatar, so it reads "Saved" rather than the sharing notice.
  func testOneSaveKeepsWhatSavedAndRetriesOnlyWhatFailed() throws {
    let app = launch(["AVATAR_FAILURE"])
    openRanchSettings(app)
    XCTAssertTrue(app.buttons["settingsSection.profile"].label.contains("Shared with your household"))
    app.selectSettingsTab("Profile")
    let save = app.buttons["saveChanges"]
    XCTAssertTrue(save.waitForExistence(timeout: 5)); XCTAssertFalse(save.isEnabled, "Nothing to save yet")
    let name = app.textFields["Name"]
    XCTAssertTrue(name.wait(until: "enabled == true"))
    name.typeWhenFocused(" two\n")
    let style = app.buttons["Mascot"].isSelected ? app.buttons["Geometric"] : app.buttons["Mascot"]
    style.tapWhenReady()
    XCTAssertTrue(save.wait(until: "enabled == true"))
    save.tap()
    XCTAssertTrue(app.staticTexts["Fixture avatar save failed"].waitForExistence(timeout: 10), app.debugDescription)
    XCTAssertTrue(save.wait(until: "enabled == true"), "The avatar is still unsaved")
    try capture("after-save-partial-failure")
    save.tap()
    XCTAssertTrue(app.staticTexts["settingsNotice"].wait(until: "label == %@", "Saved"), "Only the avatar was sent again")
    XCTAssertTrue(save.wait(until: "enabled == false"))
    app.showSettingsSections()
    XCTAssertTrue(app.staticTexts["Ranch hand two"].waitForExistence(timeout: 5), "The name saved on the first try")
  }
  func testMcpServersAreSwitchesInAdvancedAndHiddenInSimple() throws {
    var app = launch(presentation: "advanced")
    openRanchSettings(app)
    app.selectSettingsTab("Access")
    let calendar = app.switches["mcpServer.existing-calendar"], files = app.switches["mcpServer.household-files"]
    XCTAssertTrue(calendar.waitForExistence(timeout: 10))
    XCTAssertTrue(calendar.wait(until: "value == %@", "1")); XCTAssertTrue(files.wait(until: "value == %@", "0"))
    XCTAssertFalse(app.buttons["saveChanges"].exists, "Access shows Save changes only while edits are unsaved")
    try capture("after-access-mcp")
    files.switches.firstMatch.tapWhenReady()
    XCTAssertTrue(files.wait(until: "value == %@", "1"))
    let save = app.buttons["saveChanges"]
    XCTAssertTrue(save.waitForExistence(timeout: 5)); save.tapWhenReady()
    XCTAssertTrue(app.staticTexts["settingsNotice"].wait(until: "label == %@", "Changes saved for both household members."))
    XCTAssertTrue(save.waitForDisappearance(), "Saved edits put the bar away on Access")
    app.terminate()

    app = launch()
    openRanchSettings(app)
    app.selectSettingsTab("Access")
    XCTAssertTrue(app.buttons["settingsPage.connections"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["settingsPage.logins"].exists)
    XCTAssertFalse(app.switches["mcpServer.existing-calendar"].exists)
  }

  func testHermesShowsReleaseDatesWithTheHashAsDetail() throws {
    let app = launch()
    openSettings(app)
    waitFor("label CONTAINS 'Hermes released Oct 14, 2026'", app.buttons["Hermes updates"])
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
