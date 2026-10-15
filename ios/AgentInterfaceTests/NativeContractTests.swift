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
    func fail(_ error: URLError) { client?.urlProtocol(self, didFailWithError: error) }
    func respond(status: Int, data: Data, headers: [String: String] = [:]) {
        guard let url = request.url, let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers.merging(["Content-Type": "application/json"]) { value, _ in value }) else { return }
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
    /// Paths the server acts on at once but answers only when released, like a slow response.
    private var delayedPaths: Set<String> = []
    private var delayed: [String: () -> Void] = [:]
    private var currentUser = "one"
    private var messageStatus = 200
    private var run = "run-one"
    private var state = "idle"
    private var logoutStatus = 200
    private var logoutCode: String?
    private var authConfigStatus = 200
    private var bootstrapStatus = 200
    private var bootstrapCode: String?
    private var offline = false
    private var connected = true
    private var conversationStatus = 200
    private var botHidden = false
    private var assistantsChanged = 0
    private var failAnchoredOnce = false
    private var history: [String]?
    private var heldOnce: Set<String> = []
    private var fileOwners: [String: [String]] = [:]
    private var readAnchor = "message-one"
    private var upgradeResponseStatus = 200
    private var etags = false
    private var forcedNotModified = 0
    private var notModifiedCount = 0
    /// Per assistant, once `versionDrafts` is called: drafts then follow the app server's revision rules.
    private var draftRecords: [String: [String: Any]]?
    let origin = URL(string: "https://native-\(UUID().uuidString.lowercased()).example.test")!
    var user: String { get { lock.withLock { currentUser } } set { lock.withLock { currentUser = newValue } } }
    var sendStatus: Int { get { lock.withLock { messageStatus } } set { lock.withLock { messageStatus = newValue } } }
    var requests: [URLRequest] { lock.withLock { recorded } }
    func interrupt(runId: String) { lock.withLock { run = runId; state = "interrupted" } }
    func failLogout(status: Int = 503, code: String? = nil) { lock.withLock { logoutStatus = status; logoutCode = code } }
    func failAuthConfig(_ fail: Bool = true) { lock.withLock { authConfigStatus = fail ? 503 : 200 } }
    /// Answers bootstrap with an error, like the app server's "sign in required" 401.
    func failBootstrap(status: Int, code: String? = nil) { lock.withLock { bootstrapStatus = status; bootstrapCode = code } }
    /// Drops every request as if the phone had no network.
    func setOffline(_ value: Bool) { lock.withLock { offline = value } }
    func requestCount(_ path: String) -> Int { requests.filter { $0.url?.path == path }.count }
    func disconnect(_ value: Bool = true) { lock.withLock { connected = !value } }
    /// Fails the next conversation request that starts at a message, as a saved reading position does.
    func failNextAnchoredConversation() { lock.withLock { failAnchoredOnce = true } }
    func failConversation(_ fail: Bool = true) { lock.withLock { conversationStatus = fail ? 503 : 200 } }
    /// Another member made "bot" their personal assistant: it leaves the roster and its routes answer 404.
    func hideBot() { lock.withLock { botHidden = true } }
    /// Answers the next reads as if an assistant turned private while they ran.
    func answerAssistantsChanged(times: Int) { lock.withLock { assistantsChanged = times } }
    func setUpgradeResponseStatus(_ status: Int) { lock.withLock { upgradeResponseStatus = status } }
    func hold(_ path: String) { _ = lock.withLock { heldPaths.insert(path) } }
    /// Answers the held request with a server error, without acting on it.
    /// Answers every draft save with a server error, without acting on it.
    func failDraftSaves(_ fail: Bool = true) { lock.withLock { draftSavesFail = fail } }
    private var draftSavesFail = false
    func failHeld(_ path: String) {
        lock.withLock { () -> NativeMockProtocol? in heldPaths.remove(path); return held.removeValue(forKey: path) }?
            .respond(status: 500, data: Self.json(["error": "Synthetic save failure"]))
    }
    /// Mirrors the server: GET JSON carries a weak ETag, and a matching If-None-Match gets an empty 304.
    func serveETags() { lock.withLock { etags = true } }
    /// Answers the next GETs with 304 regardless of validators, like a confused intermediary.
    func replyNotModified(times: Int) { lock.withLock { forcedNotModified = times } }
    var notModified: Int { lock.withLock { notModifiedCount } }
    /// Versions drafts like the app server, starting this assistant's draft at `revision`.
    func versionDrafts(_ bot: String = "bot", text: String = "", revision: Int = 0, sentRevision: Int = 0) {
        lock.withLock {
            var records = draftRecords ?? [:]
            records[bot] = ["text": text, "attachments": [], "revision": revision, "reason": sentRevision == revision && revision > 0 ? "sent" : "edit", "sentRevision": sentRevision]
            draftRecords = records
        }
    }
    /// Another device saves an edit, or sends the draft and the server clears it.
    func otherDevice(_ bot: String = "bot", edits text: String) { changeDraft(bot, text: text, reason: "edit") }
    func otherDevice(_ bot: String = "bot", sends text: String) { clearDraft(bot, sent: text) }
    /// Accepting a message clears the sender's draft while it still holds that text, or while
    /// nothing changed it after the revision the message was written on.
    private func clearDraft(_ bot: String, sent text: String, base: Int? = nil) {
        guard let record = draftRecord(bot), let current = record["text"] as? String else { return }
        if current.isEmpty || current == text || base.map({ (record["revision"] as? Int ?? 0) <= $0 }) == true { changeDraft(bot, text: "", reason: "sent") }
    }
    func draftRecord(_ bot: String = "bot") -> [String: Any]? { lock.withLock { draftRecords?[bot] } }
    func draftSaves(_ bot: String = "bot") -> [DraftSaveBody] {
        requests.filter { $0.httpMethod == "PUT" && $0.url?.path == "/api/bots/\(bot)/draft" }
            .compactMap { Self.body($0).flatMap { try? JSONDecoder().decode(DraftSaveBody.self, from: $0) } }
    }
    struct DraftSaveBody: Decodable, Equatable { var text: String; var baseRevision: Int? }
    private func changeDraft(_ bot: String, text: String, reason: String) {
        lock.withLock {
            guard let previous = draftRecords?[bot] else { return }
            let revision = (previous["revision"] as? Int ?? 0) + 1
            draftRecords?[bot] = ["text": text, "attachments": [], "revision": revision, "reason": reason,
                                  "sentRevision": reason == "sent" ? revision : previous["sentRevision"] ?? 0]
        }
    }
    /// The app server's PUT rules: same content is no change, a stale base is a 409.
    private func versionedDraft(_ request: URLRequest, bot: String) -> (status: Int, data: Data)? {
        guard let record = draftRecord(bot) else { return nil }
        guard request.httpMethod == "PUT",
            let body = Self.body(request).flatMap({ try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }),
            let text = body["text"] as? String, text != record["text"] as? String
        else { return (200, Self.json(record)) }
        if let base = body["baseRevision"] as? Int, base != record["revision"] as? Int {
            return (409, Self.json(["error": "This draft changed on another device.", "code": "draft_conflict", "draft": record]))
        }
        changeDraft(bot, text: text, reason: "edit")
        return (200, Self.json(draftRecord(bot)!))
    }
    func receive(_ protocolInstance: NativeMockProtocol) {
        let path = protocolInstance.request.url!.path
        let delay = lock.withLock {
            recorded.append(protocolInstance.request)
            if heldPaths.contains(path) || heldOnce.remove(path) != nil { held[path] = protocolInstance; return true }
            return false
        }
        if lock.withLock({ offline }) { protocolInstance.fail(URLError(.notConnectedToInternet)); return }
        if !delay { finish(protocolInstance) }
    }
    func delayResponse(_ path: String) { _ = lock.withLock { delayedPaths.insert(path) } }
    func releaseResponse(_ path: String) { lock.withLock { delayed.removeValue(forKey: path) }?() }
    func waitForDelayed(_ path: String) async throws {
        for _ in 0..<200 {
            if lock.withLock({ delayed[path] != nil }) { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        throw URLError(.timedOut)
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
        let (isConnected, hidden) = lock.withLock { (connected, botHidden) }
        let family: [String: Any] = ["id": "family", "name": "Family", "model": "test", "shared": true, "activity": "idle"]
        return Self.json(["user": ["id": user, "name": user, "email": "\(user)@example.test", "picture": NSNull()],
                   "household": [], "preferences": ["presentation": "simple", "theme": "system", "favorites": [], "sections": [], "followBots": []],
                   "bots": !isConnected ? [] : hidden ? [family] : [["id": "bot", "name": "Bot", "model": "test", "shared": true, "activity": "idle"]],
                   "capabilities": ["uploads": ["supported": true], "chat": ["supported": true], "steering": ["supported": true], "idempotency": ["supported": true]],
                   "connection": ["connected": isConnected], "csrfToken": NSNull()])
    }
    func conversationData(_ bot: String = "bot", query: String? = nil) -> Data {
        let state: String = lock.withLock { self.state }
        let run: String = lock.withLock { self.run }
        let history: [String]? = lock.withLock { self.history }
        let activity: [String: String] = ["state": state, "runId": run]
        let draft: [String: Any] = draftRecord(bot) ?? ["text": "server draft for \(user)", "attachments": [String]()]
        let readPosition: [String: Any] = ["messageId": lock.withLock { readAnchor }, "scrollTop": 12.5]
        var body: [String: Any] = [:]
        body["botId"] = "bot"
        body["messages"] = [String]()
        body["activity"] = activity
        body["approvals"] = [String]()
        body["files"] = [String]()
        body["draft"] = draft
        body["readPosition"] = readPosition
        if let history {
            let window = Self.window(history, query: query)
            body["messages"] = window.ids.map { (id: String) -> [String: Any] in messageBody(id) }
            body["earlier"] = window.earlier
            var shown = Set<String>(), before = Set<String>(), files: [[String: Any]] = []
            for (index, id) in history.enumerated() {
                for file in lock.withLock({ fileOwners[id] ?? [] }) {
                    if index >= window.earlier {
                        if shown.insert(file).inserted { files.append(fileBody(file)) }
                    } else { before.insert(file) }
                }
            }
            body["files"] = files
            body["earlierFiles"] = before.subtracting(shown).count
        }
        return Self.json(body)
    }
    private func messageBody(_ id: String) -> [String: Any] {
        var message: [String: Any] = ["id": id, "role": "user", "text": id]
        let owned: [String] = lock.withLock { fileOwners[id] ?? [] }
        if !owned.isEmpty { message["files"] = owned.map { (file: String) -> [String: Any] in fileBody(file) } }
        return message
    }
    private func fileBody(_ id: String) -> [String: Any] { ["id": id, "name": id + ".txt", "mime": "text/plain"] }
    /// Gives these messages the files with these IDs.
    func serveFiles(_ owners: [String: [String]]) { lock.withLock { fileOwners = owners } }
    /// Sets the message the person last read, as the server remembers it.
    func serveReadAnchor(_ id: String) { lock.withLock { readAnchor = id } }
    /// Mirrors `filesBefore`: the file-bearing messages before `before`.
    private func earlierFilesData(query: String?) -> Data {
        let history: [String] = lock.withLock { self.history ?? [] }
        var before: String?
        for item in URLComponents(string: "?" + (query ?? ""))?.queryItems ?? [] where item.name == "before" { before = item.value }
        let end: Int = before.flatMap { history.firstIndex(of: $0) } ?? history.count
        var messages: [[String: Any]] = []
        for id in history[..<end] where !lock.withLock({ fileOwners[id] ?? [] }).isEmpty {
            var message = messageBody(id)
            message["text"] = nil
            messages.append(message)
        }
        return Self.json(["messages": messages])
    }
    /// Mirrors the app server's `historyWindow` for a history where every message starts a turn.
    private static func window(_ ids: [String], query: String?) -> (ids: [String], earlier: Int) {
        guard let query else { return (ids, 0) }
        let items: [URLQueryItem] = URLComponents(string: "?" + query)?.queryItems ?? []
        var start: String?
        var turns = 0
        for item in items {
            if item.name == "start" { start = item.value }
            if item.name == "turns", let value = item.value, let count = Int(value) { turns = count }
        }
        var end = ids.count
        if let start, let index = ids.firstIndex(of: start) { end = index } else { turns = max(turns, 20) }
        let from: Int = max(0, end - turns)
        return (Array(ids[from...]), from)
    }
    /// Makes the conversation answer with these message IDs, windowed by each request's query.
    /// The reader starts at the latest message.
    func serveHistory(_ ids: [String]) { lock.withLock { history = ids; readAnchor = ids.last ?? readAnchor } }
    func appendHistory(_ id: String) { lock.withLock { history?.append(id) } }
    /// Holds only the next request to this path, so a later one can overtake it.
    func holdNext(_ path: String) { _ = lock.withLock { heldOnce.insert(path) } }
    /// The query of each conversation request, in order.
    var conversationQueries: [String] {
        var queries: [String] = []
        for request in requests where request.url?.path.hasSuffix("/conversation") == true {
            queries.append(request.url?.query ?? "")
        }
        return queries
    }
    private func finish(_ protocolInstance: NativeMockProtocol) {
        let request = protocolInstance.request, path = request.url!.path
        var status = 200, data = Self.json(["ok": true])
        if path == "/api/auth/config" {
            status = lock.withLock { authConfigStatus }
            data = status == 200 ? Self.json(["googleClientId": "google", "localDevAuth": false, "nativeAuthVersion": 1]) : Self.json(["error": "Synthetic config outage"])
        }
        else if path == "/api/auth/native/exchange" { data = Self.json(["token": "replacement-session", "expiresAt": "2026-10-07T09:08:21.125Z", "user": ["id": "one", "name": "One", "email": "one@example.test"]]) }
        else if request.httpMethod == "GET", lock.withLock({ assistantsChanged > 0 ? { assistantsChanged -= 1; return true }() : false }) {
            status = 503; data = Self.errorBody("Assistants changed while this loaded. Try again.", code: "assistants_changed")
        }
        else if path == "/api/bootstrap" {
            let failure = lock.withLock { (status: bootstrapStatus, code: bootstrapCode) }
            status = failure.status
            data = status == 200 ? bootstrapData() : Self.errorBody("Sign in required", code: failure.code)
        }
        else if path.hasPrefix("/api/bots/bot/") && lock.withLock({ botHidden }) { status = 404; data = Self.errorBody("Assistant not found", code: "assistant_not_found") }
        else if path == "/api/bots/bot/files" { data = earlierFilesData(query: request.url?.query) }
        else if path.hasSuffix("/conversation") {
            status = lock.withLock { conversationStatus }
            let anchored: Bool = lock.withLock {
                guard failAnchoredOnce, request.url?.query?.hasPrefix("start=") == true else { return false }
                failAnchoredOnce = false
                return true
            }
            if anchored { status = 503 }
            data = status == 200 ? conversationData(request.url!.pathComponents.dropLast().last ?? "bot", query: request.url?.query) : Self.json(["error": "Synthetic conversation outage"])
        }
        else if path.hasSuffix("/draft") && request.httpMethod == "PUT" && lock.withLock({ draftSavesFail }) {
            status = 500; data = Self.json(["error": "Synthetic save failure"])
        }
        else if path.hasSuffix("/draft") {
            let bot = request.url!.pathComponents.dropLast().last ?? ""
            if let versioned = versionedDraft(request, bot: bot) { (status, data) = versioned }
            // An older server answers a save with the draft it saved.
            else if request.httpMethod == "PUT", let body = Self.body(request) { data = body }
            else { data = Self.json(["text": "server draft for \(user)", "attachments": []]) }
        }
        else if path.hasSuffix("/messages") {
            status = sendStatus
            let payload = Self.body(request).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            if status == 200, let text = payload?["text"] as? String {
                clearDraft(request.url!.pathComponents.dropLast().last ?? "", sent: text, base: payload?["draftBaseRevision"] as? Int)
            }
            data = status == 200 ? Self.json(["requestId": payload?["requestId"] as? String ?? "missing", "status": "accepted", "runId": "run-one"]) : Self.json(["error": "Synthetic admission failure"])
        } else if path.hasSuffix("/uploads") { data = Self.json(["id": "file.signature", "name": "note.txt", "mime": "text/plain"]) }
        else if path == "/api/preferences" { data = Self.body(request) ?? Data() }
        else if path == "/api/auth/logout" {
            let failure = lock.withLock { (status: logoutStatus, code: logoutCode) }
            status = failure.status
            if status != 200 { data = Self.errorBody("Sign in required", code: failure.code) }
        }
        else if path.hasPrefix("/api/hermes/upgrade") {
            status = lock.withLock { upgradeResponseStatus }
            data = status == 200 ? Self.json(["available": true, "phase": "ready", "current": ["revision": "current"], "candidate": ["revision": "candidate"], "message": "Update checked", "checks": [["id": "compatibility", "label": "Compatibility", "status": "passed"]], "canCheck": true, "canInstall": true, "canRetry": true, "canCancel": false, "canRestartService": true, "operationId": "failed-update", "busyBots": []]) : Self.json(["error": "Synthetic update failure"])
        }
        let validation = lock.withLock { () -> (etag: String, notModified: Bool)? in
            guard etags, request.httpMethod == "GET", status == 200 else { return nil }
            let etag = "W/\"" + Data(SHA256.hash(data: data)).base64URLEncoded.prefix(27) + "\""
            let notModified = forcedNotModified > 0 || request.value(forHTTPHeaderField: "If-None-Match") == etag
            if notModified { forcedNotModified = max(0, forcedNotModified - 1); notModifiedCount += 1 }
            return (etag, notModified)
        }
        if let validation {
            protocolInstance.respond(status: validation.notModified ? 304 : 200, data: validation.notModified ? Data() : data, headers: ["ETag": validation.etag])
            return
        }
        let answer = { protocolInstance.respond(status: status, data: data) }
        let park = lock.withLock { () -> Bool in
            guard delayedPaths.contains(path) else { return false }
            delayedPaths.remove(path); delayed[path] = answer; return true
        }
        if !park { answer() }
    }
    static func errorBody(_ message: String, code: String?) -> Data {
        json(code.map { ["error": message, "code": $0] } ?? ["error": message])
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
    /// A store that has only a saved server address, like a fresh launch.
    private func launchedStore(_ server: NativeMockServer, token: String?) -> AppStore {
        let value = AppStore(); value.host = server.origin.absoluteString
        let api = client(server); api.token = token
        value.makeClient = { _ in api }
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

    func testAnAssistantThatBecomesSomeoneElsesPersonalOneReturnsHomeAndStopsAsking() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        server.hideBot()
        await value.refreshConversation()
        XCTAssertNil(value.selectedBotId); XCTAssertNil(value.conversation); XCTAssertEqual(value.leftBotId, "bot")
        XCTAssertEqual(value.notice, "That assistant is no longer available to you.")
        XCTAssertNil(value.error); XCTAssertFalse(value.appUnavailable)
        await value.refreshBootstrap()
        XCTAssertNil(value.selectedBotId, "home stays open instead of opening another assistant")
        let reads = server.requestCount("/api/bots/bot/conversation")
        await value.refreshConversation()
        XCTAssertEqual(server.requestCount("/api/bots/bot/conversation"), reads)
        await value.select("family")
        XCTAssertNil(value.notice)
    }

    func testTheRosterDroppingTheOpenAssistantLeavesItAndAnOwnDeletionLeavesQuietly() async throws {
        for deleted in [false, true] {
            let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
            server.hideBot()
            if deleted { value.deletedBotId = "bot" }
            await value.refreshBootstrap()
            XCTAssertNil(value.selectedBotId)
            XCTAssertEqual(value.notice, deleted ? nil : "That assistant is no longer available to you.")
        }
    }

    func testMakingAnAssistantEveryoneSeesPersonalNeedsConfirmation() throws {
        let shared = Bot(id: "family", name: "Family", model: "test", shared: true, activity: .idle)
        var mine = shared; mine.shared = false; mine.ownerId = "one"
        var legacy = shared; legacy.shared = false
        for (bot, expected) in [(shared, true), (legacy, true), (mine, false)] {
            var input = BotInput(bot: bot); input.shared = false
            XCTAssertEqual(input.hidesFromHousehold(bot), expected, bot.ownerId ?? String(bot.shared))
        }
        var input = BotInput(bot: nil); input.shared = false
        XCTAssertFalse(input.hidesFromHousehold(nil), "a new assistant hides nothing from anyone")
        let encoded = { (value: BotInput) in try JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as? [String: Any] ?? [:] }
        XCTAssertNil(try encoded(input)["confirmPrivate"])
        input.confirmPrivate = true
        XCTAssertEqual(try encoded(input)["confirmPrivate"] as? Bool, true)
    }

    func testAMissingGroupKeepsNoPrivateIdentityAndPrivateRoutinesNotifyOnlyTheOwner() {
        let room = GroupRoom(room_id: "ledger", name: "Ledger room", members: [GroupMember(member_id: "zq-ledger", profile: "zq-ledger", handle: "zq-ledger", display_name: "Moonlit Saddle Ledger")])
        XCTAssertEqual(GroupConversationView.identity(room, missing: false).members, "Moonlit Saddle Ledger (@zq-ledger)")
        let gone = GroupConversationView.identity(room, missing: true)
        XCTAssertEqual(gone.title, "Group chat"); XCTAssertNil(gone.members)
        let household = [Member(id: "one", name: "One", email: "one@example.test"), Member(id: "two", name: "Two", email: "two@example.test")]
        var bot = Bot(id: "books", name: "Books", model: "test", shared: true, activity: .idle)
        XCTAssertEqual(bot.routineRecipients(household).map(\.id), ["one", "two"])
        bot.shared = false; bot.ownerId = "one"
        XCTAssertEqual(bot.routineRecipients(household).map(\.id), ["one"])
    }

    func testAReadRacingAnAssistantTurningPrivateIsReadAgainOnce() async throws {
        let server = NativeMockServer(), api = client(server); defer { clean(server) }
        server.answerAssistantsChanged(times: 1)
        let _: Bootstrap = try await api.get("/bootstrap")
        XCTAssertEqual(server.requestCount("/api/bootstrap"), 2)
        server.answerAssistantsChanged(times: 2)
        do { let _: Bootstrap = try await api.get("/bootstrap"); XCTFail("A second change in a row is reported") }
        catch { XCTAssertEqual((error as? APIError)?.code, "assistants_changed") }
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

    func testOnlyTheServersSessionExpiredCodeSignsThePersonOut() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        server.failBootstrap(status: 401)
        await value.refreshBootstrap()
        XCTAssertEqual(value.api?.token, "synthetic-native-session")
        XCTAssertFalse(value.sessionExpired); XCTAssertEqual(value.error, "Sign in required")
        server.failBootstrap(status: 401, code: "other_failure")
        await value.refreshBootstrap()
        XCTAssertEqual(value.api?.token, "synthetic-native-session"); XCTAssertFalse(value.sessionExpired)
        server.failBootstrap(status: 403, code: "session_expired")
        await value.refreshBootstrap()
        XCTAssertFalse(value.sessionExpired, "The code only counts on a 401")
        server.failBootstrap(status: 401, code: "session_expired")
        await value.refreshBootstrap()
        XCTAssertNil(value.api?.token); XCTAssertTrue(value.sessionExpired)
    }

    func testStoredSignInOpensWithoutAuthConfigAndRetriesAfterAnOutage() async throws {
        let server = NativeMockServer(), value = launchedStore(server, token: "synthetic-native-session"); defer { clean(server, value) }
        server.failAuthConfig(); server.setOffline(true)
        await value.restore(); value.suspend()
        XCTAssertNotNil(value.api); XCTAssertNil(value.bootstrap); XCTAssertNotNil(value.error)
        XCTAssertEqual(server.requestCount("/api/auth/config"), 0, "A stored sign-in must not depend on auth config")
        server.setOffline(false)
        await value.resume(); value.suspend()
        XCTAssertEqual(value.bootstrap?.user.id, "one"); XCTAssertEqual(value.selectedBotId, "bot")
        XCTAssertNil(value.error); XCTAssertFalse(value.restoring)
        XCTAssertEqual(server.requestCount("/api/auth/config"), 0)
    }

    func testPollingRefreshesBootstrapOnlyWhenDueButTheConversationEveryPass() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        var time = ContinuousClock.now
        value.now = { time }
        let bootstraps = { server.requestCount("/api/bootstrap") }
        let polls = { server.conversationQueries.count }
        let tick = { (seconds: Double) in time += .seconds(seconds); _ = await value.pollOnce() }
        _ = await value.pollOnce()
        XCTAssertEqual(bootstraps(), 1, "A fresh poll loop starts from current data")
        for _ in 0..<30 { await tick(1.5) }
        XCTAssertEqual(bootstraps(), 1, "Bootstrap must not ride the 1.5 second conversation cadence")
        XCTAssertEqual(polls(), 31)
        await tick(30)
        XCTAssertEqual(bootstraps(), 2, "The slow timer refreshes bootstrap about once a minute")
        await value.refreshBootstrap()
        await tick(59)
        XCTAssertEqual(bootstraps(), 3, "An action's refresh restarts the timer")
        await tick(2)
        XCTAssertEqual(bootstraps(), 4)
        value.suspend(); _ = await value.pollOnce()
        XCTAssertEqual(bootstraps(), 5, "Returning to the foreground refreshes at once")
        XCTAssertEqual(polls(), 35)
    }

    func testPollingKeepsRefreshingBootstrapWhileTheServerIsDisconnectedOrFailing() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        var time = ContinuousClock.now
        value.now = { time }
        _ = await value.pollOnce()
        let bootstraps = { server.requestCount("/api/bootstrap") }
        server.disconnect(); await value.refreshBootstrap()
        var expected = bootstraps()
        for _ in 0..<2 {
            time += .seconds(1.5); _ = await value.pollOnce(); expected += 1
            XCTAssertEqual(bootstraps(), expected, "Recovery from a runtime disconnect needs bootstrap")
        }
        server.disconnect(false)
        time += .seconds(1.5); _ = await value.pollOnce(); expected += 1
        XCTAssertEqual(bootstraps(), expected)
        time += .seconds(1.5); _ = await value.pollOnce()
        XCTAssertEqual(bootstraps(), expected, "Once connected again, bootstrap goes back to the slow timer")
        server.failConversation(); time += .seconds(1.5); _ = await value.pollOnce()
        XCTAssertFalse(value.connected)
        server.failConversation(false)
        time += .seconds(1.5); _ = await value.pollOnce(); expected += 1
        XCTAssertEqual(bootstraps(), expected, "An outage clears only through bootstrap")
        XCTAssertTrue(value.connected)
    }

    private func ids(_ range: ClosedRange<Int>) -> [String] { range.map { String(format: "m%02d", $0) } }

    func testConversationRequestsAreWindowedAndEarlierHistoryExtendsTheWindow() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        server.serveHistory(ids(1...30))
        await value.refreshConversation()
        XCTAssertEqual(server.conversationQueries, ["turns=20"])
        XCTAssertEqual(value.conversation?.messages.first?.id, "m11"); XCTAssertEqual(value.conversation?.earlier, 10)
        await value.loadEarlier()
        XCTAssertEqual(server.conversationQueries.last, "start=m11&turns=20")
        XCTAssertEqual(value.conversation?.messages.count, 30)
        await value.refreshConversation()
        XCTAssertEqual(server.conversationQueries.last, "start=m01", "Polling keeps the loaded window")
        let requests = server.conversationQueries.count
        await value.loadEarlier()
        XCTAssertEqual(server.conversationQueries.count, requests, "Nothing is requested once the start is loaded")
        server.user = "two"; await value.refreshBootstrap()
        XCTAssertEqual(server.conversationQueries.dropFirst(requests).first, "turns=20", "Another person starts from the latest page")
    }

    func testNewTurnsBetweenPollsDoNotSlideTheWindowPastTheTurnBeingRead() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        server.serveHistory(ids(1...25))
        await value.refreshConversation()
        XCTAssertEqual(value.conversation?.messages.first?.id, "m06")
        for next in 26...28 {
            server.appendHistory(String(format: "m%02d", next))
            await value.refreshConversation()
            XCTAssertEqual(server.conversationQueries.last, "start=m06")
            XCTAssertEqual(value.conversation?.messages.first?.id, "m06", "The oldest loaded turn stays put")
            XCTAssertEqual(value.conversation?.messages.last?.id, String(format: "m%02d", next))
        }
    }

    func testAPollThatAnsweredLateCannotReplaceExpandedHistory() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        server.serveHistory(ids(1...30))
        await value.refreshConversation()
        let path = "/api/bots/bot/conversation"
        server.holdNext(path)
        let poll = Task { await value.refreshConversation() }
        try await server.waitForHeld(path)
        await value.loadEarlier()
        XCTAssertEqual(value.conversation?.messages.count, 30)
        server.release(path); await poll.value
        XCTAssertEqual(value.conversation?.messages.count, 30, "The late response asked for the narrower window")
        await value.refreshConversation()
        XCTAssertEqual(server.conversationQueries.last, "start=m01")
    }

    func testFilesFromBeforeTheWindowLoadOnDemandAndMergeWithoutDuplicates() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        server.serveHistory(ids(1...30))
        server.serveFiles(["m02": ["old.txt"], "m05": ["old.txt", "older.txt"], "m12": ["new.txt"], "m11": ["old.txt"]])
        await value.refreshConversation()
        XCTAssertEqual(value.conversation?.earlierFiles, 1, "Only older.txt exists solely before the window")
        XCTAssertEqual(value.conversationFiles.map(\.id), ["old.txt", "new.txt"])
        XCTAssertTrue(value.hasConversationFiles)
        await value.loadEarlierFiles()
        // The unsaved draft also saves meanwhile, so only file requests count here.
        let files = { server.requests.filter { $0.url?.path == "/api/bots/bot/files" } }
        XCTAssertEqual(files().last?.url?.query, "before=m11")
        XCTAssertEqual(value.conversationFiles.map(\.id).sorted(), ["new.txt", "old.txt", "older.txt"], "Merged by ID")
        let requests = files().count
        await value.loadEarlierFiles()
        XCTAssertEqual(files().count, requests, "A fetched list is not fetched again")
        await value.loadEarlier()
        XCTAssertEqual(value.conversation?.earlierFiles, 0)
        XCTAssertEqual(value.conversationFiles.map(\.id).sorted(), ["new.txt", "old.txt", "older.txt"])
    }

    func testFileListStaysAvailableWhenOnlyEarlierTurnsHaveFiles() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        server.serveHistory(ids(1...30)); server.serveFiles(["m03": ["only.txt"]])
        await value.refreshConversation()
        XCTAssertTrue(value.conversationFiles.isEmpty)
        XCTAssertTrue(value.hasConversationFiles, "The list must not hide while older files wait to load")
        await value.loadEarlierFiles()
        XCTAssertEqual(value.conversationFiles.map(\.id), ["only.txt"])
    }

    func testASavedReadingPositionOlderThanTheLatestPageOpensTheWindowThatEndsAtIt() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        server.serveHistory(ids(1...60)); server.serveReadAnchor("m35")
        await value.refreshConversation()
        XCTAssertEqual(server.conversationQueries, ["turns=20", "start=m35&turns=20"])
        XCTAssertEqual(value.conversation?.restorableReadAnchor(value.readMessageId()), "m35")
        XCTAssertEqual(value.conversation?.messages.first?.id, "m15", "The page reaches back 20 turns from the saved message")
        await value.refreshConversation()
        XCTAssertEqual(server.conversationQueries.last, "start=m15", "The window stays where the position put it")
    }

    func testAFailedSavedPositionFetchKeepsRestorationPendingUntilThePollRetries() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        var time = ContinuousClock.now
        value.now = { time }
        server.serveHistory(ids(1...60)); server.serveReadAnchor("m35")
        server.failNextAnchoredConversation()
        await value.refreshConversation()
        XCTAssertTrue(value.conversation?.messages.isEmpty ?? true, "The latest page must not stand in for the saved position")
        XCTAssertNotNil(value.error); XCTAssertFalse(value.connected)
        XCTAssertFalse(server.requests.contains { $0.url?.path.hasSuffix("/read-position") == true })
        time += .seconds(2); _ = await value.pollOnce()
        XCTAssertEqual(server.conversationQueries, ["turns=20", "start=m35&turns=20", "turns=20", "start=m35&turns=20"])
        XCTAssertEqual(value.conversation?.restorableReadAnchor(value.readMessageId()), "m35")
        XCTAssertTrue(value.connected)
    }

    func testRecentOrMissingReadingPositionsStayOnTheLatestPage() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        server.serveHistory(ids(1...60)); server.serveReadAnchor("m58")
        await value.refreshConversation()
        XCTAssertEqual(server.conversationQueries, ["turns=20"])
        XCTAssertEqual(value.conversation?.restorableReadAnchor(value.readMessageId()), "m58")
    }

    func testFailedEarlierHistoryReportsWithoutMarkingTheServerUnavailable() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        server.serveHistory(ids(1...30))
        await value.refreshConversation()
        server.failConversation(); await value.loadEarlier()
        XCTAssertNotNil(value.error); XCTAssertTrue(value.connected)
        XCTAssertEqual(value.conversation?.messages.first?.id, "m11")
        server.failConversation(false); await value.refreshConversation()
        XCTAssertEqual(server.conversationQueries.last, "start=m11", "A failed page leaves the window where it was")
    }

    func testForegroundResumeOnlyRetriesALaunchThatHasNoBootstrap() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        let fresh = AppStore(); await fresh.resume()
        XCTAssertNil(fresh.api, "Nothing to retry before a server is chosen")
        value.sessionExpired = true; value.bootstrap = nil
        let before = server.requests.count
        await value.resume()
        XCTAssertEqual(server.requests.count, before, "An expired session needs sign-in, not a retry")
    }

    func testSignInConfigIsFetchedLazilyAndRecoversAfterAnOutage() async throws {
        let server = NativeMockServer(), value = launchedStore(server, token: nil); defer { clean(server, value) }
        server.failAuthConfig()
        await value.restore()
        XCTAssertNotNil(value.api); XCTAssertNil(value.authConfig); XCTAssertNotNil(value.error)
        do { try await value.ensureAuthConfig(); XCTFail("The outage should surface") } catch {}
        server.failAuthConfig(false)
        await value.restore()
        XCTAssertEqual(value.authConfig?.nativeAuthVersion, 1); XCTAssertNil(value.error)
        let requests = server.requestCount("/api/auth/config")
        try await value.ensureAuthConfig()
        XCTAssertEqual(server.requestCount("/api/auth/config"), requests, "A loaded config is reused")
    }

    func testChangeServerStillWorksWhenLogoutCannotBeConfirmed() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        let api = value.api
        server.failLogout()
        let confirmed = await value.changeConnection()
        XCTAssertFalse(confirmed); XCTAssertNotNil(value.api); XCTAssertEqual(api?.token, "synthetic-native-session")
        let local = await value.changeConnection(localOnly: true)
        XCTAssertTrue(local); XCTAssertNil(value.api); XCTAssertNil(api?.token); XCTAssertNil(value.bootstrap)
        XCTAssertTrue(value.error?.contains("stays valid there until it expires") == true)
    }

    func testChangeServerTreatsAnAlreadyExpiredSessionAsSignedOut() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        server.failLogout(status: 401, code: "session_expired")
        let changed = await value.changeConnection()
        XCTAssertTrue(changed); XCTAssertNil(value.api); XCTAssertNil(value.error)
    }

    func testDiscardingAnUnconfirmedSendReturnsItsTextToThatAssistantsDraft() async throws {
        // The draft still holds the text, or the person kept editing, or emptied it.
        for edit in [nil, "Send this and more", ""] as [String?] {
            let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
            server.sendStatus = 503; await value.send()
            XCTAssertNotNil(value.pending)
            if let edit { value.draft.text = edit }
            value.discardUnconfirmedSubmission()
            XCTAssertNil(value.pending); XCTAssertNil(value.receipt); XCTAssertTrue(value.canSend)
            XCTAssertNil(UserDefaults.standard.data(forKey: value.key("pending")!))
            XCTAssertEqual(value.draft.text, edit == "Send this and more" ? "Send this and more" : "Send this")
            try await Task.sleep(for: .milliseconds(800))
            let saved = server.requests.last { $0.httpMethod == "PUT" && $0.url?.path == "/api/bots/bot/draft" }
            XCTAssertEqual(saved.flatMap(NativeMockServer.body).flatMap { try? JSONDecoder().decode(Draft.self, from: $0) }?.text, value.draft.text)
        }
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        value.draft.text = "Typed after"
        value.pending = PendingSubmission(requestId: "lost", botId: "bot", text: "Lost message", attachments: [FileRef(id: "a", name: "a.txt", mime: "text/plain")], reviewedInterruption: false)
        value.discardUnconfirmedSubmission()
        XCTAssertEqual(value.draft.text, "Lost message\n\nTyped after"); XCTAssertEqual(value.draft.attachments.map(\.id), ["a"])
    }

    func testDiscardingAnotherAssistantsUnconfirmedSendWorksOfflineAndLandsInItsDraft() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        value.pending = PendingSubmission(requestId: "lost", botId: "other", text: "Lost message", attachments: [], reviewedInterruption: false)
        server.setOffline(true)
        value.discardUnconfirmedSubmission()
        XCTAssertNil(value.pending); XCTAssertEqual(value.draft.text, "Send this", "The open assistant's draft is untouched")
        let saved = UserDefaults.standard.data(forKey: value.key("draft", "other")!).flatMap { try? JSONDecoder().decode(Draft.self, from: $0) }
        XCTAssertEqual(saved?.text, "Lost message"); XCTAssertEqual(saved?.dirty, true)
        server.setOffline(false)
        await value.select("other")
        XCTAssertEqual(value.draft.text, "Lost message")
    }

    func testDiscardWhileTheAssistantsDraftIsStillLoadingSurvivesTheLateRead() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        UserDefaults.standard.removeObject(forKey: value.key("draft", "bot")!)
        value.draft = Draft(); value.draftReady = false
        value.pending = PendingSubmission(requestId: "lost", botId: "bot", text: "Lost message", attachments: [FileRef(id: "a", name: "a.txt", mime: "text/plain")], reviewedInterruption: false)
        let path = "/api/bots/bot/draft"; server.hold(path)
        let reopen = Task { await value.select("bot") }
        try await server.waitForHeld(path)
        value.discardUnconfirmedSubmission()
        XCTAssertNil(value.pending)
        let stored = UserDefaults.standard.data(forKey: value.key("draft", "bot")!).flatMap { try? JSONDecoder().decode(Draft.self, from: $0) }
        XCTAssertEqual(stored?.text, "Lost message", "The recovered text is saved before the read returns")
        server.release(path); await reopen.value
        XCTAssertEqual(value.draft.text, "Lost message"); XCTAssertEqual(value.draft.attachments.map(\.id), ["a"])
        XCTAssertTrue(value.draftReady); XCTAssertTrue(value.canSend)
        try await Task.sleep(for: .milliseconds(900))
        let sync = server.requests.last { $0.httpMethod == "PUT" && $0.url?.path == path }
        XCTAssertEqual(sync.flatMap(NativeMockServer.body).flatMap { try? JSONDecoder().decode(Draft.self, from: $0) }?.text, "Lost message", "The recovered draft is synced to the server")
        XCTAssertEqual(value.draft.dirty, false, "A successful sync clears dirty so newer web drafts can load again")
        let synced = UserDefaults.standard.data(forKey: value.key("draft", "bot")!).flatMap { try? JSONDecoder().decode(Draft.self, from: $0) }
        XCTAssertEqual(synced?.dirty, false)
        XCTAssertNil(UserDefaults.standard.data(forKey: value.key("recovered", "bot")!), "The recovery mark clears once the server has the draft")
    }

    func testALeftoverDirtyDraftSavesOnItsBaseOnceLoaded() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        server.versionDrafts(text: "Server copy", revision: 1)
        let leftover = Draft(text: "Old unsent text", attachments: [], dirty: true, baseRevision: 1)
        UserDefaults.standard.set(try JSONEncoder().encode(leftover), forKey: value.key("draft", "bot")!)
        value.draftReady = false
        await value.select("bot")
        XCTAssertEqual(value.draft.text, "Old unsent text"); XCTAssertTrue(value.draftReady)
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(server.draftSaves(), [.init(text: "Old unsent text", baseRevision: 1)], "Saved on its base, so a changed server copy refuses it")
    }

    func testARevertSavesAgainAfterAnOlderSaveLands() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        server.versionDrafts(text: "A", revision: 1)
        value.draft = Draft(text: "A", attachments: [], dirty: false, baseRevision: 1, baseHash: Draft.contentHash("A", []))
        let path = "/api/bots/bot/draft"; server.hold(path)
        value.updateDraft(Draft(text: "AB", attachments: []))
        try await server.waitForHeld(path)
        value.updateDraft(Draft(text: "A", attachments: []))
        try await Task.sleep(for: .milliseconds(800))
        server.release(path)
        try await Task.sleep(for: .milliseconds(300))
        await value.refreshConversation()
        XCTAssertEqual(server.draftRecord()?["text"] as? String, "A", "Another device sees the revert")
        XCTAssertEqual(value.draft.dirty, false)
    }

    func testAStaleDraftFromAnEarlierSessionIsDroppedOnceAnotherDeviceSentIt() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        server.versionDrafts(text: "Old unsent text", revision: 1)
        server.otherDevice(sends: "Old unsent text")
        // Marked unsaved, but unchanged since the revision it was loaded on.
        let stale = Draft(text: "Old unsent text", attachments: [], dirty: true, baseRevision: 1, baseHash: Draft.contentHash("Old unsent text", []))
        UserDefaults.standard.set(try JSONEncoder().encode(stale), forKey: value.key("draft", "bot")!)
        value.draftReady = false
        await value.select("bot")
        XCTAssertEqual(value.draft, Draft(text: "", attachments: [], dirty: false, baseRevision: 2, baseHash: Draft.contentHash("", [])))
        value.updateDraft(Draft(text: "Fresh", attachments: []))
        try await Task.sleep(for: .milliseconds(900))
        XCTAssertEqual(server.draftSaves(), [.init(text: "Fresh", baseRevision: 2)], "The sent text is never saved back")
        XCTAssertEqual(server.draftRecord()?["text"] as? String, "Fresh")
    }

    func testDifferentTextTypedOfflineSurvivesASendOfTheSharedDraftElsewhere() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        server.versionDrafts(text: "Shared plan", revision: 1)
        server.otherDevice(sends: "Shared plan")
        let offline = Draft(text: "Offline note", attachments: [], dirty: true, baseRevision: 1, baseHash: Draft.contentHash("Shared plan", []))
        UserDefaults.standard.set(try JSONEncoder().encode(offline), forKey: value.key("draft", "bot")!)
        value.draftReady = false
        await value.select("bot")
        XCTAssertEqual(value.draft.text, "Offline note")
        try await Task.sleep(for: .milliseconds(900))
        XCTAssertEqual(server.draftSaves(), [.init(text: "Offline note", baseRevision: 2)])
        XCTAssertEqual(server.draftRecord()?["text"] as? String, "Offline note")
    }

    func testSwitchingAssistantsOrLeavingSavesAPendingEditAtOnce() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        server.versionDrafts(); server.versionDrafts("other")
        value.draft = Draft(baseRevision: 0)
        value.updateDraft(Draft(text: "Pick up feed", attachments: []))
        await value.select("other")
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(server.draftSaves(), [.init(text: "Pick up feed", baseRevision: 0)])
        let cached = UserDefaults.standard.data(forKey: value.key("draft", "bot")!).flatMap { try? JSONDecoder().decode(Draft.self, from: $0) }
        XCTAssertEqual(cached?.dirty, false); XCTAssertEqual(cached?.baseRevision, 1)
        // Another device sends the saved text.
        server.otherDevice(sends: "Pick up feed")
        await value.select("bot")
        XCTAssertEqual(value.draft.text, ""); XCTAssertEqual(value.draft.baseRevision, 2)
        value.updateDraft(Draft(text: "Before leaving", attachments: []))
        value.suspend()
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(server.draftSaves().last, .init(text: "Before leaving", baseRevision: 2))
        XCTAssertEqual(value.draft.dirty, false)
    }

    func testAnEditTypedHereWinsOverANewerEditFromAnotherDevice() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        server.versionDrafts(text: "Start", revision: 1)
        value.draft = Draft(text: "Start", attachments: [], dirty: false, baseRevision: 1)
        server.otherDevice(edits: "Phone words")
        value.updateDraft(Draft(text: "Typed here", attachments: []))
        try await Task.sleep(for: .milliseconds(900))
        XCTAssertEqual(server.draftSaves(), [.init(text: "Typed here", baseRevision: 1), .init(text: "Typed here", baseRevision: 2)])
        XCTAssertEqual(server.draftRecord()?["revision"] as? Int, 3)
        XCTAssertEqual(value.draft, Draft(text: "Typed here", attachments: [], dirty: false, baseRevision: 3, baseHash: Draft.contentHash("Typed here", [])))
        // While idle, polling brings in the next edit from the other device.
        server.otherDevice(edits: "Phone again")
        await value.refreshConversation()
        XCTAssertEqual(value.draft, Draft(text: "Phone again", attachments: [], dirty: false, baseRevision: 4, baseHash: Draft.contentHash("Phone again", [])))
    }

    func testLeavingSendsAnEditTypedDuringASlowSaveThatThenFails() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        server.versionDrafts(); server.versionDrafts("other")
        value.draft = Draft(baseRevision: 0, baseHash: Draft.contentHash("", []))
        let path = "/api/bots/bot/draft"; server.holdNext(path)
        value.updateDraft(Draft(text: "A", attachments: []))
        try await server.waitForHeld(path)
        value.updateDraft(Draft(text: "AB", attachments: []))
        try await Task.sleep(for: .milliseconds(700))
        await value.select("other")
        try await Task.sleep(for: .milliseconds(200))
        server.failHeld(path)
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(server.draftRecord()?["text"] as? String, "AB")
    }

    func testPollingWaitsForTheBackoffOfAFailingSave() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        server.versionDrafts(); server.failDraftSaves()
        value.draft = Draft(baseRevision: 0, baseHash: Draft.contentHash("", []))
        value.updateDraft(Draft(text: "A", attachments: []))
        try await Task.sleep(for: .milliseconds(700))
        XCTAssertEqual(server.draftSaves().count, 1)
        for _ in 0..<3 { await value.refreshConversation(); try await Task.sleep(for: .milliseconds(80)) }
        XCTAssertEqual(server.draftSaves().count, 1, "Polls do not retry before the backoff")
        try await Task.sleep(for: .milliseconds(1000))
        XCTAssertEqual(server.draftSaves().count, 2, "The backoff retries once")
    }

    func testANewEditAfterAdoptingTheServerDraftNeverReusesAnInFlightSequence() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        server.versionDrafts(); server.versionDrafts("other")
        value.draft = Draft(baseRevision: 0, baseHash: Draft.contentHash("", []))
        let path = "/api/bots/bot/draft"; server.holdNext(path)
        value.updateDraft(Draft(text: "A", attachments: []))
        try await server.waitForHeld(path)
        await value.send()
        await value.refreshConversation()
        XCTAssertEqual(value.draft.baseRevision, 1, "Adopted the send's clear")
        value.updateDraft(Draft(text: "B", attachments: []))
        await value.select("other")
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(server.draftSaves().last?.text, "B", "Leaving sends the new edit")
        server.failHeld(path)
    }

    func testAnEditTypedDuringAFailedSaveSavesAfterABackoff() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        server.versionDrafts()
        value.draft = Draft(baseRevision: 0, baseHash: Draft.contentHash("", []))
        let path = "/api/bots/bot/draft"; server.holdNext(path)
        value.updateDraft(Draft(text: "A", attachments: []))
        try await server.waitForHeld(path)
        value.updateDraft(Draft(text: "AB", attachments: []))
        try await Task.sleep(for: .milliseconds(700))
        server.failHeld(path)
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(server.draftRecord()?["revision"] as? Int, 0, "Nothing saved yet")
        try await Task.sleep(for: .milliseconds(1200))
        XCTAssertEqual(server.draftRecord()?["text"] as? String, "AB")
        XCTAssertEqual(value.draft.dirty, false)
    }

    func testTextSentWhileItsSaveWasInFlightIsNotRestoredByARetry() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        server.versionDrafts()
        value.draft = Draft(baseRevision: 0, baseHash: Draft.contentHash("", []))
        let draftPath = "/api/bots/bot/draft", sendPath = "/api/bots/bot/messages"
        server.hold(draftPath); server.delayResponse(sendPath)
        value.updateDraft(Draft(text: "Hello", attachments: []))
        try await server.waitForHeld(draftPath)
        let sending = Task { await value.send() }
        try await server.waitForDelayed(sendPath)
        XCTAssertEqual(server.draftRecord()?["reason"] as? String, "sent", "Accepted while its receipt is still on the way")
        server.release(draftPath)
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(server.draftSaves().count, 1, "The stale save's 409 is not retried")
        XCTAssertEqual(server.draftRecord()?["text"] as? String, "")
        XCTAssertEqual(value.draft.text, "")
        server.releaseResponse(sendPath); await sending.value
    }

    func testAMessageTypedRightAfterSendingSurvivesTheClearForThatSend() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        server.versionDrafts(text: "Send this", revision: 1)
        value.draft = Draft(text: "Send this", attachments: [], dirty: false, baseRevision: 1)
        await value.send()
        XCTAssertEqual(server.draftRecord()?["reason"] as? String, "sent")
        value.updateDraft(Draft(text: "Second message", attachments: []))
        try await Task.sleep(for: .milliseconds(900))
        XCTAssertEqual(server.draftRecord()?["text"] as? String, "Second message")
        XCTAssertEqual(value.draft.text, "Second message"); XCTAssertEqual(value.draft.dirty, false)
    }

    func testASendBeforeTheLastEditsSavedStillClearsTheServerDraft() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        server.versionDrafts(text: "Pick up fe", revision: 1)
        value.draft = Draft(text: "Pick up fe", attachments: [], dirty: false, baseRevision: 1)
        value.updateDraft(Draft(text: "Pick up feed", attachments: []))
        await value.send()
        XCTAssertEqual(server.draftSaves(), [], "The send went out before the edit was saved")
        XCTAssertEqual(server.draftRecord()?["reason"] as? String, "sent")
        await value.select("bot")
        XCTAssertEqual(value.draft.text, "")
    }

    func testARecoveredDraftSyncsOnItsBaseEvenAfterItsOwnSendCleared() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        // The discarded message did arrive and cleared the draft.
        server.versionDrafts(text: "Lost message", revision: 2)
        server.otherDevice(sends: "Lost message")
        value.pending = PendingSubmission(requestId: "lost", botId: "bot", text: "Lost message", attachments: [], reviewedInterruption: false)
        value.draft = Draft(text: "", attachments: [], dirty: false, baseRevision: 2); value.draftReady = false
        value.discardUnconfirmedSubmission()
        await value.select("bot")
        XCTAssertEqual(value.draft.text, "Lost message")
        try await Task.sleep(for: .milliseconds(900))
        XCTAssertEqual(server.draftSaves(), [.init(text: "Lost message", baseRevision: 3)])
        XCTAssertNil(UserDefaults.standard.data(forKey: value.key("recovered", "bot")!))
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

    func testConditionalGetsReuseTheValidatedBodyOnlyForTheSamePathAndIdentity() async throws {
        let server = NativeMockServer(), api = client(server); defer { clean(server) }
        server.serveETags()
        let first: Bootstrap = try await api.get("/bootstrap")
        XCTAssertNil(server.requests.last?.value(forHTTPHeaderField: "If-None-Match"))
        let second: Bootstrap = try await api.get("/bootstrap")
        XCTAssertTrue(server.requests.last?.value(forHTTPHeaderField: "If-None-Match")?.hasPrefix("W/\"") == true)
        XCTAssertEqual(server.requests.last?.cachePolicy, .reloadIgnoringLocalCacheData)
        XCTAssertEqual(server.notModified, 1); XCTAssertEqual(second.user.id, first.user.id)
        let _: Conversation = try await api.get("/bots/bot/conversation")
        XCTAssertNil(server.requests.last?.value(forHTTPHeaderField: "If-None-Match"), "Each path validates only its own body")
        let _: EmptyResponse = try await api.write("/auth/logout", [String: String]())
        XCTAssertNil(server.requests.last?.value(forHTTPHeaderField: "If-None-Match"), "Writes never send validators")
        server.user = "two"
        let changed: Bootstrap = try await api.get("/bootstrap")
        XCTAssertEqual(changed.user.id, "two"); XCTAssertEqual(server.notModified, 1)
        let _: Bootstrap = try await api.get("/bootstrap")
        XCTAssertEqual(server.notModified, 2, "The changed body replaced the cached one")
        api.token = "another-native-session"
        let _: Bootstrap = try await api.get("/bootstrap")
        XCTAssertNil(server.requests.last?.value(forHTTPHeaderField: "If-None-Match"), "A new identity never reuses the previous body")
    }

    func testAResponseThatArrivesAfterAnIdentityChangeIsNotCached() async throws {
        let server = NativeMockServer(), api = client(server); defer { clean(server) }
        server.serveETags()
        let path = "/api/bootstrap"; server.hold(path)
        let operation = Task { () async throws -> Bootstrap in try await api.get("/bootstrap") }
        try await server.waitForHeld(path)
        api.token = "another-native-session"
        server.release(path)
        _ = try await operation.value
        let _: Bootstrap = try await api.get("/bootstrap")
        XCTAssertNil(server.requests.last?.value(forHTTPHeaderField: "If-None-Match"), "The previous identity's late body must not become the new identity's validator")
    }

    func testNotModifiedWithoutAValidatedBodyRetriesOnceInFull() async throws {
        let server = NativeMockServer(), api = client(server); defer { clean(server) }
        server.serveETags(); server.replyNotModified(times: 1)
        let value: Bootstrap = try await api.get("/bootstrap")
        XCTAssertEqual(value.user.id, "one")
        XCTAssertEqual(server.requests.count, 2)
        XCTAssertTrue(server.requests.allSatisfy { $0.value(forHTTPHeaderField: "If-None-Match") == nil })
        server.replyNotModified(times: 2)
        do { let _: Conversation = try await api.get("/bots/bot/conversation"); XCTFail("A repeated 304 must not loop") }
        catch let error as APIError { XCTAssertEqual(error.status, 304) }
        XCTAssertEqual(server.requests.count, 4)
    }

    func testSignOutDuringAConditionalGetFetchesAFreshBodyInsteadOfTheOldOne() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        let api = try XCTUnwrap(value.api)
        server.serveETags()
        let _: Bootstrap = try await api.get("/bootstrap")
        let path = "/api/bootstrap"; server.hold(path)
        let operation = Task { () async throws -> Bootstrap in try await api.get("/bootstrap") }
        try await server.waitForHeld(path)
        XCTAssertNotNil(server.requests.last?.value(forHTTPHeaderField: "If-None-Match"))
        let signedOut = await value.signOut(); XCTAssertTrue(signedOut)
        server.release(path)
        _ = try await operation.value
        let retry = try XCTUnwrap(server.requests.last)
        XCTAssertEqual(retry.url?.path, path)
        XCTAssertNil(retry.value(forHTTPHeaderField: "If-None-Match"), "The signed-out person's cached body is gone")
        XCTAssertNil(retry.value(forHTTPHeaderField: "Authorization"))
        XCTAssertEqual(server.requests.map { $0.url!.path }, [path, path, "/api/auth/logout", path])
    }

    func testUnreadableResponseKeepsTheFriendlyMessageAndAddsTheCodingPath() async throws {
        let server = NativeMockServer(), api = client(server); defer { clean(server) }
        do { let _: Bootstrap = try await api.get("/auth/config"); XCTFail("Expected a decoding failure") }
        catch let error as APIError {
            XCTAssertEqual(error.code, "INVALID_RESPONSE"); XCTAssertEqual(error.status, 502)
            XCTAssertTrue(error.message.contains("unreadable response")); XCTAssertEqual(error.detail, "user is missing")
        }
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

final class DraftMergeTests: XCTestCase {
    private func hash(_ text: String) -> String { Draft.contentHash(text, []) }
    private func server(_ text: String, _ revision: Int, sent: Int = 0) -> SavedDraft {
        SavedDraft(text: text, attachments: [], revision: revision, reason: sent == revision && revision > 0 ? "sent" : "edit", sentRevision: sent)
    }
    private func copy(_ text: String = "Typed here", dirty: Bool? = true, base: Int? = 2, baseHash: String? = nil, sentHash: String? = nil) -> Draft {
        Draft(text: text, attachments: [], dirty: dirty, baseRevision: base, baseHash: baseHash, sentHash: sentHash)
    }

    func testACleanCopyAdoptsTheServerDraft() {
        let merged = Draft.merge(copy(dirty: nil), with: server("From the phone", 3))
        XCTAssertEqual(merged.draft, Draft(text: "From the phone", attachments: [], dirty: false, baseRevision: 3, baseHash: hash("From the phone"))); XCTAssertFalse(merged.push)
        XCTAssertEqual(Draft.merge(copy(dirty: nil, base: nil), with: nil).draft, Draft(dirty: false, baseRevision: 0, baseHash: hash("")))
    }

    func testAnUnsavedCopyStillHoldingItsBaseContentIsDroppedAfterASend() {
        let merged = Draft.merge(copy(baseHash: hash("Typed here")), with: server("", 4, sent: 3))
        XCTAssertEqual(merged.draft, Draft(dirty: false, baseRevision: 4, baseHash: hash(""))); XCTAssertFalse(merged.push)
    }

    func testWorkChangedSinceItsBaseSurvivesASendElsewhere() {
        let offline = copy("Offline note", baseHash: hash("Shared plan"))
        let merged = Draft.merge(offline, with: server("", 3, sent: 3), authoritative: true)
        XCTAssertEqual(merged.draft, copy("Offline note", base: 3, baseHash: hash(""))); XCTAssertTrue(merged.push)
        XCTAssertEqual(Draft.merge(copy(base: nil), with: server("", 1, sent: 1)).draft.text, "Typed here", "A copy without a fingerprint is kept")
    }

    func testTheTextThisDeviceSentIsDroppedOnceTheServerShowsTheSend() {
        let sending = copy(base: 0, baseHash: hash(""), sentHash: hash("Typed here"))
        XCTAssertEqual(Draft.merge(sending, with: server("", 1, sent: 1)).draft, Draft(dirty: false, baseRevision: 1, baseHash: hash("")))
        let cleared = copy("", dirty: false, base: 0, sentHash: hash("Typed here"))
        XCTAssertEqual(Draft.merge(cleared, with: server("Typed here", 1)).draft, cleared, "A save from before the send is not adopted")
        XCTAssertEqual(Draft.merge(cleared, with: server("", 2, sent: 2)).draft.baseRevision, 2)
    }

    func testALaterDraftWithTheLastSentTextIsAdoptedOnceTheServerShowsThatSend() {
        // Sent "Continue" on revision 5 and missed the empty revision 6.
        var cleared = copy("", dirty: false, base: 5, sentHash: hash("Continue")); cleared.sentBase = 5
        let merged = Draft.merge(cleared, with: server("Continue", 7, sent: 6)).draft
        XCTAssertEqual(merged.text, "Continue"); XCTAssertNil(merged.sentHash)
        XCTAssertEqual(Draft.merge(cleared, with: server("Continue", 6, sent: 0)).draft, cleared, "Before the send shows, the guard holds")
    }

    func testEditsHereWinOverANewerEditAndSaveOnItsRevision() {
        let merged = Draft.merge(copy(), with: server("Phone edit", 5, sent: 1))
        XCTAssertEqual(merged.draft, copy(base: 5, baseHash: hash("Phone edit"))); XCTAssertTrue(merged.push)
    }

    func testUnsavedEditsOnAnUnchangedServerCopyAreLeftAlone() {
        let merged = Draft.merge(copy(), with: server("Older text", 2))
        XCTAssertEqual(merged.draft, copy()); XCTAssertFalse(merged.push)
        XCTAssertEqual(Draft.merge(copy(base: nil), with: SavedDraft(text: "Old server")).draft, copy(base: nil), "A server without revisions is revision 0")
    }

    func testMatchingTextIsMarkedSavedOnlyOnceNoOlderSaveIsInFlight() {
        XCTAssertEqual(Draft.merge(copy(base: 1), with: server("Typed here", 4)).draft, copy(dirty: false, base: 4, baseHash: hash("Typed here")))
        let waiting = Draft.merge(copy(base: 1), with: server("Typed here", 4), settled: false)
        XCTAssertEqual(waiting.draft, copy(base: 4, baseHash: hash("Typed here"))); XCTAssertFalse(waiting.push)
    }

    func testAnOlderResponseIsIgnoredUnlessItAnswersTheLatestEdit() {
        XCTAssertEqual(Draft.merge(copy(dirty: nil, base: 7), with: server("Older read", 6)).draft, copy(dirty: nil, base: 7))
        XCTAssertEqual(Draft.merge(copy(dirty: false, base: 3, baseHash: hash("Newer")), with: server("Older", 2)).draft.text, "Typed here",
                       "A late 409 from an older save leaves the newer copy")
        let restored = Draft.merge(copy(base: 7), with: server("Restored", 2), authoritative: true)
        XCTAssertEqual(restored.draft, copy(base: 2, baseHash: hash("Restored"))); XCTAssertTrue(restored.push, "After a database restore, edits still save")
    }

    func testASaveKeepsEditsTypedWhileItWasInFlight() {
        XCTAssertEqual(Draft.merge(copy("Typed", base: 1), with: server("Typed", 2)).draft, copy("Typed", dirty: false, base: 2, baseHash: hash("Typed")))
        XCTAssertEqual(Draft.merge(copy(base: 1), with: server("Typed", 2)).draft, copy(base: 2, baseHash: hash("Typed")))
    }

    func testASentCopyEmptiesButKeepsItsBase() {
        let submission = PendingSubmission(requestId: "r", botId: "bot", text: "Typed here", attachments: [], reviewedInterruption: false)
        XCTAssertEqual(copy(dirty: nil, base: 3, baseHash: "h", sentHash: "s").sent(submission), Draft(dirty: false, baseRevision: 3, baseHash: "h", sentHash: "s"))
        let more = copy("More", base: 3)
        XCTAssertEqual(more.sent(submission), more)
    }
}
