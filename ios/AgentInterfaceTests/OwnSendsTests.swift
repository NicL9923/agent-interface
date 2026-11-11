import XCTest
@testable import AgentInterface

/// The person's own sends, kept after their echo leaves, ported from the web's tests/sent-echo.test.ts
/// ("the person's own sends, kept after their echo leaves") and its row labels in src/app/Conversation.tsx.
final class OwnSendsTests: XCTestCase {
  private let sender = Sender(id: "one", name: "One")
  private let kim = Sender(id: "two", name: "Two")
  private let start = Date(timeIntervalSince1970: 1)
  private let hi = Message(id: "a", role: "assistant", text: "Hi")
  private func request(_ words: String, id: String = "req") -> PendingSubmission {
    PendingSubmission(requestId: id, botId: "bot", text: words, attachments: [], reviewedInterruption: false)
  }
  private func conversation(_ messages: [Message], _ state: ActivityState = .idle, bot: String = "bot") -> Conversation {
    Conversation(botId: bot, messages: messages, activity: Activity(state: state), approvals: [], files: [])
  }
  private func user(_ id: String, _ text: String, from sender: Sender? = nil) -> Message { Message(id: id, role: "user", text: text, sender: sender) }
  private func accept(_ id: String = "req") -> Receipt { Receipt(requestId: id, status: "accepted", messageId: "row-9") }
  /// The echo of a send still on its way, anchored on the assistant's message.
  private func sending(_ words: String, id: String = "req", conversation: Conversation? = nil) -> SentEcho {
    SentEcho.next(nil, pending: request(words, id: id), receipt: nil, sending: true, conversation: conversation ?? self.conversation([hi]),
      sender: sender, now: start)!
  }
  /// The send as the app records it when Hermes accepts it.
  private func recorded(_ words: String, id: String = "req", receipt: Receipt? = nil, sends: [OwnSend] = []) -> [OwnSend] {
    let echo = sending(words, id: id)
    return SentEcho.nextSends(sends, before: [echo], after: [echo], receipt: receipt ?? accept(id), sender: sender, conversation: nil)
  }
  private func claimed(_ sends: [OwnSend], _ messages: [Message], bot: String = "bot") -> [String] {
    let rows = SentEcho.ownRows(sends, in: conversation(messages, bot: bot))
    return messages.map(\.id).filter(rows.contains)
  }

  func testRecordsASendWhenHermesAcceptsItFromTheEchoItHadUntilThen() {
    XCTAssertEqual(recorded("Avoid flights"),
      [OwnSend(requestId: "req", messageId: "row-9", botId: "bot", senderId: "one", text: "Avoid flights", after: "a")])
  }

  func testRecordsNothingForASendThatWasRefusedEndedWithoutAReceiptOrAnotherRequestsReceipt() {
    let echo = sending("Avoid flights")
    for (name, receipt) in [("refused", Receipt(requestId: "req", status: "rejected")), ("interrupted", Receipt(requestId: "req", status: "interrupted")),
      ("another request's", accept("older"))] as [(String, Receipt?)] + [("none", nil)]
    {
      XCTAssertEqual(SentEcho.nextSends([], before: [echo], after: [echo], receipt: receipt, sender: sender, conversation: nil), [], name)
    }
  }

  func testRecordsASendOnceAndForgetsTheLastPersonsOnSignOutOrAnotherSignIn() {
    let sends = recorded("Avoid flights")
    let echo = sending("Avoid flights")
    XCTAssertEqual(SentEcho.nextSends(sends, before: [echo], after: [echo], receipt: accept(), sender: sender, conversation: nil), sends)
    XCTAssertEqual(SentEcho.nextSends(sends, before: [], after: [], receipt: nil, sender: sender, conversation: nil), sends)
    XCTAssertEqual(SentEcho.nextSends(sends, before: [], after: [], receipt: nil, sender: kim, conversation: nil), [])
    XCTAssertEqual(SentEcho.nextSends(sends, before: [], after: [], receipt: nil, sender: nil, conversation: nil), [])
  }

  func testKeepsAChatsNewestTwentySendsAndLeavesAnotherChatsAlone() {
    var sends = recorded("elsewhere", id: "other-chat")
    sends[0].botId = "other"
    for index in 0...SentEcho.ownSendsKept { sends = recorded("send \(index)", id: "req-\(index)", sends: sends) }
    XCTAssertEqual(sends.count, SentEcho.ownSendsKept + 1)
    XCTAssertEqual(sends.map(\.requestId), ["other-chat"] + (1...SentEcho.ownSendsKept).map { "req-\($0)" },
      "The oldest of the chat is dropped, never the other chat's")
  }

  func testClaimsTheNoSenderRowThatCopiesASteerAfterItsAnchorMatchingTrimmedWords() {
    let sends = recorded("Avoid flights")
    XCTAssertEqual(claimed(sends, [hi, user("steer", "  Avoid flights \n")]), ["steer"])
  }

