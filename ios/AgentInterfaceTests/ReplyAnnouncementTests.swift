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

  func testAProgressLineIsNeverReadAloudButTheAnswerAfterItIs() {
    let prompt = user("u2", "Status?")
    let note = Message(id: "n", role: "assistant", text: "I'll check first.", interim: true)
    XCTAssertEqual(read([
      conversation(settled),
      conversation(settled + [prompt, note], .done),
      conversation(settled + [prompt, note, reply("a2", "All clear.")]),
    ]), [nil, nil, "All clear."])
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

  // MARK: A reply saved as several rows, ported from tests/reply-announcement.test.ts (#337).
  private func question(_ id: String = "q") -> Message { user(id, "Fix the fence?") }
  private func tool(_ id: String) -> Message { Message(id: id, role: "assistant", text: "", toolCall: ToolCall(id: id, name: "terminal", status: "completed")) }
  private func streaming(_ text: String) -> Message { reply("run-inflight", text) }
  private struct Read { var watch: ReplyWatch; var reply: Message?; var said: String? }
  /// One refresh after `watch`, and what the screen reader is given for it.
  private func announced(_ watch: ReplyWatch, _ messages: [Message], _ state: ActivityState = .idle) -> Read {
    let (next, message) = ReplyWatch.next(watch, conversation(messages, state), baseline: false)
    return Read(watch: next, reply: message, said: message.map { ReplyWatch.snippet($0.text) })
  }
  private let fence = "I checked the north fence.", latch = "The gate latch is loose."

  func testAReplySavedAsSeveralRowsIsAnnouncedWholeWithoutTheRowsThatAreNotWords() {
    let progress = Message(id: "n", role: "assistant", text: "Checking the gate.", interim: true)
    let rows = [question(), reply("a", fence), tool("t"), progress, reply("b", latch)]
    let result = announced(ReplyWatch(lastId: "q"), rows)
    XCTAssertEqual(result.said, "\(fence) \(latch)")
    XCTAssertEqual(result.reply?.id, "b", "The last row's ID is how the screen reader tells replies apart")
    XCTAssertEqual(announced(result.watch, rows).reply?.id, nil, "Read once")
  }

  func testTheJoinedReplyIsCutToTwoHundredCharactersAfterItIsJoined() throws {
    let first = String(repeating: "alpha ", count: 20).trimmingCharacters(in: .whitespaces)
    let second = String(repeating: "bravo ", count: 20).trimmingCharacters(in: .whitespaces)
    let said = try XCTUnwrap(announced(ReplyWatch(lastId: "q"), [question(), reply("a", first), tool("t"), reply("b", second)]).said)
    // 200 characters of the joined reply, which runs into the second segment, then an ellipsis.
    XCTAssertTrue(said.contains("\(first) bravo"))
    XCTAssertTrue(said.hasSuffix("…")); XCTAssertEqual(said.count, 201)
  }

  func testOnlyTheNewestTurnsRowsAreReadWhenTwoTurnsFinishedBetweenReads() {
    let rows = [question("q1"), reply("a1", "First answer."), question("q2"), reply("a2", "Second answer."), tool("t"), reply("b2", "More of the second.")]
    XCTAssertEqual(announced(ReplyWatch(lastId: "q1"), rows).said, "Second answer. More of the second.")
  }

  func testAnUnsavedReplyThatWasHeardWholeIsNotReadAgainWhenItsSavedRowsReplaceIt() {
    let live = reply("run-inflight", "\(fence)\n\(latch)")
    let first = announced(ReplyWatch(lastId: "q"), [question(), live], .thinking)
    XCTAssertNil(first.reply)
    let heard = announced(first.watch, [question(), live])
    XCTAssertEqual(heard.said, "\(fence) \(latch)")
    XCTAssertNil(announced(heard.watch, [question(), reply("a", fence), tool("t"), reply("b", latch)]).reply)
  }

  func testOnlyTheRowsAfterTheHeardHeadAreReadAndRowsEndingWithTheHeardTailStaySilent() {
    let rows = [question(), reply("a", fence), tool("t"), reply("b", latch)]
    XCTAssertEqual(announced(ReplyWatch(lastId: "q", heard: .init(text: fence, turn: "q")), rows).said, latch, "A head that was read")
    XCTAssertNil(announced(ReplyWatch(lastId: "q", heard: .init(text: latch, turn: "q")), rows).reply, "A tail that was read")
    XCTAssertNil(announced(ReplyWatch(lastId: "q", heard: .init(text: "\(fence)\n\(latch)", turn: "q")), rows).reply, "The whole of it, separated differently")
    XCTAssertNil(announced(ReplyWatch(lastId: "q", heard: .init(text: "I checked the north   fence.\n\nThe gate latch is loose.", turn: "q")), rows).reply, "Whitespace never tells words apart")
  }

  func testWordsThatWereNotInTheReplyOrWereHeardInAnEarlierTurnLeaveItWholeToRead() {
    let rows = [question(), reply("a", fence), tool("t"), reply("b", latch)]
    for heard in [ReplyWatch.Heard(text: "Something else entirely.", turn: "q"), ReplyWatch.Heard(text: latch, turn: "earlier")] {
      XCTAssertEqual(announced(ReplyWatch(lastId: "q", heard: heard), rows).said, "\(fence) \(latch)", heard.text)
    }
  }

  func testASegmentThatArrivesWhileTheAssistantWorksWaitsAndJoinsTheNextOnesOnceEach() {
    let first = [question(), reply("a", fence)]
    let one = announced(ReplyWatch(lastId: "q"), first, .working)
    XCTAssertNil(one.reply); XCTAssertEqual(one.watch.waiting?.text, fence)
    let second = first + [tool("t"), reply("b", latch)]
    let two = announced(one.watch, second, .working)
    XCTAssertNil(two.reply)
    let done = announced(two.watch, second + [tool("u"), reply("c", "It needs a new hinge.")])
    XCTAssertEqual(done.said, "\(fence) \(latch) It needs a new hinge.")
    XCTAssertNil(done.watch.waiting); XCTAssertEqual(done.watch.waitingBefore, [])
    // One segment is joined with the next when only the second arrives after it finishes.
    XCTAssertEqual(announced(one.watch, second).said, "\(fence) \(latch)")
  }

  func testAHeldRowIsReadAsItEndedUpWhenItGrewInPlaceWhileTheAssistantWorked() {
    let one = announced(ReplyWatch(lastId: "q"), [question(), reply("a", "I checked."), tool("t"), reply("b", "The gate")], .working)
    let grown = [question(), reply("a", "I checked."), tool("t"), reply("b", latch)]
    let two = announced(one.watch, grown, .working)
    XCTAssertNil(two.reply)
    XCTAssertEqual(announced(two.watch, grown).said, "I checked. \(latch)")
    let single = announced(announced(ReplyWatch(lastId: "q"), [question(), reply("a", "Checking")], .working).watch, [question(), reply("a", "Checking. All clear.")], .working)
    XCTAssertEqual(announced(single.watch, [question(), reply("a", "Checking. All clear."), tool("t"), reply("b", "Gate shut.")]).said, "Checking. All clear. Gate shut.")
  }

  func testTheHeldSegmentIsAnnouncedAloneWhenTheNextReadAddsNothingAndTheAssistantFinished() {
    let first = [question(), reply("a", fence)]
    XCTAssertEqual(announced(announced(ReplyWatch(lastId: "q"), first, .working).watch, first).said, fence)
  }

  func testAHeldReplyFromAnEarlierTurnIsDroppedWhenANewTurnsReplyArrives() {
    let first = [question(), reply("a", fence)]
    let waiting = announced(ReplyWatch(lastId: "q"), first, .working)
    XCTAssertEqual(announced(waiting.watch, first + [question("q2"), reply("b", "Second answer.")]).said, "Second answer.")
  }

  func testTheHeldSegmentSurvivesWhileTheLastSegmentStillStreams() throws {
    let intro = [question(), reply("a", "Intro."), tool("t")]
    // The saved last segment replaces the streaming one.
    let held = announced(ReplyWatch(lastId: "q"), [question(), reply("a", "Intro.")], .working)
    let streamed = announced(held.watch, intro + [streaming("Answ")], .working)
    XCTAssertNil(streamed.reply)
    XCTAssertEqual(announced(streamed.watch, intro + [reply("b", "Answer.")]).said, "Intro. Answer.")
    // Through every read that sees the last segment grow.
    var watch = announced(held.watch, intro + [streaming("Answ")], .working).watch
    watch = announced(watch, intro + [streaming("Answer, ple")], .working).watch
    watch = announced(watch, intro + [reply("b", "Answer, please."), tool("u"), streaming("More")], .working).watch
    XCTAssertEqual(announced(watch, intro + [reply("b", "Answer, please."), tool("u"), reply("c", "More.")]).said, "Intro. Answer, please. More.")
    // The turn finishes before the streaming tail is saved: held, saved and streaming are all read.
    let done = announced(held.watch, intro + [reply("m", "Middle."), streaming("Answer.")])
    XCTAssertEqual(done.said, "Intro. Middle. Answer.")
    XCTAssertEqual(done.reply?.id, "run-inflight")
    XCTAssertNil(announced(done.watch, intro + [reply("m", "Middle."), reply("b", "Answer.")]).reply, "Saved later, it is the same words")
    // Saved rows ahead of a streaming tail that no read held.
    XCTAssertEqual(announced(ReplyWatch(lastId: "q"), [question(), reply("a", "Intro."), tool("t"), streaming("Answer.")]).said, "Intro. Answer.")
    // A held segment of an earlier turn is dropped when the next turn's reply is streaming.
    XCTAssertEqual(announced(held.watch, [question(), reply("a", "Intro."), question("q2"), streaming("Second answer.")]).said, "Second answer.")
  }
}
