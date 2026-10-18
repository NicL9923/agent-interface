import XCTest
@testable import AgentInterface

/// The web's reply announcement cases (tests/app-ui.test.ts), against the native port.
final class ReplyAnnouncementTests: XCTestCase {
  private let settled = [Message(id: "u1", role: "user", text: "Hello"), Message(id: "a1", role: "assistant", text: "Hi, I'm here.")]
  private func conversation(_ messages: [Message], _ state: ActivityState = .done) -> Conversation {
    Conversation(botId: "shared", messages: messages, activity: Activity(state: state, runId: "run"), approvals: [], files: [])
  }
  private func user(_ id: String, _ text: String) -> Message { Message(id: id, role: "user", text: text) }
  private func reply(_ id: String, _ text: String) -> Message { Message(id: id, role: "assistant", text: text) }
  /// Feeds refreshes in order, as the conversation view sees them, and returns what was read.
  private func read(_ refreshes: [Conversation]) -> [String?] {
    var watch: ReplyWatch?
    return refreshes.map { value in
      let (next, message) = ReplyWatch.next(watch ?? ReplyWatch(), value, baseline: watch == nil)
      watch = next
      return message.map { ReplyWatch.snippet($0.text) }
    }
  }

  func testTheReplyAlreadyThereOnOpenStaysQuiet() {
    XCTAssertEqual(read([conversation(settled), conversation(settled)]), [nil, nil])
  }

  func testANewReplyIsReadOnceAsPlainWords() {
    let next = settled + [user("u2", "Status?"), reply("a2", "## Done\n**The report** is [ready](https://example.invalid).\n```\nnpm test\n```")]
    XCTAssertEqual(read([conversation(settled), conversation(next), conversation(next)]), [nil, "Done The report is ready.", nil])
  }

  func testAReplyWaitsUntilTheAssistantStopsWorking() {
    let prompt = user("u2", "Status?")
    XCTAssertEqual(read([
      conversation(settled),
      conversation(settled + [prompt, reply("a2", "Checking")], .working),
      conversation(settled + [prompt, reply("a2", "Checking. All clear.")], .working),
      conversation(settled + [prompt, reply("a2", "Checking. All clear.")]),
    ]), [nil, nil, nil, "Checking. All clear."])
  }

  func testSavedRowsReplacingAnInFlightReplyAreReadWhenFinished() {
    let prompt = user("u2", "Status?")
    XCTAssertEqual(read([
      conversation(settled),
      conversation(settled + [prompt, reply("session-inflight", "Checking")], .working),
      conversation(settled + [prompt, reply("row-41", "Checking. All clear.")]),
    ]), [nil, nil, "Checking. All clear."])
  }

  func testAnUnsavedReplyIsNotReadAgainWhenSavedRowsReplaceIt() {
    let prompt = user("u2", "Status?")
    XCTAssertEqual(read([
      conversation(settled),
      conversation(settled + [prompt, reply("session-inflight", "All clear.")]),
      conversation(settled + [prompt, reply("row-41", "All clear.")]),
    ]), [nil, "All clear.", nil])
  }

  func testAnIdenticalReplyInTheNextTurnIsReadAgain() {
    let first = user("u2", "Status?"), second = user("u3", "And now?")
    let saved = settled + [first, reply("row-41", "Done.")]
    XCTAssertEqual(read([
      conversation(settled),
      conversation(settled + [first, reply("session-inflight", "Done.")]),
      conversation(saved + [second, reply("session-inflight", "Done.")]),
      conversation(saved + [second, reply("row-50", "Done.")]),
    ]), [nil, "Done.", "Done.", nil])
  }

  func testDiagnosticActivityIsQuietButAScheduledAnswerIsRead() {
    let diagnostic = Message(id: "d", role: "assistant", text: "Internal failure details", origin: MessageOrigin(kind: "diagnostic", visibility: "activity"))
    let answer = Message(id: "s", role: "assistant", text: "Your reminder is ready.", origin: MessageOrigin(kind: "scheduled", visibility: "conversation"))
    XCTAssertEqual(ReplyWatch.next(ReplyWatch(), conversation([diagnostic]), baseline: false).1?.id, nil)
    XCTAssertEqual(ReplyWatch.next(ReplyWatch(), conversation([answer]), baseline: false).1?.id, "s")
  }

  func testLongRepliesAreCutToTwoHundredCharacters() {
    let snippet = ReplyWatch.snippet(String(repeating: "word ", count: 80))
    XCTAssertEqual(snippet.count, 200)
    XCTAssertTrue(snippet.hasSuffix("…"))
  }
}