  func testClaimsOneRowForEachSendSoAnotherMembersSameWordsStayUnclaimed() {
    let sends = recorded("Avoid flights")
    let rows = [hi, user("mine", "Avoid flights"), user("theirs", "Avoid flights")]
    XCTAssertEqual(claimed(sends, rows), ["mine"])
    XCTAssertEqual(claimed(recorded("Avoid flights", id: "req-2", sends: sends), rows), ["mine", "theirs"], "Sent twice, each claims its own")
  }

  func testDoesNotClaimARowSavedBeforeTheSendNorAnyRowOnceTheAnchorIsGone() {
    let sends = recorded("Avoid flights")
    XCTAssertEqual(claimed(sends, [user("older", "Avoid flights"), hi]), [])
    XCTAssertEqual(claimed(sends, [user("elsewhere", "Avoid flights")]), [])
  }

  func testARowHermesNamedForTheSendOrBoundToThePersonTakesTheClaimBeforeANoSenderRow() {
    let sends = recorded("Avoid flights")
    XCTAssertEqual(claimed(sends, [hi, user("bound", "Avoid flights", from: sender), user("native", "Avoid flights")]), ["bound"])
    XCTAssertEqual(claimed(sends, [hi, user("native", "Avoid flights"), user("row-9", "Avoid flights, please", from: sender)]), ["row-9"])
  }

  func testSkipsARowAnotherMemberSentAndASendOfAnotherChatOrWithoutWords() {
    let sends = recorded("Avoid flights")
    XCTAssertEqual(claimed(sends, [hi, user("theirs", "Avoid flights", from: kim)]), [])
    XCTAssertEqual(claimed(sends, [hi, user("x", "Avoid flights")], bot: "other"), [])
    XCTAssertEqual(SentEcho.ownRows(sends, in: nil), [])
    XCTAssertEqual(claimed(recorded("   ", id: "photo"), [hi, user("blank", "")]), [])
  }

  func testASendRestoredBeforeTheChatWasReadClaimsOnlyARowHermesNamedForIt() {
    // The app relaunches while the outcome is unknown: the pending send comes back while the conversation
    // is still nil, so its echo has no anchor, and Hermes then queues it under no row ID.
    let echo = SentEcho.next(nil, pending: request("Thanks"), receipt: nil, sending: true, conversation: nil, sender: sender, now: start)!
    XCTAssertNil(echo.after)
    var queued = Receipt(requestId: "req", status: "accepted")
    var sends = SentEcho.nextSends([], before: [echo], after: [echo], receipt: queued, sender: sender, conversation: nil)
    XCTAssertEqual(claimed(sends, [hi, user("older", "Thanks"), user("queued", "Thanks")]), [], "An older member's same words keep their label")
    queued.messageId = "row-9"
    sends = SentEcho.nextSends([], before: [echo], after: [echo], receipt: queued, sender: sender, conversation: nil)
    XCTAssertEqual(claimed(sends, [hi, user("older", "Thanks"), user("row-9", "Thanks, then")]), ["row-9"])
  }

  // MARK: A send Hermes never saves under its own words ends with its echo.

  /// Both lists after a change, together so a send ends in the same step as its echo, as `AppStore.updateEcho` does.
  private struct State: Equatable { var echoes: [SentEcho] = []; var sends: [OwnSend] = [] }
  private func advance(_ state: State, pending: PendingSubmission? = nil, receipt: Receipt? = nil, sending: Bool = false,
    conversation: Conversation, now: Date? = nil) -> State
  {
    let echoes = SentEcho.nextEchoes(state.echoes, pending: pending, receipt: receipt, sending: sending, conversation: conversation,
      sender: sender, now: now ?? start)
    return State(echoes: echoes, sends: SentEcho.nextSends(state.sends, before: state.echoes, after: echoes, receipt: receipt, sender: sender,
      conversation: conversation))
  }
  private func afterJoined(_ rows: [Message], steers: [String] = ["Avoid flights", "Use trains"]) -> State {
    let working = conversation([hi], .working)
    var state = State()
    for (index, words) in steers.enumerated() {
      let id = "steer-\(index)"
      state = advance(state, pending: request(words, id: id), sending: true, conversation: working)
      state = advance(state, receipt: Receipt(requestId: id, status: "accepted", steered: true), conversation: working)
    }
    XCTAssertEqual(state.sends.count, steers.count)
    state = advance(state, conversation: working, now: start + 1)
    return advance(state, conversation: conversation([hi] + rows, .done), now: start + 2)
  }

