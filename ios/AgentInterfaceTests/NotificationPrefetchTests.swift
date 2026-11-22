import Foundation
import XCTest

@testable import AgentInterface

/// Notification service extension conversation prefetching (Option 2) and parallel foreground
/// resume / notification navigation (Option 4).
@MainActor final class NotificationPrefetchTests: XCTestCase {
  private func temporaryDirectory() -> URL {
    let url = FileManager.default.temporaryDirectory
      .appendingPathComponent("notification-prefetch-\(UUID().uuidString)", isDirectory: true)
    addTeardownBlock { try? FileManager.default.removeItem(at: url) }
    return url
  }

  private func fakeSession(for host: FakeHost) -> URLSession {
    FakeExchange.register(host)
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [FakeExchange.self]
    config.httpCookieStorage = nil
    config.urlCache = nil
    return URLSession(configuration: config)
  }

  nonisolated private static func json(_ object: Any) -> String {
    String(decoding: try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]), as: UTF8.self)
  }

  nonisolated private static func bootstrapJSON(user: String = "one", bots: [String] = ["bot"]) -> String {
    json([
      "user": ["id": user, "name": user.capitalized, "email": "\(user)@example.test"],
      "household": [],
      "preferences": ["presentation": "simple", "theme": "system", "favorites": [], "sections": [], "followBots": []],
      "bots": bots.map {
        ["id": $0, "name": $0.capitalized, "model": "test", "shared": true, "activity": "idle"] as [String: Any]
      },
      "capabilities": ["chat": ["supported": true]],
      "connection": ["connected": true],
    ])
  }

  nonisolated private static func conversationJSON(
    botId: String = "bot",
    messages: [[String: Any]],
    earlier: Int? = nil
  ) -> String {
    var payload: [String: Any] = [
      "botId": botId,
      "messages": messages,
      "activity": ["state": "idle"],
      "approvals": [],
      "files": [],
      "draft": ["text": "", "attachments": []],
    ]
    if let earlier { payload["earlier"] = earlier }
    return json(payload)
  }

  private func clean(_ server: FakeServer, _ store: AppStore) {
    store.suspend()
    if let api = store.api {
      UserDefaults.standard.removeObject(forKey: DeviceDefaults.expiry(api.baseURL))
    }
    for key in UserDefaults.standard.dictionaryRepresentation().keys
    where key.hasPrefix("native.\(store.scope ?? "-").") {
      UserDefaults.standard.removeObject(forKey: key)
    }
    FakeExchange.remove(host: server.origin.host!)
  }

  // MARK: Target parsing and store guards

  func testPrefetchTargetFiltersNonChatAndMalformedPayloads() {
    let account = NotificationActions.accountMarker("one")
    let valid = NotificationPrefetchTarget(userInfo: ["botId": "kitchen", "account": account, "url": "/?bot=kitchen"])
    XCTAssertEqual(valid, NotificationPrefetchTarget(botId: "kitchen", account: account, url: "/?bot=kitchen"))
    XCTAssertNotNil(NotificationPrefetchTarget(userInfo: ["botId": "kitchen", "account": account]))

    let rejected: [[AnyHashable: Any]] = [
      ["account": account, "url": "/?bot=kitchen"],
      ["botId": "", "account": account, "url": "/?bot=kitchen"],
      ["botId": "kitchen", "account": "not-a-marker", "url": "/?bot=kitchen"],
      ["botId": "kitchen", "account": "0123456789ABCDEF", "url": "/?bot=kitchen"],
      ["botId": "kitchen", "account": "../../escape", "url": "/?bot=kitchen"],
      ["botId": "kitchen", "account": account, "url": "/?view=today"],
      ["botId": "kitchen", "account": account, "url": "/?view=home"],
      ["botId": "kitchen", "account": account, "url": "/?bot=kitchen&routine=daily"],
    ]
    for payload in rejected {
      XCTAssertNil(NotificationPrefetchTarget(userInfo: payload), "\(payload)")
    }
  }

  func testPrefetchStoreProtectsPathsEnforcesCapsAndExpiresOldEntries() throws {
    let root = temporaryDirectory()
    let one = NotificationActions.accountMarker("one")
    let two = NotificationActions.accountMarker("two")

    XCTAssertNil(NotificationPrefetchStore.conversationURL(account: "../../tmp", botId: "kitchen", root: root))
    XCTAssertNil(NotificationPrefetchStore.conversationURL(account: one, botId: "", root: root))
    let escaped = try XCTUnwrap(NotificationPrefetchStore.conversationURL(account: one, botId: "../../escape", root: root))
    XCTAssertEqual(
      escaped.deletingLastPathComponent().standardizedFileURL.path,
      root.appendingPathComponent(one).standardizedFileURL.path
    )

    // Oversized payloads are refused before touching disk.
    let oversized = PrefetchedConversation(
      botId: "huge", account: one, fetchedAt: Date(), etag: nil,
      payload: Data(repeating: 65, count: NotificationPrefetchStore.maximumBytes + 1)
    )
    XCTAssertFalse(NotificationPrefetchStore.save(oversized, root: root))
    XCTAssertNil(NotificationPrefetchStore.read(account: one, botId: "huge", root: root))

    // Cap to maximumChats (5) by pruning the oldest files.
    let base = Date(timeIntervalSinceNow: -1000)
    for index in 0..<(NotificationPrefetchStore.maximumChats + 2) {
      let botId = "bot-\(index)"
      let entry = PrefetchedConversation(
        botId: botId, account: one, fetchedAt: base.addingTimeInterval(Double(index) * 10),
        etag: "e\(index)", payload: Data("{\"botId\":\"\(botId)\"}".utf8)
      )
      XCTAssertTrue(NotificationPrefetchStore.save(entry, root: root))
      if let file = NotificationPrefetchStore.conversationURL(account: one, botId: botId, root: root) {
        try FileManager.default.setAttributes(
          [.modificationDate: base.addingTimeInterval(Double(index) * 10)], ofItemAtPath: file.path
        )
      }
    }
    let kept = NotificationPrefetchStore.readAll(account: one, root: root, now: base.addingTimeInterval(100))
    XCTAssertEqual(kept.count, NotificationPrefetchStore.maximumChats)
    XCTAssertFalse(kept.contains { $0.botId == "bot-0" || $0.botId == "bot-1" })

    // Expired entries are dropped and deleted on read.
    XCTAssertTrue(
      NotificationPrefetchStore.readAll(
        account: one, root: root, now: base.addingTimeInterval(NotificationPrefetchStore.maximumAge + 200)
      ).isEmpty
    )

    // Switching accounts removes the previous account's cached directory.
    XCTAssertTrue(NotificationPrefetchStore.save(
      PrefetchedConversation(botId: "kitchen", account: one, fetchedAt: base, etag: nil, payload: Data("{\"botId\":\"kitchen\"}".utf8)),
      root: root
    ))
    NotificationPrefetchStore.writeConfig(NotificationPrefetchConfig(origin: "https://app.example.test", account: one), root: root)
    XCTAssertNotNil(NotificationPrefetchStore.read(account: one, botId: "kitchen", root: root, now: base))
    NotificationPrefetchStore.writeConfig(NotificationPrefetchConfig(origin: "https://app.example.test", account: two), root: root)
    XCTAssertNil(NotificationPrefetchStore.read(account: one, botId: "kitchen", root: root, now: base))
    NotificationPrefetchStore.writeConfig(nil, root: root)
    XCTAssertNil(NotificationPrefetchStore.readConfig(root: root))
  }

  // MARK: NotificationPrefetcher network and security boundaries

  func testPrefetcherFetchesValidatesAndSavesConversation() async throws {
    let root = temporaryDirectory()
    let account = NotificationActions.accountMarker("one")
    let body = Self.conversationJSON(
      botId: "kitchen helper",
      messages: [["id": "m1", "role": "assistant", "text": "Dinner is ready."]]
    )
    let host = HeaderHost(status: 200, body: Data(body.utf8), headers: ["ETag": "\"v7\""])
    defer { FakeExchange.remove(host: host.origin.host!) }

    NotificationPrefetchStore.writeConfig(
      NotificationPrefetchConfig(origin: host.origin.absoluteString, account: account), root: root
    )
    let started = Date(timeIntervalSince1970: 1_800_000_123)
    let target = NotificationPrefetchTarget(
      userInfo: ["botId": "kitchen helper", "account": account, "url": "/?bot=kitchen%20helper"]
    )
    let saved = await NotificationPrefetcher.prefetch(
      target: target,
      root: root,
      tokenProvider: { $0 == host.origin.absoluteString ? "prefetch-token" : nil },
      session: fakeSession(for: host),
      timeout: .seconds(2),
      now: { started }
    )
    XCTAssertTrue(saved)
    let request = try XCTUnwrap(host.lastRequest)
    XCTAssertEqual(request.url?.path, "/api/bots/kitchen helper/conversation")
    XCTAssertEqual(request.url?.query, "turns=20")
    XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer prefetch-token")
    XCTAssertEqual(request.value(forHTTPHeaderField: "Cache-Control"), "no-store")

    let entry = try XCTUnwrap(NotificationPrefetchStore.read(account: account, botId: "kitchen helper", root: root, now: started))
    XCTAssertEqual(entry.fetchedAt, started)
    XCTAssertEqual(entry.etag, "\"v7\"")
    let decoded = try JSONDecoder().decode(Conversation.self, from: entry.payload)
    XCTAssertEqual(decoded.messages.map(\.text), ["Dinner is ready."])
  }

  func testPrefetcherRejectsMismatchedAccountStatusBodySizeAndSignOutMidFlight() async throws {
    let root = temporaryDirectory()
    let one = NotificationActions.accountMarker("one")
    let two = NotificationActions.accountMarker("two")
    let server = FakeServer()
    defer { FakeExchange.remove(host: server.origin.host!) }
    let session = fakeSession(for: server)
    let target = NotificationPrefetchTarget(userInfo: ["botId": "kitchen", "account": one, "url": "/?bot=kitchen"])

    // Missing config: never hits the network.
    let missingConfig = await NotificationPrefetcher.prefetch(target: target, root: root, tokenProvider: { _ in "tok" }, session: session)
    XCTAssertFalse(missingConfig)
    XCTAssertTrue(server.requests.isEmpty)

    // Wrong signed-in account: never hits the network.
    NotificationPrefetchStore.writeConfig(NotificationPrefetchConfig(origin: server.origin.absoluteString, account: two), root: root)
    let wrongAccount = await NotificationPrefetcher.prefetch(target: target, root: root, tokenProvider: { _ in "tok" }, session: session)
    XCTAssertFalse(wrongAccount)
    XCTAssertTrue(server.requests.isEmpty)

    // Matching account, missing token: never hits the network.
    NotificationPrefetchStore.writeConfig(NotificationPrefetchConfig(origin: server.origin.absoluteString, account: one), root: root)
    let missingToken = await NotificationPrefetcher.prefetch(target: target, root: root, tokenProvider: { _ in nil }, session: session)
    XCTAssertFalse(missingToken)
    XCTAssertTrue(server.requests.isEmpty)

    // Non-200 responses, malformed JSON, mismatched botId, oversized payload: nothing saved.
    let badReplies: [FakeServer.Reply] = [
      .init(status: 401, body: #"{"error":"unauthorized"}"#),
      .init(status: 403, body: #"{"error":"forbidden"}"#),
      .init(status: 500, body: #"{"error":"boom"}"#),
      .init(status: 200, body: "not-json"),
      .init(status: 200, body: Self.conversationJSON(botId: "other", messages: [])),
      .init(status: 200, body: "{\"botId\":\"kitchen\",\"pad\":\"" + String(repeating: "x", count: NotificationPrefetchStore.maximumBytes) + "\"}"),
    ]
    for reply in badReplies {
      server.reply = reply
      let savedBad = await NotificationPrefetcher.prefetch(target: target, root: root, tokenProvider: { _ in "tok" }, session: session)
      XCTAssertFalse(savedBad)
      XCTAssertNil(NotificationPrefetchStore.read(account: one, botId: "kitchen", root: root))
    }

    // Timeout cancels cleanly without saving.
    server.reply = .init(status: 200, body: Self.conversationJSON(botId: "kitchen", messages: []))
    let releaseTimeout = server.hold(path: "/api/bots/kitchen/conversation")
    let timedOut = await NotificationPrefetcher.prefetch(
      target: target, root: root, tokenProvider: { _ in "tok" }, session: session, timeout: .milliseconds(80)
    )
    releaseTimeout()
    XCTAssertFalse(timedOut)
    XCTAssertNil(NotificationPrefetchStore.read(account: one, botId: "kitchen", root: root))

    // Sign-out while the fetch is in flight discards the result and writes nothing.
    let signOutServer = FakeServer { _ in
      NotificationPrefetchStore.clear(root: root)
      return .init(status: 200, body: Self.conversationJSON(botId: "kitchen", messages: [["id": "m1", "role": "assistant", "text": "Late"]]))
    }
    defer { FakeExchange.remove(host: signOutServer.origin.host!) }
    NotificationPrefetchStore.writeConfig(NotificationPrefetchConfig(origin: signOutServer.origin.absoluteString, account: one), root: root)
    let afterSignOut = await NotificationPrefetcher.prefetch(
      target: target, root: root, tokenProvider: { _ in "tok" }, session: fakeSession(for: signOutServer)
    )
    XCTAssertFalse(afterSignOut)
    XCTAssertNil(NotificationPrefetchStore.read(account: one, botId: "kitchen", root: root))
  }

  // MARK: AppStore absorption and Option 4 parallel resume

  func testResumeAndSelectAbsorbPrefetchWithoutClobberingNewerOrWidenedWindows() async throws {
    let root = temporaryDirectory()
    let account = NotificationActions.accountMarker("one")
    let server = FakeServer { request in
      if request.url?.path == "/api/bootstrap" { return .init(body: Self.bootstrapJSON(bots: ["bot", "garden"])) }
      if request.url?.path == "/api/bots/garden/draft" { return .init(body: #"{"text":"","attachments":[]}"#) }
      if request.url?.path == "/api/bots/garden/conversation" {
        return .init(body: Self.conversationJSON(botId: "garden", messages: [["id": "g1", "role": "assistant", "text": "Watered."]]))
      }
      return .init(body: Self.conversationJSON(botId: "bot", messages: [["id": "m1", "role": "assistant", "text": "Old"]]))
    }
    let store = AppStore()
    store.widgetSnapshotURL = nil
    store.prefetchRoot = root
    store.api = server.api()
    defer { clean(server, store) }

    store.bootstrap = try JSONDecoder().decode(Bootstrap.self, from: Data(Self.bootstrapJSON(bots: ["bot", "garden"]).utf8))
    store.selectedBotId = "bot"
    store.conversationShown("bot", true)
    let oldTime = Date(timeIntervalSinceNow: -120)
    store.conversationCapturedAt["bot"] = oldTime
    store.conversation = try JSONDecoder().decode(
      Conversation.self,
      from: Data(Self.conversationJSON(botId: "bot", messages: [["id": "m1", "role": "assistant", "text": "Old"]]).utf8)
    )
    store.conversationCache["bot"] = store.conversation

    // Stage a newer prefetched conversation for "bot" while suspended.
    let newerPayload = Self.conversationJSON(
      botId: "bot",
      messages: [
        ["id": "m1", "role": "assistant", "text": "Old"],
        ["id": "m2", "role": "assistant", "text": "Prefetched reply!"],
      ]
    )
    XCTAssertTrue(NotificationPrefetchStore.save(
      PrefetchedConversation(botId: "bot", account: account, fetchedAt: Date(timeIntervalSinceNow: -5), etag: nil, payload: Data(newerPayload.utf8)),
      root: root
    ))

    // Hold all network replies during resume to prove the prefetched message appears immediately at 0 ms.
    let releaseBoot = server.hold(path: "/api/bootstrap")
    let releaseChat = server.hold(path: "/api/bots/bot/conversation")

    await store.resume()
    XCTAssertEqual(store.conversation?.messages.last?.text, "Prefetched reply!", "Resume shows prefetched reply before any network response")
    XCTAssertNil(NotificationPrefetchStore.read(account: account, botId: "bot", root: root), "Consumed prefetch file is removed when live")
    releaseBoot(); releaseChat()
    store.suspend()

    // A stale prefetch older than conversationCapturedAt must not overwrite the newer live copy.
    let stalePayload = Self.conversationJSON(botId: "bot", messages: [["id": "m0", "role": "assistant", "text": "Stale"]])
    XCTAssertTrue(NotificationPrefetchStore.save(
      PrefetchedConversation(botId: "bot", account: account, fetchedAt: Date(timeIntervalSinceNow: -300), etag: nil, payload: Data(stalePayload.utf8)),
      root: root
    ))
    XCTAssertFalse(store.absorbPrefetchedConversations())
    XCTAssertEqual(store.conversation?.messages.last?.text, "Prefetched reply!")

    // A widened earlier-history window is preserved instead of shrinking scroll history.
    store.conversation = try JSONDecoder().decode(
      Conversation.self,
      from: Data(Self.conversationJSON(
        botId: "bot",
        messages: [
          ["id": "m0", "role": "user", "text": "Earlier"],
          ["id": "m1", "role": "assistant", "text": "Old"],
        ],
        earlier: 0
      ).utf8)
    )
    store.conversationCapturedAt["bot"] = Date(timeIntervalSinceNow: -60)
    let narrowerPayload = Self.conversationJSON(
      botId: "bot",
      messages: [["id": "m2", "role": "assistant", "text": "Latest only"]],
      earlier: 2
    )
    XCTAssertTrue(NotificationPrefetchStore.save(
      PrefetchedConversation(botId: "bot", account: account, fetchedAt: Date(), etag: nil, payload: Data(narrowerPayload.utf8)),
      root: root
    ))
    _ = store.absorbPrefetchedConversations()
    XCTAssertEqual(store.conversation?.messages.first?.id, "m0", "Widened history window stays intact until live start= refresh")

    // Selecting another chat absorbs its prefetched conversation immediately before network responds.
    let gardenPayload = Self.conversationJSON(botId: "garden", messages: [["id": "g1", "role": "assistant", "text": "Prefetched garden"]])
    XCTAssertTrue(NotificationPrefetchStore.save(
      PrefetchedConversation(botId: "garden", account: account, fetchedAt: Date(), etag: nil, payload: Data(gardenPayload.utf8)),
      root: root
    ))
    let releaseGardenChat = server.hold(path: "/api/bots/garden/conversation")
    let releaseGardenDraft = server.hold(path: "/api/bots/garden/draft")
    let selectTask = Task { await store.select("garden") }
    try await until { store.selectedBotId == "garden" && store.conversation?.messages.last?.text == "Prefetched garden" }
    releaseGardenDraft(); releaseGardenChat()
    await selectTask.value

    // Sign-out wipes the App Group prefetch config and any staged conversations.
    NotificationPrefetchStore.writeConfig(NotificationPrefetchConfig(origin: server.origin.absoluteString, account: account), root: root)
    XCTAssertTrue(NotificationPrefetchStore.save(
      PrefetchedConversation(botId: "garden", account: account, fetchedAt: Date(), etag: nil, payload: Data(gardenPayload.utf8)),
      root: root
    ))
    await store.signOut(localOnly: true)
    XCTAssertNil(NotificationPrefetchStore.readConfig(root: root))
    XCTAssertNil(NotificationPrefetchStore.read(account: account, botId: "garden", root: root))
  }

  func testResumeRefreshesOpenConversationConcurrentlyWhileBootstrapIsHeld() async throws {
    let server = FakeServer { request in
      if request.url?.path == "/api/bootstrap" { return .init(body: Self.bootstrapJSON(bots: ["bot"])) }
      if request.url?.path == "/api/bots/bot/conversation" {
        return .init(body: Self.conversationJSON(botId: "bot", messages: [["id": "m2", "role": "assistant", "text": "Live reply"]]))
      }
      return .init()
    }
    let store = AppStore()
    store.widgetSnapshotURL = nil
    store.api = server.api()
    defer { clean(server, store) }

    store.bootstrap = try JSONDecoder().decode(Bootstrap.self, from: Data(Self.bootstrapJSON(bots: ["bot"]).utf8))
    store.selectedBotId = "bot"
    store.conversationShown("bot", true)
    store.draftReady = true
    store.suspend()

    // Hold /api/bootstrap so it cannot answer yet.
    let releaseBootstrap = server.hold(path: "/api/bootstrap")
    defer { releaseBootstrap() }

    await store.resume()

    // The open conversation must refresh and render BEFORE /api/bootstrap answers!
    try await until { store.conversation?.messages.last?.text == "Live reply" }
    XCTAssertTrue(server.requests.contains { $0.url?.path == "/api/bots/bot/conversation" })
  }

  func testRestoreAbsorbsPrefetchAndOpensPendingNotificationBeforeBootstrapReturns() async throws {
    let offlineRoot = temporaryDirectory()
    let prefetchRoot = temporaryDirectory()
    let account = NotificationActions.accountMarker("one")

    let server = FakeServer { request in
      if request.url?.path == "/api/bootstrap" { return .init(body: Self.bootstrapJSON(bots: ["bot", "garden"])) }
      if request.url?.path == "/api/bots/garden/draft" { return .init(body: #"{"text":"","attachments":[]}"#) }
      if request.url?.path == "/api/bots/garden/conversation" {
        return .init(body: Self.conversationJSON(botId: "garden", messages: [["id": "g1", "role": "assistant", "text": "Live garden"]]))
      }
      return .init(body: Self.conversationJSON(botId: "bot", messages: []))
    }
    let token = "synthetic-session-token"
    let bootstrap = try JSONDecoder().decode(Bootstrap.self, from: Data(Self.bootstrapJSON(bots: ["bot", "garden"]).utf8))
    let oldBotChat = try JSONDecoder().decode(
      Conversation.self,
      from: Data(Self.conversationJSON(botId: "bot", messages: [["id": "m1", "role": "assistant", "text": "Old bot"]]).utf8)
    )
    let oldTime = Date(timeIntervalSinceNow: -120)
    let offlineURL = OfflineLibrary.url(origin: server.origin.absoluteString, token: token, root: offlineRoot)
    OfflineLibrary(savedAt: oldTime, bootstrap: bootstrap, conversations: ["bot": oldBotChat], selected: "bot").write(offlineURL)
    UserDefaults.standard.set(
      ServerDate.string(Date(timeIntervalSinceNow: 3600)),
      forKey: DeviceDefaults.expiry(server.origin)
    )

    // Stage a prefetched message for "garden" from the notification extension.
    let gardenPayload = Self.conversationJSON(botId: "garden", messages: [["id": "g1", "role": "assistant", "text": "Prefetched from NSE"]])
    XCTAssertTrue(NotificationPrefetchStore.save(
      PrefetchedConversation(botId: "garden", account: account, fetchedAt: Date(), etag: nil, payload: Data(gardenPayload.utf8)),
      root: prefetchRoot
    ))

    let store = AppStore()
    store.widgetSnapshotURL = nil
    store.offlineLibraryRoot = offlineRoot
    store.prefetchRoot = prefetchRoot
    store.host = server.origin.absoluteString
    store.makeClient = { _ in server.api(token: token) }
    defer { clean(server, store) }

    let controller = NotificationController()
    controller.store = store
    controller.pendingURL = "/?bot=garden"
    store.onBootstrapReady = {
      guard controller.hasPendingNavigation else { return nil }
      return Task { await controller.openPendingConversation() }
    }

    // Hold /api/bootstrap and garden's live reads so only OfflineLibrary + NSE prefetch can answer.
    let releaseBootstrap = server.hold(path: "/api/bootstrap")
    let releaseGardenDraft = server.hold(path: "/api/bots/garden/draft")
    let releaseGardenChat = server.hold(path: "/api/bots/garden/conversation")

    let restoreTask = Task { await store.restore() }
    try await until { store.selectedBotId == "garden" && store.conversation?.messages.last?.text == "Prefetched from NSE" }

    releaseGardenDraft(); releaseGardenChat(); releaseBootstrap()
    await restoreTask.value
  }

  func testSynchronizeOpensPendingNotificationBeforePushConfigReturns() async throws {
    let server = FakeServer { request in
      if request.url?.path == "/api/native/push/config" { return .init(body: #"{"available":true,"environment":"sandbox"}"#) }
      if request.url?.path == "/api/bots/kitchen/draft" { return .init(body: #"{"text":"","attachments":[]}"#) }
      if request.url?.path == "/api/bots/kitchen/conversation" {
        return .init(body: Self.conversationJSON(botId: "kitchen", messages: [["id": "k1", "role": "assistant", "text": "Ready"]]))
      }
      return .init()
    }
    let store = AppStore()
    store.widgetSnapshotURL = nil
    store.api = server.api()
    store.bootstrap = try JSONDecoder().decode(Bootstrap.self, from: Data(Self.bootstrapJSON(bots: ["kitchen"]).utf8))
    defer { clean(server, store) }

    let controller = NotificationController(
      permissions: NotificationPermissions(status: { .authorized }, request: { true }),
      register: {}, unregister: {}
    )
    controller.store = store
    controller.pendingURL = "/?bot=kitchen"

    let releasePushConfig = server.hold(path: "/api/native/push/config")
    let syncTask = Task { await controller.synchronize() }
    try await until { store.selectedBotId == "kitchen" && store.conversation?.messages.last?.text == "Ready" }
    releasePushConfig()
    await syncTask.value
  }
}

/// Minimal `FakeHost` that returns custom HTTP headers (such as `ETag`) and records the last request.
private final class HeaderHost: FakeHost, @unchecked Sendable {
  let origin = URL(string: "https://header-\(UUID().uuidString.lowercased()).example.test")!
  private let status: Int
  private let body: Data
  private let headers: [String: String]
  private let lock = NSLock()
  private var recorded: URLRequest?
  var lastRequest: URLRequest? { lock.withLock { recorded } }

  init(status: Int, body: Data, headers: [String: String]) {
    self.status = status
    self.body = body
    self.headers = headers
  }

  func receive(_ exchange: FakeExchange) {
    lock.withLock { recorded = exchange.request }
    exchange.respond(status: status, data: body, headers: headers)
  }
}
