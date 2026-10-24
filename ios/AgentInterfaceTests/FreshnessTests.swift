import Foundation
import XCTest

@testable import AgentInterface

/// Home's unread marks, sign-in renewal, poll errors that clear themselves, and what a streamed
/// reply patch renders.
@MainActor final class FreshnessTests: XCTestCase {
  /// Answers each route from a table the test changes as it goes.
  private final class Routes: @unchecked Sendable {
    private let lock = NSLock()
    private var table: [String: FakeServer.Reply] = [:]
    subscript(path path: String) -> FakeServer.Reply? {
      get { lock.withLock { table[path] } }
      set { lock.withLock { table[path] = newValue } }
    }
  }
  private static func json(_ object: Any) -> String {
    String(decoding: try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]), as: UTF8.self)
  }
  private static func bot(unread: Bool?, at: String?) -> [String: Any] {
    var bot: [String: Any] = ["id": "bot", "name": "Bot", "model": "test", "shared": true, "activity": "idle"]
    if let unread { bot["unread"] = unread }
    if let at { bot["lastMessage"] = ["text": "Feed the horses", "at": at] }
    return bot
  }
  private static func bootstrap(user: String = "one", bots: [[String: Any]]) -> String {
    json([
      "user": ["id": user, "name": user, "email": "\(user)@example.test"], "household": [],
      "preferences": ["presentation": "simple", "theme": "system", "favorites": [], "sections": [], "followBots": []],
      "bots": bots, "capabilities": ["chat": ["supported": true]], "connection": ["connected": true],
    ])
  }
  private static func conversation(state: String = "idle", reply: String? = nil) -> String {
    var messages: [[String: Any]] = []
    if let reply { messages.append(["id": "s-inflight", "role": "assistant", "text": reply]) }
    return json([
      "botId": "bot", "messages": messages, "activity": ["state": state, "runId": "run"], "approvals": [],
      "files": [], "draft": ["text": "", "attachments": []],
    ])
  }
  private func decode<T: Decodable>(_ text: String) throws -> T { try JSONDecoder().decode(T.self, from: Data(text.utf8)) }
  private func store(_ server: FakeServer) -> AppStore {
    let value = AppStore()
    value.widgetSnapshotURL = nil
    value.api = server.api()
    return value
  }
  private func clean(_ server: FakeServer, _ store: AppStore) {
    store.suspend()
    if let api = store.api { UserDefaults.standard.removeObject(forKey: DeviceDefaults.expiry(api.baseURL)) }
    for key in UserDefaults.standard.dictionaryRepresentation().keys where key.hasPrefix("native.\(store.scope ?? "-").") {
      UserDefaults.standard.removeObject(forKey: key)
    }
    FakeExchange.remove(host: server.origin.host!)
  }

  // MARK: Unread

  func testUnreadFollowsTheServerExceptForChatsReadHere() throws {
    let server = FakeServer(), value = store(server)
    defer { clean(server, value) }
    value.bootstrap = try decode(Self.bootstrap(bots: [Self.bot(unread: true, at: "2026-10-20T10:00:00Z")]))
    let bot = { value.bootstrap!.bots[0] }
    XCTAssertTrue(value.unread(bot()))
    value.selectedBotId = "bot"
    value.conversationShown("bot", true)
    XCTAssertFalse(value.unread(bot()), "The chat on screen is never unread")
    value.conversationShown("bot", false)
    XCTAssertFalse(value.unread(bot()), "Leaving reads it, before the server has caught up")
    value.bootstrap = try decode(Self.bootstrap(bots: [Self.bot(unread: true, at: "2026-10-20T10:00:00Z")]))
    XCTAssertFalse(value.unread(bot()), "A roster still behind on the read does not bring the mark back")
    value.bootstrap = try decode(Self.bootstrap(bots: [Self.bot(unread: true, at: "2026-10-20T11:00:00Z")]))
    XCTAssertTrue(value.unread(bot()), "A newer reply is unread again")
    value.bootstrap = try decode(Self.bootstrap(bots: [Self.bot(unread: false, at: "2026-10-20T11:00:00Z")]))
    XCTAssertFalse(value.unread(bot()))
    value.bootstrap = try decode(Self.bootstrap(bots: [Self.bot(unread: nil, at: nil)]))
    XCTAssertFalse(value.unread(bot()), "An older server without the field shows nothing")
  }

  func testAChatReadByOneAccountIsNotReadForTheNext() throws {
    let at = "2026-10-20T10:00:00Z"
    var chats = UnreadChats()
    let bot = try XCTUnwrap((try decode(Self.bootstrap(bots: [Self.bot(unread: true, at: at)])) as Bootstrap).bots.first)
    chats.keep([bot], user: "one")
    chats.read(bot)
    XCTAssertFalse(chats.unread(bot, open: nil))
    chats.keep([bot], user: "one")
    XCTAssertFalse(chats.unread(bot, open: nil))
    chats.keep([bot], user: "two")
    XCTAssertTrue(chats.unread(bot, open: nil))
    chats.read(bot)
    chats.keep([], user: "two")
    XCTAssertTrue(chats.unread(bot, open: nil), "An assistant that left the roster is forgotten")
  }

  // MARK: Sign-in renewal

  func testRenewalIsDueInTheLastTwoDaysAtMostHourly() {
    let now = Date(timeIntervalSinceReferenceDate: 800_000_000)
    let day: TimeInterval = 24 * 3600
    func due(_ left: TimeInterval?, attempted ago: TimeInterval? = nil) -> Bool {
      SignInRenewal.due(
        expiresAt: left.map { now.addingTimeInterval($0) }, lastAttempt: ago.map { now.addingTimeInterval(-$0) }, now: now)
    }
    XCTAssertFalse(due(nil), "A sign-in without a known expiry is left alone")
    XCTAssertFalse(due(3 * day))
    XCTAssertTrue(due(1.9 * day))
    XCTAssertTrue(due(30), "A sign-in about to lapse still renews before polling stops")
    XCTAssertFalse(due(-30), "An expired one cannot renew")
    XCTAssertFalse(due(day, attempted: 1800))
    XCTAssertTrue(due(day, attempted: 3600))
    XCTAssertTrue(due(day, attempted: -3 * 3600), "A clock set back does not stall renewal")
  }

  func testAPollRenewsAnExpiringSignInOncePerHourAndKeepsPolling() async throws {
    let routes = Routes()
    let renewed = ISO8601DateFormatter().string(from: Date().addingTimeInterval(7 * 24 * 3600))
    routes[path: "/api/auth/native/renew"] = .init(body: Self.json(["expiresAt": renewed]))
    routes[path: "/api/bootstrap"] = .init(body: Self.bootstrap(bots: []))
    let server = FakeServer { routes[path: $0.url!.path] ?? .init() }
    let value = store(server)
    defer { clean(server, value) }
    let key = DeviceDefaults.expiry(server.origin)
    UserDefaults.standard.set(ISO8601DateFormatter().string(from: Date().addingTimeInterval(30)), forKey: key)
    let renewals = { server.requests.filter { $0.url?.path == "/api/auth/native/renew" } }
    let continues = await value.pollOnce()
    XCTAssertTrue(continues, "Before renewal a sign-in this close to expiry stopped polling")
    XCTAssertFalse(value.sessionExpired)
    XCTAssertEqual(UserDefaults.standard.string(forKey: key), renewed)
    XCTAssertEqual(renewals().count, 1)
    XCTAssertEqual(renewals().first?.httpMethod, "POST")
    XCTAssertEqual(renewals().first?.value(forHTTPHeaderField: "Authorization"), "Bearer synthetic-session-token")
    // Still inside the window, as when the server's 90-day cap returns the same expiry.
    UserDefaults.standard.set(ISO8601DateFormatter().string(from: Date().addingTimeInterval(24 * 3600)), forKey: key)
    await value.renewSignInIfDue()
    XCTAssertEqual(renewals().count, 1, "Not again within the hour")
    value.date = { Date().addingTimeInterval(3601) }
    await value.renewSignInIfDue()
    XCTAssertEqual(renewals().count, 2)
  }

  func testARenewalFailureStaysQuietButA401SignsOut() async throws {
    let routes = Routes()
    routes[path: "/api/auth/native/renew"] = .init(status: 503, body: Self.json(["error": "Synthetic outage"]))
    let server = FakeServer { routes[path: $0.url!.path] ?? .init() }
    let value = store(server)
    defer { clean(server, value) }
    UserDefaults.standard.set(
      ISO8601DateFormatter().string(from: Date().addingTimeInterval(24 * 3600)), forKey: DeviceDefaults.expiry(server.origin))
    await value.renewSignInIfDue()
    XCTAssertNil(value.error)
    XCTAssertEqual(value.api?.token, "synthetic-session-token")
    routes[path: "/api/auth/native/renew"] = .init(status: 401, body: Self.json(["error": "Sign in required"]))
    value.date = { Date().addingTimeInterval(3601) }
    await value.renewSignInIfDue()
    XCTAssertTrue(value.sessionExpired)
    XCTAssertNil(value.api?.token)
  }

  // MARK: Poll errors

  func testAPollErrorClearsWhenThatReadWorksAgainAndStaysDismissed() async throws {
    let routes = Routes()
    let outage = FakeServer.Reply(status: 503, body: Self.json(["error": "Synthetic outage"]))
    let healthy = FakeServer.Reply(body: Self.bootstrap(bots: []))
    routes[path: "/api/bootstrap"] = outage
    let server = FakeServer { routes[path: $0.url!.path] ?? .init() }
    let value = store(server)
    defer { clean(server, value) }
    await value.refreshBootstrap()
    XCTAssertEqual(value.error, "Synthetic outage")
    XCTAssertEqual(value.connectionError, .roster)
    routes[path: "/api/bootstrap"] = healthy
    await value.refreshBootstrap()
    XCTAssertNil(value.error, "Before this a later success left the outage on screen")
    // Dismissed during an outage, it stays dismissed through the next failures.
    routes[path: "/api/bootstrap"] = outage
    await value.refreshBootstrap()
    value.dismissError()
    await value.refreshBootstrap()
    XCTAssertNil(value.error, "Before this the next failed poll put it right back")
    routes[path: "/api/bootstrap"] = healthy
    await value.refreshBootstrap()
    routes[path: "/api/bootstrap"] = outage
    await value.refreshBootstrap()
    XCTAssertEqual(value.error, "Synthetic outage", "A new outage shows again")
  }

  func testAFailedActionKeepsItsErrorThroughSuccessfulPolls() async throws {
    let server = FakeServer { _ in .init(body: Self.bootstrap(bots: [])) }
    let value = store(server)
    defer { clean(server, value) }
    value.report(APIError(message: "Hermes did not accept this message.", status: 400))
    XCTAssertNil(value.connectionError)
    await value.refreshBootstrap()
    XCTAssertEqual(value.error, "Hermes did not accept this message.")
  }

  func testAConversationErrorClearsOnTheNextConversationRead() async throws {
    let routes = Routes()
    routes[path: "/api/bots/bot/conversation"] = .init(status: 503, body: Self.json(["error": "Synthetic chat outage"]))
    let server = FakeServer { routes[path: $0.url!.path] ?? .init() }
    let value = store(server)
    defer { clean(server, value) }
    value.bootstrap = try decode(Self.bootstrap(bots: [Self.bot(unread: nil, at: nil)]))
    value.selectedBotId = "bot"
    value.draft = Draft(text: "", attachments: [], dirty: false); value.draftReady = true
    await value.refreshConversation()
    XCTAssertEqual(value.connectionError, .chat)
    routes[path: "/api/bootstrap"] = .init(body: Self.bootstrap(bots: [Self.bot(unread: nil, at: nil)]))
    await value.refreshBootstrap()
    XCTAssertEqual(value.error, "Synthetic chat outage", "The roster working says nothing about the chat")
    routes[path: "/api/bots/bot/conversation"] = .init(body: Self.conversation())
    await value.refreshConversation()
    XCTAssertNil(value.error)
  }

  // MARK: Streaming

  func testAStreamedPatchRendersTheComposerOnlyWhenItsActivityChanges() async throws {
    let server = FakeServer(), value = store(server)
    defer { clean(server, value) }
    value.bootstrap = try decode(Self.bootstrap(bots: [Self.bot(unread: nil, at: nil)]))
    value.selectedBotId = "bot"
    value.conversation = try decode(Self.conversation(state: "working", reply: "Checking the"))
    XCTAssertEqual(value.activity, .working)
    let patch = try decode(Self.conversation(state: "working", reply: "Checking the gate")) as Conversation
    let streamed = await observedChanges(of: value) { value.conversation = patch }
    XCTAssertEqual(streamed["conversation"], 1)
    XCTAssertNil(streamed["activity"], "Before this every token rendered the composer and home rows")
    let finished = try decode(Self.conversation(state: "done", reply: "Checking the gate. Done.")) as Conversation
    let settled = await observedChanges(of: value) { value.conversation = finished }
    XCTAssertEqual(settled["activity"], 1)
    XCTAssertEqual(value.latestReply?.text, "Checking the gate. Done.")
  }

  private static let streamedReplies = [
    """
    # Ranch report

    Check **the gate** and [weather](https://example.test).

    - Hay
    - Water

    1. First
    2. Second

    3. Third after a blank line

    | Task | Result |
    | --- | --- |
    | Gate | Ready |

    ```swift
    let answer = 42

    print(answer)
    ```

        indented code

        more indented code
    after code

    > quoted
    lazy continuation

    > second quote

    Setext title
    ===

    <!-- a comment

    that spans blank lines -->

    Final paragraph with trailing spaces
    and a hard break.
    """,
    """
    - item one

      continued paragraph

    - item two

    text after the list

    * star list
    + plus list

    10) ten
    11) eleven

    Done.
    """,
    "<div>\nblock html\n\n</div>\n\n\tTabbed code\n\nPara\r\nwith CRLF\r\n\r\nNext para\r\rLast\n",
    "Intro\n\n```\ncode line\n\nstill code\n```\n\nAfter.\n\n~~~\nnever closed\n\nstill inside\n",
    "[ref]: https://example.test\n\nUse [the ref][ref] here.[^1]\n\n[^1]: A footnote.\n\n<script>\nlet a = 1\n\nlet b = 2\n</script>\n\n<?php\n\necho 1 ?>\n\n<![CDATA[\n\n]]>\n\n<p>\nopen tag\n\nAfter.\n",
  ]

  func testStreamedRepliesParseExactlyAsAWholeParseAtEveryPatch() {
    for (index, reply) in Self.streamedReplies.enumerated() {
      for chunk in [1, 7] {
        let cache = MarkdownCache()
        let characters = Array(reply)
        var settledAtEnd = 0
        for end in stride(from: chunk, through: characters.count + chunk - 1, by: chunk) {
          let prefix = String(characters[..<min(end, characters.count)])
          let streamed = cache.streamingBlocks(prefix)
          XCTAssertEqual(streamed.blocks, Markdown.parse(prefix), "reply \(index), chunk \(chunk), length \(prefix.count)")
          settledAtEnd = streamed.settled
        }
        // The report settles at its paragraphs; the list reply, mostly lists that may still grow, rarely does.
        if index == 0 { XCTAssertGreaterThan(settledAtEnd, 8, "Only the end of a long reply parses again") }
      }
    }
  }
}