  func testARecordEndsWithItsEchoSoItCannotClaimAnotherMembersIdenticalWordsLater() {
    // Hermes wrote both steers as one row, so neither echo finds its copy and both leave when the work ends.
    let state = afterJoined([user("joined", "Avoid flights\nUse trains")])
    XCTAssertEqual(state.echoes, [])
    XCTAssertEqual(state.sends, [])
    XCTAssertEqual(claimed(state.sends, [hi, user("joined", "Avoid flights\nUse trains"), user("theirs", "Avoid flights")]), [])
  }

  func testARecordWhoseCopyIsShownStaysAndOneWhoseEchoStillWaitsOnALongQueueStays() {
    let copied = afterJoined([user("mine", "Avoid flights"), user("joined", "Use trains")])
    XCTAssertEqual(copied.sends.map(\.requestId), ["steer-0", "steer-1"])
    XCTAssertEqual(afterJoined([], steers: ["Avoid flights"]).sends, [])
    // Still working long after: the echo, and so the record, wait for the queue however long it is.
    let working = conversation([hi], .working)
    var state = advance(State(), pending: request("Avoid flights"), sending: true, conversation: working)
    state = advance(state, receipt: Receipt(requestId: "req", status: "accepted"), conversation: working)
    state = advance(state, conversation: working, now: start + 600)
    XCTAssertEqual(state.sends.count, 1)
  }

  func testARecordIsLeftAloneWhileAnotherChatIsOpen() {
    let sends = recorded("Avoid flights")
    let echo = sending("Avoid flights")
    XCTAssertEqual(SentEcho.nextSends(sends, before: [echo], after: [], receipt: nil, sender: sender, conversation: conversation([hi], bot: "other")), sends)
    XCTAssertEqual(SentEcho.nextSends(sends, before: [echo], after: [], receipt: nil, sender: sender, conversation: nil), sends)
    XCTAssertEqual(SentEcho.nextSends(sends, before: [echo], after: [], receipt: nil, sender: sender, conversation: conversation([hi])), [])
  }

  func testTheEchoStillMatchesACopyTheSameWayAfterSharingItsRule() {
    // `shown(in:)` and the record share one matcher: a named row, or words after the anchor from no one else.
    var echo = sending("Avoid flights")
    XCTAssertFalse(echo.shown(in: conversation([hi, user("x", "Avoid flights")])), "Words count only once Hermes accepted it")
    XCTAssertTrue(echo.shown(in: conversation([hi, user("req", "")])), "A row named by the request ID counts at any time")
    echo.status = .accepted
    XCTAssertTrue(echo.shown(in: conversation([hi, user("x", "Avoid flights")])))
    XCTAssertFalse(echo.shown(in: conversation([hi, user("x", "Avoid flights", from: kim)])))
    XCTAssertFalse(echo.shown(in: conversation([user("x", "Avoid flights"), hi])))
  }

  // MARK: The label above a person's message

  private func label(_ message: Message, shared: Bool = true, own: Set<String> = [], userId: String? = "one") -> String {
    MessageView.label(for: message, userId: userId, sharedChat: shared, ownRows: own)
  }

  func testANoSenderRowInASharedChatIsLabeledAHouseholdMemberUnlessItIsThePersonsOwnSend() {
    let native = user("native", "Hello")
    XCTAssertEqual(label(native), "Household member")
    XCTAssertEqual(label(native, own: ["native"]), "", "A steer or queued send of this person's own, saved without a sender")
    XCTAssertEqual(label(native, own: ["another-row"]), "Household member")
    XCTAssertEqual(label(native, shared: false), "", "In a private chat they are the only member")
  }

  func testARowWithASenderKeepsItsOldLabelWhateverTheChat() {
    for shared in [true, false] {
      XCTAssertEqual(label(user("mine", "Hi", from: sender), shared: shared), "")
      XCTAssertEqual(label(user("theirs", "Hi", from: kim), shared: shared), "Two")
      XCTAssertEqual(label(user("mine", "Hi", from: sender), shared: shared, own: ["mine"], userId: "two"), "One", "Signed in as another member")
    }
  }

  func testOnlyAPrivateAssistantWithAnOwnerIsNotSharedWithOtherMembers() {
    func bot(shared: Bool, ownerId: String?) -> Bot {
      try! JSONDecoder().decode(Bot.self, from: Data(#"{"id":"b","name":"B","model":"m","shared":\#(shared),"ownerId":\#(ownerId.map { "\"\($0)\"" } ?? "null"),"activity":"idle"}"#.utf8))
    }
    XCTAssertFalse(bot(shared: false, ownerId: "one").othersCanWrite)
    XCTAssertTrue(bot(shared: true, ownerId: nil).othersCanWrite)
    XCTAssertTrue(bot(shared: true, ownerId: "one").othersCanWrite)
    XCTAssertTrue(bot(shared: false, ownerId: nil).othersCanWrite, "Visible to the household, so anyone may write")
  }
}
