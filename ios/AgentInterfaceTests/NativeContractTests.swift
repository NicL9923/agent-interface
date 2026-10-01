import XCTest
import Foundation
import CryptoKit
@testable import AgentInterface

private final class NativeMockProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var servers: [String: NativeMockServer] = [:]
    static func register(_ server: NativeMockServer, host: String) { lock.withLock { servers[host] = server } }
    static func remove(host: String) { _ = lock.withLock { servers.removeValue(forKey: host) } }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let host = request.url?.host, let server = Self.lock.withLock({ Self.servers[host] }) else {
            client?.urlProtocol(self, didFailWithError: URLError(.badURL)); return
        }
        server.receive(self)
    }
    override func stopLoading() {}
    func respond(status: Int, data: Data) {
        guard let url = request.url, let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"]) else { return }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
}

private final class NativeMockServer: @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [URLRequest] = []
    private var held: [String: NativeMockProtocol] = [:]
    private var heldPaths: Set<String> = []
    private var currentUser = "one"
    private var messageStatus = 200
    private var run = "run-one"
    private var state = "idle"
    private var logoutStatus = 200
    private var connected = true
    private var conversationStatus = 200
    private var upgradeResponseStatus = 200
    let origin = URL(string: "https://native-\(UUID().uuidString.lowercased()).example.test")!
    var user: String { get { lock.withLock { currentUser } } set { lock.withLock { currentUser = newValue } } }
    var sendStatus: Int { get { lock.withLock { messageStatus } } set { lock.withLock { messageStatus = newValue } } }
    var requests: [URLRequest] { lock.withLock { recorded } }
    func interrupt(runId: String) { lock.withLock { run = runId; state = "interrupted" } }
    func failLogout() { lock.withLock { logoutStatus = 503 } }
    func disconnect() { lock.withLock { connected = false } }
    func failConversation(_ fail: Bool = true) { lock.withLock { conversationStatus = fail ? 503 : 200 } }
    func setUpgradeResponseStatus(_ status: Int) { lock.withLock { upgradeResponseStatus = status } }
    func hold(_ path: String) { _ = lock.withLock { heldPaths.insert(path) } }
    func receive(_ protocolInstance: NativeMockProtocol) {
        let path = protocolInstance.request.url!.path
        let delay = lock.withLock {
            recorded.append(protocolInstance.request)
            if heldPaths.contains(path) { held[path] = protocolInstance; return true }
            return false
        }
        if !delay { finish(protocolInstance) }
    }
    func release(_ path: String) {
        let pending = lock.withLock { () -> NativeMockProtocol? in
            heldPaths.remove(path); return held.removeValue(forKey: path)
        }
        if let pending { finish(pending) }
    }
    func waitForHeld(_ path: String) async throws {
        for _ in 0..<200 {
            if lock.withLock({ held[path] != nil }) { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        throw URLError(.timedOut)
    }
    func bootstrapData() -> Data {
        let isConnected = lock.withLock { connected }
        return Self.json(["user": ["id": user, "name": user, "email": "\(user)@example.test", "picture": NSNull()],
                   "household": [], "preferences": ["presentation": "simple", "theme": "system", "favorites": [], "sections": [], "followBots": []],
                   "bots": isConnected ? [["id": "bot", "name": "Bot", "model": "test", "shared": true, "activity": "idle"]] : [],
                   "capabilities": ["uploads": ["supported": true], "chat": ["supported": true], "steering": ["supported": true], "idempotency": ["supported": true]],
                   "connection": ["connected": isConnected], "csrfToken": NSNull()])
    }
    func conversationData() -> Data {
        let activity = lock.withLock { ["state": state, "runId": run] }
        return Self.json(["botId": "bot", "messages": [], "activity": activity, "approvals": [], "files": [],
                          "draft": ["text": "server draft for \(user)", "attachments": []],
                          "readPosition": ["messageId": "message-one", "scrollTop": 12.5]])
    }
    private func finish(_ protocolInstance: NativeMockProtocol) {
        let request = protocolInstance.request, path = request.url!.path
        var status = 200, data = Self.json(["ok": true])
        if path == "/api/auth/config" { data = Self.json(["googleClientId": "google", "localDevAuth": false, "nativeAuthVersion": 1]) }
        else if path == "/api/auth/native/exchange" { data = Self.json(["token": "replacement-session", "expiresAt": "2026-10-07T09:08:21.125Z", "user": ["id": "one", "name": "One", "email": "one@example.test"]]) }
        else if path == "/api/bootstrap" { data = bootstrapData() }
        else if path.hasSuffix("/conversation") {
            status = lock.withLock { conversationStatus }
            data = status == 200 ? conversationData() : Self.json(["error": "Synthetic conversation outage"])
        }
        else if path.hasSuffix("/draft") { data = Self.json(["text": "server draft for \(user)", "attachments": []]) }
        else if path.hasSuffix("/messages") {
            status = sendStatus
            let payload = Self.body(request).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            data = status == 200 ? Self.json(["requestId": payload?["requestId"] as? String ?? "missing", "status": "accepted", "runId": "run-one"]) : Self.json(["error": "Synthetic admission failure"])
        } else if path.hasSuffix("/uploads") { data = Self.json(["id": "file.signature", "name": "note.txt", "mime": "text/plain"]) }
        else if path == "/api/preferences" { data = Self.body(request) ?? Data() }
        else if path == "/api/auth/logout" { status = lock.withLock { logoutStatus } }
        else if path.hasPrefix("/api/hermes/upgrade") {
            status = lock.withLock { upgradeResponseStatus }
            data = status == 200 ? Self.json(["available": true, "phase": "ready", "current": ["revision": "current"], "candidate": ["revision": "candidate"], "message": "Update checked", "checks": [["id": "compatibility", "label": "Compatibility", "status": "passed"]], "canCheck": true, "canInstall": true, "canRetry": true, "canCancel": false, "canRestartService": true, "operationId": "failed-update", "busyBots": []]) : Self.json(["error": "Synthetic update failure"])
        }
        protocolInstance.respond(status: status, data: data)
    }
    static func json(_ object: Any) -> Data { try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) }
    static func body(_ request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open(); defer { stream.close() }
        var result = Data(), buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 { break }
            result.append(contentsOf: buffer.prefix(count))
        }
        return result
    }
}

