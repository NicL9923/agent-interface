import XCTest
import UserNotifications
import Foundation
import CryptoKit
import SwiftUI
@testable import AgentInterface

private final class NativeMockServer: FakeHost, @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [URLRequest] = []
    private var held: [String: FakeExchange] = [:]
    private var heldPaths: Set<String> = []
    /// Paths the server acts on at once but answers only when released, like a slow response.
    private var delayedPaths: Set<String> = []
    private var delayed: [String: () -> Void] = [:]
    private var currentUser = "one"
    private var messageStatus = 200
    private var uploadStatus = 200
    private var pushAvailable = true
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
    private var extraBot = false
    func addFamilyBot() { lock.withLock { extraBot = true } }
    private var assistantsChanged = 0
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
    func startRun(_ runId: String) { lock.withLock { run = runId; state = "thinking" } }
    func interrupt(runId: String) { lock.withLock { run = runId; state = "interrupted" } }
    func failUploads(_ fail: Bool) { lock.withLock { uploadStatus = fail ? 503 : 200 } }
    func configurePush(_ available: Bool) { lock.withLock { pushAvailable = available } }
    func failLogout(status: Int = 503, code: String? = nil) { lock.withLock { logoutStatus = status; logoutCode = code } }
    func failAuthConfig(_ fail: Bool = true) { lock.withLock { authConfigStatus = fail ? 503 : 200 } }
    /// Answers bootstrap with an error, like the app server's "sign in required" 401.
    func failBootstrap(status: Int, code: String? = nil) { lock.withLock { bootstrapStatus = status; bootstrapCode = code } }
    /// Drops every request as if the phone had no network.
    func setOffline(_ value: Bool) { lock.withLock { offline = value } }
    func requestCount(_ path: String) -> Int { requests.filter { $0.url?.path == path }.count }
    func disconnect(_ value: Bool = true) { lock.withLock { connected = !value } }
    /// Fails the next conversation request that starts at a message, as a saved reading position does.
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
    private var submissionAnswer: String?
    /// Answers submission checks with this status, as the app server does once it knows.
    func answerSubmissions(_ status: String?) { lock.withLock { submissionAnswer = status } }
    private var approvalRefusal: String?
    /// Answers approval decisions with a 409, as the app server does for one no longer pending.
    func refuseApprovals(_ message: String?) { lock.withLock { approvalRefusal = message } }
    func failHeld(_ path: String) {
        lock.withLock { () -> FakeExchange? in heldPaths.remove(path); return held.removeValue(forKey: path) }?
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
            .compactMap { FakeExchange.body($0).flatMap { try? JSONDecoder().decode(DraftSaveBody.self, from: $0) } }
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
            let body = FakeExchange.body(request).flatMap({ try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }),
            let text = body["text"] as? String, text != record["text"] as? String
        else { return (200, Self.json(record)) }
        if let base = body["baseRevision"] as? Int, base != record["revision"] as? Int {
            return (409, Self.json(["error": "This draft changed on another device.", "code": "draft_conflict", "draft": record]))
        }
        changeDraft(bot, text: text, reason: "edit")
        return (200, Self.json(draftRecord(bot)!))
    }
    private var streaming = false
    private var streams: [FakeExchange] = []
    /// Answers change-stream requests with an open stream instead of a JSON body.
    func serveEventStreams() { lock.withLock { streaming = true } }
    /// A change notice, as the server sends one when the conversation changes.
    func notifyChange() { for stream in lock.withLock({ streams }).filter({ $0.request.url?.path != "/api/events" }) { stream.send("data: change\n\n") } }
    func notifyInflight() {
        for stream in lock.withLock({ streams }).filter({ $0.request.url?.path != "/api/events" }) {
            stream.send("event: inflight\ndata: {\"botId\":\"bot\",\"message\":{\"id\":\"sid-inflight\",\"role\":\"assistant\",\"text\":\"Live native reply\"},\"activity\":{\"state\":\"thinking\",\"runId\":\"live-run\"},\"toolCalls\":[]}\n\n")
        }
    }
    func notifyRoster() { for stream in lock.withLock({ streams }).filter({ $0.request.url?.path == "/api/events" }) { stream.send("event: roster\ndata: roster\n\n") } }
    func receive(_ protocolInstance: FakeExchange) {
        let path = protocolInstance.request.url!.path
        if path.hasSuffix("/events"), lock.withLock({ streaming }) {
            lock.withLock { recorded.append(protocolInstance.request); streams.append(protocolInstance) }
            protocolInstance.openStream(); return
        }
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
        guard try await eventually({ lock.withLock { delayed[path] != nil } }) else { throw URLError(.timedOut) }
    }
    func release(_ path: String) {
        let pending = lock.withLock { () -> FakeExchange? in
            heldPaths.remove(path); return held.removeValue(forKey: path)
        }
        if let pending { finish(pending) }
    }
    func waitForHeld(_ path: String) async throws {
        guard try await eventually({ lock.withLock { held[path] != nil } }) else { throw URLError(.timedOut) }
    }
    func bootstrapData() -> Data {
        let (isConnected, hidden, extra) = lock.withLock { (connected, botHidden, extraBot) }
        let family: [String: Any] = ["id": "family", "name": "Family", "model": "test", "shared": true, "activity": "idle"]
        var bots: [[String: Any]] = !isConnected ? [] : hidden ? [family] : [["id": "bot", "name": "Bot", "model": "test", "shared": true, "activity": "idle"]]
        if isConnected && extra && !hidden { bots.append(family) }
        return Self.json(["user": ["id": user, "name": user, "email": "\(user)@example.test", "picture": NSNull()],
                   "household": [], "preferences": ["presentation": "simple", "theme": "system", "favorites": [], "sections": [], "followBots": []],
                   "bots": bots,
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
        // History IDs that start with "reply" are the assistant's answers.
        var message: [String: Any] = ["id": id, "role": id.hasPrefix("reply") ? "assistant" : "user", "text": id]
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
    private func finish(_ protocolInstance: FakeExchange) {
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
            data = status == 200 ? conversationData(request.url!.pathComponents.dropLast().last ?? "bot", query: request.url?.query) : Self.json(["error": "Synthetic conversation outage"])
        }
        else if path.hasSuffix("/draft") && request.httpMethod == "PUT" && lock.withLock({ draftSavesFail }) {
            status = 500; data = Self.json(["error": "Synthetic save failure"])
        }
        else if path.hasSuffix("/draft") {
            let bot = request.url!.pathComponents.dropLast().last ?? ""
            if let versioned = versionedDraft(request, bot: bot) { (status, data) = versioned }
            // An older server answers a save with the draft it saved.
            else if request.httpMethod == "PUT", let body = FakeExchange.body(request) { data = body }
            else { data = Self.json(["text": "server draft for \(user)", "attachments": []]) }
        }
        else if path.hasSuffix("/messages") {
            status = sendStatus
            let payload = FakeExchange.body(request).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            if status == 200, let text = payload?["text"] as? String {
                clearDraft(request.url!.pathComponents.dropLast().last ?? "", sent: text, base: payload?["draftBaseRevision"] as? Int)
            }
            data = status == 200 ? Self.json(["requestId": payload?["requestId"] as? String ?? "missing", "status": "accepted", "runId": "run-one"]) : Self.json(["error": "Synthetic admission failure"])
        } else if path.hasSuffix("/uploads") {
            status = lock.withLock { uploadStatus }
            data = status == 200 ? Self.json(["id": "file.signature", "name": "note.txt", "mime": "text/plain"]) : Self.json(["error": "Synthetic upload failure"])
        }
        else if path.contains("/approvals/"), let refusal = lock.withLock({ approvalRefusal }) { status = 409; data = Self.json(["error": refusal]) }
        else if path.hasPrefix("/api/submissions/"), let answer = lock.withLock({ submissionAnswer }) {
            data = Self.json(["requestId": request.url!.lastPathComponent, "status": answer])
        }
        else if path.hasSuffix("/voice/speak") {
            data = Self.json(["url": "/api/voice/audio/\(UUID().uuidString.lowercased())", "mime": "audio/wav", "expiresAt": "2026-10-17T12:05:00Z"])
        }
        else if path.hasPrefix("/api/voice/audio/") { data = Self.silence }
        else if path == "/api/native/push/config" { data = Self.json(["available": lock.withLock { pushAvailable }]) }
        else if path == "/api/preferences" { data = FakeExchange.body(request) ?? Data() }
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
    /// A second of 8 kHz, 8-bit mono silence as WAV.
    static let silence: Data = {
        var data = Data("RIFF".utf8)
        func append<T: FixedWidthInteger>(_ value: T) { withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) } }
        append(UInt32(36 + 8_000)); data.append(Data("WAVEfmt ".utf8))
        append(UInt32(16)); append(UInt16(1)); append(UInt16(1)); append(UInt32(8_000)); append(UInt32(8_000)); append(UInt16(1)); append(UInt16(8))
        data.append(Data("data".utf8)); append(UInt32(8_000)); data.append(Data(repeating: 128, count: 8_000))
        return data
    }()
    static func errorBody(_ message: String, code: String?) -> Data {
        json(code.map { ["error": message, "code": $0] } ?? ["error": message])
    }
    static func json(_ object: Any) -> Data { try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) }
}

@MainActor final class NativeContractTests: XCTestCase {
    private func client(_ server: NativeMockServer) -> APIClient {
        FakeExchange.client(for: server, token: "synthetic-native-session")
    }
    private func store(_ server: NativeMockServer) throws -> AppStore {
        let value = AppStore(); value.api = client(server)
        value.bootstrap = try JSONDecoder().decode(Bootstrap.self, from: server.bootstrapData())
        value.selectedBotId = "bot"; value.conversation = try JSONDecoder().decode(Conversation.self, from: server.conversationData())
        value.draft = Draft(text: "Send this", attachments: [], dirty: true); value.draftReady = true
        // Its conversation is on screen, so polls and the change stream follow it.
        value.conversationShown("bot", true)
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
        FakeExchange.remove(host: server.origin.host!)
    }

