import XCTest
@testable import AgentInterface

/// The transcript's chat UX catch-up: code coloring, table copies, the question card, Retry, find in
/// chat, the folded work row, quoting and opening a chat at a message.
@MainActor final class TranscriptFeatureTests: XCTestCase {
  // MARK: Code coloring

  private func kinds(_ code: String, _ language: String) -> [String: SyntaxToken.Kind] {
    var result: [String: SyntaxToken.Kind] = [:]
    for token in SyntaxHighlighter.tokens(code, language: language) ?? [] {
      if let kind = token.kind { result[token.text.trimmingCharacters(in: .whitespacesAndNewlines)] = kind }
    }
    return result
  }

  func testHighlighterColorsTheCommonPartsOfEachLanguage() throws {
    let swift = kinds("// Reads it\nlet level = try await gate.battery(\"north\")\nif level < 0.2 { print(level) }", "swift")
    XCTAssertEqual(swift["// Reads it"], .comment)
    XCTAssertEqual(swift["let"], .keyword); XCTAssertEqual(swift["try"], .keyword); XCTAssertEqual(swift["if"], .keyword)
    XCTAssertEqual(swift["\"north\""], .string)
    XCTAssertEqual(swift["0.2"], .number)
    XCTAssertEqual(swift["print"], .type)
    XCTAssertNil(swift["level"], "A plain identifier stays plain")

    let ts = kinds("const total: number = items.length; /* note */ return `n=${total}`", "typescript")
    XCTAssertEqual(ts["const"], .keyword); XCTAssertEqual(ts["number"], .type); XCTAssertEqual(ts["/* note */"], .comment)
    XCTAssertEqual(ts["`n=${total}`"], .string)

    let python = kinds("def f(x):\n    \"\"\"Doc\nmore\"\"\"\n    return None  # done\n@cache", "py")
    XCTAssertEqual(python["def"], .keyword); XCTAssertEqual(python["\"\"\"Doc\nmore\"\"\""], .string, "A triple-quoted string spans lines")
    XCTAssertEqual(python["None"], .type); XCTAssertEqual(python["# done"], .comment); XCTAssertEqual(python["@cache"], .attribute)

    let json = kinds(#"{"name": "Hay", "count": 3, "ok": true, "none": null}"#, "json")
    XCTAssertEqual(json[#""name""#], .attribute, "A key reads differently from a value")
    XCTAssertEqual(json[#""Hay""#], .string); XCTAssertEqual(json["3"], .number); XCTAssertEqual(json["true"], .type)

    let shell = kinds("echo $HOME ${PATH} # note\nls a#b", "sh")
    XCTAssertEqual(shell["echo"], .type); XCTAssertEqual(shell["$HOME"], .type); XCTAssertEqual(shell["${PATH}"], .type)
    XCTAssertEqual(shell["# note"], .comment)
    XCTAssertFalse((SyntaxHighlighter.tokens("ls a#b", language: "bash") ?? []).contains { $0.kind == .comment },
      "A # inside a word is not a comment")

    let sql = kinds("select id from users where age > 21 -- adults", "SQL")
    XCTAssertEqual(sql["select"], .keyword, "SQL keywords match in any case"); XCTAssertEqual(sql["-- adults"], .comment)

    let rust = SyntaxHighlighter.tokens("fn main<'a>(x: &'a str) { let c = 'c'; }", language: "rust") ?? []
    XCTAssertTrue(rust.contains(SyntaxToken(kind: .string, text: "'c'")))
    XCTAssertFalse(rust.contains { $0.kind == .string && $0.text.contains("'a") }, "A lifetime is not a string")

    let html = SyntaxHighlighter.tokens(#"<div class="a">Hi &amp; bye<!-- c --></div>"#, language: "html") ?? []
    XCTAssertTrue(html.contains(SyntaxToken(kind: .keyword, text: "div")))
    XCTAssertTrue(html.contains(SyntaxToken(kind: .attribute, text: "class")))
    XCTAssertTrue(html.contains(SyntaxToken(kind: .string, text: "\"a\"")))
    XCTAssertTrue(html.contains(SyntaxToken(kind: .comment, text: "<!-- c -->")))

    let diff = SyntaxHighlighter.tokens("--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n same", language: "diff") ?? []
    XCTAssertEqual(diff.compactMap(\.kind), [.meta, .meta, .meta, .removed, .added], "A context line stays plain")
    XCTAssertTrue(diff.contains(SyntaxToken(kind: .removed, text: "-old")))
    XCTAssertTrue(diff.contains(SyntaxToken(kind: .added, text: "+new")))
    XCTAssertTrue(diff.contains(SyntaxToken(kind: .meta, text: "@@ -1 +1 @@")))

    let css = kinds(".a { color: #fff; margin: -10px !important; }", "css")
    XCTAssertEqual(css["color"], .attribute); XCTAssertEqual(css["#fff"], .number); XCTAssertEqual(css["10px"], .number)
    XCTAssertEqual(css["!important"], .keyword)

    for language in ["go", "kotlin", "java", "c", "cpp", "ruby", "yaml"] {
      XCTAssertNotNil(SyntaxHighlighter.tokens("x", language: language), "\(language) is known")
    }
    XCTAssertEqual(kinds("package main\nfunc main() {}", "go")["func"], .keyword)
    XCTAssertEqual(kinds("name: ranch\n# c", "yml")["name"], .attribute)
  }

  func testHighlighterKeepsEveryCharacterAndLeavesUnknownOrHugeBlocksPlain() {
    let code = "let a = \"x\" // é 🐴\n\tlet b = 0x1F"
    let tokens = SyntaxHighlighter.tokens(code, language: "swift") ?? []
    XCTAssertEqual(tokens.map(\.text).joined(), code)
    let colored = SyntaxHighlighter.attributed(tokens) { _ in AttributeContainer() }
    XCTAssertEqual(String(colored.characters), code)
    XCTAssertNil(SyntaxHighlighter.tokens(code, language: "brainfudge"))
    XCTAssertNil(SyntaxHighlighter.tokens(code, language: nil))
    XCTAssertNil(SyntaxHighlighter.tokens(String(repeating: "a", count: SyntaxHighlighter.limit + 1), language: "swift"))
  }

  func testCodeIsColoredOnlyOnceItsBlockSettles() {
    let cache = MarkdownCache()
    var styled = 0
    let style: (SyntaxToken.Kind) -> AttributeContainer = { _ in styled += 1; return AttributeContainer() }
    XCTAssertNil(cache.highlighted("let a = 1", language: "swift", settled: false, style: style), "A streaming block stays plain")
    XCTAssertNil(cache.highlighted("let a = 1", language: "klingon", settled: true, style: style))
    let first = cache.highlighted("let a = 1", language: "swift", settled: true, style: style)
    let count = styled
    XCTAssertNotNil(first); XCTAssertGreaterThan(count, 0)
    XCTAssertEqual(cache.highlighted("let a = 1", language: "Swift", settled: true, style: style), first)
    XCTAssertEqual(styled, count, "The second read comes from the cache")
  }

  // MARK: Tables

  func testTablesCopyAsMarkdownAndCSV() throws {
    guard case .table(let table) = Markdown.parse("| Gate | Battery |\n| :--- | ---: |\n| **North** | 18% |\n| South, back | \"76\" \\| ok |").first
    else { return XCTFail("Expected a table") }
    XCTAssertEqual(table.markdown, "| Gate | Battery |\n| --- | ---: |\n| **North** | 18% |\n| South, back | \"76\" \\| ok |")
    XCTAssertEqual(Markdown.parse(table.markdown), [.table(table)], "The copy parses back to the same table")
    XCTAssertEqual(table.csv, "Gate,Battery\r\nNorth,18%\r\n\"South, back\",\"\"\"76\"\" | ok\"")
  }

  // MARK: Questions

  private let one = Question(id: "plan", prompt: "Plan", options: ["First", "Second"])
  private let several = Question(id: "extras", prompt: "Extras", options: ["Hay", "Water", "Feed"], multiSelect: true)
  private let written = Question(id: "note", prompt: "Note")

  func testASingleChoiceSettlesItsQuestionAndMovesOn() {
    var answers = QuestionAnswers()
    let questions = [one, several, written]
    XCTAssertFalse(answers.complete(questions))
    XCTAssertTrue(answers.choose(1, in: one), "One choice settles the question")
    XCTAssertEqual(answers.answer(one), "Second")
    XCTAssertTrue(answers.choose(0, in: one)); XCTAssertEqual(answers.answer(one), "First", "Another tap changes the choice")
    XCTAssertEqual(answers.next(after: one, in: questions)?.id, "extras")
    XCTAssertFalse(answers.choose(9, in: one), "An option that is not there is ignored")
  }

  func testSeveralChoicesToggleAndJoinWithAWrittenAnswer() {
    var answers = QuestionAnswers()
    XCTAssertFalse(answers.choose(2, in: several)); XCTAssertFalse(answers.choose(0, in: several))
    XCTAssertEqual(answers.answer(several), "Hay, Feed", "Choices read in the options' order")
    _ = answers.choose(2, in: several)
    XCTAssertEqual(answers.answer(several), "Hay")
    answers.writeOwn(several); answers.text["extras"] = "  Salt block "
    XCTAssertEqual(answers.answer(several), "Hay, Salt block")
    answers.writeOwn(several)
    XCTAssertEqual(answers.answer(several), "Hay", "Turning the written answer off drops it")
  }

  func testWritingYourOwnAnswerReplacesASingleChoiceAndGatesSend() {
    var answers = QuestionAnswers()
    let questions = [one, written]
    _ = answers.choose(0, in: one)
    answers.writeOwn(one)
    XCTAssertFalse(answers.isSelected(0, one))
    XCTAssertEqual(answers.answer(one), "", "An empty written answer does not count")
    answers.text["plan"] = "Handle both tomorrow"
    XCTAssertEqual(answers.answer(one), "Handle both tomorrow")
    XCTAssertFalse(answers.complete(questions))
    XCTAssertEqual(answers.next(after: one, in: questions)?.id, "note")
    answers.text["note"] = "   "
    XCTAssertFalse(answers.complete(questions), "Whitespace is not an answer")
    answers.text["note"] = "Thanks"
    XCTAssertTrue(answers.complete(questions))
    XCTAssertNil(answers.next(after: one, in: questions))
    XCTAssertEqual(answers.payload(questions), ["plan": "Handle both tomorrow", "note": "Thanks"])
    _ = answers.choose(1, in: one)
    XCTAssertEqual(answers.answer(one), "Second", "Choosing an option again leaves the written answer")
  }

  func testNextQuestionWrapsToAnEarlierUnansweredOne() {
    var answers = QuestionAnswers()
    _ = answers.choose(0, in: several)
    XCTAssertEqual(answers.next(after: several, in: [one, several, written])?.id, "note")
    answers.text["note"] = "Done"
    XCTAssertEqual(answers.next(after: written, in: [one, several, written])?.id, "plan")
  }

  // MARK: Retry

  private func conversation(_ messages: [Message], _ state: ActivityState, session: String? = "session") -> Conversation {
    Conversation(botId: "bot", sessionId: session, messages: messages, activity: Activity(state: state), approvals: [], files: [])
  }

  func testRetryIsOfferedOnlyForAFailedTurnWithoutAReply() {
    let prompt = Message(id: "p", role: "user", text: "Is the gate closed?", files: [FileRef(id: "f", name: "gate.jpg", mime: "image/jpeg")])
    let tool = Message(id: "t", role: "tool", text: "Timed out", toolCall: ToolCall(id: "c", name: "gate", status: "failed"))
    XCTAssertEqual(RetryTurn.target(conversation([prompt, tool], .failed))?.id, "p")
    XCTAssertEqual(RetryTurn.target(conversation([prompt, Message(id: "e", role: "assistant", text: "  ")], .failed))?.id, "p",
      "An empty assistant row is no reply")
    XCTAssertNil(RetryTurn.target(conversation([prompt, tool], .idle)), "Only a failed run offers Retry")
    XCTAssertNil(RetryTurn.target(conversation([prompt, tool], .working)))
    XCTAssertNil(RetryTurn.target(conversation([prompt, Message(id: "a", role: "assistant", text: "Closed.")], .failed)),
      "A reply after the message means the turn answered")
    let scheduled = Message(id: "s", role: "user", text: "[Cron delivery: hay] Done", origin: MessageOrigin(kind: "scheduled", visibility: "conversation"))
    XCTAssertEqual(RetryTurn.target(conversation([prompt, scheduled], .failed))?.id, "p", "A scheduled delivery is not the person's message")
    XCTAssertNil(RetryTurn.target(conversation([], .failed)))
  }

  // MARK: Find in chat

  private func hit(_ id: String?, session: String = "session", bot: String = "bot", offset: Int? = nil) -> SearchHit {
    SearchHit(botId: bot, botName: "Bot", sessionId: session, title: "", snippet: "", messageId: id, offset: offset)
  }

  func testFindMergesUnloadedHistoryFromTheCanonicalSessionFirst() {
    let loaded = [Message(id: "m10", role: "user", text: "Gate check"), Message(id: "m11", role: "assistant", text: "The gate is closed"),
      Message(id: "m12", role: "tool", text: "gate log", toolCall: ToolCall(id: "c", name: "gate", status: "completed"))]
    let hits = [hit("m11"), hit("m3", offset: 3), hit("m1", offset: 1), hit("m3", offset: 3), hit("old", session: "other"),
      hit("theirs", bot: "kitchen"), hit(nil), hit("m12")]
    let matches = FindMatches.merge(loaded: loaded, query: "gate", hits: hits, botId: "bot", sessionId: "session")
    XCTAssertEqual(matches, [.init(id: "m1", loaded: false), .init(id: "m3", loaded: false), .init(id: "m10", loaded: true), .init(id: "m11", loaded: true)],
      "Older hits lead in session order; loaded, duplicate, other-session, other-assistant and activity rows do not repeat")
    XCTAssertEqual(FindMatches.merge(loaded: loaded, query: "gate", hits: hits, botId: "bot", sessionId: nil).map(\.id), ["m10", "m11"],
      "Without a canonical session only loaded messages count")
    XCTAssertEqual(FindMatches.merge(loaded: loaded, query: "  ", hits: hits, botId: "bot", sessionId: "session"), [])
    XCTAssertEqual(FindMatches.status(position: 2, count: 4), "3 of 4")
    XCTAssertEqual(FindMatches.status(position: nil, count: 4), "4 matches")
    XCTAssertEqual(FindMatches.status(position: nil, count: 1), "1 match")
    XCTAssertEqual(FindMatches.status(position: nil, count: 0), "0 matches")
  }

  // MARK: Folded work

  func testWorkFoldsIntoOneRowWithItsDurationAndCounts() throws {
    let messages = [
      Message(id: "p", role: "user", text: "Check it", createdAt: "2026-10-24T15:00:00.000Z"),
      Message(id: "n", role: "assistant", text: "Checking.", reasoning: "Look at the log"),
      Message(id: "t1", role: "assistant", text: "", toolCall: ToolCall(id: "c1", name: "web_search", status: "completed", startedAt: "2026-10-24T15:00:04.000Z", completedAt: "2026-10-24T15:00:20.000Z")),
      Message(id: "t2", role: "tool", text: "ok", toolCall: ToolCall(id: "c2", name: "read_file", status: "completed")),
      Message(id: "s", role: "assistant", text: "", toolCall: ToolCall(id: "c3", name: "delegate_task", status: "completed")),
      Message(id: "a", role: "assistant", text: "Done.", createdAt: "2026-10-24T15:02:14.000Z"),
    ]
    let turn = try XCTUnwrap(conversation(messages, .idle).presentationTurns.first)
    XCTAssertEqual(turn.transcriptRows(advanced: false).map(\.id), ["message-p", "message-n", "work", "message-a"])
    XCTAssertEqual(turn.transcriptRows(advanced: true).map(\.id), ["message-p", "work", "message-n", "message-a"],
      "With reasoning shown, the fold sits where the reasoning would have")
    let summary = WorkSummary(turn)
    XCTAssertEqual(summary.label(live: false), "Worked for 2m 14s · 2 tool calls, 1 subagent")
    let start = try XCTUnwrap(ServerDate.parse("2026-10-24T15:00:00.000Z"))
    XCTAssertEqual(summary.label(live: true, now: start.addingTimeInterval(65)), "Working for 1m 5s · 2 tool calls, 1 subagent")

    var untimed = messages.map { message -> Message in var copy = message; copy.createdAt = nil; copy.toolCall?.startedAt = nil; copy.toolCall?.completedAt = nil; return copy }
    let plain = WorkSummary(try XCTUnwrap(conversation(untimed, .idle).presentationTurns.first))
    XCTAssertEqual(plain.label(live: false), "2 tool calls, 1 subagent", "Without times there is no duration")
    XCTAssertEqual(plain.label(live: true), "Working · 2 tool calls, 1 subagent")
    untimed = [untimed[0], untimed[1], untimed[5]]
    let reasoningOnly = try XCTUnwrap(conversation(untimed, .idle).presentationTurns.first)
    XCTAssertEqual(reasoningOnly.transcriptRows(advanced: false).map(\.id), ["message-p", "message-n", "message-a"], "No work, no fold")
    XCTAssertEqual(WorkSummary(reasoningOnly).label(live: false), "Reasoning")
  }

  func testWorkDurationsAndGroupNouns() {
    XCTAssertEqual(WorkSummary.duration(45.9), "45s")
    XCTAssertEqual(WorkSummary.duration(120), "2m")
    XCTAssertEqual(WorkSummary.duration(134), "2m 14s")
    XCTAssertEqual(WorkSummary.duration(3600), "1h")
    XCTAssertEqual(WorkSummary.duration(3780), "1h 3m")
    XCTAssertEqual(WorkSummary.noun("Scheduled jobs", 2), "scheduled handoffs")
    XCTAssertEqual(WorkSummary.noun("Background processes", 1), "background process")
    XCTAssertEqual(WorkSummary.noun("Bot messages", 3), "bot messages")
    XCTAssertEqual(WorkSummary.noun("Diagnostics", 1), "diagnostic")
  }

  func testLiveWorkNamesTheRunningToolAndTheLatestReasoningLine() throws {
    let messages = [Message(id: "p", role: "user", text: "Weather?"),
      Message(id: "r-inflight", role: "assistant", text: "", reasoning: "First thought.\n\n  Need a fresh forecast.  \n")]
    let turn = conversation(messages, .working).presentationTurns.last
    let live = LiveWork(turn: turn, toolCalls: [ToolCall(id: "done", name: "read", status: "completed"), ToolCall(id: "c", name: "web_search", status: "running")])
    XCTAssertEqual(live.receipt, "Action in progress · web_search")
    XCTAssertEqual(live.reasoning, "Need a fresh forecast.")
    XCTAssertNil(LiveWork(turn: turn, toolCalls: [ToolCall(id: "done", name: "read", status: "completed")]).receipt)
  }

  // MARK: Quotes

  func testAQuoteIsABlockQuoteWithRoomToAnswer() {
    XCTAssertEqual(ReplyQuote.block("  First line\n\nSecond line\n"), "> First line\n>\n> Second line\n\n")
  }

  // MARK: Store

  private final class Box: @unchecked Sendable {
    let lock = NSLock()
    var messages: [[String: Any]] = []
    var state = "failed"
    var sendStatus = 200
  }
  /// The fake app server's routes. Nonisolated: URLSession calls it off the main actor.
  nonisolated private static func answer(_ request: URLRequest, _ box: Box) -> FakeServer.Reply {
    let path = request.url?.path ?? ""
    return box.lock.withLock {
      if path == "/api/bots/bot/messages" {
        guard box.sendStatus == 200 else { return .init(status: box.sendStatus, body: #"{"error":"Refused"}"#) }
        let id = (FakeExchange.body(request).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] })?["requestId"] as? String ?? ""
        box.state = "thinking"
        return .init(body: #"{"requestId":"\#(id)","status":"accepted","messageId":"\#(id)"}"#)
      }
      if path == "/api/bots/bot/conversation" {
        let start = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "start" }?.value
        let from = start.flatMap { id in box.messages.firstIndex { $0["id"] as? String == id } } ?? max(0, box.messages.count - 2)
        let body: [String: Any] = ["botId": "bot", "sessionId": "session", "messages": Array(box.messages[from...]), "earlier": from,
          "activity": ["state": box.state], "approvals": [], "files": [], "draft": ["text": "Keep my words", "attachments": [], "revision": 1]]
        return .init(body: String(decoding: try! JSONSerialization.data(withJSONObject: body), as: UTF8.self))
      }
      return .init()
    }
  }
  private var stores: [AppStore] = []
  override func tearDown() async throws {
    for value in stores {
      value.suspend()
      if let scope = value.scope {
        for key in UserDefaults.standard.dictionaryRepresentation().keys where key.hasPrefix("native.\(scope).") { UserDefaults.standard.removeObject(forKey: key) }
      }
    }
    stores = []
    try await super.tearDown()
  }
  private func store(_ box: Box) async throws -> (AppStore, FakeServer) {
    let server = FakeServer { Self.answer($0, box) }
    let value = AppStore(); value.api = server.api()
    value.bootstrap = try JSONDecoder().decode(Bootstrap.self, from: Data(#"""
      {"user":{"id":"transcript-\#(UUID().uuidString)","name":"Tester","email":"t@example.test"},"household":[],
       "preferences":{"presentation":"simple","theme":"system","favorites":[],"sections":[],"followBots":[]},
       "bots":[{"id":"bot","name":"Bot","model":"test","shared":true,"activity":"idle"}],
       "capabilities":{"chat":{"supported":true},"steering":{"supported":true}},"connection":{"connected":true},"csrfToken":null}
      """#.utf8))
    value.selectedBotId = "bot"
    await value.refreshConversation()
    value.draft = Draft(text: "Keep my words", attachments: [], dirty: false, baseRevision: 1); value.draftReady = true
    stores.append(value)
    return (value, server)
  }
  private func failedTurn(_ box: Box) {
    box.lock.withLock {
      box.messages = [["id": "p", "role": "user", "text": "Is the gate closed?", "files": [["id": "f", "name": "gate.jpg", "mime": "image/jpeg"]]],
        ["id": "t", "role": "tool", "text": "Timed out", "toolCall": ["id": "c", "name": "gate", "status": "failed"]]]
    }
  }

  func testRetrySendsTheMessageAgainWithoutTouchingTheDraft() async throws {
    let box = Box(); failedTurn(box)
    let (value, server) = try await store(box)
    value.editComposer { $0.text = "A different draft" }
    let draft = value.draft
    let prompt = try XCTUnwrap(value.conversation.flatMap(RetryTurn.target))
    await value.retry(prompt)
    let sends = server.requests.filter { $0.url?.path == "/api/bots/bot/messages" }
    XCTAssertEqual(sends.count, 1)
    let body = try XCTUnwrap(sends.first.flatMap(FakeExchange.body).flatMap { try JSONSerialization.jsonObject(with: $0) as? [String: Any] })
    XCTAssertEqual(body["retryOf"] as? String, "p")
    XCTAssertEqual(body["text"] as? String, "Is the gate closed?")
    XCTAssertEqual((body["attachments"] as? [[String: Any]])?.first?["id"] as? String, "f")
    XCTAssertNil(body["draftBaseRevision"], "A retry is not written on a draft")
    XCTAssertNotEqual(body["requestId"] as? String, "p")
    XCTAssertEqual(value.draft.text, draft.text, "The draft stays as it was")
    XCTAssertEqual(value.draft.sentHash, nil)
    XCTAssertNil(value.pending); XCTAssertNil(value.retrying)
    XCTAssertEqual(value.receipt?.status, "accepted"); XCTAssertEqual(value.haptic?.kind, .sent)
    XCTAssertNil(value.conversation.flatMap(RetryTurn.target), "Working again, the turn offers no Retry")
  }

  func testARefusedRetryKeepsTheDraftAndShowsTheError() async throws {
    let box = Box(); failedTurn(box); box.sendStatus = 409
    let (value, _) = try await store(box)
    let prompt = try XCTUnwrap(value.conversation.flatMap(RetryTurn.target))
    await value.retry(prompt)
    XCTAssertEqual(value.draft.text, "Keep my words", "A refused retry never goes into the draft")
    XCTAssertEqual(value.receipt?.status, "rejected"); XCTAssertNil(value.pending)
    XCTAssertEqual(value.error, "Refused"); XCTAssertEqual(value.haptic?.kind, .failed)
  }

  func testRetryIsRefusedForAMessageThatIsNotTheFailedTurns() async throws {
    let box = Box(); failedTurn(box); box.state = "idle"
    let (value, server) = try await store(box)
    await value.retry(Message(id: "p", role: "user", text: "Is the gate closed?"))
    XCTAssertTrue(server.requests.filter { $0.url?.path == "/api/bots/bot/messages" }.isEmpty)
  }

  func testOpeningAtAnUnloadedMessageLoadsFromItAndFocusesIt() async throws {
    let box = Box(); box.state = "idle"
    box.messages = (1...6).map { ["id": "m\($0)", "role": $0 % 2 == 1 ? "user" : "assistant", "text": "Message \($0)"] }
    let (value, server) = try await store(box)
    XCTAssertEqual(value.conversation?.messages.map(\.id), ["m5", "m6"])
    let request = value.conversationRequest
    await value.openConversation(botId: "bot", atMessage: "m2")
    XCTAssertNotEqual(value.conversationRequest, request, "The open chat comes to the front")
    XCTAssertEqual(server.lastRequest?.url?.query, "start=m2")
    XCTAssertEqual(value.conversation?.messages.map(\.id), ["m2", "m3", "m4", "m5", "m6"])
    XCTAssertEqual(value.focusedMessage?.messageId, "m2")
    await value.refreshConversation()
    XCTAssertEqual(server.lastRequest?.url?.query, "start=m2", "Later reads keep the window that holds it")

    // A loaded message is focused without another read; a missing one is not focused.
    let reads = server.requests.count
    value.focusedMessage = nil
    await value.openConversation(botId: "bot", atMessage: "m4")
    XCTAssertEqual(server.requests.count, reads); XCTAssertEqual(value.focusedMessage?.messageId, "m4")
    value.focusedMessage = nil
    await value.openConversation(botId: "bot", atMessage: "gone")
    XCTAssertNil(value.focusedMessage)
  }

  func testAQuoteJoinsTheDraftOrWaitsForASendToSettle() async throws {
    let box = Box(); box.state = "idle"
    let (value, _) = try await store(box)
    XCTAssertEqual(value.quoteInReply("North gate\nclosed", botId: "bot"), .added)
    await value.deliverAdditions()
    XCTAssertEqual(value.draft.text, "Keep my words\n\n> North gate\n> closed\n\n")
    value.pending = PendingSubmission(requestId: "r", botId: "bot", text: value.draft.text, attachments: [], reviewedInterruption: false)
    XCTAssertEqual(value.quoteInReply("Later", botId: "bot"), .waiting)
    await value.deliverAdditions()
    XCTAssertFalse(value.draft.text.contains("> Later"), "Nothing changes a draft while its send is unsettled")
    value.pending = nil
    await value.deliverAdditions()
    XCTAssertTrue(value.draft.text.hasSuffix("> Later\n\n"))
    XCTAssertEqual(value.quoteInReply("   ", botId: "bot"), .refused)
  }
}
