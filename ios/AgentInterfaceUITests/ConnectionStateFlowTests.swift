import XCTest

/// How a lost connection reaches the screen, as the web does since November 19: nothing for a 3-second
/// grace period, then one line until the loss lasts 10 seconds, then what is down with Reconnect now.
/// The Debug fixture loses the connection at a moment the test picks (`UIConnectionLoss`); these
/// establish native behavior on the simulator, not a real server, Hermes or network.
@MainActor final class ConnectionStateFlowTests: XCTestCase {
  override func setUp() { continueAfterFailure = false }
  /// Launches on the open chat, losing `loss` `after` seconds from now on the clock the simulator shares.
  /// The first launch on a freshly booted simulator can take 11 seconds, so the default leaves 20.
  private func launch(_ loss: String, after seconds: TimeInterval = 20, _ switches: [String] = []) -> (XCUIApplication, Date) {
    let app = XCUIApplication()
    for name in switches { app.launchEnvironment["AGENT_INTERFACE_UI_" + name] = "1" }
    app.launchEnvironment["AGENT_INTERFACE_UI_FIXTURE"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_RESET"] = "1"
    app.launchEnvironment["AGENT_INTERFACE_UI_SCOPE"] = UUID().uuidString.lowercased()
    let lostAt = Date().addingTimeInterval(seconds)
    app.launchEnvironment["AGENT_INTERFACE_UI_LOSE_CONNECTION"] = loss
    app.launchEnvironment["AGENT_INTERFACE_UI_LOSE_AT"] = String(lostAt.timeIntervalSince1970)
    app.launch()
    return (app, lostAt)
  }
  private func capture(_ name: String) throws {
    let screenshot = XCUIScreen.main.screenshot()
    let attachment = XCTAttachment(screenshot: screenshot); attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    if let directory = ProcessInfo.processInfo.environment["AGENT_INTERFACE_SCREENSHOT_DIR"] {
      try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
      try screenshot.pngRepresentation.write(to: URL(fileURLWithPath: directory).appendingPathComponent(name + ".png"))
    }
  }
  private func openChat(_ app: XCUIApplication, before lostAt: Date) -> XCUIElement {
    let composer = app.textViews["messageComposer"]
    XCTAssertTrue(composer.waitForExistence(timeout: 15), app.debugDescription)
    XCTAssertLessThan(Date(), lostAt, "The chat must be open before the fixture loses the connection")
    return composer
  }
  /// Seconds since the fixture lost the connection.
  private func since(_ lostAt: Date) -> TimeInterval { Date().timeIntervalSince(lostAt) }
  private func sleep(until date: Date) {
    let wait = date.timeIntervalSinceNow
    // Timer: the moment inside the grace period is the behavior under test, so it is a fixed point in time.
    if wait > 0 { Thread.sleep(forTimeInterval: wait) }
  }
  private var card: (XCUIApplication) -> XCUIElement { { $0.descendants(matching: .any)["connectionCard"] } }

  func testAHermesLossWaitsThenSaysOneLineThenNamesWhatIsDown() throws {
    let (app, lostAt) = launch("hermes")
    _ = openChat(app, before: lostAt)
    // The chat reads every 1.5 seconds, so the loss is found within that and shows 3 seconds later.
    sleep(until: lostAt.addingTimeInterval(1.5))
    XCTAssertFalse(card(app).exists, "Nothing shows inside the grace period")
    try capture("ios-1-in-grace")
    let line = app.staticTexts["Reconnecting…"]
    XCTAssertTrue(line.waitForExistence(timeout: 10), app.debugDescription)
    XCTAssertGreaterThanOrEqual(since(lostAt), 3, "Not before the grace period ends")
    XCTAssertFalse(app.buttons["reconnectNow"].exists, "One line: the app is already retrying")
    XCTAssertFalse(app.staticTexts["connectionDetail"].exists)
    try capture("ios-2-one-line")
    let lasting = app.staticTexts["Hermes isn't answering"]
    XCTAssertTrue(lasting.waitForExistence(timeout: 15), app.debugDescription)
    XCTAssertGreaterThanOrEqual(since(lostAt), 10, "Named once it lasts")
    XCTAssertEqual(app.staticTexts["connectionDetail"].label, "Messages can't be sent until it's back. We'll keep trying.",
      "No draft, so no word about one")
    XCTAssertTrue(app.buttons["reconnectNow"].exists)
    XCTAssertTrue(app.buttons["Connection details"].exists)
    try capture("ios-3-lasting")
  }

  func testALastingLossWithADraftSaysTheDraftIsKept() throws {
    let (app, lostAt) = launch("app")
    let composer = openChat(app, before: lostAt)
    composer.typeWhenFocused("Move the heifers to the north pasture")
    XCTAssertTrue(app.staticTexts["Can't reach the app"].waitForExistence(timeout: 40), app.debugDescription)
    XCTAssertEqual(app.staticTexts["connectionDetail"].label, "Your draft is kept. We'll keep trying.")
    try capture("ios-4-lasting-draft")
  }

  func testOneChatsFailedReadsStayInThatChat() throws {
    let (app, lostAt) = launch("chat")
    _ = openChat(app, before: lostAt)
    XCTAssertTrue(app.staticTexts["Can't refresh this chat"].waitForExistence(timeout: 30), app.debugDescription)
    XCTAssertEqual(app.staticTexts["connectionDetail"].label, "New messages may not show yet. We'll keep trying.")
    XCTAssertTrue(app.buttons["reconnectNow"].exists)
    XCTAssertFalse(app.buttons["Connection details"].exists, "Hermes's details say nothing about one chat")
    try capture("ios-5-chat-only")
    // Home lists every assistant as it was: the chat's loss is the chat's.
    app.navigationBars.buttons.firstMatch.tapWhenReady()
    XCTAssertTrue(app.buttons["openSettings"].waitForExistence(timeout: 10), app.debugDescription)
    XCTAssertFalse(app.descendants(matching: .any)["homeSync"].exists, "Home says nothing is lost")
  }

  /// Review finding 5: the chat whose reads failed stayed selected, so its loss disabled a healthy group
  /// room's Send and made Settings say Hermes was reconnecting.
  func testOneChatsFailedReadsLeaveGroupChatsAndSettingsLive() throws {
    let (app, lostAt) = launch("chat", ["GROUP"])
    _ = openChat(app, before: lostAt)
    XCTAssertTrue(app.staticTexts["Can't refresh this chat"].waitForExistence(timeout: 30), app.debugDescription)
    app.navigationBars.buttons.firstMatch.tapWhenReady()
    // Round 2, finding 5: home's New group chat and a room's settings read the household too.
    app.buttons["newMenu"].tapWhenReady(timeout: 15)
    let newGroup = app.buttons["newGroup"]
    XCTAssertTrue(newGroup.waitForExistence(timeout: 5), app.debugDescription)
    XCTAssertTrue(newGroup.isEnabled, "One assistant's chat says nothing about making a group")
    XCTAssertFalse(app.staticTexts["Reconnect to Hermes to make a group chat."].exists)
    newGroup.tap()
    app.buttons["Close"].tapWhenReady()
    app.buttons["room.fixture-room"].tapWhenReady(timeout: 15)
    let composer = app.descendants(matching: .any).matching(identifier: "groupComposer").firstMatch
    XCTAssertTrue(composer.waitForExistence(timeout: 10), app.debugDescription)
    composer.typeWhenFocused("Who has the truck?")
    let send = app.buttons["Send to group"]
    XCTAssertTrue(send.waitForExistence(timeout: 5), app.debugDescription)
    XCTAssertTrue(send.isEnabled, "One assistant's chat says nothing about the household's rooms")
    app.buttons["groupSettings"].tapWhenReady()
    let save = app.buttons["saveGroupSettings"]
    XCTAssertTrue(save.waitForExistence(timeout: 5), app.debugDescription)
    XCTAssertTrue(save.isEnabled, "or about the room's settings")
    XCTAssertFalse(app.staticTexts["Reconnect to Hermes to change these settings."].exists)
    app.buttons["Cancel"].tapWhenReady()
  }

  /// Round 3, finding 4: an assistant's settings need the household, not the open chat. With the chat's reads
  /// failing, Save was disabled and, once it ran, its tools step was refused after the profile saved.
  func testOneChatsFailedReadsLeaveItsAssistantsSettingsSavable() throws {
    let (app, lostAt) = launch("chat")
    _ = openChat(app, before: lostAt)
    XCTAssertTrue(app.staticTexts["Can't refresh this chat"].waitForExistence(timeout: 30), app.debugDescription)
    app.openAssistantSettings("Ranch hand")
    app.selectSettingsTab("Behavior")
    let web = app.switches.matching(NSPredicate(format: "label BEGINSWITH %@", "Web search")).firstMatch
    XCTAssertTrue(web.waitForExistence(timeout: 5), app.debugDescription)
    let save = app.buttons["saveChanges"]
    XCTAssertFalse(app.staticTexts["Reconnect to save your changes."].exists)
    web.switches.firstMatch.tapWhenReady()
    XCTAssertTrue(save.wait(until: "enabled == true"), "One chat's failed read says nothing about its assistant's settings")
    save.tap()
    XCTAssertTrue(app.staticTexts["settingsNotice"].wait(until: "label == %@", "Saved"), "The tools reached the server")
  }

  func testOfflineWaitsItsGracePeriodThenSaysSoWithoutARetry() throws {
    let (app, lostAt) = launch("offline")
    _ = openChat(app, before: lostAt)
    XCTAssertTrue(app.staticTexts["You're offline"].waitForExistence(timeout: 30), app.debugDescription)
    XCTAssertGreaterThanOrEqual(since(lostAt), 3, "Not before the grace period ends")
    XCTAssertEqual(app.staticTexts["connectionDetail"].label, "We'll reconnect when you're back online.")
    XCTAssertFalse(app.buttons["reconnectNow"].exists, "Nothing to retry until the network is back")
    try capture("ios-6-offline")
  }
}