    /// A controller whose iOS permission and APNs are scripted, so no OS alert appears.
    @MainActor private final class NotificationHarness {
        var status: UNAuthorizationStatus
        var requests = 0, registrations = 0, unregistrations = 0
        var grant = true
        let controller: NotificationController
        init(_ status: UNAuthorizationStatus = .notDetermined, store: AppStore) {
            self.status = status
            var box: NotificationHarness?
            controller = NotificationController(permissions: NotificationPermissions(status: { box?.status ?? .notDetermined }, request: {
                box?.requests += 1
                let granted = box?.grant ?? false
                box?.status = granted ? .authorized : .denied
                return granted
            }), register: { box?.registrations += 1 }, unregister: { box?.unregistrations += 1 })
            box = self
            controller.store = store
        }
        func devicePuts(_ server: NativeMockServer) -> Int { server.requests.filter { $0.httpMethod == "PUT" && $0.url?.path == "/api/native/push/device" }.count }
        func deviceDeletes(_ server: NativeMockServer) -> Int { server.requests.filter { $0.httpMethod == "DELETE" && $0.url?.path == "/api/native/push/device" }.count }
    }
    func testNotificationPermissionIsAskedOnlyAfterEnableThenRegisters() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        let notifications = NotificationHarness(store: value), controller = notifications.controller
        await controller.synchronize()
        XCTAssertEqual(notifications.requests, 0, "Signing in must not ask iOS for permission")
        XCTAssertEqual(value.deviceNotifications, .ready(prompt: true))
        await controller.enable()
        XCTAssertEqual(notifications.requests, 1); XCTAssertEqual(notifications.registrations, 1)
        XCTAssertEqual(value.deviceNotifications, .registering)
        controller.token = String(repeating: "ab", count: 32)
        await controller.synchronize()
        XCTAssertEqual(notifications.requests, 1); XCTAssertEqual(notifications.devicePuts(server), 1)
        XCTAssertEqual(value.deviceNotifications, .enabledState)
        notifications.status = .denied
        await controller.synchronize()
        XCTAssertEqual(server.requests.last?.httpMethod, "DELETE"); XCTAssertNil(controller.token)
        XCTAssertTrue(value.deviceNotifications.blockedInSettings); XCTAssertFalse(value.deviceNotifications.enabled)
        notifications.status = .authorized
        await controller.synchronize()
        XCTAssertEqual(notifications.registrations, 2, "Re-enabling in iOS Settings registers with APNs again")
        XCTAssertEqual(notifications.requests, 1)
    }
    func testDeclinedPermissionBlocksAndDeniedOrUnavailableNeverPrompts() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        let notifications = NotificationHarness(store: value), controller = notifications.controller
        server.configurePush(false)
        await controller.synchronize()
        XCTAssertEqual(value.deviceNotifications, .unconfigured)
        await controller.enable()
        XCTAssertEqual(notifications.requests, 0, "A server without push never triggers the iOS prompt")
        server.configurePush(true)
        notifications.grant = false
        await controller.synchronize()
        await controller.enable()
        XCTAssertEqual(notifications.requests, 1); XCTAssertEqual(notifications.registrations, 0)
        XCTAssertTrue(value.deviceNotifications.blockedInSettings)
        await controller.synchronize(); await controller.enable()
        XCTAssertEqual(notifications.requests, 1, "A denial is final until iOS Settings changes it")
    }
    func testNotificationPermissionAnswerCannotRegisterAnotherAccount() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        let controller = NotificationController(permissions: NotificationPermissions(status: { .notDetermined }, request: {
            server.user = "two"; await value.refreshBootstrap(); return true
        }), register: { XCTFail("Old permission answer must not register another account") }, unregister: {})
        controller.store = value
        await controller.synchronize()
        await controller.enable()
        XCTAssertFalse(server.requests.contains { $0.url?.path == "/api/native/push/device" })
    }
    // Notification actions. "one" is the mock's signed-in user; its marker is the server's accountMarker("one").
    private let one = NotificationActions.accountMarker("one")
    private func decision() -> ApprovalDecision {
        ApprovalDecision(botId: "bot", approvalId: "request-7", account: one, url: "/?bot=bot", title: "Bot")
    }
    func testDeclineFromANotificationInTheBackgroundUsesTheSavedSignInOnce() async throws {
        let server = NativeMockServer(); defer { clean(server) }
        let controller = NotificationController(permissions: NotificationPermissions(status: { .authorized }, request: { true }), register: {}, unregister: {})
        var notices: [UNNotificationRequest] = []
        controller.deliverNotice = { notices.append($0) }
        // No store: the app was launched in the background just for this action.
        let api = client(server); controller.actionClient = { api }
        await controller.decide(decision())
        let path = "/api/bots/bot/approvals/request-7"
        XCTAssertEqual(server.requestCount(path), 1)
        let sent = try XCTUnwrap(server.requests.last { $0.url?.path == path })
        XCTAssertEqual(sent.httpMethod, "POST")
        XCTAssertEqual(sent.value(forHTTPHeaderField: "Authorization"), "Bearer synthetic-native-session")
        XCTAssertEqual(try JSONSerialization.jsonObject(with: XCTUnwrap(FakeExchange.body(sent))) as? [String: String], ["decision": "denied", "account": one])
        XCTAssertTrue(notices.isEmpty)
        // A second tap while the first is on its way never sends it twice.
        server.hold(path)
        let first = Task { await controller.decide(decision()) }
        try await server.waitForHeld(path)
        await controller.decide(decision())
        server.release(path); await first.value
        XCTAssertEqual(server.requestCount(path), 2)
    }
    func testADecisionThatDidNotGoThroughIsReportedAndNeverRetried() async throws {
        let server = NativeMockServer(); defer { clean(server) }
        let controller = NotificationController(permissions: NotificationPermissions(status: { .authorized }, request: { true }), register: {}, unregister: {})
        var notices: [UNNotificationRequest] = []
        controller.deliverNotice = { notices.append($0) }
        let api = client(server); controller.actionClient = { api }
        let path = "/api/bots/bot/approvals/request-7"
        server.refuseApprovals("This approval is no longer pending")
        await controller.decide(decision())
        XCTAssertEqual(server.requestCount(path), 1)
        XCTAssertEqual(notices.last?.content.title, "Your decline didn't go through")
        XCTAssertEqual(notices.last?.content.body, "This approval is no longer pending. Tap to open the chat.")
        XCTAssertEqual(notices.last?.content.userInfo["url"] as? String, "/?bot=bot")
        server.refuseApprovals(nil); server.setOffline(true)
        await controller.decide(decision())
        XCTAssertEqual(server.requestCount(path), 2, "An unanswered decision may have applied, so it is not sent again")
        XCTAssertEqual(notices.last?.content.title, "Your decline may not have gone through")
        controller.actionClient = { nil }
        await controller.decide(decision())
        XCTAssertEqual(server.requestCount(path), 2)
        XCTAssertEqual(notices.last?.content.body, "Sign in to WildBots again, then decide in the chat.")
        XCTAssertEqual(notices.count, 3)
    }
    func testANotificationReplyWaitsForTheSendOnItsWayThenJoinsTheDraft() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        server.versionDrafts(text: "Send this", revision: 1)
        value.draft = Draft(text: "Send this", attachments: [], dirty: false, baseRevision: 1)
        let notifications = NotificationHarness(.authorized, store: value), controller = notifications.controller
        let sendPath = "/api/bots/bot/messages"; server.delayResponse(sendPath)
        let sending = Task { await value.send() }
        try await server.waitForDelayed(sendPath)
        await controller.handle(.reply(NotificationReply(botId: "bot", account: one, text: "Also bring rope", url: "/?bot=bot")))
        XCTAssertEqual(value.selectedBotId, "bot")
        XCTAssertFalse(value.draft.text.contains("rope"), "The draft stays the sent copy while its send is unsettled")
        XCTAssertTrue(value.holdsText(for: "bot"), "The composer says why")
        server.releaseResponse(sendPath); await sending.value
        await value.deliverAdditions()
        XCTAssertEqual(value.draft.text, "Also bring rope")
        XCTAssertFalse(value.holdsText(for: "bot"))
        XCTAssertEqual(server.requests.filter { $0.httpMethod == "POST" && $0.url?.path == sendPath }.count, 1, "The reply is never sent for the person")
        // The draft write is debounced; a slower host gets time without a fixed sleep.
        try await until { server.draftRecord()?["text"] as? String == "Also bring rope" }
    }
    func testAHeldNotificationReplySurvivesARelaunchAndRefusesAnotherAccount() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        value.pendings["bot"] = PendingSubmission(requestId: "request", botId: "bot", text: "Send this", attachments: [], reviewedInterruption: false)
        XCTAssertFalse(value.addNotificationReply("Written for two", botId: "bot", account: NotificationActions.accountMarker("two")))
        XCTAssertNotNil(value.error)
        XCTAssertTrue(value.addNotificationReply("Bring rope", botId: "bot", account: one))
        XCTAssertEqual(value.draft.text, "Send this")
        let relaunched = try store(server)
        await relaunched.deliverAdditions()
        XCTAssertEqual(relaunched.draft.text, "Send this\n\nBring rope", "Without the unsettled send it joins the draft")
        XCTAssertFalse(relaunched.draft.text.contains("two"))
        // Taken once: the first copy finds nothing left to add when its send settles.
        value.pendings["bot"] = nil
        await value.deliverAdditions()
        XCTAssertEqual(value.draft.text, "Send this")
        relaunched.suspend()
    }
    /// Before the unified hold, a second Ask while the first opened its chat replaced the first and was never delivered.
    func testAsksAndRepliesArrivingWhileTheFirstOpensItsChatAllLandInOrder() async throws {
        for source in ["ask", "reply"] {
            let server = NativeMockServer(); server.addFamilyBot()
            let value = try store(server); defer { clean(server, value) }
            server.versionDrafts("family", text: "Milk", revision: 1)
            let notifications = NotificationHarness(.authorized, store: value), controller = notifications.controller
            let account = one
            let arrive = { (text: String) -> Task<Void, Never> in
                if source == "ask" {
                    value.queueAsk(AskRequest(botId: "family", text: text, scope: value.scope ?? "", at: Date()))
                    return Task {}
                }
                return Task { await controller.handle(.reply(NotificationReply(botId: "family", account: account, text: text, url: "/?bot=family"))) }
            }
            // Only the first read waits: a notification opening the chat again reads it once more.
            let path = "/api/bots/family/draft"; server.holdNext(path)
            let first = arrive("First")
            try await server.waitForHeld(path)
            XCTAssertEqual(value.selectedBotId, "family", source)
            let second = arrive("Second")
            // The second arrives while the first chat open still waits on its read.
            try await until { value.additions.count >= 2 || value.draft.text.contains("Second") }
            server.release(path)
            await first.value; await second.value
            await value.deliverAdditions()
            XCTAssertEqual(value.draft.text, "Milk\n\nFirst\n\nSecond", source)
            XCTAssertTrue(value.additions.isEmpty, source)
            value.suspend()
        }
    }
    /// Before this, discarding a send whose assistant held text applied the text inside `pendings.didSet`, then
    /// the discard's own restore wrote over it and the saved copy was already gone.
    func testDiscardingAnUnconfirmedSendRestoresItsDraftThenAddsHeldText() async throws {
        for source in ["reply", "ask"] {
            let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
            server.sendStatus = 503; await value.send()
            XCTAssertNotNil(value.pending, source)
            if source == "reply" {
                XCTAssertTrue(value.addNotificationReply("Also bring rope", botId: "bot", account: one))
            } else {
                value.queueAsk(AskRequest(botId: "bot", text: "Also bring rope", scope: value.scope ?? "", at: Date()))
            }
            await value.deliverAdditions()
            XCTAssertEqual(value.draft.text, "Send this", source)
            value.discardUnconfirmedSubmission()
            XCTAssertEqual(value.draft.text, "Send this", "The discarded send's draft is restored first")
            await value.deliverAdditions()
            XCTAssertEqual(value.draft.text, "Send this\n\nAlso bring rope", source)
            XCTAssertTrue(value.additions.isEmpty, source)
            XCTAssertNil(UserDefaults.standard.data(forKey: value.key(.draftAdditions)!), source)
            let saved = { server.draftSaves().last?.text }
            try await until { saved() == "Send this\n\nAlso bring rope" }
            XCTAssertEqual(saved(), "Send this\n\nAlso bring rope", "It saves like any draft edit")
            value.suspend()
        }
    }
    func testNotNowIsRememberedPerAccountAndNeverReasks() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        let notifications = NotificationHarness(store: value), controller = notifications.controller
        await controller.synchronize()
        XCTAssertTrue(value.deviceNotifications.prompt)
        controller.dismissPrompt()
        XCTAssertFalse(value.deviceNotifications.prompt)
        await controller.synchronize()
        XCTAssertFalse(value.deviceNotifications.prompt, "Not now holds across launches")
        XCTAssertTrue(value.deviceNotifications.canEnable, "Settings can still turn notifications on")
        XCTAssertEqual(notifications.requests, 0)
        server.user = "two"; await value.refreshBootstrap()
        await controller.synchronize()
        XCTAssertTrue(value.deviceNotifications.prompt, "Another account has its own answer")
    }
    func testSettingsSwitchUnregistersThisDeviceAndStaysOffAcrossSyncs() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        let notifications = NotificationHarness(store: value), controller = notifications.controller
        controller.token = String(repeating: "cd", count: 32)
        await controller.synchronize()
        await controller.enable()
        XCTAssertEqual(notifications.devicePuts(server), 1); XCTAssertTrue(value.deviceNotifications.enabled)
        await controller.disable()
        XCTAssertEqual(notifications.deviceDeletes(server), 1); XCTAssertEqual(notifications.unregistrations, 1)
        XCTAssertNil(controller.token); XCTAssertEqual(value.deviceNotifications, .disabledByChoice)
        await controller.synchronize()
        XCTAssertEqual(notifications.devicePuts(server), 1, "A person who turned it off is not registered again by a sync")
        XCTAssertEqual(notifications.registrations, 0)
        XCTAssertEqual(value.deviceNotifications, .disabledByChoice)
        await controller.enable()
        XCTAssertEqual(notifications.registrations, 1, "The switch registers again without asking iOS twice")
        XCTAssertEqual(notifications.requests, 1)
    }
    func testPreviouslyAllowedDeviceKeepsNotificationsUntilTurnedOff() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        let notifications = NotificationHarness(.authorized, store: value), controller = notifications.controller
        controller.token = String(repeating: "ef", count: 32)
        await controller.synchronize()
        XCTAssertEqual(notifications.devicePuts(server), 1); XCTAssertEqual(value.deviceNotifications, .enabledState)
        XCTAssertEqual(notifications.requests, 0)
    }
    func testTurningOffDuringAnInFlightRegistrationEndsUnregistered() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        let notifications = NotificationHarness(.authorized, store: value), controller = notifications.controller
        controller.token = String(repeating: "ab", count: 32)
        let path = "/api/native/push/device"
        server.holdNext(path)
        let sync = Task { await controller.synchronize() }
        try await server.waitForHeld(path)
        await controller.disable()
        XCTAssertEqual(notifications.deviceDeletes(server), 1)
        server.release(path); await sync.value
        XCTAssertEqual(server.requests.last { $0.url?.path == path }?.httpMethod, "DELETE", "The late registration is removed again")
        XCTAssertEqual(value.deviceNotifications, .disabledByChoice)
    }
    func testAnAccountSwitchDuringTurnOffSyncsTheNewAccountWhenItEnds() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        let notifications = NotificationHarness(.authorized, store: value), controller = notifications.controller
        controller.token = String(repeating: "ab", count: 32)
        await controller.synchronize()
        let path = "/api/native/push/device"
        server.holdNext(path)
        let turningOff = Task { await controller.disable() }
        try await server.waitForHeld(path)
        server.user = "two"; await value.refreshBootstrap()
        value.deviceNotifications = DeviceNotificationState()
        await controller.synchronize()
        server.release(path); await turningOff.value
        try await until { value.deviceNotifications == .enabledState }
        XCTAssertEqual(value.deviceNotifications, .enabledState, "The new account's own state replaces Checking")
    }
    func testEnableDuringACleanupSyncEndsRegistered() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        let notifications = NotificationHarness(.authorized, store: value), controller = notifications.controller
        controller.token = String(repeating: "ab", count: 32)
        await controller.synchronize(); await controller.disable()
        controller.token = String(repeating: "ab", count: 32)
        let path = "/api/native/push/device"
        server.holdNext(path)
        let cleanup = Task { await controller.synchronize() }
        try await server.waitForHeld(path)
        await controller.enable()
        server.release(path); await cleanup.value
        XCTAssertEqual(server.requests.last { $0.url?.path == path }?.httpMethod, "PUT", "The late removal is followed by registering again")
        XCTAssertEqual(value.deviceNotifications, .enabledState)
    }
    func testFailedTurnOffKeepsSwitchOnAndRetryRecovers() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        let notifications = NotificationHarness(.authorized, store: value), controller = notifications.controller
        controller.token = String(repeating: "ab", count: 32)
        await controller.synchronize()
        server.setOffline(true)
        await controller.disable()
        XCTAssertTrue(value.deviceNotifications.enabled, "The server may still deliver here")
        XCTAssertNotNil(value.deviceNotifications.error); XCTAssertFalse(value.deviceNotifications.busy)
        server.setOffline(false)
        await controller.retry()
        XCTAssertNil(value.deviceNotifications.error); XCTAssertEqual(value.deviceNotifications, .enabledState)
    }
    func testColdLaunchWithSavedSignInStaysConnectingThroughAnOutageAndRecovers() async throws {
        let server = NativeMockServer(), value = launchedStore(server, token: "saved-session"); defer { clean(server, value) }
        server.failBootstrap(status: 503)
        await value.restore()
        XCTAssertTrue(value.connectingToHousehold, "An outage keeps the connecting screen, not the sign-in controls")
        XCTAssertTrue(value.appUnavailable)
        server.failBootstrap(status: 200)
        await value.restore()
        XCTAssertFalse(value.connectingToHousehold); XCTAssertNotNil(value.bootstrap)
    }
    func testFailedAttachmentBlocksSendUntilRetryOrRemovalAndNeverSendsAutomatically() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("native-upload-\(UUID().uuidString).txt")
        try Data("Attachment to keep".utf8).write(to: file); defer { try? FileManager.default.removeItem(at: file) }
        server.failUploads(true)
        // As on the web, a message on its way must finish sending before files can be attached.
        value.sending = true
        await value.uploads.attach(urls: [file])
        XCTAssertEqual(value.uploads.notice, [AppStore.attachWhileSending]); XCTAssertTrue(value.uploads.items.isEmpty)
        value.sending = false
        await value.uploads.attach(urls: [file])
        XCTAssertEqual(value.uploads.items.count, 1); XCTAssertNotNil(value.uploads.items.first?.error)
        XCTAssertFalse(value.canSend); XCTAssertTrue(value.draft.attachments.isEmpty)
        server.failUploads(false)
        await value.uploads.retry(try XCTUnwrap(value.uploads.items.first?.id))
        XCTAssertTrue(value.uploads.items.isEmpty); XCTAssertEqual(value.draft.attachments.count, 1)
        XCTAssertTrue(value.canSend); XCTAssertEqual(server.requestCount("/api/bots/bot/messages"), 0)
        server.failUploads(true)
        await value.uploads.attach(urls: [file])
        value.uploads.remove(try XCTUnwrap(value.uploads.items.first?.id))
        XCTAssertTrue(value.canSend)
    }
    func testAttachmentBatchKeepsAvailableFilesAndExplainsOverflow() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("native-slots-\(UUID().uuidString).txt")
        try Data("Next attachment".utf8).write(to: file); defer { try? FileManager.default.removeItem(at: file) }
        value.draft.attachments = (0..<9).map { FileRef(id: "existing-\($0)", name: "Existing.txt", mime: "text/plain") }
        await value.uploads.attach(urls: [file, file])
        XCTAssertEqual(value.draft.attachments.count, 10)
        XCTAssertEqual(value.uploads.notice, ["A message can carry up to 10 attachments, so 1 of these wasn't added."])
        XCTAssertTrue(value.uploads.items.isEmpty)
    }

    func testPreferencesQueueFinishesAfterSheetClosureAndSerializesNewerEdits() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        var first = try XCTUnwrap(value.bootstrap?.preferences); first.theme = "dark"
        server.hold("/api/preferences")
        value.queuePreferences(first)
        try await server.waitForHeld("/api/preferences")
        var second = first; second.presentation = "advanced"
        value.queuePreferences(second)
        XCTAssertTrue(value.preferencesSaving)
        server.release("/api/preferences")
        try await until { !value.preferencesSaving }
        XCTAssertFalse(value.preferencesSaving); XCTAssertFalse(value.preferencesSaveFailed)
        XCTAssertEqual(value.bootstrap?.preferences.theme, "dark")
        XCTAssertEqual(value.bootstrap?.preferences.presentation, "advanced")
        XCTAssertEqual(server.requestCount("/api/preferences"), 2)
        XCTAssertNil(value.preferencesDraft)
    }
    func testSettingsSaveDoesNotResendStaleModelFavorites() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        var preferences = try XCTUnwrap(value.bootstrap?.preferences)
        preferences.modelFavorites = [ModelChoice(provider: "old", model: "stale")]
        let saved = await value.setPreferences(preferences)
        XCTAssertTrue(saved)
        let request = try XCTUnwrap(server.requests.last { $0.url?.path == "/api/preferences" })
        let body = try XCTUnwrap(FakeExchange.body(request))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertNil(object["modelFavorites"])
    }

    func testAdvancedRoutineOverridesRoundTripAndClearExplicitly() throws {
        let source = Data(#"{"id":"abc123","botId":"bot","name":"Morning","prompt":"","schedule":"1h","enabled":false,"skills":["weather"],"model":"saved","provider":"configured","script":"reports/morning.py","noAgent":true,"enabledToolsets":[],"contextFrom":["self","def456"]}"#.utf8)
        var routine = try JSONDecoder().decode(Routine.self, from: source)
        let roundTrip = try JSONDecoder().decode(Routine.self, from: JSONEncoder().encode(routine))
        XCTAssertEqual(roundTrip.skills, ["weather"])
        XCTAssertEqual(roundTrip.model, "saved")
        XCTAssertEqual(roundTrip.provider, "configured")
        XCTAssertEqual(roundTrip.script, "reports/morning.py")
        XCTAssertEqual(roundTrip.noAgent, true)
        XCTAssertEqual(roundTrip.enabledToolsets, [])
        XCTAssertEqual(roundTrip.contextFrom, ["self", "def456"])
        routine.model = nil
        routine.provider = nil
        routine.script = nil
        routine.enabledToolsets = nil
        routine.contextFrom = []
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(routine)) as? [String: Any])
        for key in ["model", "provider", "script", "enabledToolsets"] { XCTAssertTrue(json[key] is NSNull, key) }
        XCTAssertEqual(json["contextFrom"] as? [String], [])
        XCTAssertEqual(Routine.empty(botId: "bot").contextFrom, ["self"])
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
        // Absence check: outlasts the typing pause that would save the cleared draft.
        try await Task.sleep(for: AppStore.draftSaveDelay + .milliseconds(300))
        XCTAssertEqual(server.requests.filter { $0.httpMethod == "POST" && $0.url?.path.hasSuffix("/messages") == true }.count, 1)
        XCTAssertTrue(server.requests.filter { $0.httpMethod == "PUT" && $0.url?.path.hasSuffix("/draft") == true }.isEmpty)
    }

    func testDefinitiveAdmissionRejectionAndUncertainServerFailureKeepDifferentRetryState() async throws {
        // As on the web, every answer below 500 is a refusal, including a 408.
        for status in [409, 408, 503] {
            let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
            server.sendStatus = status; await value.send()
            XCTAssertEqual(value.draft.text, "Send this")
            if status < 500 { XCTAssertNil(value.pending); XCTAssertEqual(value.receipt?.status, "rejected") }
            else { XCTAssertNotNil(value.pending); XCTAssertEqual(value.receipt?.status, "uncertain") }
        }
    }

    func testASentMessageShowsAtOnceAndHandsItsPlaceToHermessCopy() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        let path = "/api/bots/bot/messages"; server.hold(path)
        let operation = Task { await value.send() }
        try await server.waitForHeld(path)
        let requestId = try XCTUnwrap(value.pending?.requestId)
        XCTAssertTrue(value.sending, "Send keeps spinning until Hermes answers")
        XCTAssertEqual(value.outgoing, SentEcho.Delivery(id: requestId, status: .sending))
        XCTAssertEqual(value.transcript?.messages.last?.text, "Send this")
        XCTAssertEqual(value.turns.last?.id, requestId)
        XCTAssertTrue(value.sendingDraft, "The composer is read-only while its draft is on its way")
        XCTAssertEqual(value.composerDraft.text, "", "The transcript shows the message, so the composer reads empty")
        XCTAssertEqual(value.draft.text, "Send this", "The draft keeps the message until Hermes accepts it")
        XCTAssertEqual(value.attachUnavailable("bot"), AppStore.attachWhileSending)
        // The sent copy must stay as sent: a draft and its send are told apart by content.
        value.editComposer { $0.text = "Typed over" }
        XCTAssertEqual(value.draft.text, "Send this"); XCTAssertEqual(value.composerDraft.text, "")
        server.release(path); await operation.value
        XCTAssertEqual(value.echoes.map(\.status), [.accepted])
        XCTAssertNil(value.outgoing)
        XCTAssertEqual(value.transcript?.messages.map(\.id), [requestId], "Accepted, it stands in until Hermes's copy arrives")
        XCTAssertEqual(value.draft.text, ""); XCTAssertFalse(value.sendingDraft)
        value.editComposer { $0.text = "Next message" }
        XCTAssertEqual(value.draft.text, "Next message", "Once the send settles, the composer takes typing again")
        server.serveHistory([requestId]); await value.refreshConversation()
        XCTAssertEqual(value.echoes, [])
        XCTAssertEqual(value.transcript, value.conversation)
        XCTAssertEqual(value.turns.map(\.id), [requestId])
    }

    func testSharedItemsWaitInTheInboxUntilASendForThatAssistantSettles() async throws {
        for refused in [false, true] {
            let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
            if refused { server.sendStatus = 413 }
            let path = "/api/bots/bot/messages"; server.hold(path)
            let operation = Task { await value.send() }
            try await server.waitForHeld(path)
            XCTAssertTrue(value.holdsAdditions("bot"))
            XCTAssertFalse(value.addShared(text: "Shared note", botId: "bot"))
            XCTAssertTrue(value.holdShared("Shared text", botId: "bot"), "Shared text waits with Siri's and replies'")
            await value.deliverAdditions()
            XCTAssertEqual(value.draft.text, "Send this", "The sent copy is left exactly as sent")
            server.release(path); await operation.value
            XCTAssertEqual(value.haptic?.kind, refused ? .failed : .sent, "The send ends in a tap, and a refusal in a different one")
            XCTAssertFalse(value.holdsAdditions("bot"))
            await value.deliverAdditions()
            XCTAssertEqual(value.draft.text, refused ? "Send this\n\nShared text" : "Shared text")
            XCTAssertTrue(value.addShared(text: "Shared note", botId: "bot"))
            XCTAssertEqual(value.draft.text, refused ? "Send this\n\nShared text\n\nShared note" : "Shared text\n\nShared note")
        }
    }

    func testARefusedMessageGivesItsDraftBack() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        let path = "/api/bots/bot/messages"; server.hold(path)
        server.sendStatus = 413
        let operation = Task { await value.send() }
        try await server.waitForHeld(path)
        value.editComposer { $0.text = "Typed over" }
        XCTAssertTrue(value.sendingDraft); XCTAssertEqual(value.composerDraft.text, "")
        server.release(path); await operation.value
        XCTAssertFalse(value.sendingDraft)
        XCTAssertEqual(value.composerDraft.text, "Send this", "The refused message is back in the composer")
        XCTAssertEqual(value.echoes, []); XCTAssertNil(value.pending)
        XCTAssertEqual(value.transcript?.messages.isEmpty, true)
        XCTAssertEqual(value.receipt?.status, "rejected")
    }

    func testARefusedMessageGoesBackInFrontOfWhatReplacedItsDraftMeanwhile() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        let path = "/api/bots/bot/messages"; server.hold(path)
        server.sendStatus = 413
        let operation = Task { await value.send() }
        try await server.waitForHeld(path)
        // Not the composer: another device's edit or the Share inbox can still change the draft.
        value.updateDraft(Draft(text: "From the phone"))
        server.release(path); await operation.value
        XCTAssertEqual(value.draft.text, "Send this\n\nFrom the phone")
        XCTAssertEqual(value.draft.dirty, true)
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
        for _ in 0..<5 { await tick(1.5) }
        XCTAssertEqual(bootstraps(), 1, "Bootstrap must not ride the 1.5 second conversation cadence")
        XCTAssertEqual(polls(), 6)
        await tick(38)
        XCTAssertEqual(bootstraps(), 2, "Like the web, bootstrap falls back every 45 seconds")
        await value.refreshBootstrap()
        await tick(44)
        XCTAssertEqual(bootstraps(), 3, "An action's refresh restarts the timer")
        await tick(2)
        XCTAssertEqual(bootstraps(), 4)
        value.suspend(); _ = await value.pollOnce()
        XCTAssertEqual(bootstraps(), 5, "Returning to the foreground refreshes at once")
        XCTAssertEqual(polls(), 10)
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

    func testASavedReadingPositionStillOpensTheLatestPageLikeTheWeb() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        server.serveHistory(ids(1...60)); server.serveReadAnchor("m35")
        await value.refreshConversation()
        XCTAssertEqual(server.conversationQueries, ["turns=20"], "Opening never waits on a second page for an old position")
        XCTAssertEqual(value.conversation?.messages.first?.id, "m41")
        await value.refreshConversation()
        XCTAssertEqual(server.conversationQueries.last, "start=m41", "The window then stays where it opened")
    }

    func testInflightPatchesTheTranscriptWithoutFetchingAndRosterRefreshesBootstrap() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        server.startRun("live-run")
        server.serveEventStreams()
        _ = await value.pollOnce()
        // Both streams are open and their connect refreshes have been asked for.
        try await until {
            server.requestCount("/api/events") == 1 && server.requestCount("/api/bots/bot/events") == 1
                && server.requestCount("/api/bootstrap") == 2 && server.conversationQueries.count >= 2
        }
        XCTAssertEqual(server.requests.first { $0.url?.path == "/api/bootstrap" }?.url?.query, "roster=lean")
        let reads = server.conversationQueries.count
        server.notifyInflight()
        try await until { value.conversation?.messages.last?.text == "Live native reply" }
        XCTAssertEqual(value.conversation?.messages.last?.text, "Live native reply")
        XCTAssertEqual(value.conversation?.activity.runId, "live-run")
        XCTAssertEqual(server.conversationQueries.count, reads)
        let bootstraps = server.requestCount("/api/bootstrap")
        server.notifyRoster()
        try await until { server.requestCount("/api/bootstrap") > bootstraps }
        XCTAssertEqual(server.requestCount("/api/bootstrap"), bootstraps + 1)
        XCTAssertEqual(server.conversationQueries.count, reads, "Neither notice reads the conversation")
    }

    func testALiveChangeStreamReplacesFastConversationPollingLikeTheWeb() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        var time = ContinuousClock.now
        value.now = { time }
        let polls = { server.conversationQueries.count }
        server.serveEventStreams()
        _ = await value.pollOnce()
        // Every read the connect started must finish before fake time moves, or a late one would
        // be stamped with a later clock.
        try await until { server.requestCount("/api/bots/bot/events") == 1 && polls() >= 2 && value.conversationReadsInFlight == 0 }
        XCTAssertEqual(server.requestCount("/api/bots/bot/events"), 1)
        let connected = polls()
        XCTAssertGreaterThanOrEqual(connected, 2, "Connecting reads the conversation, since earlier notices were lost")
        for _ in 0..<10 { time += .seconds(1.5); _ = await value.pollOnce() }
        XCTAssertEqual(polls(), connected, "A live stream replaces the 1.5 second conversation poll")
        server.notifyChange()
        // The read must be applied, not just sent, before the clock moves on, or its refresh time
        // would be stamped with the later clock and the slow poll below would be skipped.
        try await until { polls() >= connected + 1 && value.conversationReadsInFlight == 0 }
        XCTAssertEqual(polls(), connected + 1, "A change notice reads the conversation")
        time += .seconds(30); _ = await value.pollOnce()
        XCTAssertEqual(polls(), connected + 2, "A slow poll still covers a stream that failed unnoticed")
        time += .seconds(61); _ = await value.pollOnce()
        XCTAssertEqual(polls(), connected + 3, "A silent stream falls back to polling every pass")
    }

    func testAnOlderConversationReadCannotUndoANewerOne() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        let path = "/api/bots/bot/conversation"
        server.serveHistory(ids(1...30))
        server.holdNext(path)
        let older = Task { await value.refreshConversation() }
        try await server.waitForHeld(path)
        server.serveHistory(ids(1...31))
        await value.refreshConversation()
        XCTAssertEqual(value.conversation?.messages.last?.id, "m31")
        // The held read answers last, with what the server had when it was asked.
        server.serveHistory(ids(1...30)); server.release(path); await older.value
        XCTAssertEqual(value.conversation?.messages.last?.id, "m31", "A late, older response must not remove the newer reply")
    }

    func testTheFirstReadAfterOpeningIsTheAnnouncementBaselineEvenWhenUnchanged() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        server.serveHistory(["m01", "reply-1"])
        await value.refreshConversation()
        await value.select("bot")
        XCTAssertNil(value.replyAnnouncement, "Reopening reads the same conversation as the cache, quietly")
        server.serveHistory(["m01", "reply-1", "m02", "reply-2"])
        await value.refreshConversation()
        XCTAssertEqual(value.replyAnnouncement?.text, "reply-2", "The next reply is new, not a baseline")
    }

    func testAnExpiringSignInStopsTheChangeStreamToo() async throws {
        let server = NativeMockServer(), value = try store(server)
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        value.offlineLibraryRoot = root
        value.offlineWriteDelay = .milliseconds(200)
        defer { try? FileManager.default.removeItem(at: root); clean(server, value) }
        server.serveEventStreams()
        _ = await value.pollOnce()
        try await until { server.requestCount("/api/bots/bot/events") == 1 && server.conversationQueries.count >= 2 }
        let reads = server.conversationQueries.count
        UserDefaults.standard.set(ISO8601DateFormatter().string(from: Date().addingTimeInterval(30)), forKey: DeviceDefaults.expiry(server.origin))
        defer { UserDefaults.standard.removeObject(forKey: DeviceDefaults.expiry(server.origin)) }
        let continues = await value.pollOnce()
        XCTAssertFalse(continues); XCTAssertTrue(value.sessionExpired)
        // Absence check: a live stream would read within this window.
        server.notifyChange(); try await Task.sleep(for: .milliseconds(150))
        XCTAssertEqual(server.conversationQueries.count, reads, "The stream ends with polling, so no read follows a notice")
        await value.refreshConversation()
        value.suspend()
        // Absence check: outlasts the shortened offline write delay three times over.
        try await Task.sleep(for: .milliseconds(600))
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.path), "An expiring session recreated its purged snapshot")
    }

    func testAnOlderMissingAssistantErrorCannotCloseAConversationANewerReadShowed() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        let path = "/api/bots/bot/conversation"
        server.holdNext(path)
        let older = Task { await value.refreshConversation() }
        try await server.waitForHeld(path)
        await value.refreshConversation()
        server.hideBot(); server.release(path); await older.value
        XCTAssertEqual(value.selectedBotId, "bot", "Only a current read may close the conversation")
        XCTAssertNil(value.notice)
    }

    func testAnEarlierPageAnsweringAfterANewerReadKeepsTheNewerTurns() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        let path = "/api/bots/bot/conversation"
        server.serveHistory(ids(1...30))
        await value.refreshConversation()
        XCTAssertEqual(value.conversation?.messages.first?.id, "m11")
        // The page is read now and answered later, after a newer turn has been shown.
        server.delayResponse(path)
        let earlier = Task { await value.loadEarlier() }
        try await server.waitForDelayed(path)
        server.serveHistory(ids(1...31))
        await value.refreshConversation()
        server.releaseResponse(path); await earlier.value
        XCTAssertEqual(value.conversation?.messages.first?.id, "m01", "The wider window is kept")
        XCTAssertEqual(value.conversation?.messages.last?.id, "m31", "The newer turn is not undone by the older page")
    }

    func testWithoutAStreamTheConversationIsPolledEveryPass() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        var time = ContinuousClock.now
        value.now = { time }
        for _ in 0..<4 { _ = await value.pollOnce(); time += .seconds(1.5) }
        XCTAssertEqual(server.conversationQueries.count, 4)
    }

    func testOnlyTheConversationOnScreenIsPolledAndStreamedAndItRefreshesOnReturn() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        var time = ContinuousClock.now
        value.now = { time }
        server.serveEventStreams()
        server.sendStatus = 503; await value.send()
        server.answerSubmissions("uncertain")
        let reads = { server.conversationQueries.count }, checks = { server.requests.filter { $0.url?.path.hasPrefix("/api/submissions/") == true }.count }
        let before = reads()
        // Home, Today or Search: the selected assistant stays selected, but nobody is reading it.
        value.conversationShown("bot", false)
        for _ in 0..<4 { _ = await value.pollOnce(); time += .seconds(60) }
        // Absence check: no read or stream starts for the chat that is off screen.
        try await Task.sleep(for: .milliseconds(150))
        XCTAssertEqual(reads(), before, "Before this change each pass read the whole loaded history again")
        XCTAssertEqual(server.requestCount("/api/bots/bot/events"), 0)
        XCTAssertEqual(checks(), 4, "An unconfirmed send is still checked while its chat is closed")
        // Back on screen, as after switching tabs: read at once, and follow its stream again.
        // The first pass ends with the next due check, so it can no longer read the chat itself.
        value.startPolling(); try await until { checks() == 5 }
        value.conversationShown("bot", true)
        try await until { reads() >= before + 2 && server.requestCount("/api/bots/bot/events") == 1 }
        XCTAssertEqual(reads(), before + 2, "Returning reads now, and the new stream's connection reads once more")
        XCTAssertEqual(server.requestCount("/api/bots/bot/events"), 1)
        XCTAssertEqual(value.followedBotId, "bot")
        // Opening a chat reads it itself; its view arriving adds no read.
        // Absence check: lets a read still in flight land before counting from here.
        value.conversationShown("bot", false); try await Task.sleep(for: .milliseconds(100))
        let opened = reads()
        await value.select("bot"); value.conversationShown("bot", true)
        try await until { reads() >= opened + 2 }
        XCTAssertEqual(reads(), opened + 2, "One read to open it and one for its stream connecting")
    }

    func testAnUncertainSendIsCheckedWithBackoffAndNeverResubmitted() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        var time = ContinuousClock.now
        value.now = { time }
        server.sendStatus = 503; await value.send()
        server.answerSubmissions("uncertain")
        let checks = { server.requests.filter { $0.url?.path.hasPrefix("/api/submissions/") == true }.count }
        let sends = { server.requests.filter { $0.httpMethod == "POST" && $0.url?.path == "/api/bots/bot/messages" }.count }
        var expected = 0
        // Each check waits its delay from the last one: just short of it, then just past it.
        for (wait, asks) in [(0.0, true), (0.0, false), (1.3, false), (0.4, true), (4.8, false), (0.4, true), (14.8, false), (0.4, true), (59.8, false), (0.4, true), (60.2, true)] {
            time += .seconds(wait); await value.reconcilePending()
            if asks { expected += 1 }
            XCTAssertEqual(checks(), expected, "After \(wait) more seconds")
        }
        XCTAssertEqual(sends(), 1, "Checking never sends the message again")
        XCTAssertEqual(value.receipt?.status, "uncertain")
        // Before this change, the 1.5 second poll asked about 95 times over these 142.5 seconds.
        await value.send(reviewedUncertain: true)
        XCTAssertEqual(sends(), 2, "Only the person's explicit retry sends it again")
        await value.reconcilePending()
        XCTAssertEqual(checks(), expected + 1, "A retry is checked at once")
        // A change notice from its conversation asks again at once too.
        server.serveEventStreams(); _ = await value.pollOnce()
        try await until { server.requestCount("/api/bots/bot/events") == 1 }
        // Absence check: the connection, once handled, must not count as a change notice.
        try await Task.sleep(for: .milliseconds(150))
        await value.reconcilePending()
        XCTAssertEqual(checks(), expected + 1, "Connecting the stream is not a change notice")
        // A notice frees the check before it asks for the conversation, so that read means it was heard.
        let heard = server.conversationQueries.count
        server.notifyChange(); try await until { server.conversationQueries.count > heard }
        await value.reconcilePending()
        XCTAssertEqual(checks(), expected + 2)
        server.answerSubmissions("accepted"); time += .seconds(60); await value.reconcilePending()
        XCTAssertNil(value.pending)
    }

    func testUnchangedPollsSkipDecodingAndPublishNothing() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        server.serveETags()
        value.draft = Draft(text: "", attachments: [], dirty: false)
        await value.refreshBootstrap(); await value.refreshConversation()
        let unchanged = await observedChanges(of: value) {
            for _ in 0..<3 { await value.refreshBootstrap(); await value.refreshConversation() }
        }
        XCTAssertEqual(server.notModified, 6)
        XCTAssertEqual(unchanged, [:], "Before this change every unchanged pass republished bootstrap and the offline marker")
        let changed = await observedChanges(of: value) {
            server.startRun("run-two")
            await value.refreshConversation()
        }
        XCTAssertEqual(value.conversation?.activity.runId, "run-two", "A changed body still applies")
        XCTAssertEqual(changed["conversation"], 1)
        // A local change, such as a live reply patch, makes the next read apply in full again.
        var patched = try XCTUnwrap(value.conversation); patched.activity.state = .working
        value.conversation = patched
        await value.refreshConversation()
        XCTAssertEqual(value.conversation?.activity.state, .thinking, "The server's copy replaces the local patch")
    }

    func testUnchangedPollsStillRenewTheWidgetSnapshot() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("widget-renewal-" + UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("snapshot.json")
        value.widgetSnapshotURL = url
        server.serveETags()
        await value.refreshBootstrap()
        let written = try XCTUnwrap(WidgetSnapshotStore.read(from: url))
        // The stored snapshot is now older than its renewal age, as after ten minutes of unchanged polls.
        var aged = written; aged.generatedAt = Date().addingTimeInterval(-WidgetSnapshotStore.rewriteAge - 1)
        try JSONEncoder().encode(aged).write(to: url)
        let before = server.notModified
        await value.refreshBootstrap()
        XCTAssertEqual(server.notModified, before + 1, "The roster was unchanged")
        let renewed = try XCTUnwrap(WidgetSnapshotStore.read(from: url))
        XCTAssertLessThan(abs(renewed.generatedAt.timeIntervalSinceNow), 60, "Before this fix the widget went stale while the app polled")
        XCTAssertEqual(renewed.assistants, written.assistants)
        // Within the renewal age an unchanged poll leaves the file alone.
        await value.refreshBootstrap()
        XCTAssertEqual(WidgetSnapshotStore.read(from: url)?.generatedAt, renewed.generatedAt)
    }

    func testTypingPublishesOnceAndWritesTheLocalDraftAfterAPauseOrOnLeaving() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        server.versionDrafts(); server.versionDrafts("other")
        let stored = { UserDefaults.standard.data(forKey: value.key(.draft, "bot")!).flatMap { try? JSONDecoder().decode(Draft.self, from: $0) }?.text }
        let changes = await observedChanges(of: value) { value.updateDraft(Draft(text: "Feed the horses", attachments: [])) }
        XCTAssertEqual(changes, ["draft": 1], "Before this change each keystroke published four times")
        XCTAssertNil(stored(), "Typing waits for a pause before encoding the draft")
        value.updateDraft(Draft(text: "Feed the horses at six", attachments: []))
        try await until { stored() == "Feed the horses at six" }
        value.updateDraft(Draft(text: "Feed the horses tonight", attachments: []))
        value.suspend()
        XCTAssertEqual(stored(), "Feed the horses tonight", "Leaving the app writes it at once")
        value.updateDraft(Draft(text: "Switching", attachments: []))
        await value.select("other")
        XCTAssertEqual(stored(), "Switching", "Switching assistants writes it at once")
    }

    func testTheObservedListNamesEveryTrackedProperty() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        XCTAssertEqual(AppStore.trackedPropertyNames(of: value), Set(AppStore.observedForTests.keys))
        let counted = await observedChanges(of: value) { value.notice = "Saved"; value.notice = "Saved again" }
        XCTAssertEqual(counted, ["notice": 2], "Each change counts, so a test expecting one can fail")
    }

    func testBackgroundPollsPauseWhileTheAppIsNotActiveAndRefreshOnceOnReturn() async throws {
        final class Counter { var count = 0 }
        struct Probe: View {
            var phase: ScenePhase; var counter: Counter
            var body: some View {
                Color.clear.pollWhileActive(id: "probe", every: .milliseconds(250)) { counter.count += 1 }
                    .environment(\.scenePhase, phase)
            }
        }
        let counter = Counter()
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        let host = UIHostingController(rootView: Probe(phase: .background, counter: counter))
        window.rootViewController = host; window.isHidden = false
        defer { window.isHidden = true }
        let reaches = { (count: Int) in try await until { counter.count >= count } }
        // Absence check: two 250 ms intervals pass in the background without a poll.
        try await Task.sleep(for: .milliseconds(500))
        XCTAssertEqual(counter.count, 0, "Nothing polls in the background")
        host.rootView = Probe(phase: .active, counter: counter)
        try await reaches(1)
        XCTAssertEqual(counter.count, 1, "Returning refreshes once at once, before the interval")
        try await reaches(3)
        XCTAssertGreaterThanOrEqual(counter.count, 3, "Active, it polls on its interval")
        host.rootView = Probe(phase: .inactive, counter: counter)
        // Absence check: once the inactive phase renders, three 250 ms intervals pass without a poll.
        try await Task.sleep(for: .milliseconds(100))
        let paused = counter.count
        try await Task.sleep(for: .milliseconds(800)) // Absence check, as above.
        XCTAssertEqual(counter.count, paused, "Inactive, it waits")
    }

    func testConcurrentLoadsOfOneImageDownloadOnce() async throws {
        let loads = AuthenticatedImage.ImageLoads()
        let png = UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4)).pngData { $0.fill(CGRect(x: 0, y: 0, width: 4, height: 4)) }
        var fetches = 0
        let fetch: @MainActor () async throws -> Data = {
            // Latency: a slow download, so the second load arrives while the first is in flight.
            fetches += 1; try await Task.sleep(for: .milliseconds(100)); return png
        }
        let key = "coalesce:\(UUID().uuidString)" as NSString
        let first = Task { try await loads.image(key, fetch: fetch) }
        let second = Task { try await loads.image(key, fetch: fetch) }
        let images = [try await first.value, try await second.value]
        XCTAssertEqual(fetches, 1); XCTAssertTrue(images.allSatisfy { $0 != nil })
        // A row that scrolled away stops its download; the next one starts its own.
        let other = "abandon:\(UUID().uuidString)" as NSString
        let leaving = Task { try await loads.image(other, fetch: fetch) }
        try await until { fetches == 2 }; leaving.cancel()
        _ = try? await leaving.value
        let returning = try await loads.image(other, fetch: fetch)
        XCTAssertEqual(fetches, 3); XCTAssertNotNil(returning)
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
            let path = "/api/bots/bot/draft"
            server.hold(path); defer { server.release(path) }
            value.discardUnconfirmedSubmission()
            XCTAssertNil(value.pending); XCTAssertNil(value.receipt); XCTAssertTrue(value.canSend)
            XCTAssertNil(UserDefaults.standard.data(forKey: value.key(.pending, "bot")!))
            XCTAssertEqual(value.draft.text, edit == "Send this and more" ? "Send this and more" : "Send this")
            try await server.waitForHeld(path)
            let saved = server.requests.last { $0.httpMethod == "PUT" && $0.url?.path == path }
            XCTAssertEqual(saved.flatMap(FakeExchange.body).flatMap { try? JSONDecoder().decode(Draft.self, from: $0) }?.text, value.draft.text)
        }
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        value.draft.text = "Typed after"
        value.pending = PendingSubmission(requestId: "lost", botId: "bot", text: "Lost message", attachments: [FileRef(id: "a", name: "a.txt", mime: "text/plain")], reviewedInterruption: false)
        value.discardUnconfirmedSubmission()
        XCTAssertEqual(value.draft.text, "Lost message\n\nTyped after"); XCTAssertEqual(value.draft.attachments.map(\.id), ["a"])
    }

    func testDiscardingAnotherAssistantsUnconfirmedSendWorksOfflineAndLandsInItsDraft() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        server.versionDrafts("other")
        value.pending = PendingSubmission(requestId: "lost", botId: "other", text: "Lost message", attachments: [], reviewedInterruption: false)
        server.setOffline(true)
        value.discardUnconfirmedSubmission(botId: "other")
        XCTAssertNil(value.pendings["other"]); XCTAssertEqual(value.draft.text, "Send this", "The open assistant's draft is untouched")
        let saved = UserDefaults.standard.data(forKey: value.key(.draft, "other")!).flatMap { try? JSONDecoder().decode(Draft.self, from: $0) }
        XCTAssertEqual(saved?.text, "Lost message"); XCTAssertEqual(saved?.dirty, true)
        server.setOffline(false)
        await value.select("other")
        XCTAssertEqual(value.draft.text, "Lost message")
    }

    func testDiscardWhileTheAssistantsDraftIsStillLoadingSurvivesTheLateRead() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        UserDefaults.standard.removeObject(forKey: value.key(.draft, "bot")!)
        value.draft = Draft(); value.draftReady = false
        value.pending = PendingSubmission(requestId: "lost", botId: "bot", text: "Lost message", attachments: [FileRef(id: "a", name: "a.txt", mime: "text/plain")], reviewedInterruption: false)
        let path = "/api/bots/bot/draft"; server.hold(path)
        let reopen = Task { await value.select("bot") }
        try await server.waitForHeld(path)
        value.discardUnconfirmedSubmission()
        XCTAssertNil(value.pending)
        let stored = UserDefaults.standard.data(forKey: value.key(.draft, "bot")!).flatMap { try? JSONDecoder().decode(Draft.self, from: $0) }
        XCTAssertEqual(stored?.text, "Lost message", "The recovered text is saved before the read returns")
        server.release(path); await reopen.value
        XCTAssertEqual(value.draft.text, "Lost message"); XCTAssertEqual(value.draft.attachments.map(\.id), ["a"])
        XCTAssertTrue(value.draftReady); XCTAssertTrue(value.canSend)
        try await until { value.draft.dirty == false }
        let sync = server.requests.last { $0.httpMethod == "PUT" && $0.url?.path == path }
        XCTAssertEqual(sync.flatMap(FakeExchange.body).flatMap { try? JSONDecoder().decode(Draft.self, from: $0) }?.text, "Lost message", "The recovered draft is synced to the server")
        XCTAssertEqual(value.draft.dirty, false, "A successful sync clears dirty so newer web drafts can load again")
        let synced = UserDefaults.standard.data(forKey: value.key(.draft, "bot")!).flatMap { try? JSONDecoder().decode(Draft.self, from: $0) }
        XCTAssertEqual(synced?.dirty, false)
        XCTAssertNil(UserDefaults.standard.data(forKey: value.key(.recovered, "bot")!), "The recovery mark clears once the server has the draft")
    }

    func testALeftoverDirtyDraftSavesOnItsBaseOnceLoaded() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        server.versionDrafts(text: "Server copy", revision: 1)
        let leftover = Draft(text: "Old unsent text", attachments: [], dirty: true, baseRevision: 1)
        UserDefaults.standard.set(try JSONEncoder().encode(leftover), forKey: value.key(.draft, "bot")!)
        value.draftReady = false
        await value.select("bot")
        XCTAssertEqual(value.draft.text, "Old unsent text"); XCTAssertTrue(value.draftReady)
        try await until { !server.draftSaves().isEmpty }
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
        // Timer: the revert's typing pause passes while the older save is still held.
        try await Task.sleep(for: AppStore.draftSaveDelay + .milliseconds(200))
        server.release(path)
        try await until { server.draftRecord()?["text"] as? String == "A" && value.draft.dirty == false }
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
        UserDefaults.standard.set(try JSONEncoder().encode(stale), forKey: value.key(.draft, "bot")!)
        value.draftReady = false
        await value.select("bot")
        XCTAssertEqual(value.draft, Draft(text: "", attachments: [], dirty: false, baseRevision: 2, baseHash: Draft.contentHash("", [])))
        value.updateDraft(Draft(text: "Fresh", attachments: []))
        try await until { server.draftRecord()?["text"] as? String == "Fresh" && value.draft.dirty == false }
        XCTAssertEqual(server.draftSaves(), [.init(text: "Fresh", baseRevision: 2)], "The sent text is never saved back")
        XCTAssertEqual(server.draftRecord()?["text"] as? String, "Fresh")
    }

    func testDifferentTextTypedOfflineSurvivesASendOfTheSharedDraftElsewhere() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        server.versionDrafts(text: "Shared plan", revision: 1)
        server.otherDevice(sends: "Shared plan")
        let offline = Draft(text: "Offline note", attachments: [], dirty: true, baseRevision: 1, baseHash: Draft.contentHash("Shared plan", []))
        UserDefaults.standard.set(try JSONEncoder().encode(offline), forKey: value.key(.draft, "bot")!)
        value.draftReady = false
        await value.select("bot")
        XCTAssertEqual(value.draft.text, "Offline note")
        try await until { server.draftRecord()?["text"] as? String == "Offline note" }
        XCTAssertEqual(server.draftSaves(), [.init(text: "Offline note", baseRevision: 2)])
        XCTAssertEqual(server.draftRecord()?["text"] as? String, "Offline note")
    }

    func testSwitchingAssistantsOrLeavingSavesAPendingEditAtOnce() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        server.versionDrafts(); server.versionDrafts("other")
        value.draft = Draft(baseRevision: 0)
        value.updateDraft(Draft(text: "Pick up feed", attachments: []))
        await value.select("other")
        let cached = { UserDefaults.standard.data(forKey: value.key(.draft, "bot")!).flatMap { try? JSONDecoder().decode(Draft.self, from: $0) } }
        try await until { cached()?.dirty == false }
        XCTAssertEqual(server.draftSaves(), [.init(text: "Pick up feed", baseRevision: 0)])
        XCTAssertEqual(cached()?.dirty, false); XCTAssertEqual(cached()?.baseRevision, 1)
        // Another device sends the saved text.
        server.otherDevice(sends: "Pick up feed")
        await value.select("bot")
        XCTAssertEqual(value.draft.text, ""); XCTAssertEqual(value.draft.baseRevision, 2)
        value.updateDraft(Draft(text: "Before leaving", attachments: []))
        value.suspend()
        try await until { server.draftSaves().last?.text == "Before leaving" && value.draft.dirty == false }
        XCTAssertEqual(server.draftSaves().last, .init(text: "Before leaving", baseRevision: 2))
        XCTAssertEqual(value.draft.dirty, false)
    }

    func testAnEditTypedHereWinsOverANewerEditFromAnotherDevice() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        server.versionDrafts(text: "Start", revision: 1)
        value.draft = Draft(text: "Start", attachments: [], dirty: false, baseRevision: 1)
        server.otherDevice(edits: "Phone words")
        value.updateDraft(Draft(text: "Typed here", attachments: []))
        try await until { server.draftRecord()?["revision"] as? Int == 3 && value.draft.dirty == false }
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
        // Timer: the AB edit's typing pause passes while the first save is still held.
        try await Task.sleep(for: AppStore.draftSaveDelay + .milliseconds(100))
        await value.select("other")
        try await until { server.draftSaves().contains { $0.text == "AB" } }
        server.failHeld(path)
        // Absence check: the older save's failure must not undo the newer text.
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(server.draftRecord()?["text"] as? String, "AB")
    }

    func testPollingWaitsForTheBackoffOfAFailingSave() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        // The backoff is measured on the store's clock, held still here so a slow test host
        // cannot let the polls below cross it before the assertion.
        var time = ContinuousClock.now
        value.now = { time }
        server.versionDrafts(); server.failDraftSaves()
        value.draft = Draft(baseRevision: 0, baseHash: Draft.contentHash("", []))
        value.updateDraft(Draft(text: "A", attachments: []))
        // The failure is reported once its backoff is set, so the polls below run inside it.
        try await until { server.draftSaves().count == 1 && value.error != nil }
        XCTAssertEqual(server.draftSaves().count, 1)
        // Absence check: polls inside the backoff never retry.
        for _ in 0..<3 { await value.refreshConversation(); try await Task.sleep(for: .milliseconds(80)) }
        XCTAssertEqual(server.draftSaves().count, 1, "Polls do not retry before the backoff")
        // The retry task's own sleep may already have fired against the held clock, so a poll
        // after the backoff proves the boundary; the timer path is covered by the test above.
        time += .seconds(1)
        await value.refreshConversation()
        try await until { server.draftSaves().count >= 2 }
        XCTAssertEqual(server.draftSaves().count, 2, "A poll after the backoff retries once")
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
        try await until { server.draftSaves().last?.text == "B" }
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
        // Timer: the AB edit's typing pause passes while the first save is still held.
        try await Task.sleep(for: AppStore.draftSaveDelay + .milliseconds(100))
        server.failHeld(path)
        // Absence check: well inside the 1 s retry backoff, nothing is saved.
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(server.draftRecord()?["revision"] as? Int, 0, "Nothing saved yet")
        try await until { value.draft.dirty == false }
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
        // Absence check: a retry of the stale save would follow its 409 at once.
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
        try await until { server.draftRecord()?["text"] as? String == "Second message" && value.draft.dirty == false }
        XCTAssertEqual(server.draftRecord()?["text"] as? String, "Second message")
        XCTAssertEqual(value.draft.text, "Second message"); XCTAssertEqual(value.draft.dirty, false)
    }

    func testTheSameWordsTypedRightAfterSendingSurviveTheClearForThatSend() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        server.versionDrafts(text: "Send this", revision: 1)
        value.draft = Draft(text: "Send this", attachments: [], dirty: false, baseRevision: 1)
        await value.send()
        XCTAssertEqual(server.draftRecord()?["reason"] as? String, "sent")
        // Typed again, word for word: new work, told apart from the sent copy by its edit.
        value.editComposer { $0.text = "Send this" }
        XCTAssertFalse(value.draft.isSentCopy)
        try await until { server.draftRecord()?["text"] as? String == "Send this" && value.draft.dirty == false }
        await value.refreshConversation()
        XCTAssertEqual(server.draftRecord()?["text"] as? String, "Send this")
        XCTAssertEqual(value.draft.text, "Send this")
    }

    func testTheSameWordsTypedAfterTheServerClearedBeforeTheReceiptAreKept() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        server.versionDrafts(text: "Send this", revision: 1)
        value.draft = Draft(text: "Send this", attachments: [], dirty: false, baseRevision: 1)
        let sendPath = "/api/bots/bot/messages"; server.delayResponse(sendPath)
        let sending = Task { await value.send() }
        try await server.waitForDelayed(sendPath)
        XCTAssertTrue(value.sendingDraft)
        // A poll brings the server's clear before the receipt: the composer is free again.
        await value.refreshConversation()
        XCTAssertEqual(value.draft.text, ""); XCTAssertFalse(value.sendingDraft)
        value.editComposer { $0.text = "Send this" }
        XCTAssertEqual(value.composerDraft.text, "Send this")
        server.releaseResponse(sendPath); await sending.value
        XCTAssertEqual(value.draft.text, "Send this", "Acceptance empties only the copy that was sent")
        try await until { server.draftRecord()?["text"] as? String == "Send this" && value.draft.dirty == false }
        await value.refreshConversation()
        XCTAssertEqual(server.draftRecord()?["text"] as? String, "Send this")
        XCTAssertEqual(value.draft.text, "Send this")
    }

    func testARetryNeverTakesAnEditedDraftForTheMessageItResends() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        server.sendStatus = 503
        await value.send()
        XCTAssertEqual(value.receipt?.status, "uncertain"); XCTAssertFalse(value.sendingDraft)
        value.editComposer { $0.text = "Edited meanwhile" }
        server.sendStatus = 200
        let path = "/api/bots/bot/messages"; server.hold(path)
        let retry = Task { await value.send(reviewedUncertain: true) }
        try await server.waitForHeld(path)
        // Edited back to the resent words: still the person's own copy, shown and kept.
        value.editComposer { $0.text = "Send this" }
        XCTAssertFalse(value.sendingDraft); XCTAssertEqual(value.composerDraft.text, "Send this")
        server.release(path); await retry.value
        XCTAssertEqual(value.draft.text, "Send this")
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
        try await until { UserDefaults.standard.data(forKey: value.key(.recovered, "bot")!) == nil }
        XCTAssertEqual(server.draftSaves(), [.init(text: "Lost message", baseRevision: 3)])
        XCTAssertNil(UserDefaults.standard.data(forKey: value.key(.recovered, "bot")!))
    }

    func testDelayedUploadDoesNotAttachToNewIdentity() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("native-contract-\(UUID().uuidString).txt")
        try Data("Synthetic attachment".utf8).write(to: file); defer { try? FileManager.default.removeItem(at: file) }
        let path = "/api/bots/bot/uploads"; server.hold(path)
        let operation = Task { await value.uploads.attach(urls: [file]) }
        try await server.waitForHeld(path)
        server.user = "two"; await value.refreshBootstrap()
        XCTAssertFalse(value.uploads.uploading, "An old identity's delayed upload must not block the new person")
        server.release(path); await operation.value
        XCTAssertEqual(value.bootstrap?.user.id, "two"); XCTAssertTrue(value.draft.attachments.isEmpty)
        XCTAssertEqual(value.draft.text, "server draft for two")
    }

    func testUploadFinishingWhileReturningDraftLoadsKeepsTheFile() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        server.versionDrafts("bot")
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("native-loading-\(UUID().uuidString).txt")
        try Data("Keep this file".utf8).write(to: file); defer { try? FileManager.default.removeItem(at: file) }
        let uploadPath = "/api/bots/bot/uploads", draftPath = "/api/bots/bot/draft"
        server.hold(uploadPath)
        let upload = Task { await value.uploads.attach(urls: [file]) }
        try await server.waitForHeld(uploadPath)
        await value.select("other")
        server.holdNext(draftPath)
        let returning = Task { await value.select("bot") }
        try await server.waitForHeld(draftPath)
        XCTAssertFalse(value.draftReady)
        server.release(uploadPath); await upload.value
        let cached = UserDefaults.standard.data(forKey: value.key(.draft, "bot")!).flatMap { try? JSONDecoder().decode(Draft.self, from: $0) }
        XCTAssertEqual(cached?.attachments.map(\.id), ["file.signature"])
        server.release(draftPath); await returning.value
        XCTAssertEqual(value.draft.attachments.map(\.id), ["file.signature"])
        XCTAssertTrue(value.uploads.items.isEmpty)
    }
    func testQueuedUploadStartsAfterConnectionReturnsWithoutSendingMessage() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("native-queued-\(UUID().uuidString).txt")
        try Data("Queued attachment".utf8).write(to: file); defer { try? FileManager.default.removeItem(at: file) }
        value.bootstrap?.connection.connected = false
        await value.uploads.attach(urls: [file])
        XCTAssertEqual(value.uploads.items.count, 1); XCTAssertNil(value.uploads.items.first?.error)
        XCTAssertEqual(server.requestCount("/api/bots/bot/uploads"), 0)
        // The next poll finds the connection back and starts the queued file without being asked.
        let polling = await value.pollOnce(); XCTAssertTrue(polling)
        try await until { value.uploads.items.isEmpty }
        XCTAssertTrue(value.uploads.items.isEmpty); XCTAssertEqual(value.draft.attachments.count, 1)
        XCTAssertEqual(server.requestCount("/api/bots/bot/messages"), 0)
    }

    func testAttachNamesEveryRefusedFileInOneNoticeAndSendsAnyTextFormatAsPlainText() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("native-kinds-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true); defer { try? FileManager.default.removeItem(at: directory) }
        let names = ["server.log", "script.py", "data.json", "big.txt"]
        for name in names { try Data("text".utf8).write(to: directory.appendingPathComponent(name)) }
        let big = try FileHandle(forWritingTo: directory.appendingPathComponent("big.txt"))
        try big.truncate(atOffset: UInt64(UploadRules.maxBytes + 1)); try big.close()
        let path = "/api/bots/bot/uploads"; server.hold(path)
        let attaching = Task { await value.uploads.attach(urls: names.map { directory.appendingPathComponent($0) }) }
        try await server.waitForHeld(path)
        XCTAssertEqual(value.uploads.notice, [
            "data.json can't be attached. Use PNG, JPEG, WebP or GIF images, PDFs, or plain text.",
            "big.txt is 20 MB. Each attachment can be up to 20 MB.",
        ])
        XCTAssertEqual(value.uploads.items.map(\.name), ["server.log", "script.py"])
        XCTAssertEqual(value.uploads.items.map(\.mime), ["text/plain", "text/plain"])
        // One file at a time, in order: the first is on its way, the second waits.
        XCTAssertEqual(value.uploads.items.map(\.caption), ["Uploading 0%", "Waiting…"])
        XCTAssertFalse(value.canSend, "A message never goes out while its files are still uploading")
        server.release(path); await attaching.value
        XCTAssertTrue(value.uploads.items.isEmpty)
        XCTAssertEqual(value.draft.attachments.count, 2)
        XCTAssertEqual(value.draft.attachments.first?.size, 4, "The tray shows the size of what was uploaded")
    }
    func testUploadProgressReadsLikeTheWebUntilTheServerFinishes() {
        var upload = AttachmentUpload(botId: "bot", url: URL(fileURLWithPath: "/tmp/a.png"), name: "a.png", mime: "image/png")
        XCTAssertEqual(upload.caption, "Waiting…")
        upload.record(sent: 0.5)
        XCTAssertEqual(upload.caption, "Waiting…", "Progress for a file not yet started is ignored")
        upload.status = .uploading
        upload.record(sent: 0.426); XCTAssertEqual(upload.caption, "Uploading 43%")
        upload.record(sent: 1); XCTAssertEqual(upload.caption, "Finishing…")
        upload.status = .failed; upload.record(sent: 0.2)
        XCTAssertEqual(upload.caption, "Didn't upload")
    }
    func testAttachingIsRefusedWithTheReasonWhenUploadsAreUnavailableOrTheDraftIsFull() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("native-refused-\(UUID().uuidString).txt")
        try Data("Refused".utf8).write(to: file); defer { try? FileManager.default.removeItem(at: file) }
        XCTAssertNil(value.attachUnavailable("bot"))
        value.draftReady = false
        XCTAssertEqual(value.attachUnavailable("bot"), "Your draft is still loading.")
        value.draftReady = true
        value.draft.attachments = (0..<10).map { FileRef(id: "file-\($0)", name: "File.txt", mime: "text/plain") }
        await value.uploads.attach(urls: [file])
        XCTAssertEqual(value.uploads.notice, ["A message can carry up to 10 attachments."])
        value.bootstrap?.capabilities["uploads"] = Capability(supported: false, reason: "This Hermes cannot store files.")
        XCTAssertEqual(value.attachUnavailable("bot"), "This Hermes cannot store files.")
        XCTAssertEqual(server.requestCount("/api/bots/bot/uploads"), 0)
    }
    func testPastedAndPhotographedImagesGetReadableNames() {
        var parts = DateComponents(); parts.year = 2026; parts.month = 10; parts.day = 17; parts.hour = 9; parts.minute = 3; parts.second = 7
        let date = Calendar.current.date(from: parts)!
        XCTAssertEqual(UploadRules.imageName("Pasted image", at: date, index: 0, ext: "png"), "Pasted image 09.03.07.png")
        XCTAssertEqual(UploadRules.imageName("Photo", at: date, index: 2, ext: "jpg"), "Photo 09.03.07 (3).jpg")
    }
    func testEachAssistantKeepsItsOwnUnconfirmedSendAndEveryOneIsReconciled() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        server.sendStatus = 503; await value.send()
        XCTAssertNotNil(value.pending)
        // Another assistant is not held up by this one's unconfirmed message, as on the web.
        value.selectedBotId = "other"
        value.draft = Draft(text: "For the other assistant", attachments: [], dirty: true); value.draftReady = true
        XCTAssertNil(value.pending); XCTAssertNil(value.receipt); XCTAssertTrue(value.canSend)
        await value.send()
        XCTAssertEqual(Set(value.pendings.keys), ["bot", "other"])
        XCTAssertNotNil(UserDefaults.standard.data(forKey: value.key(.pending, "bot")!))
        XCTAssertNotNil(UserDefaults.standard.data(forKey: value.key(.pending, "other")!))
        server.answerSubmissions("accepted")
        await value.reconcilePending()
        XCTAssertTrue(value.pendings.isEmpty)
        XCTAssertEqual(server.requests.filter { $0.url?.path.hasPrefix("/api/submissions/") == true }.count, 2)
        XCTAssertNil(UserDefaults.standard.data(forKey: value.key(.pending, "bot")!))
        let closed = UserDefaults.standard.data(forKey: value.key(.draft, "bot")!).flatMap { try? JSONDecoder().decode(Draft.self, from: $0) }
        XCTAssertEqual(closed?.text, "", "The accepted message clears the closed assistant's draft")
    }
    func testASingleUnconfirmedSendSavedByAnOlderVersionMovesToItsAssistant() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        let legacy = PendingSubmission(requestId: "legacy", botId: "bot", text: "Old send", attachments: [], reviewedInterruption: false)
        UserDefaults.standard.set(try JSONEncoder().encode(legacy), forKey: value.key(.pending)!)
        await value.refreshBootstrap()
        XCTAssertEqual(value.pending?.requestId, "legacy"); XCTAssertFalse(value.canSend)
        XCTAssertNil(UserDefaults.standard.data(forKey: value.key(.pending)!))
        XCTAssertNotNil(UserDefaults.standard.data(forKey: value.key(.pending, "bot")!))
        value.discardUnconfirmedSubmission()
        XCTAssertNil(value.pending); XCTAssertNil(UserDefaults.standard.data(forKey: value.key(.pending, "bot")!))
        XCTAssertTrue(value.draft.text.contains("Old send"))
    }
    func testTheDraftLoadNoticeClearsOnceALaterReadBringsTheDraft() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        value.draftReady = false
        value.error = "Your saved draft could not be loaded. Retrying. Can't reach the app server."
        await value.refreshConversation()
        XCTAssertNil(value.error); XCTAssertTrue(value.draftReady)
        value.error = "Something else went wrong"
        await value.refreshConversation()
        XCTAssertEqual(value.error, "Something else went wrong", "Only the draft notice is the draft's to clear")
    }
    func testMessageLengthIsCountedInUTF16LikeTheServer() throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        // Each emoji is one Character but two UTF-16 units, as JavaScript counts it.
        value.draft.text = String(repeating: "😀", count: 25_000)
        XCTAssertTrue(value.canSend)
        value.draft.text += "a"
        XCTAssertFalse(value.canSend)
    }
    func testHardwareReturnSendsUnlessShiftedOrComposing() {
        XCTAssertTrue(ComposerUITextView.sends(.keyboardReturnOrEnter, [], composing: false))
        XCTAssertTrue(ComposerUITextView.sends(.keypadEnter, [], composing: false))
        XCTAssertTrue(ComposerUITextView.sends(.keyboardReturnOrEnter, .alphaShift, composing: false), "Caps Lock is not Shift")
        XCTAssertFalse(ComposerUITextView.sends(.keyboardReturnOrEnter, .shift, composing: false))
        XCTAssertFalse(ComposerUITextView.sends(.keyboardReturnOrEnter, [], composing: true))
        XCTAssertFalse(ComposerUITextView.sends(.keyboardA, [], composing: false))
    }
    func testATranscriptJoinsTheDraftOnItsOwnLine() throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        XCTAssertTrue(value.appendTranscript("Check the gate", botId: "bot"))
        XCTAssertEqual(value.draft.text, "Send this\nCheck the gate")
        value.draft.text = "  \n"
        value.appendTranscript("Only this", botId: "bot")
        XCTAssertEqual(value.draft.text, "Only this")
        XCTAssertFalse(value.appendTranscript("Wrong assistant", botId: "other"))
        XCTAssertEqual(value.draft.text, "Only this")
    }
    func testListenToReplyUsesTheServersVoiceAndRefusesLongReplies() async throws {
        let server = NativeMockServer(); defer { FakeExchange.remove(host: server.origin.host!) }
        let voice = VoiceController(); voice.api = client(server); voice.botId = "bot"
        defer { voice.cancel() }
        let long = Message(id: "long", role: "assistant", text: String(repeating: "a", count: VoiceController.maxSpokenText + 1))
        voice.speak(long)
        XCTAssertEqual(voice.error, "This reply is too long to read aloud. Ask for a shorter summary.")
        XCTAssertEqual(voice.state, .idle); XCTAssertTrue(server.requests.isEmpty)
        voice.speak(Message(id: "reply-1", role: "assistant", text: "The gate is closed."))
        XCTAssertEqual(voice.state, .preparing); XCTAssertEqual(voice.error, "")
        try await until { voice.state != .preparing }
        XCTAssertEqual(voice.state, .speaking, voice.error)
        let speak = try XCTUnwrap(server.requests.first { $0.url?.path == "/api/bots/bot/voice/speak" })
        XCTAssertEqual(speak.httpMethod, "POST")
        XCTAssertEqual(FakeExchange.body(speak).flatMap { try? JSONDecoder().decode([String: String].self, from: $0) }, ["messageId": "reply-1"])
        XCTAssertTrue(server.requests.contains { $0.url?.path.hasPrefix("/api/voice/audio/") == true && $0.value(forHTTPHeaderField: "Authorization") != nil })
        voice.cancel()
        XCTAssertEqual(voice.state, .idle)
    }
    func testDelayedPreferencesCannotReplaceNewIdentityPreferencesAndFailedLogoutRetainsToken() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        var preferences = Preferences(); preferences.theme = "dark"
        server.hold("/api/preferences")
        let operation = Task { await value.setPreferences(preferences) }
        try await server.waitForHeld("/api/preferences")
        server.user = "two"; await value.refreshBootstrap()
        server.release("/api/preferences"); _ = await operation.value
        XCTAssertEqual(value.bootstrap?.preferences.theme, "system")
        server.failLogout(); let signedOut = await value.signOut()
        XCTAssertFalse(signedOut); XCTAssertEqual(value.api?.token, "synthetic-native-session")
        XCTAssertEqual(value.bootstrap?.user.id, "two")
    }

    func testHermesUpgradeUsesAuthenticatedAPIAndRejectsAChangedCandidate() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        await value.upgrade.refresh()
        XCTAssertEqual(value.upgrade.status?.candidate?.revision, "candidate")
        XCTAssertEqual(server.requests.last?.value(forHTTPHeaderField: "Authorization"), "Bearer synthetic-native-session")
        await value.upgrade.install(candidateRevision: "stale-candidate")
        XCTAssertFalse(server.requests.contains { $0.url?.path == "/api/hermes/upgrade/install" })
        await value.upgrade.check()
        XCTAssertEqual(server.requests.last?.url?.path, "/api/hermes/upgrade/check")
        XCTAssertEqual(server.requests.last?.httpMethod, "POST")
        await value.upgrade.install(candidateRevision: "candidate")
        let request = try XCTUnwrap(server.requests.last)
        XCTAssertEqual(request.url?.path, "/api/hermes/upgrade/install")
        let body = try XCTUnwrap(FakeExchange.body(request))
        let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: String])
        XCTAssertEqual(payload["candidateRevision"], "candidate")
        XCTAssertNotNil(UUID(uuidString: payload["requestId"] ?? ""))
    }

    func testUncertainUpgradeInstallRequiresAStatusReadAndOlderServersGetUsefulGuidance() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        await value.upgrade.refresh()
        server.setUpgradeResponseStatus(503)
        await value.upgrade.install(candidateRevision: "candidate")
        XCTAssertTrue(value.upgrade.installUncertain)
        let requests = server.requests.count
        await value.upgrade.install(candidateRevision: "candidate")
        XCTAssertEqual(server.requests.count, requests, "Do not replay an uncertain install")
        server.setUpgradeResponseStatus(200)
        await value.upgrade.refresh()
        XCTAssertFalse(value.upgrade.installUncertain)
        server.setUpgradeResponseStatus(404)
        await value.upgrade.refresh()
        XCTAssertTrue(value.upgrade.error?.contains("update the app server") == true)
        XCTAssertEqual(value.draft.text, "Send this")
    }

    func testUpgradeRecoveryFencesStaleOperationsAndDoesNotReplayUncertainRequests() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        await value.upgrade.refresh()
        let initialCount = server.requests.count
        await value.upgrade.control("restart_service", operationId: "stale")
        await value.upgrade.control("cancel", operationId: "failed-update")
        XCTAssertEqual(server.requests.count, initialCount)
        server.setUpgradeResponseStatus(503)
        await value.upgrade.control("restart_service", operationId: "failed-update")
        let request = try XCTUnwrap(server.requests.last)
        XCTAssertEqual(request.url?.path, "/api/hermes/upgrade/control")
        let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(FakeExchange.body(request))) as? [String: String])
        XCTAssertEqual(payload["action"], "restart_service")
        XCTAssertEqual(payload["operationId"], "failed-update")
        XCTAssertNotNil(UUID(uuidString: payload["requestId"] ?? ""))
        XCTAssertTrue(value.upgrade.installUncertain)
        let count = server.requests.count
        await value.upgrade.control("retry", operationId: "failed-update")
        XCTAssertEqual(server.requests.count, count)
        server.setUpgradeResponseStatus(200)
        await value.upgrade.refresh()
        XCTAssertFalse(value.upgrade.installUncertain)
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
        let operation = Task { await value.upgrade.refresh() }
        try await server.waitForHeld(path)
        server.user = "two"; await value.refreshBootstrap()
        XCTAssertFalse(value.upgrade.busy)
        server.release(path); await operation.value
        XCTAssertNil(value.upgrade.status)
        XCTAssertNil(value.upgrade.error)
    }
}

