import XCTest

extension XCUIApplication {
  /// Opens an assistant settings tab from the More menu. A menu can ignore a tap while it is still
  /// opening, as on a slower simulator, so the choice is repeated only while the menu stays open.
  func selectSettingsTab(_ title: String, file: StaticString = #filePath, line: UInt = #line) {
    let more = buttons["settingsMore"], item = buttons[title]
    more.tap()
    XCTAssertTrue(item.waitForExistence(timeout: 5), "The More menu lists \(title)", file: file, line: line)
    let hittable = NSPredicate(format: "hittable == true")
    for _ in 0..<3 {
      // The item can exist while it still animates in, so wait until a tap can land on it.
      guard XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: hittable, object: item)], timeout: 5) == .completed else { break }
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
    header.tap()
    XCTAssertTrue(buttons["profileSettings"].waitForExistence(timeout: 5), "The assistant card opens", file: file, line: line)
  }
  /// Opens assistant settings the way a person does: header, card, Settings.
  func openAssistantSettings(_ name: String, file: StaticString = #filePath, line: UInt = #line) {
    openBotProfile(name, file: file, line: line)
    buttons["profileSettings"].tap()
    XCTAssertTrue(buttons["settingsMore"].waitForExistence(timeout: 10), "Settings opens from the card", file: file, line: line)
  }
}
