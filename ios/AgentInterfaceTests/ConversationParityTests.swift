import XCTest
@testable import AgentInterface

/// Conversation copy that must read the same as the web client (src/app/Conversation.tsx and friends).
@MainActor final class ConversationParityTests: XCTestCase {
  func testInflightNeverOverwritesASettledOrDifferentRunFetch() throws {
    let data = Data(#"{"botId":"bot","messages":[{"id":"saved","role":"assistant","text":"Saved reply"}],"activity":{"state":"thinking","runId":"run"},"approvals":[],"files":[]}"#.utf8)
    var conversation = try JSONDecoder().decode(Conversation.self, from: data)
    let patch = Inflight(botId: "bot", message: Message(id: "sid-inflight", role: "assistant", text: "Old tail"), activity: Activity(state: .thinking, runId: "run"), toolCalls: [])
    XCTAssertEqual(patch.applying(to: conversation).messages.last?.text, "Old tail")
    conversation.activity.state = .done
    XCTAssertEqual(patch.applying(to: conversation), conversation)
    conversation.activity = Activity(state: .thinking, runId: "next-run")
    XCTAssertEqual(patch.applying(to: conversation), conversation)
  }

  private func sentence(_ state: ActivityState, _ detail: String? = nil, lost: Bool = false) -> String {
    ActivitySentence.text(name: "Ranch hand", state: state, detail: detail, connectionLost: lost)
  }

  func testWorkingLineNamesTheCurrentStepInOneSentence() {
    XCTAssertEqual(sentence(.working, "Creating a shared reminder"), "Ranch hand is creating a shared reminder...")
    XCTAssertEqual(sentence(.working, "  Checking the latest forecast…  "), "Ranch hand is checking the latest forecast...")
    XCTAssertEqual(sentence(.working, "Saving the list..."), "Ranch hand is saving the list...")
    XCTAssertEqual(sentence(.working, "   "), "Ranch hand is working...")
    XCTAssertEqual(sentence(.working), "Ranch hand is working...")
  }

  func testOtherStatesUseTheWebVerbsAndIgnoreTheDetail() {
    XCTAssertEqual(sentence(.thinking, "Planning"), "Ranch hand is thinking...")
    XCTAssertEqual(sentence(.waiting, "Order hay"), "Ranch hand is waiting for approval...")
    XCTAssertEqual(sentence(.blocked), "Ranch hand is waiting for your input...")
    XCTAssertEqual(sentence(.failed), "Ranch hand is having trouble...")
    XCTAssertEqual(sentence(.interrupted), "Ranch hand is stopped...")
    XCTAssertEqual(sentence(.disconnected), "Ranch hand is reconnecting...")
    XCTAssertEqual(sentence(.working, "Creating a reminder", lost: true), "Ranch hand is reconnecting...")
    XCTAssertEqual(sentence(.unknown), "Ranch hand's status is unknown")
  }

  func testDiscussRoleAppendsToTypedText() {
    XCTAssertEqual(RoleDiscussion.draft(appendingTo: "", description: nil),
      "Let's discuss your role. Ask me what I need help with and how I like to work.")
    XCTAssertEqual(RoleDiscussion.draft(appendingTo: "", description: ""),
      "Let's discuss your role. Ask me what I need help with and how I like to work.")
    XCTAssertEqual(RoleDiscussion.draft(appendingTo: "Fence notes", description: "Keeps the ranch running"),
      "Fence notes\n\nLet's discuss your role: Keeps the ranch running.")
  }

  func testOutgoingHandoffReadsTargetAndMessageFromTheCall() {
    let sent = AgentHandoff(message: Message(id: "a", role: "assistant", text: "", toolCall: ToolCall(
      id: "c", name: "message_agent", arguments: #"{"target":"Kitchen companion","message":"Plan dinners"}"#, status: "completed", result: "Delivered")))
    XCTAssertNil(sent.incoming)
    XCTAssertEqual(sent.target, "Kitchen companion")
    XCTAssertEqual(sent.body, "Plan dinners")
    XCTAssertEqual(sent.summary, "View handoff and response")
    XCTAssertEqual(sent.response, "Delivered")

    let sending = AgentHandoff(message: Message(id: "b", role: "assistant", text: "", toolCall: ToolCall(
      id: "d", name: "message_agent", arguments: "not json", status: "running")))
    XCTAssertEqual(sending.target, "another assistant")
    XCTAssertEqual(sending.summary, "Sending message…")
    XCTAssertEqual(sending.response, "Waiting for Hermes to report delivery.")

    let failed = AgentHandoff(message: Message(id: "e", role: "assistant", text: "", toolCall: ToolCall(
      id: "f", name: "message_agent", status: "failed", error: "Unknown assistant")))
    XCTAssertEqual(failed.summary, "Delivery failed")
    XCTAssertEqual(failed.response, "Unknown assistant")
  }

  func testIncomingHandoffUsesTheEnvelope() {
    let received = AgentHandoff(message: Message(id: "g", role: "user", text: "Message from Kitchen companion: Dinner is planned"))
    XCTAssertEqual(received.incoming?.name, "Kitchen companion")
    XCTAssertEqual(received.incoming?.body, "Dinner is planned")
  }

  func testAgentExchangesFollowTheMessageOriginLikeTheWeb() {
    let incoming = Message(id: "in", role: "user", text: "Message from Kitchen companion: Dinner is planned")
    XCTAssertTrue(incoming.isAgentExchange)
    XCTAssertTrue(incoming.isInternalActivity, "An incoming envelope lands in Bot messages")
    let outgoing = Message(id: "out", role: "assistant", text: "", toolCall: ToolCall(id: "c", name: "message_agent", status: "completed"))
    XCTAssertTrue(outgoing.isAgentExchange)
    var reported = Message(id: "server", role: "user", text: "Dinner is planned")
    reported.origin = MessageOrigin(kind: "agent", visibility: "conversation", name: "Kitchen companion")
    XCTAssertTrue(reported.isAgentExchange)
    XCTAssertEqual(AgentHandoff(message: reported).incoming?.name, "Kitchen companion")
    // A reply that also called message_agent is a reply; its call shows with the turn's tools.
    let reply = Message(id: "r", role: "assistant", text: "I let the kitchen know.", toolCall: ToolCall(id: "d", name: "message_agent", status: "completed"))
    XCTAssertFalse(reply.isAgentExchange)
    XCTAssertFalse(Message(id: "u", role: "user", text: "Hello", sender: Sender(id: "p", name: "Pat")).isAgentExchange)
  }

  func testOnlyRepliesRenderAsMarkdown() {
    XCTAssertTrue(Message(id: "a", role: "assistant", text: "**Done**").isReply)
    XCTAssertTrue(Message(id: "s", role: "user", text: "[Cron delivery: Morning]\n**Weather**").isReply)
    XCTAssertFalse(Message(id: "u", role: "user", text: "**literal** asterisks").isReply)
    XCTAssertFalse(Message(id: "t", role: "tool", text: "output").isReply)
  }

  func testInlineUiStaysAssistantOnlyWhileCardsParseForEveryReply() {
    let html = "```wildbots-html\n" + #"{"version":1,"title":"Planner","html":"<b>Hi</b>"}"# + "\n```"
    let cards = "```agent-ui\n" + #"{"version":1,"cards":[{"id":"list","type":"checklist","title":"Feed","items":[{"id":"hay","text":"Hay"}]}]}"# + "\n```"
    let text = "Intro\n" + html + "\n" + cards
    XCTAssertEqual(ReplyCards.parse(text).compactMap(\.inline).count, 1)
    let scheduled = ReplyCards.parse(text, inlineUi: false)
    XCTAssertTrue(scheduled.allSatisfy { $0.inline == nil })
    XCTAssertEqual(scheduled.compactMap(\.cards).flatMap { $0 }.map(\.id), ["list"])
    XCTAssertTrue(scheduled.first?.markdown?.contains("```wildbots-html") == true, "The fence stays a code block")
  }

  func testToolCallStatusAndWaitingCopyMatchTheWeb() {
    XCTAssertEqual(ToolActivityView.status("running", connected: true), "Running")
    XCTAssertEqual(ToolActivityView.status("running", connected: false), "Last seen running")
    XCTAssertEqual(ToolActivityView.status("failed", connected: true), "Failed")
    XCTAssertEqual(ToolActivityView.status("completed", connected: false), "Completed")
    let running = ToolCall(id: "c", name: "search", status: "running")
    XCTAssertEqual(ToolActivityView.waiting(running, result: nil, connected: true), "Waiting for the result from Hermes.")
    XCTAssertEqual(ToolActivityView.waiting(running, result: nil, connected: false), "The current tool status will be checked when Hermes reconnects.")
    XCTAssertNil(ToolActivityView.waiting(running, result: "partial", connected: true))
    XCTAssertNil(ToolActivityView.waiting(ToolCall(id: "d", name: "search", status: "completed"), result: nil, connected: true))
  }

  func testConnectionCardCopyFollowsTheConnectionCode() {
    XCTAssertEqual(ConnectionCopy.compact(code: "reconnecting", appUnavailable: false).title, "Reconnecting to Hermes")
    XCTAssertEqual(ConnectionCopy.compact(code: nil, appUnavailable: false).title, "Hermes is temporarily unavailable")
    XCTAssertEqual(ConnectionCopy.compact(code: "something_new", appUnavailable: false).title, "Hermes is temporarily unavailable")
    XCTAssertTrue(ConnectionCopy.compact(code: "unauthorized", appUnavailable: false).setup)
    XCTAssertEqual(ConnectionCopy.compact(code: "reconnecting", appUnavailable: true).title, "Reconnecting to the app")
  }
}

/// The sent-message echo, ported from the web's src/app/sent-echo.ts and its tests.
@MainActor final class SentEchoTests: XCTestCase {
  private let sender = Sender(id: "one", name: "One")
  private let request = PendingSubmission(requestId: "req", botId: "bot", text: "Hello there", attachments: [], reviewedInterruption: false)
  private let accepted = Receipt(requestId: "req", status: "accepted", messageId: "row-9")
  private let start = Date(timeIntervalSince1970: 1)
  private func conversation(_ messages: [Message] = [Message(id: "a", role: "assistant", text: "Hi")], _ state: ActivityState = .idle) -> Conversation {
    Conversation(botId: "bot", messages: messages, activity: Activity(state: state), approvals: [], files: [])
  }
  private func step(_ echo: SentEcho?, pending: PendingSubmission? = nil, receipt: Receipt? = nil, sending: Bool = false,
    conversation: Conversation? = nil, sender: Sender?? = nil, now: Date? = nil) -> SentEcho?
  {
    SentEcho.next(echo, pending: pending, receipt: receipt, sending: sending, conversation: conversation ?? self.conversation(),
      sender: sender ?? self.sender, now: now ?? start)
  }
  private var sending: SentEcho { step(nil, pending: request, sending: true)! }
  private func user(_ id: String, _ text: String, from sender: Sender? = nil) -> Message {
    Message(id: id, role: "user", text: text, sender: sender)
  }

  func testAppearsForANewSendAfterTheLastMessageShown() {
    XCTAssertEqual(sending.status, .sending)
    XCTAssertEqual(sending.after, "a")
    XCTAssertEqual(sending.sentAt, "1970-01-01T00:00:01.000Z")
    let shown = SentEcho.transcript(conversation(), [sending])?.messages.last
    XCTAssertEqual(shown, Message(id: "req", role: "user", text: "Hello there", createdAt: sending.sentAt, sender: sender))
    XCTAssertEqual(sending.delivery, SentEcho.Delivery(id: "req", status: .sending))
  }

  func testWaitsUnconfirmedWhenTheRequestEndsWithoutAReceipt() {
    let echo = step(sending, pending: request)
    XCTAssertEqual(echo?.status, .unconfirmed)
    XCTAssertEqual(echo?.delivery?.status, .unconfirmed)
  }

  func testLeavesWithASendThatDidNotGoThrough() {
    let receipts: [Receipt?] = [Receipt(requestId: "req", status: "rejected"), Receipt(requestId: "req", status: "interrupted"),
      Receipt(requestId: "older", status: "accepted"), nil]
    for receipt in receipts {
      XCTAssertNil(step(sending, receipt: receipt), String(describing: receipt))
    }
  }

  func testStaysAfterAcceptanceUntilHermessCopyArrivesByRequestOrRowID() throws {
    let kept = try XCTUnwrap(step(sending, receipt: accepted))
    XCTAssertEqual(kept.status, .accepted)
    XCTAssertEqual(kept.messageId, "row-9")
    XCTAssertEqual(kept.acceptedAt, start)
    XCTAssertNil(kept.delivery, "Accepted, it reads as an ordinary message")
    for id in ["req", "row-9"] {
      let arrived = conversation([Message(id: "a", role: "assistant", text: "Hi"), user(id, "Hello there")], .thinking)
      XCTAssertNil(step(kept, receipt: accepted, conversation: arrived))
      XCTAssertEqual(SentEcho.transcript(arrived, [kept]), arrived)
    }
  }

  func testMatchesAnAcceptedCopyByItsWordsOnlyAfterTheMessageLastShown() throws {
    let earlier = user("u0", "Hello there", from: sender)
    let kept = try XCTUnwrap(step(nil, pending: request, sending: true, conversation: conversation([earlier])))
    let acceptedEcho = try XCTUnwrap(step(kept, receipt: accepted, conversation: conversation([earlier])))
    let saved = conversation([earlier, user("u1", " Hello there ", from: sender)], .thinking)
    XCTAssertNil(step(acceptedEcho, receipt: accepted, conversation: saved))
    let someoneElse = conversation([earlier, user("u1", "Hello there", from: Sender(id: "two", name: "Two"))], .thinking)
    XCTAssertNotNil(step(acceptedEcho, receipt: accepted, conversation: someoneElse))
  }

  func testStandsInForAPromptSavedOnlyWhenItsRunEnds() throws {
    var echo = try XCTUnwrap(step(sending, receipt: accepted))
    echo = try XCTUnwrap(step(echo, receipt: accepted, conversation: conversation([], .working), now: start + 90))
    XCTAssertTrue(echo.ran)
    XCTAssertNil(step(echo, receipt: accepted, conversation: conversation([], .done), now: start + 120))
  }

  func testGivesUpOnAnAcceptedMessageWhoseRunNeverShows() throws {
    let echo = try XCTUnwrap(step(sending, receipt: accepted))
    XCTAssertNotNil(step(echo, receipt: accepted, now: start + SentEcho.patience))
    XCTAssertNil(step(echo, receipt: accepted, now: start + SentEcho.patience + 0.001))
  }

  func testIsDrawnOnlyInItsOwnAssistantsConversation() {
    var other = conversation()
    other.botId = "other"
    XCTAssertEqual(SentEcho.transcript(other, [sending]), other)
    XCTAssertEqual(step(sending, pending: request, sending: true, conversation: other), sending)
  }

  func testHandsTheComposerBackOnlyWhileTheSentCopyIsTheDraft() {
    let draft = Draft(text: "Hello there")
    XCTAssertTrue(SentEcho.sendingDraft(draft, pending: request, sending: true))
    XCTAssertFalse(SentEcho.sendingDraft(draft, pending: request, sending: false))
    XCTAssertFalse(SentEcho.sendingDraft(Draft(text: "Something new"), pending: request, sending: true))
  }

  func testRestoresARefusedMessageInFrontOfNewerTextOnce() {
    let file = FileRef(id: "f1", name: "a.png", mime: "image/png")
    var sent = request
    sent.attachments = [file]
    let typed = Draft(text: "Next", seq: 3)
    let restored = AppStore.draft(restoring: sent, into: typed)
    XCTAssertEqual(restored.text, "Hello there\n\nNext")
    XCTAssertEqual(restored.attachments, [file])
    XCTAssertEqual(restored.seq, 3)
    XCTAssertEqual(AppStore.draft(restoring: sent, into: restored), restored)
    let untouched = Draft(text: "Hello there", attachments: [file])
    XCTAssertEqual(AppStore.draft(restoring: sent, into: untouched), untouched)
  }

  func testLeavesWhenAnotherPersonSignsIn() throws {
    let kept = try XCTUnwrap(step(sending, receipt: accepted))
    XCTAssertNil(step(kept, sender: Sender(id: "two", name: "Two")))
    XCTAssertNil(step(kept, sender: .some(nil)))
  }

  func testKeepsAnAcceptedMessageThatIsNotSavedYetWhileAnotherIsSent() {
    var photo = request
    photo.requestId = "photo"; photo.text = ""; photo.attachments = [FileRef(id: "f1", name: "a.png", mime: "image/png")]
    var guidance = request
    guidance.requestId = "guide"; guidance.text = "Also check the gate"
    func accept(_ id: String) -> Receipt { Receipt(requestId: id, status: "accepted") }
    func steps(_ echoes: [SentEcho], pending: PendingSubmission? = nil, receipt: Receipt? = nil, sending: Bool = false,
      state: ActivityState = .working) -> [SentEcho]
    {
      SentEcho.nextEchoes(echoes, pending: pending, receipt: receipt, sending: sending,
        conversation: conversation([Message(id: "a", role: "assistant", text: "Hi")], state), sender: sender, now: start)
    }
    var echoes = steps([], pending: photo, sending: true)
    echoes = steps(echoes, receipt: accept("photo"))
    XCTAssertEqual(steps(echoes, receipt: accept("photo")), echoes)
    echoes = steps(echoes, pending: guidance, receipt: accept("photo"), sending: true)
    XCTAssertEqual(echoes.map(\.request.requestId), ["photo", "guide"])
    XCTAssertEqual(echoes.map(\.status), [.accepted, .sending])
    XCTAssertEqual(SentEcho.transcript(conversation([Message(id: "a", role: "assistant", text: "Hi")], .working), echoes)?.messages.map(\.id),
      ["a", "photo", "guide"])
    // Guidance refused: the photo stays; its run ends and its row is saved.
    echoes = steps(echoes, receipt: Receipt(requestId: "guide", status: "rejected"))
    XCTAssertEqual(echoes.map(\.request.requestId), ["photo"])
    XCTAssertEqual(steps(echoes, state: .done), [])
  }

  func testShowsTheSameWordsSentTwiceUntilHermesHasEach() throws {
    var first = try XCTUnwrap(step(nil, pending: request, sending: true))
    first.status = .accepted
    var second = first
    second.request.requestId = "req-2"
    let echoes = [first, second]
    let live = conversation([Message(id: "a", role: "assistant", text: "Hi")], .working)
    XCTAssertEqual(SentEcho.transcript(live, echoes)?.messages.map(\.id), ["a", "req", "req-2"])
  }

  func testAnchorsOnASavedMessageAndNeverMatchesWordsOnceItsAnchorIsGone() throws {
    let live = conversation([user("u0", "continue", from: sender), Message(id: "s-inflight", role: "assistant", text: "Working")], .working)
    var continued = request
    continued.text = "continue"
    var echo = try XCTUnwrap(step(nil, pending: continued, sending: true, conversation: live))
    XCTAssertEqual(echo.after, "u0", "A live reply's row is replaced as it is saved")
    echo.after = "gone"
    echo.status = .accepted
    XCTAssertNotNil(step(echo, receipt: Receipt(requestId: "req", status: "accepted"),
      conversation: conversation([user("u0", "continue", from: sender)], .working)))
  }
}