extension NativeContractTests {
    func testOfflineColdLaunchRestoresSessionBoundReadOnlyChatThenRevalidates() async throws {
        let server = NativeMockServer()
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root); clean(server) }
        server.addFamilyBot()
        let bootstrap = try JSONDecoder().decode(Bootstrap.self, from: server.bootstrapData())
        let chat = try JSONDecoder().decode(Conversation.self, from: server.conversationData())
        let url = OfflineLibrary.url(origin: server.origin.absoluteString, token: "synthetic-native-session", root: root)
        OfflineLibrary(savedAt: Date(), bootstrap: bootstrap, conversations: ["bot": chat], selected: "bot").write(url)
        let expiryKey = DeviceDefaults.expiry(server.origin)
        UserDefaults.standard.set(ISO8601DateFormatter().string(from: Date(timeIntervalSinceNow: 3600)), forKey: expiryKey)
        defer { UserDefaults.standard.removeObject(forKey: expiryKey) }
        server.setOffline(true)
        let launched = launchedStore(server, token: "synthetic-native-session"); launched.offlineLibraryRoot = root
        launched.offlineWriteDelay = .milliseconds(200)
        await launched.restore(); launched.suspend()
        XCTAssertNotNil(launched.offlineSavedAt)
        XCTAssertEqual(launched.conversation?.messages.map(\.id), OfflineLibrary.conversation(chat).messages.map(\.id))
        XCTAssertFalse(launched.canSend); XCTAssertFalse(launched.connected)
        XCTAssertFalse(launched.householdConnected); XCTAssertTrue(launched.householdConnectionLost(offline: false))
        await launched.select("family")
        XCTAssertNotNil(launched.offlineSavedAt, "An uncached assistant still belongs to the restored offline roster")
        XCTAssertNil(launched.conversation)
        await launched.select("bot")
        server.setOffline(false)
        await launched.refreshBootstrap()
        XCTAssertFalse(launched.connected, "A roster read cannot authorize an unrevalidated cached chat")
        // Home goes live with the roster, though the last chat opened still shows its saved copy.
        XCTAssertTrue(launched.householdConnected); XCTAssertFalse(launched.householdConnectionLost(offline: false))
        await launched.refreshConversation()
        XCTAssertTrue(launched.connected); XCTAssertNil(launched.offlineSavedAt)
        _ = await launched.signOut()
        // Absence check: outlasts the shortened offline write delay three times over.
        try await Task.sleep(for: .milliseconds(600))
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path), "A delayed write recreated a signed-out snapshot")
    }
}