@MainActor final class NativeContractTests: XCTestCase {
    private func client(_ server: NativeMockServer) -> APIClient {
        NativeMockProtocol.register(server, host: server.origin.host!)
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [NativeMockProtocol.self]; config.httpCookieStorage = nil; config.urlCache = nil
        let api = APIClient(baseURL: server.origin, session: URLSession(configuration: config))
        api.token = "synthetic-native-session"; return api
    }
    private func store(_ server: NativeMockServer) throws -> AppStore {
        let value = AppStore(); value.api = client(server)
        value.bootstrap = try JSONDecoder().decode(Bootstrap.self, from: server.bootstrapData())
        value.selectedBotId = "bot"; value.conversation = try JSONDecoder().decode(Conversation.self, from: server.conversationData())
        value.draft = Draft(text: "Send this", attachments: [], dirty: true); value.draftReady = true
        return value
    }
    private func clean(_ server: NativeMockServer, _ store: AppStore? = nil) {
        store?.suspend()
        for user in ["one", "two"] {
            let scope = Data((server.origin.absoluteString + "|" + user).utf8).base64URLEncoded
            for key in UserDefaults.standard.dictionaryRepresentation().keys where key.hasPrefix("native.\(scope).") { UserDefaults.standard.removeObject(forKey: key) }
        }
        NativeMockProtocol.remove(host: server.origin.host!)
    }

    func testBackendJSONContractsIncludeNullableCSRFAndISOExpiry() throws {
        let server = NativeMockServer()
        let bootstrap = try JSONDecoder().decode(Bootstrap.self, from: server.bootstrapData())
        XCTAssertNil(bootstrap.csrfToken)
        let exchange = try JSONDecoder().decode(TokenExchange.self, from: NativeMockServer.json(["token": "opaque", "expiresAt": "2026-10-07T09:08:21.125Z", "user": ["id": "one", "name": "One", "email": "one@example.test"]]))
        XCTAssertEqual(exchange.expiresAt, "2026-10-07T09:08:21.125Z")
        let conversation = try JSONDecoder().decode(Conversation.self, from: server.conversationData())
        XCTAssertEqual(conversation.draft?.text, "server draft for one")
        XCTAssertEqual(conversation.readPosition?.scrollTop, 12.5)
        let routines = try JSONDecoder().decode([Routine].self, from: NativeMockServer.json([["id": "routine", "botId": "bot", "name": "Morning", "prompt": "Weather", "schedule": "0 8 * * *", "enabled": true, "recipientIds": ["one", "two"]]]))
        XCTAssertEqual(routines.first?.recipientIds, ["one", "two"])
    }

