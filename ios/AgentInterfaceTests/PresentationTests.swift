import XCTest

@testable import AgentInterface

final class PresentationTests: XCTestCase {
  func testReadAnchorSkipsCanonicalToolsWithoutVisibleRows() {
    let conversation = Conversation(
      botId: "bot",
      messages: [
        Message(id: "before", role: "user", text: "a"),
        Message(id: "tool", role: "tool", text: "b"),
        Message(id: "after", role: "assistant", text: "c"),
        Message(id: "last-tool", role: "tool", text: "d"),
      ], activity: Activity(state: .idle), approvals: [], files: [])
    XCTAssertEqual(conversation.restorableReadAnchor("before"), "before")
    XCTAssertEqual(conversation.restorableReadAnchor("tool"), "after")
    XCTAssertNil(conversation.restorableReadAnchor("last-tool"))
    XCTAssertNil(conversation.restorableReadAnchor("missing"))
  }
  func testTaskListsAreReadOnlyCompletionIndicatorsAndOrdinaryListsKeepMarkers() throws {
    let done = try XCTUnwrap(MarkdownView.listRow("- [x] Finished **work**"))
    XCTAssertEqual(done.completed, true)
    XCTAssertEqual(done.text, "Finished **work**")
    let pending = try XCTUnwrap(MarkdownView.listRow("* [ ] Pending work"))
    XCTAssertEqual(pending.completed, false)
    XCTAssertEqual(pending.text, "Pending work")
    XCTAssertEqual(MarkdownView.listRow("2. Next step")?.marker, "2.")
    XCTAssertEqual(
      MarkdownView.blocks("- [x] Done\n- [ ] Waiting\n\nParagraph").map(\.kind), ["list", "text"])
  }
  func testNativeReadAnchorDoesNotClaimABrowserPixelOffset() throws {
    let encoded = try JSONEncoder().encode(ReadPosition(messageId: "visible-message"))
    let object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
    XCTAssertEqual(object["messageId"] as? String, "visible-message")
    XCTAssertNil(object["scrollTop"])
  }
  func testActualServerTimestampAndPlainISOAreAccepted() {
    XCTAssertNotNil(ServerDate.parse("2026-10-07T09:08:21.125Z"))
    XCTAssertNotNil(ServerDate.parse("2026-10-07T09:08:21Z"))
    XCTAssertNil(ServerDate.parse("not a date"))
  }
  func testMarkdownKeepsBlankTableCellsAndEscapedPipes() {
    XCTAssertEqual(MarkdownView.tableCells("| First | | Last |"), ["First", "", "Last"])
    XCTAssertEqual(MarkdownView.tableCells("| A\\|B | C |"), ["A|B", "C"])
    XCTAssertEqual(MarkdownView.tableCells("A | B"), ["A", "B"])
    let blocks = MarkdownView.blocks(
      "# Title\n\n| A | B |\n| --- | --- |\n| Hello | |\n\n```swift\nlet n = 1\n```")
    XCTAssertEqual(blocks.map(\.kind), ["heading", "table", "code"])
    XCTAssertEqual(blocks.last?.text, "let n = 1")
  }
  func testEveryAvatarSilhouetteSupportsFiniteConsistentMorphing() {
    for shape in AvatarConfig.shapes {
      let points = AvatarGeometry.points(shape)
      XCTAssertEqual(points.values.count, 144, shape)
      XCTAssertTrue(points.values.allSatisfy(\.isFinite), shape)
      XCTAssertGreaterThan(points.magnitudeSquared, 0)
    }
  }
  @MainActor func testPushRoutesOnlyRelativeConversationURL() {
    let origin = URL(string: "https://household.example")!
    XCTAssertEqual(NotificationController.botId(from: "/?bot=a%2Fb", origin: origin), "a/b")
    XCTAssertNil(NotificationController.botId(from: "https://evil.example/?bot=a", origin: origin))
    XCTAssertNil(NotificationController.botId(from: "//evil.example/?bot=a", origin: origin))
    XCTAssertNil(NotificationController.botId(from: "/api/files/a?bot=b", origin: origin))
  }
}