extension NativeContractTests {
    func testRosterAdditionKeepsOpenChatAndClipsWhileRemovalOnlyDeletesItsOwnClip() async throws {
        let server = NativeMockServer(), value = try store(server)
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        value.offlineLibraryRoot = root
        defer { try? FileManager.default.removeItem(at: root); clean(server, value) }
        let original = value.conversation
        let clip = try XCTUnwrap(value.voiceRecordingURL(botId: "bot"))
        try FileManager.default.createDirectory(at: clip.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("first recording".utf8).write(to: clip)
        server.addFamilyBot(); await value.refreshBootstrap()
        let other = try XCTUnwrap(value.voiceRecordingURL(botId: "family"))
        try Data("other recording".utf8).write(to: other)
        XCTAssertEqual(value.selectedBotId, "bot"); XCTAssertEqual(value.conversation, original)
        XCTAssertTrue(FileManager.default.fileExists(atPath: clip.path))
        server.hideBot(); await value.refreshBootstrap()
        XCTAssertNil(value.voiceRecordingURL(botId: "bot"), "A disappearing composer must not recreate a removed assistant's clip")
        XCTAssertFalse(FileManager.default.fileExists(atPath: clip.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: other.path))
        _ = await value.signOut()
        XCTAssertFalse(FileManager.default.fileExists(atPath: other.path))
    }
}

extension NativeContractTests {
    func testSnapshotWriterPersistsInBackgroundAndSkipsUnchangedPolls() async throws {
        let server = NativeMockServer(), value = try store(server)
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        value.offlineLibraryRoot = root; value.offlineWriteDelay = .milliseconds(200)
        defer { try? FileManager.default.removeItem(at: root); clean(server, value) }
        await value.refreshConversation(); value.suspend()
        let url = OfflineLibrary.url(origin: server.origin.absoluteString, token: "synthetic-native-session", root: root)
        try await until { FileManager.default.fileExists(atPath: url.path) }
        let original = try Data(contentsOf: url)
        XCTAssertNotNil(OfflineLibrary.read(url))
        await value.refreshBootstrap()
        // Absence check: outlasts the shortened offline write delay three times over.
        try await Task.sleep(for: .milliseconds(600))
        XCTAssertEqual(try Data(contentsOf: url), original, "An unchanged poll rewrote the snapshot")
        _ = await value.signOut()
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
    }
}

extension NativeContractTests {
    /// Before this, a relaunch from the offline library marked the cached draft ready before its saved send loaded,
    /// so a held Ask joined the sent copy, which then survived the send's acceptance as an editable draft.
    func testAnOfflineRelaunchKeepsHeldTextOffTheSentCopyUntilItsSendSettles() async throws {
        let server = NativeMockServer()
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let expiryKey = DeviceDefaults.expiry(server.origin)
        UserDefaults.standard.set(ISO8601DateFormatter().string(from: Date(timeIntervalSinceNow: 3600)), forKey: expiryKey)
        defer { try? FileManager.default.removeItem(at: root); UserDefaults.standard.removeObject(forKey: expiryKey); clean(server) }
        let value = try store(server)
        server.sendStatus = 503; await value.send()
        XCTAssertNotNil(value.pendings["bot"])
        XCTAssertFalse(value.sendingDraft, "After an uncertain answer the composer takes edits again, as on main and the web")
        value.queueAsk(AskRequest(botId: "bot", text: "What is for dinner?", scope: value.scope ?? "", at: Date()))
        await value.deliverAdditions()
        XCTAssertEqual(value.draft.text, "Send this")
        value.suspend()
        let bootstrap = try JSONDecoder().decode(Bootstrap.self, from: server.bootstrapData())
        let chat = try JSONDecoder().decode(Conversation.self, from: server.conversationData())
        OfflineLibrary(savedAt: Date(), bootstrap: bootstrap, conversations: ["bot": chat], selected: "bot")
            .write(OfflineLibrary.url(origin: server.origin.absoluteString, token: "synthetic-native-session", root: root))
        // Relaunch while the server cannot be reached: the roster comes from the device and the bootstrap read fails.
        server.setOffline(true)
        let launched = launchedStore(server, token: "synthetic-native-session"); launched.offlineLibraryRoot = root
        defer { launched.suspend() }
        await launched.restore(); await launched.deliverAdditions()
        XCTAssertTrue(launched.draftReady)
        XCTAssertNotNil(launched.pendings["bot"], "The saved send is back before the draft is ready")
        XCTAssertEqual(launched.draft.text, "Send this", "The sent copy stays exactly as sent")
        XCTAssertFalse(launched.sendingDraft, "A relaunch leaves it as the same session's uncertain answer does")
        XCTAssertEqual(launched.additions.map(\.text), ["What is for dinner?"])
        // Back online the send is accepted: its text clears and the question arrives alone.
        server.setOffline(false); server.answerSubmissions("accepted")
        await launched.refreshBootstrap(); await launched.reconcilePending(); await launched.deliverAdditions()
        XCTAssertNil(launched.pendings["bot"])
        XCTAssertEqual(launched.draft.text, "What is for dinner?")
        XCTAssertTrue(launched.additions.isEmpty)
    }