    func testConnectionOriginAndPKCERejectUnrelatedSignInAndFileURLs() throws {
        XCTAssertEqual(try ConnectionAddress.parse(" EXAMPLE.test:443/ ").absoluteString, "https://example.test")
        for address in ["http://example.test", "https://user:pass@example.test", "https://example.test/path", "https://example.test?token=x", "https://example.test#fragment"] { XCTAssertThrowsError(try ConnectionAddress.parse(address)) }
        XCTAssertNoThrow(try ConnectionAddress.parse("http://127.0.0.1:3000"))
        let pkce = try PKCE()
        XCTAssertEqual(pkce.challenge, Data(SHA256.hash(data: Data(pkce.verifier.utf8))).base64URLEncoded)
        XCTAssertEqual(try pkce.code(from: URL(string: "agentinterface://auth/callback?code=one-time&state=\(pkce.state)")!), "one-time")
        for callback in ["https://auth/callback?code=x&state=\(pkce.state)", "agentinterface://evil/callback?code=x&state=\(pkce.state)", "agentinterface://auth/other?code=x&state=\(pkce.state)", "agentinterface://auth/callback?code=x&state=wrong"] { XCTAssertThrowsError(try pkce.code(from: URL(string: callback)!)) }
        let server = NativeMockServer(), api = client(server); defer { clean(server) }
        for path in ["//evil.test/file", "https://evil.test/file", "file:///tmp/file"] { XCTAssertThrowsError(try api.url(path)) }
        XCTAssertEqual(try api.url("/api/files/file.signature").host, server.origin.host)
    }

    func testPublicConfigurationOmitsCachedBearerAndNativeWritesOmitBrowserHeaders() async throws {
        let server = NativeMockServer(), api = client(server); defer { clean(server) }
        let config: AuthConfig = try await api.publicGet("/auth/config")
        XCTAssertEqual(config.nativeAuthVersion, 1)
        XCTAssertNil(server.requests.first?.value(forHTTPHeaderField: "Authorization"))
        let _: EmptyResponse = try await api.write("/auth/logout", [String: String]())
        XCTAssertEqual(server.requests.last?.value(forHTTPHeaderField: "Authorization"), "Bearer synthetic-native-session")
        XCTAssertNil(server.requests.last?.value(forHTTPHeaderField: "Origin"))
        XCTAssertNil(server.requests.last?.value(forHTTPHeaderField: "X-CSRF-Token"))
        api.token = "expired-native-session"
        let replacement: TokenExchange = try await api.publicWrite("/auth/native/exchange", ["code": "one-time", "state": "state", "codeVerifier": "verifier"])
        XCTAssertEqual(replacement.token, "replacement-session")
        XCTAssertNil(server.requests.last?.value(forHTTPHeaderField: "Authorization"))
    }

