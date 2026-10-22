import XCTest

extension XCUIApplication {
  /// Opens an assistant settings tab from the More menu. A menu can ignore a tap while it is still
  /// opening, as on a slower simulator, so the choice is repeated only while the menu stays open.
  func selectSettingsTab(_ title: String, file: StaticString = #filePath, line: UInt = #line) {
    let more = buttons["settingsMore"], item = buttons[title]
    more.tap()
    XCTAssertTrue(item.waitForExistence(timeout: 5), "The More menu lists \(title)", file: file, line: line)
    for _ in 0..<3 where item.isHittable {
      item.tap()
      let selected = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", title), object: more)
      if XCTWaiter.wait(for: [selected], timeout: 2) == .completed { return }
    }
    XCTAssertEqual(more.value as? String, title, "The More menu selects \(title)", file: file, line: line)
  }
}