    /// Before this, a second Ask for another assistant opened its chat before the first one's text landed,
    /// leaving that text queued until it lapsed.
    func testAsksForTwoAssistantsInARowEachLandInTheirOwnDraft() async throws {
        let server = NativeMockServer(); server.addFamilyBot()
        let value = try store(server); defer { clean(server, value) }
        server.versionDrafts(); server.versionDrafts("family", text: "Milk", revision: 1)
        let scope = value.scope ?? ""
        value.queueAsk(AskRequest(botId: "family", text: "For the family", scope: scope, at: Date()))
        value.queueAsk(AskRequest(botId: "bot", text: "For the bot", scope: scope, at: Date()))
        await value.deliverAdditions()
        XCTAssertTrue(value.additions.isEmpty, "Neither question is left waiting")
        XCTAssertEqual(value.selectedBotId, "bot", "Each chat opens in turn, and the last one asked stays open")
        XCTAssertTrue(value.draft.text.hasSuffix("For the bot")); XCTAssertFalse(value.draft.text.contains("For the family"))
        let family: Draft? = value.read(value.key(.draft, "family"))
        XCTAssertEqual(family?.text, "Milk\n\nFor the family")
        value.suspend()
    }
}

extension NativeContractTests {
    /// Before this, an Ask held by an unsettled send kept its chat as the drain's destination, so a later Ask for
    /// another assistant never opened, even after the first one lapsed.
    func testAHeldAskNeverKeepsAnotherAssistantsAskFromOpening() async throws {
        let server = NativeMockServer(); server.addFamilyBot()
        let value = try store(server); defer { clean(server, value) }
        server.versionDrafts(); server.versionDrafts("family", text: "Milk", revision: 1)
        let scope = value.scope ?? ""
        value.pendings["bot"] = PendingSubmission(requestId: "r1", botId: "bot", text: "Send this", attachments: [], reviewedInterruption: false)
        value.queueAsk(AskRequest(botId: "bot", text: "For the bot", scope: scope, at: Date()))
        await value.deliverAdditions()
        XCTAssertEqual(value.draft.text, "Send this", "Held behind its unsettled send")
        value.queueAsk(AskRequest(botId: "family", text: "For the family", scope: scope, at: Date()))
        await value.deliverAdditions()
        XCTAssertEqual(value.selectedBotId, "family")
        XCTAssertEqual(value.draft.text, "Milk\n\nFor the family")
        XCTAssertEqual(value.additions.map(\.text), ["For the bot"], "The first question waits for its own draft")
        // Its send settles and the person returns to it: the question lands there.
        value.pendings = [:]
        await value.select("bot"); await value.deliverAdditions()
        XCTAssertTrue(value.draft.text.hasSuffix("For the bot"), value.draft.text)
        XCTAssertTrue(value.additions.isEmpty)
        value.suspend()
    }