    func testAcceptedSubmissionClearsDraftWithoutAnEmptyDraftWrite() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        value.updateDraft(Draft(text: "Send this", attachments: []))
        await value.send()
        XCTAssertNil(value.pending); XCTAssertEqual(value.receipt?.status, "accepted")
        XCTAssertEqual(value.draft.text, ""); XCTAssertEqual(value.draft.dirty, false)
        try await Task.sleep(for: .milliseconds(800))
        XCTAssertEqual(server.requests.filter { $0.httpMethod == "POST" && $0.url?.path.hasSuffix("/messages") == true }.count, 1)
        XCTAssertTrue(server.requests.filter { $0.httpMethod == "PUT" && $0.url?.path.hasSuffix("/draft") == true }.isEmpty)
    }

    func testDefinitiveAdmissionRejectionAndUncertainServerFailureKeepDifferentRetryState() async throws {
        for status in [409, 503] {
            let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
            server.sendStatus = status; await value.send()
            XCTAssertEqual(value.draft.text, "Send this")
            if status == 409 { XCTAssertNil(value.pending); XCTAssertEqual(value.receipt?.status, "rejected") }
            else { XCTAssertNotNil(value.pending); XCTAssertEqual(value.receipt?.status, "uncertain") }
        }
    }

    func testInterruptionReviewCannotCarryIntoAnotherRun() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        server.interrupt(runId: "first-interrupted-run"); await value.refreshConversation()
        value.interruptionReviewed = true; XCTAssertTrue(value.canSend)
        server.interrupt(runId: "second-interrupted-run"); await value.refreshConversation()
        XCTAssertFalse(value.interruptionReviewed); XCTAssertFalse(value.canSend)
    }

    func testRuntimeDisconnectKeepsKnownRosterAndCurrentDraft() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        server.disconnect(); await value.refreshBootstrap()
        XCTAssertEqual(value.bootstrap?.bots.map(\.id), ["bot"])
        XCTAssertEqual(value.selectedBotId, "bot"); XCTAssertEqual(value.draft.text, "Send this")
        XCTAssertFalse(value.canSend); XCTAssertEqual(value.activity, .disconnected)
    }

    func testConversationOutagePreservesDraftAndTranscriptWhileDisablingSendUntilRecovery() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        let transcript = value.conversation?.messages.map(\.id)
        server.failConversation(); await value.refreshConversation()
        XCTAssertEqual(value.draft.text, "Send this")
        XCTAssertEqual(value.conversation?.messages.map(\.id), transcript)
        XCTAssertEqual(value.activity, .disconnected); XCTAssertFalse(value.canSend)
        server.failConversation(false); await value.refreshBootstrap(); await value.refreshConversation()
        XCTAssertEqual(value.activity, .idle); XCTAssertTrue(value.canSend)
        XCTAssertEqual(value.draft.text, "Send this")
    }

    func testDelayedSendAndReviewedRetryCannotClearAnotherPersonsDraft() async throws {
        for retry in [false, true] {
            let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
            if retry { value.pending = PendingSubmission(requestId: UUID().uuidString, botId: "bot", text: "Send this", attachments: [], reviewedInterruption: false) }
            let path = "/api/bots/bot/messages"; server.hold(path)
            let operation = Task { await value.send(reviewedUncertain: retry) }
            try await server.waitForHeld(path)
            server.user = "two"; await value.refreshBootstrap()
            XCTAssertEqual(value.bootstrap?.user.id, "two")
            XCTAssertFalse(value.sending, "An old identity's delayed submission must not block the new person")
            server.release(path); await operation.value
            XCTAssertEqual(value.draft.text, "server draft for two"); XCTAssertNil(value.pending); XCTAssertNil(value.receipt)
        }
    }

    func testDelayedUploadDoesNotAttachToNewIdentity() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("native-contract-\(UUID().uuidString).txt")
        try Data("Synthetic attachment".utf8).write(to: file); defer { try? FileManager.default.removeItem(at: file) }
        let path = "/api/bots/bot/uploads"; server.hold(path)
        let operation = Task { await value.attach(urls: [file]) }
        try await server.waitForHeld(path)
        server.user = "two"; await value.refreshBootstrap()
        XCTAssertFalse(value.uploading, "An old identity's delayed upload must not block the new person")
        server.release(path); await operation.value
        XCTAssertEqual(value.bootstrap?.user.id, "two"); XCTAssertTrue(value.draft.attachments.isEmpty)
        XCTAssertEqual(value.draft.text, "server draft for two")
    }

    func testDelayedPreferencesCannotReplaceNewIdentityPreferencesAndFailedLogoutRetainsToken() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        var preferences = Preferences(); preferences.theme = "dark"
        server.hold("/api/preferences")
        let operation = Task { await value.setPreferences(preferences) }
        try await server.waitForHeld("/api/preferences")
        server.user = "two"; await value.refreshBootstrap()
        server.release("/api/preferences"); await operation.value
        XCTAssertEqual(value.bootstrap?.preferences.theme, "system")
        server.failLogout(); let signedOut = await value.signOut()
        XCTAssertFalse(signedOut); XCTAssertEqual(value.api?.token, "synthetic-native-session")
        XCTAssertEqual(value.bootstrap?.user.id, "two")
    }

    func testHermesUpgradeUsesAuthenticatedAPIAndRejectsAChangedCandidate() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        await value.refreshUpgrade()
        XCTAssertEqual(value.upgradeStatus?.candidate?.revision, "candidate")
        XCTAssertEqual(server.requests.last?.value(forHTTPHeaderField: "Authorization"), "Bearer synthetic-native-session")
        await value.installUpgrade(candidateRevision: "stale-candidate")
        XCTAssertFalse(server.requests.contains { $0.url?.path == "/api/hermes/upgrade/install" })
        await value.checkUpgrade()
        XCTAssertEqual(server.requests.last?.url?.path, "/api/hermes/upgrade/check")
        XCTAssertEqual(server.requests.last?.httpMethod, "POST")
        await value.installUpgrade(candidateRevision: "candidate")
        let request = try XCTUnwrap(server.requests.last)
        XCTAssertEqual(request.url?.path, "/api/hermes/upgrade/install")
        let body = try XCTUnwrap(NativeMockServer.body(request))
        let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: String])
        XCTAssertEqual(payload["candidateRevision"], "candidate")
        XCTAssertNotNil(UUID(uuidString: payload["requestId"] ?? ""))
    }

    func testUncertainUpgradeInstallRequiresAStatusReadAndOlderServersGetUsefulGuidance() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        await value.refreshUpgrade()
        server.setUpgradeResponseStatus(503)
        await value.installUpgrade(candidateRevision: "candidate")
        XCTAssertTrue(value.upgradeInstallUncertain)
        let requests = server.requests.count
        await value.installUpgrade(candidateRevision: "candidate")
        XCTAssertEqual(server.requests.count, requests, "Do not replay an uncertain install")
        server.setUpgradeResponseStatus(200)
        await value.refreshUpgrade()
        XCTAssertFalse(value.upgradeInstallUncertain)
        server.setUpgradeResponseStatus(404)
        await value.refreshUpgrade()
        XCTAssertTrue(value.upgradeError?.contains("update the app server") == true)
        XCTAssertEqual(value.draft.text, "Send this")
    }

    func testUpgradeRecoveryFencesStaleOperationsAndDoesNotReplayUncertainRequests() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        await value.refreshUpgrade()
        let initialCount = server.requests.count
        await value.controlUpgrade("restart_service", operationId: "stale")
        await value.controlUpgrade("cancel", operationId: "failed-update")
        XCTAssertEqual(server.requests.count, initialCount)
        server.setUpgradeResponseStatus(503)
        await value.controlUpgrade("restart_service", operationId: "failed-update")
        let request = try XCTUnwrap(server.requests.last)
        XCTAssertEqual(request.url?.path, "/api/hermes/upgrade/control")
        let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(NativeMockServer.body(request))) as? [String: String])
        XCTAssertEqual(payload["action"], "restart_service")
        XCTAssertEqual(payload["operationId"], "failed-update")
        XCTAssertNotNil(UUID(uuidString: payload["requestId"] ?? ""))
        XCTAssertTrue(value.upgradeInstallUncertain)
        let count = server.requests.count
        await value.controlUpgrade("retry", operationId: "failed-update")
        XCTAssertEqual(server.requests.count, count)
        server.setUpgradeResponseStatus(200)
        await value.refreshUpgrade()
        XCTAssertFalse(value.upgradeInstallUncertain)
    }

    func testSelectedAppleSnapshotUsesUploadAndPreservesExistingDraft() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        let snapshot = AppleDeviceSnapshot(capturedAt: Date(), windowStart: Date(), windowEnd: Date(), events: [], reminders: [])
        let data = try snapshot.data()
        XCTAssertTrue(String(data: data, encoding: .utf8)?.contains("snapshot, not a live connection") == true)
        try await value.attachAppleSnapshot(data, botId: "bot")
        XCTAssertEqual(value.draft.text, "Send this")
        XCTAssertEqual(value.draft.attachments.last?.id, "file.signature")
        XCTAssertTrue(server.requests.contains { $0.url?.path == "/api/bots/bot/uploads" })
        XCTAssertFalse(server.requests.contains { $0.url?.path == "/api/bots/bot/messages" })
    }

    func testSelectedReminderWindowExcludesTheDayAfterThroughDate() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let start = calendar.date(from: DateComponents(year: 2026, month: 10, day: 1))!
        let nextDay = calendar.date(byAdding: .day, value: 1, to: start)!
        XCTAssertTrue(AppleDeviceConnection.includesReminder(due: start, start: start, exclusiveEnd: nextDay, undated: false))
        XCTAssertTrue(AppleDeviceConnection.includesReminder(due: nextDay.addingTimeInterval(-1), start: start, exclusiveEnd: nextDay, undated: false))
        XCTAssertFalse(AppleDeviceConnection.includesReminder(due: nextDay, start: start, exclusiveEnd: nextDay, undated: false))
        XCTAssertFalse(AppleDeviceConnection.includesReminder(due: nil, start: start, exclusiveEnd: nextDay, undated: false))
        XCTAssertTrue(AppleDeviceConnection.includesReminder(due: nil, start: start, exclusiveEnd: nextDay, undated: true))
    }

    func testDelayedUpgradeStatusCannotLeakAcrossAnIdentityChange() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        let path = "/api/hermes/upgrade"; server.hold(path)
        let operation = Task { await value.refreshUpgrade() }
        try await server.waitForHeld(path)
        server.user = "two"; await value.refreshBootstrap()
        XCTAssertFalse(value.upgradeBusy)
        server.release(path); await operation.value
        XCTAssertNil(value.upgradeStatus)
        XCTAssertNil(value.upgradeError)
    }
}
