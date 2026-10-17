import XCTest
@testable import AgentInterface

final class HomeParityTests: XCTestCase {
  private func hit(_ session: String, _ title: String) throws -> SearchHit {
    let json = #"{"botId":"ranch","botName":"Ranch","sessionId":"\#(session)","title":"\#(title)","snippet":""}"#
    return try JSONDecoder().decode(SearchHit.self, from: Data(json.utf8))
  }
  func testSavedConversationKeepsTheSearchHitTitle() throws {
    let hits = [try hit("a", "Dinner plan"), try hit("b", String(repeating: "x", count: 200))]
    XCTAssertEqual(DiscoveryView.conversationTitle(hits, "a"), "Dinner plan")
    XCTAssertEqual(DiscoveryView.conversationTitle(hits, "b").count, 120)
    XCTAssertEqual(DiscoveryView.conversationTitle(hits, "missing"), "Saved conversation")
  }
  func testSavedReplyTitleStripsMarkdownSymbolsLikeTheWeb() {
    XCTAssertEqual(DiscoveryView.replyTitle("## **Gate**"), "Gate")
    XCTAssertEqual(DiscoveryView.replyTitle("a_b"), "a b")
    XCTAssertEqual(DiscoveryView.replyTitle(" ** "), "Saved reply")
  }
}
