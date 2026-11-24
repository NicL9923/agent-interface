import XCTest
@testable import AgentInterface

/// The same reorder targets as `QueuePanel` on the web (tests/queue-panel-ui.test.ts).
@MainActor final class MessageQueueTests: XCTestCase {
  func testMovingOnePlaceNamesTheMessageToGoInFrontOf() {
    let control = MessageQueueController()
    control.items = ["a", "b", "c"].map { QueuedMessage(id: $0, text: "Message \($0)") }
    XCTAssertEqual(control.before(moving: 1, up: true), "a", "Up goes in front of the one above")
    XCTAssertEqual(control.before(moving: 0, up: false), "c", "Down goes in front of the one two below")
    XCTAssertNil(control.before(moving: 1, up: false), "Down from second to last goes to the end")
  }
  func testReorderAlwaysSendsBeforeItemIdEvenWhenNull() throws {
    let encoded = { (value: QueueReorder) in try JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as? [String: Any] ?? [:] }
    XCTAssertTrue(try encoded(QueueReorder(beforeItemId: nil))["beforeItemId"] is NSNull)
    XCTAssertEqual(try encoded(QueueReorder(beforeItemId: "a"))["beforeItemId"] as? String, "a")
  }
}
