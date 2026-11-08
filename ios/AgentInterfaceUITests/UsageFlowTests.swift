import XCTest

/// The profile menu on home and the Usage sheet it opens. Debug fixtures stand in for the server
/// and Hermes; they establish native behavior, not a provider's real limits.
@MainActor final class UsageFlowTests: XCTestCase {
  override func setUp() { continueAfterFailure = false }
  private let chatgptKey = String(repeating: "c", count: 32)
  private func launch(dark: Bool = false) -> XCUIApplication {
    let app = XCUIApplication()
    if dark { app.launchEnvironment["AGENT_INTERFACE_UI_THEME"] = "dark" }
    app.launchEnvironment["AGENT_INTERFACE_UI_FIXTURE"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_RESET"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_SCOPE"] = UUID().uuidString.lowercased()
    app.launchEnvironment["AGENT_INTERFACE_UI_HOME"] = "1"
    app.launch()
    return app
  }
  private func capture(_ name: String) throws {
    let screenshot = XCUIScreen.main.screenshot()
    let attachment = XCTAttachment(screenshot: screenshot); attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    if let directory = ProcessInfo.processInfo.environment["AGENT_INTERFACE_SCREENSHOT_DIR"] {
      try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
      try screenshot.pngRepresentation.write(to: URL(fileURLWithPath: directory).appendingPathComponent(name + ".png"))
    }
  }
  /// A confirmation dialog is a popover on this device and has no Cancel button; a tap outside it cancels.
  private func dismissDialog(_ app: XCUIApplication) {
    app.otherElements["PopoverDismissRegion"].coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.95)).tap()
    XCTAssertTrue(app.popovers.firstMatch.waitForDisappearance(timeout: 5), app.debugDescription)
  }
  private func openUsage(_ app: XCUIApplication) {
    app.profileMenu.tapWhenReady(timeout: 15)
    app.profileMenuItem("Usage").tapWhenReady()
    XCTAssertTrue(app.staticTexts["ChatGPT"].waitForExistence(timeout: 10), app.debugDescription)
  }

  func testProfileMenuListsUsageSettingsAndSignOutAndUsageShowsTheAccounts() throws {
    let app = launch()
    app.profileMenu.tapWhenReady(timeout: 15)
    XCTAssertTrue(app.profileMenuItem("Usage").waitForExistence(timeout: 5), app.debugDescription)
    XCTAssertTrue(app.profileMenuItem("Settings").exists)
    XCTAssertTrue(app.profileMenuItem("Sign out").exists)
    // The subtitle names the account closest to a limit once the accounts have loaded.
    XCTAssertTrue(app.profileMenuItem("Usage").label.contains("ChatGPT"), app.profileMenuItem("Usage").label)
    try capture("usage-menu")
    app.profileMenuItem("Usage").tapWhenReady()
    XCTAssertTrue(app.staticTexts["ChatGPT"].waitForExistence(timeout: 10), app.debugDescription)
    XCTAssertTrue(app.staticTexts["Pro"].exists)
    XCTAssertTrue(app.staticTexts["100% used"].exists); XCTAssertTrue(app.staticTexts["63% used"].exists)
    XCTAssertTrue(app.staticTexts["Not reported"].exists, "A window with no percentage says so instead of drawing a bar")
    XCTAssertTrue(app.staticTexts["Fallback"].exists)
    XCTAssertTrue(app.staticTexts["Credits balance: $4.00"].exists)
    try capture("usage-sheet")
    // The footer is the end of a lazy list, so it is reached by scrolling.
    let footer = app.staticTexts["Usage unavailable for 1 assistant."]
    for _ in 0..<6 where !footer.canTap { app.collectionViews["usage.list"].swipeUp() }
    XCTAssertTrue(footer.waitForExistence(timeout: 5), app.debugDescription)
    XCTAssertTrue(app.buttons["usage.refresh"].exists)
    try capture("usage-sheet-footer")
  }

  func testUsageSheetInDarkAppearance() throws {
    let app = launch(dark: true)
    app.profileMenu.tapWhenReady(timeout: 15)
    XCTAssertTrue(app.profileMenuItem("Usage").waitForExistence(timeout: 5))
    try capture("usage-menu-dark")
    app.profileMenuItem("Usage").tapWhenReady()
    XCTAssertTrue(app.staticTexts["ChatGPT"].waitForExistence(timeout: 10), app.debugDescription)
    try capture("usage-sheet-dark")
  }

  func testSpendingABankedResetAsksFirstAndReportsTheOutcome() throws {
    let app = launch()
    openUsage(app)
    let reset = app.buttons["usage.reset.\(chatgptKey)"]
    XCTAssertTrue(app.staticTexts["2 banked resets"].exists)
    reset.tapWhenReady()
    XCTAssertTrue(app.staticTexts["Use a banked reset?"].waitForExistence(timeout: 5), app.debugDescription)
    XCTAssertTrue(app.staticTexts["This restores this account's session and weekly limits now. You'll have 1 left."].exists)
    try capture("usage-reset-confirm")
    dismissDialog(app)
    XCTAssertTrue(app.staticTexts["2 banked resets"].waitForExistence(timeout: 5), "Cancel spends nothing")
    XCTAssertFalse(app.staticTexts["usage.outcome.\(chatgptKey)"].exists)
    reset.tapWhenReady()
    app.popovers.buttons["usage.confirmReset"].firstMatch.tapWhenReady()
    XCTAssertTrue(app.staticTexts["Limits reset. 1 banked reset left."].waitForExistence(timeout: 10), app.debugDescription)
    XCTAssertTrue(app.staticTexts["1 banked reset"].exists, "The account is replaced by the one the server returned")
    try capture("usage-reset-done")
  }

  func testSignOutFromTheProfileMenuAsksBeforeSigningOut() throws {
    let app = launch()
    app.profileMenu.tapWhenReady(timeout: 15)
    app.profileMenuItem("Sign out").tapWhenReady()
    XCTAssertTrue(app.staticTexts["Sign out on this device? Your personal drafts stay saved for your next sign-in."].waitForExistence(timeout: 5), app.debugDescription)
    dismissDialog(app)
    XCTAssertTrue(app.profileMenu.waitUntilHittable(), "Cancelling stays signed in on home")
  }
}
