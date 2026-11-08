import XCTest

// Waits and actions that hold up on a slow CI simulator, such as GitHub's macos-26 runner. A bare
// `tap()`, `typeText(_:)`, keyboard shortcut or `exists` check right after an action can race the
// app there while it passes on a fast Mac, so tests use these by default.

/// Polls `condition` until it holds or `timeout` passes, and returns whether it held.
@MainActor private func poll(_ timeout: TimeInterval, _ condition: () -> Bool) -> Bool {
  let deadline = Date().addingTimeInterval(timeout)
  while !condition() {
    guard Date() < deadline else { return false }
    Thread.sleep(forTimeInterval: 0.1)
  }
  return true
}

extension XCUIElement {
  /// Waits until `format`, an NSPredicate over this element such as `"value == %@"`, holds. Use it
  /// instead of reading `value`, `label` or `isSelected` right after the action that changes it.
  @discardableResult
  func wait(until format: String, _ arguments: Any..., timeout: TimeInterval = 10) -> Bool {
    let predicate = NSPredicate(format: format, argumentArray: arguments)
    return poll(timeout) { predicate.evaluate(with: self) }
  }
  /// Waits for the element to leave the screen, as after dismissing it.
  @discardableResult
  func waitForDisappearance(timeout: TimeInterval = 10) -> Bool { poll(timeout) { !exists } }
  /// Whether the element exists with a real frame. While a menu or sheet animates in, an item can
  /// exist with no frame yet, and asking whether it is hittable then fails the test outright.
  var hasFrame: Bool { exists && frame.minX.isFinite && !frame.isEmpty }
  @discardableResult
  func waitForFrame(timeout: TimeInterval = 10) -> Bool { poll(timeout) { hasFrame } }
  /// Whether a tap can land now. Use it instead of `isHittable`, which fails the test outright,
  /// rather than answering false, while the element has no hit point yet.
  var canTap: Bool { hasFrame && isHittable }
  /// Waits until a tap can land: the element exists, has a frame and is hittable.
  @discardableResult
  func waitUntilHittable(timeout: TimeInterval = 10) -> Bool { poll(timeout) { canTap } }
  /// Taps once the element has a frame and, within a short grace period, is hittable. Use it for
  /// anything that appears after an action, such as a menu item, a confirmation button or a row
  /// that loads. Some buttons, such as Discard edits beside a focused field, never report hittable
  /// though a tap lands, so a missing frame fails the test but a missing hittable flag does not.
  func tapWhenReady(timeout: TimeInterval = 10, file: StaticString = #filePath, line: UInt = #line) {
    guard waitForFrame(timeout: timeout) else {
      XCTFail("\(self) never appeared with a frame", file: file, line: line); return
    }
    waitUntilHittable(timeout: 2)
    tap()
  }
  @discardableResult
  func waitForKeyboardFocus(_ focused: Bool = true, timeout: TimeInterval = 10) -> Bool {
    wait(until: "hasKeyboardFocus == %@", NSNumber(value: focused), timeout: timeout)
  }
  /// Taps a text input once, waits for keyboard focus, types, then waits for the keyboard's layout.
  /// Typing before focus arrives fails on a slow simulator. Never tap twice: while the keyboard
  /// slides in, a second tap's position is stale and can land on the transcript, whose tap puts the
  /// keyboard away.
  func typeWhenFocused(_ text: String, timeout: TimeInterval = 15, file: StaticString = #filePath, line: UInt = #line) {
    if !waitForKeyboardFocus(true, timeout: 0) { tapWhenReady(timeout: timeout, file: file, line: line) }
    guard waitForKeyboardFocus(true, timeout: timeout) else {
      XCTFail("\(self) never took keyboard focus", file: file, line: line); return
    }
    typeText(text)
    // Return submits, which can put the keyboard away or close the field's screen.
    if !text.hasSuffix("\n") { waitForKeyboardLayout() }
  }
  /// On the iOS 27 simulator, `typeText` hides the software keyboard while it types and shows it
  /// again as typing ends, and the layout moves with it. A tap aimed at a button's frame from the
  /// keyboard-less layout then lands beside the button. Waits for the keyboard and for this element
  /// to stop moving. A hardware keyboard shows no software keyboard; the wait ends after 3 seconds.
  func waitForKeyboardLayout() {
    guard XCUIApplication().keyboards.firstMatch.waitForExistence(timeout: 3) else { return }
    // Reading a missing element's frame fails the test, so a field that went away reads as null.
    var last = exists ? frame : .null
    var unchanged = 0
    _ = poll(2) {
      let current = exists ? frame : .null
      unchanged = current == last ? unchanged + 1 : 0
      last = current
      return unchanged >= 3
    }
  }
}

extension XCUIElementQuery {
  /// The first element labelled `label`, written with a straight or a typographic apostrophe. iOS 26
  /// system alerts write "Don’t Allow" with U+2019, so an exact match on "Don't Allow" never appears.
  func labeled(_ label: String) -> XCUIElement {
    let variants = Set([label, label.replacingOccurrences(of: "'", with: "\u{2019}"),
                        label.replacingOccurrences(of: "\u{2019}", with: "'")])
    return matching(NSPredicate(format: "label IN %@", Array(variants))).firstMatch
  }
}

