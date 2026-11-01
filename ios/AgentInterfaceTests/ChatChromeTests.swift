import UIKit
import XCTest

@testable import AgentInterface

/// Provider marks, reply parts that share one time, and the server's model name.
final class ChatChromeTests: XCTestCase {
  /// The same cases as tests/provider-icon.test.ts, so the two tables cannot drift apart.
  func testProviderSlugsAndAliasesPickTheWebsMarks() {
    let cases: [(String?, ProviderIconKey)] = [
      ("anthropic", .anthropic), ("claude", .anthropic), ("claude-code", .anthropic),
      ("openai", .openai), ("openai-codex", .openai), ("openai-api", .openai), ("chatgpt", .openai),
      ("gemini", .google), ("google", .google), ("google-gemini-cli", .google), ("google-ai-studio", .google),
      ("xai", .xai), ("xai-oauth", .xai), ("grok", .xai), ("x-ai", .xai),
      ("openrouter", .openrouter), ("nous", .nous), ("nous-portal", .nous),
      ("ollama", .ollama), ("ollama-cloud", .ollama), ("mistral", .mistral), ("deepseek", .deepseek),
      (" Anthropic ", .anthropic),
      ("custom:house", .generic), ("lmstudio", .generic), ("openaix", .generic), ("", .generic), (nil, .generic),
    ]
    for (slug, key) in cases { XCTAssertEqual(ProviderIconKey.key(for: slug), key, slug ?? "nil") }
  }
  func testEveryMarkIsInTheAssetCatalog() {
    for key in ProviderIconKey.allCases {
      XCTAssertNotNil(UIImage(named: key.assetName, in: Bundle(for: SpeechController.self), compatibleWith: nil), key.assetName)
    }
  }
  func testAReplyShowsItsTimeOnceUnderItsLastPart() {
    func reply(_ id: String, _ at: String?) -> Message { Message(id: id, role: "assistant", text: id, createdAt: at) }
    let question = Message(id: "q", role: "user", text: "q", createdAt: "2026-10-07T12:00:00Z")
    let turn = ConversationTurn(id: "turn", messages: [question, reply("first", "2026-10-07T12:00:09Z"), reply("second", nil), reply("third", nil)])
    let visible = turn.visibleMessages
    XCTAssertEqual(turn.replyRun(at: 0, in: visible), ReplyRun(continued: false, endsRun: true, when: "2026-10-07T12:00:00Z"))
    XCTAssertEqual(turn.replyRun(at: 1, in: visible), ReplyRun(continued: false, endsRun: false, when: "2026-10-07T12:00:09Z"))
    XCTAssertEqual(turn.replyRun(at: 2, in: visible), ReplyRun(continued: true, endsRun: false, when: "2026-10-07T12:00:09Z"))
    // The last part has no time of its own, so it takes the earlier part's.
    XCTAssertEqual(turn.replyRun(at: 3, in: visible), ReplyRun(continued: true, endsRun: true, when: "2026-10-07T12:00:09Z"))
  }
  func testAReplyAfterWorkStartsItsOwnRun() {
    let work = Message(id: "call", role: "tool", text: "", toolCall: nil)
    let turn = ConversationTurn(id: "turn", messages: [Message(id: "a", role: "assistant", text: "a"), work, Message(id: "b", role: "assistant", text: "b")], replyStart: "b")
    let visible = turn.visibleMessages
    XCTAssertTrue(turn.replyRun(at: 0, in: visible).endsRun)
    XCTAssertFalse(turn.replyRun(at: 1, in: visible).continued)
  }
  func testTheModelNameIsOptionalAndShownAsGiven() throws {
    let base = #"{"id":"ranch","name":"Ranch","model":"claude-opus-5-5","provider":"anthropic","shared":true,"activity":"idle"#
    let older = try JSONDecoder().decode(Bot.self, from: Data((base + #""}"#).utf8))
    XCTAssertNil(older.modelName)
    let newer = try JSONDecoder().decode(Bot.self, from: Data((base + #"","modelName":"Claude Opus 5.5"}"#).utf8))
    XCTAssertEqual(newer.modelName, "Claude Opus 5.5")
    XCTAssertEqual(newer.model, "claude-opus-5-5")
  }
}
