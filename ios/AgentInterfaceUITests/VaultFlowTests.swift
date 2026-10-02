import XCTest

final class VaultFlowTests: XCTestCase {
  private func launch(uncertain: Bool = false, cancelledAdd: Bool = false) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchEnvironment["AGENT_INTERFACE_UI_FIXTURE"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_RESET"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_VAULT"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_SCOPE"] = UUID().uuidString.lowercased()
    if cancelledAdd { app.launchEnvironment["AGENT_INTERFACE_UI_VAULT_ADD_CANCELLED"] = "1" }
    if uncertain { app.launchEnvironment["AGENT_INTERFACE_UI_SECURE_UNCERTAIN"] = "1" }
    app.launch(); return app
  }
  private func capture(_ app: XCUIApplication, name: String) {
    let attachment = XCTAttachment(screenshot: app.screenshot()); attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
  }
  private func field(_ id: String, app: XCUIApplication, value: String, secure: Bool = false) {
    let field = secure ? app.secureTextFields[id] : app.textFields[id]
    XCTAssertTrue(field.waitForExistence(timeout: 5)); field.tap(); field.typeText(value)
  }
  private func reveal(_ button: XCUIElement, app: XCUIApplication, container: XCUIElement? = nil) {
    for _ in 0..<5 { if button.isHittable { return }; (container ?? app.scrollViews.firstMatch).swipeUp() }
  }
  func testProfileLoginAddRemoveAndAvailableExternalSourceUnlock() {
    let app = launch()
    XCTAssertTrue(app.buttons["Configure Ranch hand"].waitForExistence(timeout: 10)); app.buttons["Configure Ranch hand"].tap()
    app.buttons["settingsMore"].tap(); app.buttons["Passwords & logins"].tap()
    XCTAssertTrue(app.staticTexts["Hermes profile: default"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["Fixture school portal"].exists)
    XCTAssertFalse(app.buttons["Unlock 1Password"].exists)
    capture(app, name: "Native Hermes profile logins")
    app.buttons["vault.add"].tap()
    field("vault.loginLabel", app: app, value: "Fixture library")
    field("vault.loginOrigin", app: app, value: "https://library.example.test")
    field("vault.loginIdentifier", app: app, value: "fixture-reader")
    field("vault.loginPassword", app: app, value: "fixture-password", secure: true)
    let save = app.buttons["vault.saveLogin"]; reveal(save, app: app, container: app.collectionViews["vaultAddForm"]); save.tap()
    XCTAssertTrue(app.staticTexts["Fixture library"].waitForExistence(timeout: 5))
    let remove = app.buttons["vault.remove.added-login"]; reveal(remove, app: app, container: app.collectionViews["vaultForm"]); remove.tap()
    app.buttons.matching(identifier: "Remove login").allElementsBoundByIndex.last?.tap()
    let absent = NSPredicate(format: "exists == false"); expectation(for: absent, evaluatedWith: app.staticTexts["Fixture library"]); waitForExpectations(timeout: 5)
    let unlock = app.buttons["Unlock Bitwarden fixture"]; reveal(unlock, app: app, container: app.collectionViews["vaultForm"]); unlock.tap()
    field("vault.unlockPassword", app: app, value: "fixture-master", secure: true); app.buttons["vault.unlock"].tap()
    XCTAssertTrue(app.buttons["Lock Bitwarden fixture"].waitForExistence(timeout: 5))
    capture(app, name: "Native available password source controls")
  }
  func testCancelledAddRequiresReviewOfPotentiallySavedLogin() {
    let app = launch(cancelledAdd: true)
    XCTAssertTrue(app.buttons["Configure Ranch hand"].waitForExistence(timeout: 10)); app.buttons["Configure Ranch hand"].tap()
    app.buttons["settingsMore"].tap(); app.buttons["Passwords & logins"].tap()
    XCTAssertTrue(app.buttons["vault.add"].waitForExistence(timeout: 5)); app.buttons["vault.add"].tap()
    field("vault.loginLabel", app: app, value: "Fixture library")
    field("vault.loginOrigin", app: app, value: "https://library.example.test")
    field("vault.loginIdentifier", app: app, value: "fixture-reader")
    field("vault.loginPassword", app: app, value: "fixture-password", secure: true)
    let save = app.buttons["vault.saveLogin"]; reveal(save, app: app, container: app.collectionViews["vaultAddForm"]); save.tap()
    XCTAssertTrue(app.staticTexts["Close this form and refresh saved logins to review the result before adding again."].waitForExistence(timeout: 5))
    XCTAssertEqual(app.textFields["vault.loginIdentifier"].value as? String, "Username, email or phone")
    XCTAssertEqual(app.secureTextFields["vault.loginPassword"].value as? String, "Password")
    for _ in 0..<5 { if save.exists { break }; app.collectionViews["vaultAddForm"].swipeUp() }
    XCTAssertTrue(save.exists); XCTAssertFalse(save.isEnabled)
    capture(app, name: "Native cancelled add requires review")
    app.buttons["Cancel"].tap()
    XCTAssertTrue(app.staticTexts["Fixture library"].waitForExistence(timeout: 5))
    capture(app, name: "Native cancelled response reveals saved metadata after review")
  }
  func testSecureRequestsAdvanceWithoutSendingChatAndClearOnBackground() {
    let app = launch()
    XCTAssertTrue(app.textFields["secure.identifier"].waitForExistence(timeout: 10))
    field("secure.identifier", app: app, value: "fixture-parent")
    field("secure.value", app: app, value: "fixture-password", secure: true)
    capture(app, name: "Native secure login request")
    app.buttons["secure.submit"].tap()
    XCTAssertTrue(app.secureTextFields["secure.value"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["Enter the fixture verification code."].waitForExistence(timeout: 5))
    XCTAssertFalse(app.textFields["secure.identifier"].exists)
    field("secure.value", app: app, value: "123456", secure: true)
    XCUIDevice.shared.press(.home); app.activate()
    XCTAssertTrue(app.secureTextFields["secure.value"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.buttons["secure.submit"].isEnabled)
    field("secure.value", app: app, value: "123456", secure: true); app.buttons["secure.submit"].tap()
    XCTAssertTrue(app.staticTexts["Unlock Bitwarden fixture in Hermes"].waitForExistence(timeout: 5))
    app.buttons["secure.cancel"].tap()
    XCTAssertTrue(app.staticTexts["FIXTURE_API_TOKEN"].waitForExistence(timeout: 5))
    field("secure.value", app: app, value: "fixture-token", secure: true); app.buttons["secure.submit"].tap()
    XCTAssertFalse(app.buttons["secure.submit"].waitForExistence(timeout: 2))
    XCTAssertFalse(app.staticTexts["fixture-parent"].exists)
    XCTAssertFalse(app.staticTexts["fixture-token"].exists)
    XCTAssertFalse(app.staticTexts["fixture-password"].exists)
    capture(app, name: "Native secure answers leave chat unchanged")
  }
  func testUncertainSecretAnswerOffersOnlyRefreshAndNoEcho() {
    let app = launch(uncertain: true)
    field("secure.identifier", app: app, value: "fixture-parent")
    field("secure.value", app: app, value: "fixture-password", secure: true); app.buttons["secure.submit"].tap()
    XCTAssertTrue(app.buttons["Refresh request"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.buttons["secure.submit"].exists)
    XCTAssertFalse(app.secureTextFields["secure.value"].isEnabled); XCTAssertFalse(app.textFields["secure.identifier"].isEnabled)
    XCTAssertFalse(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "fixture-password")).firstMatch.exists)
    app.buttons["Refresh request"].tap()
    XCTAssertTrue(app.buttons["Refresh request"].exists); XCTAssertFalse(app.buttons["secure.submit"].exists)
    capture(app, name: "Native uncertain secure request cannot replay")
  }
}
