import XCTest
@testable import AgentInterface

/// Regressions for the final cross-provider review of the merged iOS chat catch-up: the person's
/// message for Retry and recall, the desktop's control, opening a chat at a message, search, group
/// notices and refreshes, the send anchor and the desktop bridge.
@MainActor final class ReviewFixTests: XCTestCase {
  /// A server that holds the requests `holding` names until the test releases them, so responses
  /// can arrive in another order than their requests.
  final class HoldingHost: FakeHost, @unchecked Sendable {
    let origin = URL(string: "https://hold-\(UUID().uuidString.lowercased()).example.test")!
    private let lock = NSLock()
    private var seen: [(request: URLRequest, body: Data?)] = []
    private var held: [(exchange: FakeExchange, reply: FakeServer.Reply, key: String)] = []
    private let answer: @Sendable (URLRequest, Data?) -> FakeServer.Reply
    private let holding: @Sendable (URLRequest, Data?) -> String?
    init(answer: @escaping @Sendable (URLRequest, Data?) -> FakeServer.Reply, holding: @escaping @Sendable (URLRequest, Data?) -> String? = { _, _ in nil }) {
      self.answer = answer
      self.holding = holding
    }
    func receive(_ exchange: FakeExchange) {
      let body = FakeExchange.body(exchange.request)
      let reply = answer(exchange.request, body), key = holding(exchange.request, body)
      lock.withLock {
        seen.append((exchange.request, body))
        if let key { held.append((exchange, reply, key)) }
      }
      if key == nil { exchange.respond(status: reply.status, data: Data(reply.body.utf8)) }
    }
    func release(_ key: String) {
      let ready = lock.withLock { () -> [(exchange: FakeExchange, reply: FakeServer.Reply, key: String)] in
        let ready = held.filter { $0.key == key }
        held.removeAll { $0.key == key }
        return ready
      }
      for item in ready { item.exchange.respond(status: item.reply.status, data: Data(item.reply.body.utf8)) }
    }
    func heldCount(_ key: String) -> Int { lock.withLock { held.filter { $0.key == key }.count } }
    var requests: [URLRequest] { lock.withLock { seen.map(\.request) } }
    func bodies(path: String) -> [[String: Any]] {
      lock.withLock { seen.filter { $0.request.url?.path == path }.compactMap { $0.body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } } }
    }
    @MainActor func api() -> APIClient { FakeExchange.client(for: self) }
  }
  nonisolated static func json(_ object: Any) -> String {
    String(decoding: try! JSONSerialization.data(withJSONObject: object), as: UTF8.self)
  }

  private var stores: [AppStore] = []
  private var hosts: [HoldingHost] = []
  override func tearDown() async throws {
    for value in stores {
      value.suspend()
      if let scope = value.scope {
        for key in UserDefaults.standard.dictionaryRepresentation().keys where key.hasPrefix("native.\(scope).") { UserDefaults.standard.removeObject(forKey: key) }
      }
    }
    stores = []; hosts = []
    try await super.tearDown()
  }
  private func store(_ host: HoldingHost) throws -> AppStore {
    let value = AppStore(); value.api = host.api()
    value.bootstrap = try JSONDecoder().decode(Bootstrap.self, from: Data(#"""
      {"user":{"id":"review-\#(UUID().uuidString)","name":"Tester","email":"t@example.test"},"household":[],
       "preferences":{"presentation":"simple","theme":"system","favorites":[],"sections":[],"followBots":[]},
       "bots":[{"id":"bot","name":"Bot","model":"test","shared":true,"activity":"idle"}],
       "capabilities":{"chat":{"supported":true}},"connection":{"connected":true},"csrfToken":null}
      """#.utf8))
    stores.append(value); hosts.append(host)
    return value
  }

  // MARK: 1. The person's message

  func testRetryAndRecallTakeAMessageWhoseOriginIsExplicitlyHuman() throws {
    let human = MessageOrigin(kind: "human", visibility: "conversation")
    let older = Message(id: "older", role: "user", text: "Older prompt")
    let explicit = Message(id: "explicit", role: "user", text: "Is the gate closed?", origin: human)
    func conversation(_ messages: [Message]) -> Conversation {
      Conversation(botId: "bot", messages: messages, activity: Activity(state: .failed), approvals: [], files: [])
    }
    XCTAssertTrue(explicit.isHumanMessage)
    XCTAssertEqual(RetryTurn.target(conversation([explicit]))?.id, "explicit", "The only prompt is explicitly human")
    XCTAssertEqual(RetryTurn.target(conversation([older, explicit]))?.id, "explicit", "Never the older prompt before it")
    let activity = Message(id: "a", role: "user", text: "Subagent done", origin: MessageOrigin(kind: "human", visibility: "activity"))
    XCTAssertFalse(activity.isHumanMessage, "Activity never counts")
    XCTAssertEqual(RetryTurn.target(conversation([explicit, activity]))?.id, "explicit")
    XCTAssertNil(RetryTurn.target(conversation([explicit, Message(id: "live-inflight", role: "user", text: "Live")])),
      "An unsaved live row is never retried, nor does an older message stand in for it")
    let scheduled = Message(id: "s", role: "user", text: "Report", origin: MessageOrigin(kind: "scheduled", visibility: "conversation"))
    XCTAssertFalse(scheduled.isHumanMessage)
    XCTAssertEqual(PromptRecall.ownMessages([older, explicit, scheduled], userId: "me"), ["Is the gate closed?", "Older prompt"],
      "Recall uses the same rule")
  }

  // MARK: 2 and 3. The desktop's control

  private final class Desktop: @unchecked Sendable {
    let lock = NSLock()
    var owner = #"{"kind":"bot","name":"Ranch"}"#
  }
  private func desktopHost(_ desktop: Desktop, hold: @escaping @Sendable (String) -> Bool) -> HoldingHost {
    HoldingHost(answer: { request, body in
      desktop.lock.withLock {
        let action = body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }?["action"] as? String
        if request.url?.path == "/api/computer/control" {
          desktop.owner = action == "take" ? #"{"kind":"human","mine":true,"name":"Tester"}"# : #"{"kind":"idle"}"#
        }
        return .init(body: #"{"available":true,"control":\#(desktop.owner)}"#)
      }
    }, holding: { request, body in
      let action = body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }?["action"] as? String
      let key = request.url?.path == "/api/computer" ? "status" : action ?? ""
      return hold(key) ? key : nil
    })
  }

  func testAStatusReadFromBeforeATakeoverCannotUndoIt() async throws {
    let desktop = Desktop()
    let host = desktopHost(desktop) { $0 == "status" }
    let value = try store(host)
    let read = Task { await value.refreshComputer() }
    try await until { host.heldCount("status") == 1 }
    let control = DesktopControl()
    await control.take(value, viewerId: "viewer-1")
    XCTAssertTrue(control.held)
    XCTAssertTrue(DesktopLink.controlling(value.computerStatus))
    // The read saw the assistant's control before the takeover; it lands after it.
    host.release("status")
    await read.value
    XCTAssertTrue(DesktopLink.controlling(value.computerStatus), "An older read never replaces the takeover's status")
    control.statusChanged(value.computerStatus)
    XCTAssertTrue(control.held, "So the screen keeps control and offers Hand back")
    await value.refreshComputer()
    XCTAssertTrue(DesktopLink.controlling(value.computerStatus), "A read started after it applies as usual")
  }

  func testLeavingDuringATakeoverHandsTheDesktopBackOnceItLands() async throws {
    let desktop = Desktop()
    let host = desktopHost(desktop) { $0 == "take" }
    let value = try store(host)
    let control = DesktopControl()
    let take = Task { await control.take(value, viewerId: "viewer-1") }
    try await until { host.heldCount("take") == 1 }
    // The screen closes while the takeover is on its way, with that viewer's identity.
    let leave = Task { await control.leave(value, viewerId: "viewer-1") }
    host.release("take")
    await take.value
    await leave.value
    let releases = host.bodies(path: "/api/computer/control").filter { $0["action"] as? String == "release" }
    XCTAssertEqual(releases.count, 1, "The late takeover is handed back")
    XCTAssertEqual(releases.first?["viewerId"] as? String, "viewer-1")
    XCTAssertFalse(control.held)
    XCTAssertFalse(DesktopLink.controlling(value.computerStatus))
  }

  func testLeavingHandsBackWhatTheServerConfirmedEvenAfterTheViewWentToWatching() async throws {
    let desktop = Desktop()
    let host = desktopHost(desktop) { _ in false }
    let value = try store(host)
    let control = DesktopControl()
    await control.take(value, viewerId: "viewer-1")
    XCTAssertTrue(control.held)
    // A dropped connection puts the viewer in watch mode, which says nothing of the server's lease.
    await control.leave(value, viewerId: "viewer-1")
    XCTAssertEqual(host.bodies(path: "/api/computer/control").map { $0["action"] as? String }, ["take", "release"])
    // Nothing held, nothing to hand back.
    let idle = DesktopControl()
    await idle.leave(value, viewerId: "viewer-2")
    XCTAssertEqual(host.bodies(path: "/api/computer/control").count, 2)
  }

  // MARK: 4. Opening a chat at a message

  private final class History: @unchecked Sendable {
    let lock = NSLock()
    let messages: [[String: Any]] = (1...6).map { ["id": "m\($0)", "role": $0 % 2 == 1 ? "user" : "assistant", "text": "Message \($0)"] }
  }
  private func historyHost(hold: String?) -> HoldingHost {
    let history = History()
    return HoldingHost(answer: { request, _ in
      guard request.url?.path == "/api/bots/bot/conversation" else { return .init() }
      let start = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "start" }?.value
      let messages = history.messages
      let from = start.flatMap { id in messages.firstIndex { $0["id"] as? String == id } } ?? messages.count - 2
      return .init(body: Self.json(["botId": "bot", "sessionId": "session", "messages": Array(messages[from...]), "earlier": from,
        "activity": ["state": "idle"], "approvals": [], "files": [], "draft": ["text": "", "attachments": [], "revision": 1]]))
    }, holding: { request, _ in
      let start = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "start" }?.value
      return start != nil && start == hold ? start : nil
    })
  }
  private func openStore(_ host: HoldingHost) async throws -> AppStore {
    let value = try store(host)
    value.selectedBotId = "bot"
    await value.refreshConversation()
    XCTAssertEqual(value.conversation?.messages.map(\.id), ["m5", "m6"])
    return value
  }
  private func lastStart(_ host: HoldingHost) -> String? {
    host.requests.last { $0.url?.path == "/api/bots/bot/conversation" }?.url?.query
  }

  func testAnOvertakenOpenAtMessageChangesNeitherTheWindowNorTheFocus() async throws {
    let host = historyHost(hold: "m3")
    let value = try await openStore(host)
    let older = Task { await value.openConversation(botId: "bot", atMessage: "m3") }
    try await until { host.heldCount("m3") == 1 }
    await value.openConversation(botId: "bot", atMessage: "m2")
    XCTAssertEqual(value.focusedMessage?.messageId, "m2")
    // The older request answers last, with a window that holds both messages.
    host.release("m3")
    await older.value
    XCTAssertEqual(value.focusedMessage?.messageId, "m2", "The obsolete selection never takes the focus back")
    XCTAssertEqual(value.conversation?.messages.first?.id, "m2")
    await value.refreshConversation()
    XCTAssertEqual(lastStart(host), "start=m2", "Polls keep the newer window")
  }

  func testAFindStepToALoadedMessageMakesAPendingOpenObsolete() async throws {
    let host = historyHost(hold: "m3")
    let value = try await openStore(host)
    let pending = Task { await value.openConversation(botId: "bot", atMessage: "m3") }
    try await until { host.heldCount("m3") == 1 }
    value.cancelOpeningAtMessage()
    host.release("m3")
    await pending.value
    XCTAssertNil(value.focusedMessage)
    XCTAssertEqual(value.conversation?.messages.map(\.id), ["m5", "m6"], "The window it asked for is dropped")
    await value.refreshConversation()
    XCTAssertEqual(lastStart(host), "start=m5")
  }

  // MARK: 5. Search

  func testASubmittedSearchOvertakenByTypingNeverReplacesTheShownQuery() {
    var requests = SearchRequests()
    // "gate" is shown. "hay" is submitted, then the person types "gate" back before it answers.
    let hay = requests.start()
    requests.queryChanged()
    XCTAssertFalse(requests.applies(hay, asked: "hay", query: "gate"), "The hay answer is stale under the gate query")
    XCTAssertFalse(requests.applies(hay, asked: "hay", query: "hay"), "Stale even if the query came back to hay")
    let gate = requests.start()
    XCTAssertTrue(requests.applies(gate, asked: "gate", query: " gate "))
    XCTAssertFalse(requests.applies(gate, asked: "gate", query: "gat"), "Only for the query it was asked for")
  }

  // MARK: 6. Group refreshes

  @MainActor private final class Gate {
    private var waiting: [CheckedContinuation<Void, Never>] = []
    var count: Int { waiting.count }
    func wait() async { await withCheckedContinuation { waiting.append($0) } }
    func open() { let all = waiting; waiting = []; all.forEach { $0.resume() } }
  }
  func testOverlappingRoomRefreshesRunOneAtATimeAndFoldTogether() async throws {
    let refresh = SerialRefresh(), gate = Gate()
    var running = 0, peak = 0, runs = 0
    let work = {
      runs += 1; running += 1; peak = max(peak, running)
      await gate.wait()
      running -= 1
    }
    let first = Task { await refresh.run(work) }
    try await until { gate.count == 1 }
    // A notice, the fallback poll and an action all ask while the first load runs.
    await refresh.run(work); await refresh.run(work); await refresh.run(work)
    XCTAssertEqual(runs, 1)
    gate.open()
    try await until { gate.count == 1 }
    XCTAssertEqual(runs, 2, "The three requests become one more load")
    gate.open()
    await first.value
    XCTAssertEqual(runs, 2); XCTAssertEqual(peak, 1, "Loads never overlap")
  }

  // MARK: Send anchor

  func testTheSendAnchorFollowsTheReceiptNotAnotherMembersNewerMessage() {
    let mine = Message(id: "canonical", role: "user", text: "Check the gate", sender: Sender(id: "me", name: "Me"))
    let theirs = Message(id: "theirs", role: "user", text: "Feed the hens", sender: Sender(id: "kim", name: "Kim"))
    XCTAssertEqual(SendAnchor.resolve([mine, Message(id: "req", role: "user", text: "Check the gate")], requestId: "req", messageId: nil,
      text: "Check the gate", senderId: "me"), "req", "The echo first")
    XCTAssertEqual(SendAnchor.resolve([mine, theirs], requestId: "req", messageId: "canonical", text: "Check the gate", senderId: "me"),
      "canonical", "Then the copy the receipt names")
    XCTAssertNil(SendAnchor.resolve([theirs], requestId: "req", messageId: "canonical", text: "Check the gate", senderId: "me"),
      "A named copy not loaded yet is waited for")
    XCTAssertEqual(SendAnchor.resolve([mine, theirs], requestId: "req", messageId: nil, text: "Check the gate", senderId: "me"), "canonical",
      "Without a receipt, this person's message with the sent words, never another member's newer one")
    XCTAssertNil(SendAnchor.resolve([theirs], requestId: "req", messageId: nil, text: "Check the gate", senderId: "me"))
  }

  // MARK: Desktop bridge

  func testBridgeMessagesComeOnlyFromTheViewerPage() {
    let base = URL(string: "https://agentui.example.test")!
    let page = URL(string: "https://agentui.example.test/native/computer#path=x")
    XCTAssertTrue(DesktopLink.trusts(scheme: "https", host: "agentui.example.test", port: 0, page: page, base: base))
    XCTAssertFalse(DesktopLink.trusts(scheme: "https", host: "evil.example.test", port: 0, page: page, base: base))
    XCTAssertFalse(DesktopLink.trusts(scheme: "http", host: "agentui.example.test", port: 0, page: page, base: base))
    XCTAssertFalse(DesktopLink.trusts(scheme: "https", host: "agentui.example.test", port: 8443, page: page, base: base))
    XCTAssertFalse(DesktopLink.trusts(scheme: "https", host: "agentui.example.test", port: 0,
      page: URL(string: "https://agentui.example.test/settings"), base: base), "Another page on the server")
    XCTAssertFalse(DesktopLink.trusts(scheme: "https", host: "agentui.example.test", port: 0, page: URL(string: "about:blank"), base: base))
    XCTAssertFalse(DesktopLink.trusts(scheme: "https", host: "agentui.example.test", port: 0, page: nil, base: base))
    let local = URL(string: "http://localhost:3000")!
    XCTAssertTrue(DesktopLink.trusts(scheme: "http", host: "localhost", port: 3000, page: URL(string: "http://localhost:3000/native/computer"), base: local))
  }
}
