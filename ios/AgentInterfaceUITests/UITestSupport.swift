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
  private func waitForKeyboardLayout() {
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
  /// Sends a hardware keyboard shortcut and waits for `target` to appear. A shortcut sent while the
  /// screen is still settling can be dropped on a slow simulator, so it is sent again, up to
  /// `attempts` times, while `target` has not appeared.
  func shortcut(_ key: String, modifiers: XCUIElement.KeyModifierFlags = .command, shows target: XCUIElement,
                attempts: Int = 3, timeout: TimeInterval = 5, file: StaticString = #filePath, line: UInt = #line) {
    for _ in 0..<attempts {
      typeKey(key, modifierFlags: modifiers)
      if target.waitForExistence(timeout: timeout) { return }
    }
    XCTFail("The \(key) shortcut never showed \(target) after \(attempts) tries\n\(debugDescription)", file: file, line: line)
  }
  /// Opens an assistant settings tab from the More menu. A menu can ignore a tap while it is still
  /// opening, as on a slower simulator, so the choice is repeated only while the menu stays open.
  func selectSettingsTab(_ title: String, file: StaticString = #filePath, line: UInt = #line) {
    let more = buttons["settingsMore"], item = buttons[title]
    more.tap()
    XCTAssertTrue(item.waitForExistence(timeout: 5), "The More menu lists \(title)", file: file, line: line)
    for _ in 0..<3 {
      // A tap the menu ignored can also close it, so a later try reopens it as a person would.
      if !item.exists { more.tap(); _ = item.waitForExistence(timeout: 5) }
      // The item can exist while it still animates in, with no frame yet; asking whether it is
      // hittable then fails the test outright, so wait for a real frame first.
      let deadline = Date().addingTimeInterval(5)
      while Date() < deadline, !(item.exists && item.frame.minX.isFinite && !item.frame.isEmpty) { usleep(100_000) }
      guard item.exists, item.frame.minX.isFinite, !item.frame.isEmpty, item.isHittable else { continue }
      item.tap()
      let selected = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", title), object: more)
      if XCTWaiter.wait(for: [selected], timeout: 2) == .completed { return }
    }
    XCTAssertEqual(more.value as? String, title, "The More menu selects \(title)", file: file, line: line)
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
    XCTAssertTrue(buttons["settingsMore"].waitForExistence(timeout: 10), "Settings opens from the card", file: file, line: line)
  }
}