extension XCUIApplication {
  /// Home's New button: a menu of New assistant and New group chat while Hermes can host groups, else
  /// the New assistant button itself. True once either is on screen.
  func newAssistantReady(timeout: TimeInterval) -> Bool {
    buttons["newMenu"].waitForExistence(timeout: timeout) || buttons["New assistant"].exists
  }
  /// Makes a new assistant from home, through the New menu when there is one.
  func tapNewAssistant(timeout: TimeInterval = 10) {
    XCTAssertTrue(newAssistantReady(timeout: timeout), "Home's New button is on screen\n\(debugDescription)")
    if buttons["newMenu"].exists {
      buttons["newMenu"].tapWhenReady(timeout: timeout)
      buttons["newAssistant"].tapWhenReady(timeout: timeout)
    } else {
      buttons["New assistant"].tapWhenReady(timeout: timeout)
    }
  }
  /// Sends a hardware keyboard shortcut and waits for `target` to appear. A shortcut sent while the
  /// screen is still settling can be dropped on a slow simulator, so it is sent again, up to
  /// `attempts` times, while `target` has not appeared.
  @discardableResult
  func shortcut(_ key: String, modifiers: XCUIElement.KeyModifierFlags = .command, shows target: XCUIElement,
                attempts: Int = 3, timeout: TimeInterval = 5, failureContext: String? = nil,
                file: StaticString = #filePath, line: UInt = #line) -> Int {
    for attempt in 0..<attempts {
      typeKey(key, modifierFlags: modifiers)
      if target.waitForExistence(timeout: timeout) { return attempt + 1 }
    }
    if let failureContext {
      attachShortcutDiagnostics(failureContext)
    }
    XCTFail("The \(key) shortcut never showed \(target) after \(attempts) tries\n\(failureContext ?? "")\n\(debugDescription)", file: file, line: line)
    return attempts
  }
  func attachShortcutDiagnostics(_ context: String) {
    XCTContext.runActivity(named: "Keyboard shortcut failure") { activity in
      let hierarchy = XCTAttachment(string: context + "\n" + debugDescription)
      hierarchy.name = "Shortcut context and hierarchy"; hierarchy.lifetime = .keepAlways
      activity.add(hierarchy)
      let screen = XCTAttachment(screenshot: screenshot())
      screen.name = "Shortcut failure screen"; screen.lifetime = .keepAlways
      activity.add(screen)
    }
  }
  /// Where each settings page lives: its section, and the row that opens it when it is a full list
  /// of its own. Former tab names map to where that content lives now.
  private static let settingsPages: [String: (section: String, page: String?)] = [
    "Profile": ("profile", nil), "Details": ("profile", nil), "Avatar": ("profile", nil),
    "Behavior": ("behavior", nil), "Tools": ("behavior", nil), "Skills": ("behavior", nil),
    "Access": ("access", nil), "Connections": ("access", "connections"), "Logins": ("access", "logins"),
    "Automation": ("automation", nil), "Routines": ("automation", nil), "Work": ("automation", "work"),
    "Memory & learning": ("memory", nil), "Memory": ("memory", "memory"), "Learning": ("memory", "learning"),
  ]
  /// Opens an assistant settings page as a person does: back to the list of sections, the section,
  /// then the row for a page such as Logins or Work.
  func selectSettingsTab(_ title: String, file: StaticString = #filePath, line: UInt = #line) {
    guard let route = Self.settingsPages[title] else {
      XCTFail("No settings page is named \(title)", file: file, line: line); return
    }
    showSettingsSections(file: file, line: line)
    buttons["settingsSection.\(route.section)"].tapWhenReady(file: file, line: line)
    XCTAssertTrue(collectionViews["settingsSections"].waitForDisappearance(), "The \(route.section) section opens", file: file, line: line)
    guard let page = route.page else { return }
    let link = buttons["settingsPage.\(page)"]
    // Work sits below the routines, so a long list can push it off screen.
    for _ in 0..<8 where !link.canTap { collectionViews.firstMatch.swipeUp() }
    link.tapWhenReady(file: file, line: line)
    XCTAssertTrue(link.waitForDisappearance(), "Settings opens \(title)", file: file, line: line)
  }
  /// Goes back through settings pages until the list of sections shows.
  func showSettingsSections(file: StaticString = #filePath, line: UInt = #line) {
    let list = collectionViews["settingsSections"]
    let back = navigationBars.buttons.matching(NSPredicate(format: "label IN %@",
      ["All settings", "Profile", "Behavior", "Access", "Automation", "Memory & learning"])).firstMatch
    for _ in 0..<3 {
      if list.waitForExistence(timeout: 1) { return }
      if back.exists { back.tapWhenReady(file: file, line: line) }
    }
    XCTAssertTrue(list.waitForExistence(timeout: 10), "Settings shows its sections", file: file, line: line)
  }

  /// The open chat's header: the assistant's avatar and name, which opens its card.
  func chatHeader(_ name: String) -> XCUIElement {
    buttons.matching(identifier: "botProfile").matching(NSPredicate(format: "label == %@", name)).firstMatch
  }
  /// Opens the open chat's assistant card from its header.
  func openBotProfile(_ name: String, file: StaticString = #filePath, line: UInt = #line) {
    let header = chatHeader(name)
    XCTAssertTrue(header.waitForExistence(timeout: 10), "The chat header names \(name)", file: file, line: line)
    header.tapWhenReady(file: file, line: line)
    XCTAssertTrue(buttons["profileSettings"].waitForExistence(timeout: 5), "The assistant card opens", file: file, line: line)
  }
  /// Opens assistant settings the way a person does: header, card, Settings.
  func openAssistantSettings(_ name: String, file: StaticString = #filePath, line: UInt = #line) {
    openBotProfile(name, file: file, line: line)
    buttons["profileSettings"].tapWhenReady(file: file, line: line)
    XCTAssertTrue(collectionViews["settingsSections"].waitForExistence(timeout: 10), "Settings opens from the card", file: file, line: line)
  }
}
