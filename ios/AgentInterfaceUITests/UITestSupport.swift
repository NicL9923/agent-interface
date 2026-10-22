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
  /// Waits until a tap can land: the element exists, has a frame and is hittable.
  @discardableResult
  func waitUntilHittable(timeout: TimeInterval = 10) -> Bool { poll(timeout) { hasFrame && isHittable } }
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
  /// Taps a text input, waits for keyboard focus, then types. Typing before focus arrives fails on a
  /// slow simulator; a tap that landed while the field was still settling is repeated once, as a
  /// person would.
  func typeWhenFocused(_ text: String, timeout: TimeInterval = 10, file: StaticString = #filePath, line: UInt = #line) {
    if !waitForKeyboardFocus(true, timeout: 0) {
      tapWhenReady(timeout: timeout, file: file, line: line)
      if !waitForKeyboardFocus(true, timeout: 3) { tap() }
    }
    guard waitForKeyboardFocus(true, timeout: timeout) else {
      XCTFail("\(self) never took keyboard focus", file: file, line: line); return
    }
    typeText(text)
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
    more.tapWhenReady(file: file, line: line)
    XCTAssertTrue(item.waitForExistence(timeout: 5), "The More menu lists \(title)", file: file, line: line)
    for _ in 0..<3 {
      // A tap the menu ignored can also close it, so a later try reopens it as a person would.
      if !item.exists { more.tap(); _ = item.waitForExistence(timeout: 5) }
      guard item.waitUntilHittable(timeout: 5) else { continue }
      item.tap()
      if more.wait(until: "value == %@", title, timeout: 2) { return }
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