    /// Before this, an Ask that lapsed while its chat opened landed anyway, because expiry was checked only
    /// before the opening's reads.
    func testAnAskThatLapsesWhileItsChatOpensIsDropped() async throws {
        let server = NativeMockServer(); server.addFamilyBot()
        let value = try store(server); defer { clean(server, value) }
        server.versionDrafts("family", text: "Milk", revision: 1)
        let path = "/api/bots/family/draft"; server.holdNext(path)
        value.queueAsk(AskRequest(botId: "family", text: "Too late", scope: value.scope ?? "", at: Date().addingTimeInterval(0.5 - AskRequest.patience)))
        let delivering = Task { await value.deliverAdditions() }
        try await server.waitForHeld(path)
        // Timer: the Ask's last half second of patience runs out while the chat's read is held.
        try await Task.sleep(for: .milliseconds(700))
        server.release(path); await delivering.value
        await value.deliverAdditions()
        XCTAssertEqual(value.selectedBotId, "family")
        XCTAssertEqual(value.draft.text, "Milk")
        XCTAssertTrue(value.additions.isEmpty)
        value.suspend()
    }

    /// Before this, a reply or shared text queued after an Ask for the open chat landed ahead of it.
    func testTextFromEverySourceLandsInTheOrderItArrived() async throws {
        let server = NativeMockServer(), value = try store(server); defer { clean(server, value) }
        value.queueAsk(AskRequest(botId: "bot", text: "First", scope: value.scope ?? "", at: Date()))
        XCTAssertTrue(value.addNotificationReply("Second", botId: "bot", account: one))
        XCTAssertTrue(value.holdShared("Third", botId: "bot"))
        await value.deliverAdditions()
        XCTAssertEqual(value.draft.text, "Send this\n\nFirst\n\nSecond\n\nThird")
        XCTAssertTrue(value.additions.isEmpty)
        value.suspend()
    }
}
