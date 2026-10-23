import Foundation
import XCTest
@testable import AgentInterface

/// Holds a response without blocking URLSession's protocol queue. Tests release it only after
/// changing the account, client or view, so they do not depend on scheduling or fixed sleeps.
private final class AutomationResponseGate: @unchecked Sendable {
  private let lock = NSLock()
  private var delivery: (@Sendable () -> Void)?
  private var released = false
  func hold(_ delivery: @escaping @Sendable () -> Void) {
    let deliverNow = lock.withLock {
      if released { return true }
      self.delivery = delivery; return false
    }
    if deliverNow { delivery() }
  }
  func release() {
    let delivery = lock.withLock {
      released = true
      let pending = self.delivery; self.delivery = nil
      return pending
    }
    delivery?()
  }
}

private final class AutomationFixtureProtocol: URLProtocol, @unchecked Sendable {
  private static let lock = NSLock()
  nonisolated(unsafe) private static var servers: [String: AutomationFixtureServer] = [:]
  static func register(_ server: AutomationFixtureServer) {
    lock.withLock { servers[server.origin.host!] = server }
  }
  static func remove(_ server: AutomationFixtureServer) {
    _ = lock.withLock { servers.removeValue(forKey: server.origin.host!) }
  }
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  private let stateLock = NSLock()
  private var stopped = false
  override func startLoading() {
    guard let host = request.url?.host, let server = Self.lock.withLock({ Self.servers[host] }) else {
      client?.urlProtocol(self, didFailWithError: URLError(.badURL)); return
    }
    let reply = server.receive(request)
    let deliver: @Sendable () -> Void = { [self] in
      guard !stateLock.withLock({ stopped }) else { return }
      let response = HTTPURLResponse(url: request.url!, statusCode: reply.status,
        httpVersion: nil, headerFields: ["Content-Type": "application/json", "Cache-Control": "no-store"])!
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: reply.data)
      client?.urlProtocolDidFinishLoading(self)
    }
    if let gate = reply.gate { gate.hold(deliver) } else { deliver() }
  }
  override func stopLoading() { stateLock.withLock { stopped = true } }
}

private final class AutomationFixtureServer: @unchecked Sendable {
  struct Reply: Sendable { var status: Int; var data: Data; var gate: AutomationResponseGate? = nil }
  let origin = URL(string: "https://automation-\(UUID().uuidString.lowercased()).example.test")!
  private let lock = NSLock()
  private var replies: [String: [Reply]] = [:]
  private var recorded: [URLRequest] = []
  var requests: [URLRequest] { lock.withLock { recorded } }
  func enqueue(_ method: String, _ path: String, _ data: Data, status: Int = 200, gate: AutomationResponseGate? = nil) {
    lock.withLock { replies[method + " " + path, default: []].append(Reply(status: status, data: data, gate: gate)) }
  }
  func receive(_ request: URLRequest) -> Reply {
    lock.withLock {
      recorded.append(request)
      let key = (request.httpMethod ?? "GET") + " " + (request.url?.path ?? "")
      guard var queue = replies[key], !queue.isEmpty else {
        return Reply(status: 500, data: Data(#"{"error":"No fixture for request"}"#.utf8))
      }
      let reply = queue.removeFirst(); replies[key] = queue
      return reply
    }
  }
}

@MainActor final class AutomationTests: XCTestCase {
  private let path = "/api/bots/ranch/automation"
  // Wire fixture for src/shared/automation.ts and src/server/automation.ts.
  private func overview(resume: [String: Any]? = nil, canManage: Bool? = true, goalStatus: String = "paused", interrupted: Bool = false) throws -> Data {
    var goals: [String: Any] = ["supported": true, "goal": [
      "title": "Maintain the pasture", "status": goalStatus, "turnsUsed": 4, "maxTurns": 20,
      "pausedReason": "Waiting for your approval"]]
    if let resume { goals["resume"] = resume }
    goals["interruptionPending"] = interrupted
    var value: [String: Any] = [
      "botId": "ranch", "owner": "Hermes", "goals": goals,
      "tasks": ["supported": true, "items": [[
        "id": "t_fence", "title": "Check fence", "body": "Check the north gate", "status": "blocked",
        "priority": 5, "assignee": NSNull(), "owner": "ranch", "dependencies": ["t_supplies"], "blockedReason": "Needs supplies"]]],
      "triggers": ["supported": true, "items": [subscription], "platformEnabled": false],
      "skills": ["supported": true, "installed": [["name": "ranch/fences", "description": "Fence inspection"]],
        "pending": [["id": "deadbeef", "summary": "Add gate check", "origin": "agent", "revision": String(repeating: "a", count: 64)]],
        "approvalRequired": true],
    ]
    if let canManage { value["canManageTriggers"] = canManage }
    return try JSONSerialization.data(withJSONObject: value)
  }
  private var subscription: [String: Any] { [
    "id": "gate-event", "description": "Gate alert", "events": ["gate.open"], "routineId": "routine-gate",
    "enabled": false, "url": "https://hermes.example.test/webhook/gate-event", "secretSet": true,
    "revision": String(repeating: "b", count: 64),
  ] }
  private func client(_ server: AutomationFixtureServer) -> APIClient {
    AutomationFixtureProtocol.register(server)
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [AutomationFixtureProtocol.self]
    let api = APIClient(baseURL: server.origin, session: URLSession(configuration: config))
    api.token = "automation-fixture-token"
    return api
  }
  private struct BootstrapFixture: Decodable { var response: Bootstrap }
  private func makeStore(_ api: APIClient) throws -> AppStore {
    let store = AppStore()
    store.widgetSnapshotURL = nil
    store.api = api
    let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Contract/bootstrap.json")
    store.bootstrap = try JSONDecoder().decode(BootstrapFixture.self, from: Data(contentsOf: url)).response
    return store
  }
  private enum Invalidation: CaseIterable { case account, client, dismissal, cancellation }
  private func invalidate(
    _ reason: Invalidation, store: AppStore, server: AutomationFixtureServer,
    control: HermesAutomationControls, lifetime: HermesAutomationLifetime? = nil
  ) {
    switch reason {
    case .account:
      var bootstrap = store.bootstrap!; bootstrap.user.id = UUID().uuidString; store.bootstrap = bootstrap
    case .client: store.api = client(server) // Same origin and scope, a different client instance.
    case .dismissal:
      if let lifetime { lifetime.disappear() } else { control.disappear() }
    case .cancellation: break // The test cancels its actual task.
    }
  }
  private func object<V: Encodable>(_ value: V) throws -> [String: Any] {
    try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as? [String: Any])
  }
  private func body(_ request: URLRequest) throws -> [String: Any] {
    var data = request.httpBody ?? Data()
    if let stream = request.httpBodyStream {
      stream.open(); defer { stream.close() }
      var bytes = [UInt8](repeating: 0, count: 4096)
      while stream.hasBytesAvailable {
        let count = stream.read(&bytes, maxLength: bytes.count)
        if count <= 0 { break }
        data.append(bytes, count: count)
      }
    }
    return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
  }
  func testOverviewDecodesNativeContractsAndOptionalFields() throws {
    let resume = ["requestId": UUID().uuidString, "status": "accepted", "runId": "run-fence"]
    let value: HermesAutomationOverview = try APIClient.decode(overview(resume: resume), from: path)
    XCTAssertEqual(value.botId, "ranch")
    XCTAssertEqual(value.goals.goal?.maxTurns, 20)
    XCTAssertEqual(value.goals.goal?.pausedReason, "Waiting for your approval")
    XCTAssertEqual(value.goals.resume?.status, "accepted")
    XCTAssertEqual(value.goals.resume?.runId, "run-fence")
    XCTAssertNil(value.tasks.items.first?.assignee)
    XCTAssertEqual(value.tasks.items.first?.dependencies, ["t_supplies"])
    XCTAssertEqual(value.triggers.items.first?.revision, String(repeating: "b", count: 64))
    XCTAssertFalse(value.triggers.platformEnabled)
    XCTAssertTrue(value.skills.approvalRequired)
    XCTAssertEqual(value.skills.installed.first?.name, "ranch/fences")
    XCTAssertEqual(value.canManageTriggers, true)
    let older: HermesAutomationOverview = try APIClient.decode(overview(canManage: nil), from: path)
    XCTAssertNil(older.goals.resume)
    XCTAssertNil(older.canManageTriggers)
    let denied: HermesAutomationOverview = try APIClient.decode(overview(canManage: false), from: path)
    XCTAssertEqual(denied.canManageTriggers, false)
    let unsupported = Data(#"{"botId":"ranch","owner":"Hermes","goals":{"supported":false,"reason":"Update Hermes","goal":null},"tasks":{"supported":false,"items":[]},"triggers":{"supported":false,"items":[],"platformEnabled":false},"skills":{"supported":false,"installed":[],"pending":[],"approvalRequired":true}}"#.utf8)
    let absent: HermesAutomationOverview = try APIClient.decode(unsupported, from: path)
    XCTAssertFalse(absent.goals.supported); XCTAssertNil(absent.goals.goal)
    XCTAssertEqual(absent.goals.reason, "Update Hermes")
    XCTAssertTrue(absent.tasks.items.isEmpty)
  }
  func testDetailRevisionDrivesDecisionsAndTruncatedDiffCannotBeApproved() throws {
    let list: HermesAutomationOverview = try APIClient.decode(overview(), from: path)
    let detailRevision = String(repeating: "c", count: 64)
    let data = try JSONSerialization.data(withJSONObject: [
      "id": "deadbeef", "diff": "+ Check the north gate", "revision": detailRevision, "truncated": false])
    var detail: HermesSkillDiff = try APIClient.decode(data, from: path + "/skills/pending/deadbeef")
    XCTAssertNotEqual(detail.revision, list.skills.pending.first?.revision)
    let decision = try XCTUnwrap(detail.decision(.approve))
    XCTAssertEqual(try object(decision)["revision"] as? String, detailRevision)
    XCTAssertEqual(try object(decision)["decision"] as? String, "approve")
    detail.truncated = true
    XCTAssertNil(detail.decision(.approve))
    XCTAssertEqual(detail.decision(.reject)?.revision, detailRevision)
    let content: HermesSkillContent = try APIClient.decode(Data(##"{"name":"ranch/fences","content":"# Fence inspection","truncated":true}"##.utf8), from: path)
    XCTAssertTrue(content.truncated); XCTAssertEqual(content.content, "# Fence inspection")
  }
  func testTaskIntentRetainsUUIDForRetryAndUsesFlatFinitePayload() throws {
    var intent = HermesTaskCreationIntent()
    var draft = HermesTaskDraft(title: "Fix fence", body: "North gate", priority: 5,
      assignee: "ranch", dependencies: ["t_supplies"])
    let first = intent.prepare(draft)
    XCTAssertNotNil(UUID(uuidString: first.requestId))
    XCTAssertEqual(intent.prepare(draft).requestId, first.requestId)
    let wire = try object(first)
    XCTAssertEqual(Set(wire.keys), Set(["requestId", "title", "body", "priority", "assignee", "dependencies"]))
    XCTAssertEqual(wire["dependencies"] as? [String], ["t_supplies"])
    draft.body = "South gate"
    XCTAssertNotEqual(intent.prepare(draft).requestId, first.requestId)
    draft.body = String(repeating: "a", count: 20_001)
    XCTAssertFalse(draft.valid)
    draft.body = "Ready"; XCTAssertTrue(draft.valid)
    XCTAssertNil(try object(HermesTaskUpdate(draft))["requestId"])
  }
  func testUnassignedTasksEncodeExplicitNullAndTruncatedBoardsDecode() throws {
    let draft = HermesTaskDraft(title: "Unassigned work", assignee: nil)
    XCTAssertTrue(try object(HermesTaskUpdate(draft))["assignee"] is NSNull)
    XCTAssertTrue(try object(HermesTaskCreate(draft: draft, requestId: UUID().uuidString))["assignee"] is NSNull)
    var json = try XCTUnwrap(JSONSerialization.jsonObject(with: overview()) as? [String: Any])
    var tasks = try XCTUnwrap(json["tasks"] as? [String: Any])
    tasks["truncated"] = true; tasks["limit"] = 100; json["tasks"] = tasks
    let value: HermesAutomationOverview = try APIClient.decode(JSONSerialization.data(withJSONObject: json), from: path)
    XCTAssertEqual(value.tasks.truncated, true); XCTAssertEqual(value.tasks.limit, 100)
  }
  func testResumeIntentOnlyResetsForMatchingDefinitiveReceipt() {
    var intent = HermesGoalResumeIntent()
    let first = intent.prepare().requestId
    XCTAssertEqual(intent.prepare().requestId, first)
    intent.resolve(HermesGoalResumeReceipt(requestId: first, status: "uncertain"))
    XCTAssertEqual(intent.prepare().requestId, first)
    intent.resolve(HermesGoalResumeReceipt(requestId: UUID().uuidString, status: "accepted"))
    XCTAssertEqual(intent.prepare().requestId, first)
    intent.resolve(HermesGoalResumeReceipt(requestId: first, status: "accepted", runId: "run-one"))
    XCTAssertNil(intent.requestId)
    let second = intent.prepare().requestId
    XCTAssertNotEqual(second, first)
    intent.resolve(HermesGoalResumeReceipt(requestId: second, status: "rejected"))
    XCTAssertNil(intent.requestId)
  }
  func testTriggerPayloadsPreserveRevisionAndExcludeSecretsAndExecutionFields() throws {
    let draft = HermesTriggerInput(id: "gate-event", description: "Gate alert", events: ["gate.open"], routineId: "routine-gate")
    XCTAssertTrue(draft.valid)
    let update = try object(HermesTriggerUpdate(draft, revision: "revision-from-overview"))
    XCTAssertEqual(Set(update.keys), Set(["description", "events", "routineId", "revision"]))
    XCTAssertEqual(update["revision"] as? String, "revision-from-overview")
    XCTAssertEqual(try object(HermesTriggerToggle(enabled: true, revision: "current"))["revision"] as? String, "current")
    XCTAssertEqual(Set(try object(HermesRevisionInput(revision: "current")).keys), ["revision"])
    var invalid = draft; invalid.id = "Uppercase"; XCTAssertFalse(invalid.valid)
    invalid = draft; invalid.id = String(repeating: "a", count: 81); XCTAssertFalse(invalid.valid)
    invalid = draft; invalid.events = []; XCTAssertFalse(invalid.valid)
    invalid = draft; invalid.events = ["event with spaces"]; XCTAssertFalse(invalid.valid)
  }
  func testSecretDefaultsToHiddenAndCanBeClearedWithoutPersistence() throws {
    let data = try JSONSerialization.data(withJSONObject: ["subscription": subscription, "secret": "once-only-fixture"])
    let result: HermesTriggerResult = try APIClient.decode(data, from: path + "/triggers")
    var transient = HermesTransientSecret()
    transient.receive(result)
    XCTAssertEqual(transient.value, "once-only-fixture")
    XCTAssertFalse(transient.revealed)
    transient.reveal(true); XCTAssertTrue(transient.revealed)
    transient.clear()
    XCTAssertNil(transient.value); XCTAssertNil(transient.url); XCTAssertFalse(transient.revealed)
    transient.reveal(true); XCTAssertFalse(transient.revealed)
  }
  func testUnconfirmedMutationRequiresSuccessfulRefreshAndNeverReplays() async throws {
    let server = AutomationFixtureServer(), store = try makeStore(client(server))
    defer { AutomationFixtureProtocol.remove(server) }
    server.enqueue("GET", path, try overview())
    server.enqueue("PUT", path + "/goal", Data(#"{"error":"Native response lost"}"#.utf8), status: 502)
    server.enqueue("GET", path, Data(#"{"error":"Still unavailable"}"#.utf8), status: 503)
    server.enqueue("GET", path, try overview())
    let control = HermesAutomationControls(botId: "ranch")
    let initial = await control.refresh(store); XCTAssertTrue(initial)
    let input = HermesGoalInput(title: "Fix fence", maxTurns: 20)
    let result = await control.changeOK(store, "/goal", input, method: "PUT")
    XCTAssertFalse(result); XCTAssertTrue(control.needsRefresh); XCTAssertTrue(control.disabled)
    XCTAssertTrue(control.error?.contains("Nothing will be sent again automatically") == true)
    let blocked = await control.changeOK(store, "/goal", input, method: "PUT")
    XCTAssertFalse(blocked)
    let failedRefresh = await control.refresh(store); XCTAssertFalse(failedRefresh)
    XCTAssertTrue(control.needsRefresh)
    let refreshed = await control.refresh(store); XCTAssertTrue(refreshed)
    XCTAssertFalse(control.disabled)
    XCTAssertEqual(server.requests.filter { $0.httpMethod == "PUT" }.count, 1)
  }
  func testExplicitTaskRetrySendsSameRequestUUIDAfterStatusRead() async throws {
    let server = AutomationFixtureServer(), store = try makeStore(client(server))
    defer { AutomationFixtureProtocol.remove(server) }
    for _ in 0..<3 { server.enqueue("GET", path, try overview()) }
    server.enqueue("POST", path + "/tasks", Data(#"{"error":"Response lost"}"#.utf8), status: 502)
    server.enqueue("POST", path + "/tasks", Data(#"{"id":"t_created","title":"Fix fence","body":"North gate","status":"blocked","priority":0,"assignee":"ranch","owner":"ranch","dependencies":[]}"#.utf8))
    let control = HermesAutomationControls(botId: "ranch")
    _ = await control.refresh(store)
    var intent = HermesTaskCreationIntent()
    let draft = HermesTaskDraft(title: "Fix fence", body: "North gate", assignee: "ranch")
    let first: HermesTask? = await control.change(store, "/tasks", intent.prepare(draft))
    XCTAssertNil(first)
    _ = await control.refresh(store)
    let second: HermesTask? = await control.change(store, "/tasks", intent.prepare(draft))
    XCTAssertEqual(second?.status, "blocked")
    let writes = server.requests.filter { $0.httpMethod == "POST" }
    XCTAssertEqual(writes.count, 2)
    XCTAssertEqual(try body(writes[0])["requestId"] as? String, try body(writes[1])["requestId"] as? String)
    XCTAssertNil(try body(writes[0])["initial_status"])
  }
  func testResumeSendsStableUUIDAndAcceptsDurableReceipt() async throws {
    let server = AutomationFixtureServer(), store = try makeStore(client(server))
    defer { AutomationFixtureProtocol.remove(server) }
    let control = HermesAutomationControls(botId: "ranch")
    let requestId = control.resumeIntent.prepare().requestId
    let accepted = try overview(resume: ["requestId": requestId, "status": "accepted", "runId": "run-one"])
    server.enqueue("GET", path, try overview())
    server.enqueue("POST", path + "/goal/resume", accepted)
    server.enqueue("GET", path, accepted)
    _ = await control.refresh(store)
    await control.resume(store)
    let request = try XCTUnwrap(server.requests.first { $0.httpMethod == "POST" })
    XCTAssertEqual(Set(try body(request).keys), ["requestId"])
    XCTAssertEqual(try body(request)["requestId"] as? String, requestId)
    XCTAssertEqual(control.value?.goals.resume?.runId, "run-one")
    XCTAssertNil(control.resumeIntent.requestId)
  }
  func testInterruptedResumeRequiresExplicitReviewAndOmitsImplicitAcknowledgement() async throws {
    let server = AutomationFixtureServer(), store = try makeStore(client(server))
    defer { AutomationFixtureProtocol.remove(server) }
    server.enqueue("GET", path, try overview(interrupted: true))
    let control = HermesAutomationControls(botId: "ranch")
    _ = await control.refresh(store)
    await control.resume(store)
    XCTAssertFalse(server.requests.contains { $0.httpMethod == "POST" })
    XCTAssertNil(control.resumeIntent.requestId)
    let requestId = control.resumeIntent.prepare().requestId
    let accepted = try overview(resume: ["requestId": requestId, "status": "accepted", "message": "Goal continuation accepted."], goalStatus: "active")
    server.enqueue("POST", path + "/goal/resume", accepted)
    server.enqueue("GET", path, accepted)
    await control.resume(store, reviewedInterruption: true)
    let sent = try XCTUnwrap(server.requests.first { $0.httpMethod == "POST" })
    XCTAssertEqual(try body(sent)["reviewedInterruption"] as? Bool, true)
    XCTAssertEqual(control.notice, "Goal continuation accepted.")
    var intent = HermesGoalResumeIntent()
    XCTAssertNil(try object(intent.prepare())["reviewedInterruption"])
  }
  func testRejectedResumeShowsNativeMessageAndNeverClaimsSavedSuccess() async throws {
    let server = AutomationFixtureServer(), store = try makeStore(client(server))
    defer { AutomationFixtureProtocol.remove(server) }
    let control = HermesAutomationControls(botId: "ranch")
    let requestId = control.resumeIntent.prepare().requestId
    let rejected = try overview(resume: ["requestId": requestId, "status": "rejected", "message": "Another task still owns this session."])
    server.enqueue("GET", path, try overview())
    server.enqueue("POST", path + "/goal/resume", rejected)
    server.enqueue("GET", path, rejected)
    _ = await control.refresh(store)
    await control.resume(store)
    XCTAssertEqual(control.value?.goals.goal?.status, "paused")
    XCTAssertEqual(control.error, "Another task still owns this session.")
    XCTAssertNil(control.notice)
    XCTAssertNil(control.resumeIntent.requestId)
  }
  func testUnconfirmedResumeFromAnotherDeviceRequiresReviewedFreshAttempt() async throws {
    let server = AutomationFixtureServer(), store = try makeStore(client(server))
    defer { AutomationFixtureProtocol.remove(server) }
    let priorId = UUID().uuidString
    server.enqueue("GET", path, try overview(resume: ["requestId": priorId, "status": "uncertain"], interrupted: true))
    server.enqueue("POST", path + "/goal/resume", Data(#"{"error":"New admission response lost"}"#.utf8), status: 502)
    let control = HermesAutomationControls(botId: "ranch")
    _ = await control.refresh(store)
    XCTAssertFalse(control.canResume)
    XCTAssertTrue(control.canStartNewResumeAttempt)
    await control.resume(store, reviewedInterruption: true)
    let noConversationReview = await control.startNewResumeAttempt(store, reviewedConversation: false,
      acceptsRepeatedWork: true, reviewedInterruption: true)
    let noRepeatConsent = await control.startNewResumeAttempt(store, reviewedConversation: true,
      acceptsRepeatedWork: false, reviewedInterruption: true)
    let noInterruptionReview = await control.startNewResumeAttempt(store, reviewedConversation: true,
      acceptsRepeatedWork: true, reviewedInterruption: false)
    XCTAssertFalse(noConversationReview); XCTAssertFalse(noRepeatConsent); XCTAssertFalse(noInterruptionReview)
    XCTAssertFalse(server.requests.contains { $0.httpMethod == "POST" })
    XCTAssertNil(control.resumeIntent.requestId)
    let sent = await control.startNewResumeAttempt(store, reviewedConversation: true,
      acceptsRepeatedWork: true, reviewedInterruption: true)
    XCTAssertTrue(sent)
    let request = try XCTUnwrap(server.requests.first { $0.httpMethod == "POST" })
    let wire = try body(request)
    let newId = try XCTUnwrap(wire["requestId"] as? String)
    XCTAssertNotNil(UUID(uuidString: newId)); XCTAssertNotEqual(newId, priorId)
    XCTAssertEqual(wire["reviewedInterruption"] as? Bool, true)
    XCTAssertEqual(control.resumeIntent.requestId, newId)
    XCTAssertTrue(control.needsRefresh)
    let blocked = await control.startNewResumeAttempt(store, reviewedConversation: true,
      acceptsRepeatedWork: true, reviewedInterruption: true)
    XCTAssertFalse(blocked)
    XCTAssertEqual(server.requests.filter { $0.httpMethod == "POST" }.count, 1)
  }
  func testConfirmedGoalReplacementRetiresPreviousResumeIntent() async throws {
    let server = AutomationFixtureServer(), store = try makeStore(client(server))
    let key = "automation-test.\(UUID().uuidString)"
    defer { AutomationFixtureProtocol.remove(server); UserDefaults.standard.removeObject(forKey: key) }
    UserDefaults.standard.set(UUID().uuidString, forKey: key)
    server.enqueue("GET", path, try overview())
    server.enqueue("PUT", path + "/goal", try overview())
    server.enqueue("GET", path, try overview())
    let control = HermesAutomationControls(botId: "ranch")
    control.restoreResumeIntent(key: key)
    _ = await control.refresh(store)
    XCTAssertNotNil(control.resumeIntent.requestId)
    let result = await control.changeOK(store, "/goal", HermesGoalInput(title: "Replacement goal", maxTurns: 10), method: "PUT")
    XCTAssertTrue(result)
    XCTAssertNil(control.resumeIntent.requestId)
    XCTAssertNil(UserDefaults.standard.string(forKey: key))
  }
  func testResumeIntentSurvivesReopeningUntilDefinitiveStatus() async throws {
    let server = AutomationFixtureServer(), store = try makeStore(client(server))
    let key = "automation-test.\(UUID().uuidString)"
    defer { AutomationFixtureProtocol.remove(server); UserDefaults.standard.removeObject(forKey: key) }
    server.enqueue("GET", path, try overview())
    server.enqueue("POST", path + "/goal/resume", Data(#"{"error":"Response lost"}"#.utf8), status: 502)
    let first = HermesAutomationControls(botId: "ranch")
    first.restoreResumeIntent(key: key)
    _ = await first.refresh(store)
    await first.resume(store)
    let requestId = try XCTUnwrap(first.resumeIntent.requestId)
    XCTAssertEqual(UserDefaults.standard.string(forKey: key), requestId)
    first.disappear()
    let reopened = HermesAutomationControls(botId: "ranch")
    reopened.restoreResumeIntent(key: key)
    XCTAssertEqual(reopened.resumeIntent.requestId, requestId)
    server.enqueue("GET", path, try overview(resume: ["requestId": requestId, "status": "uncertain"]))
    _ = await reopened.refresh(store)
    XCTAssertEqual(UserDefaults.standard.string(forKey: key), requestId)
    server.enqueue("GET", path, try overview(resume: ["requestId": requestId, "status": "rejected"]))
    _ = await reopened.refresh(store)
    XCTAssertNil(reopened.resumeIntent.requestId)
    XCTAssertNil(UserDefaults.standard.string(forKey: key))
    XCTAssertEqual(server.requests.filter { $0.httpMethod == "POST" }.count, 1)
  }
  func testCompletedAndActiveGoalsCannotBeResumed() async throws {
    let server = AutomationFixtureServer(), store = try makeStore(client(server))
    defer { AutomationFixtureProtocol.remove(server) }
    let control = HermesAutomationControls(botId: "ranch")
    for status in ["completed", "active"] {
      server.enqueue("GET", path, try overview(goalStatus: status))
      _ = await control.refresh(store)
      await control.resume(store)
    }
    XCTAssertFalse(server.requests.contains { $0.httpMethod == "POST" })
    XCTAssertNil(control.resumeIntent.requestId)
  }
  func testForegroundExitClearsSecretAndBackgroundResponseDoesNotRevealIt() async throws {
    let server = AutomationFixtureServer(), store = try makeStore(client(server))
    defer { AutomationFixtureProtocol.remove(server) }
    server.enqueue("GET", path, try overview())
    server.enqueue("POST", path + "/triggers", try JSONSerialization.data(withJSONObject: ["subscription": subscription, "secret": "once-only-fixture"]))
    server.enqueue("GET", path, try overview())
    let control = HermesAutomationControls(botId: "ranch")
    control.appear(foreground: true)
    _ = await control.refresh(store)
    let result: HermesTriggerResult? = await control.change(store, "/triggers",
      HermesTriggerInput(id: "gate-event", description: "Gate alert", events: ["gate.open"], routineId: "routine-gate"))
    XCTAssertNotNil(result)
    XCTAssertEqual(control.secret.value, "once-only-fixture")
    control.foreground(false)
    XCTAssertNil(control.secret.value)
    server.enqueue("POST", path + "/triggers", try JSONSerialization.data(withJSONObject: ["subscription": subscription, "secret": "background-fixture"]))
    server.enqueue("GET", path, try overview())
    let _: HermesTriggerResult? = await control.change(store, "/triggers",
      HermesTriggerInput(id: "other-event", description: "Gate alert", events: ["gate.open"], routineId: "routine-gate"))
    XCTAssertNil(control.secret.value)
    control.disappear(); XCTAssertNil(control.secret.url)
  }
  func testDelayedOverviewAndRoutineReadsDiscardStaleSuccessesAndErrors() async throws {
    for reason in Invalidation.allCases {
      for failing in [false, true] {
        for routines in [false, true] {
          let server = AutomationFixtureServer(), store = try makeStore(client(server))
          defer { AutomationFixtureProtocol.remove(server) }
          let control = HermesAutomationControls(botId: "ranch"), gate = AutomationResponseGate()
          server.enqueue("GET", path, try overview())
          _ = await control.refresh(store)
          let readPath = routines ? "/api/routines" : path
          let data = failing ? Data(#"{"error":"Earlier session failed"}"#.utf8)
            : routines ? Data(#"[{"id":"gate","botId":"ranch","name":"Gate","prompt":"Check gate","schedule":"0 7 * * *","enabled":true}]"#.utf8)
            : try overview(goalStatus: "active")
          server.enqueue("GET", readPath, data, status: failing ? 503 : 200, gate: gate)
          let previousCount = server.requests.count
          control.error = "Keep current overview error"; control.triggerRoutineError = "Keep current routine error"
          let task = Task {
            if routines { await control.loadTriggerRoutines(store) } else { _ = await control.refresh(store) }
          }
          try await until { server.requests.count == previousCount + 1 }
          invalidate(reason, store: store, server: server, control: control)
          if reason == .cancellation { task.cancel() }
          gate.release()
          await task.value
          XCTAssertEqual(control.value?.goals.goal?.status, "paused", "\(reason), routines=\(routines), failure=\(failing)")
          XCTAssertTrue(control.triggerRoutines.isEmpty)
          XCTAssertEqual(control.error, "Keep current overview error")
          XCTAssertEqual(control.triggerRoutineError, "Keep current routine error")
          XCTAssertFalse(control.loading); XCTAssertFalse(control.loadingTriggerRoutines)
        }
      }
    }
  }

  func testDelayedWriteCannotPublishSecretsOrStartFollowUpAfterInvalidation() async throws {
    for reason in Invalidation.allCases {
      for failing in [false, true] {
        let server = AutomationFixtureServer(), store = try makeStore(client(server))
        defer { AutomationFixtureProtocol.remove(server) }
        let control = HermesAutomationControls(botId: "ranch"), gate = AutomationResponseGate()
        control.appear(foreground: true)
        server.enqueue("GET", path, try overview())
        _ = await control.refresh(store)
        let data = failing ? Data(#"{"error":"Earlier session failed"}"#.utf8)
          : try JSONSerialization.data(withJSONObject: ["subscription": subscription, "secret": "must-never-display"])
        server.enqueue("POST", path + "/triggers", data, status: failing ? 503 : 200, gate: gate)
        let task = Task { () -> HermesTriggerResult? in
          await control.change(store, "/triggers", HermesTriggerInput(id: "gate-event", description: "Gate alert",
            events: ["gate.open"], routineId: "routine-gate"))
        }
        try await until { server.requests.count == 2 }
        invalidate(reason, store: store, server: server, control: control)
        if reason == .cancellation { task.cancel() }
        gate.release()
        let result = await task.value
        XCTAssertNil(result); XCTAssertNil(control.secret.value); XCTAssertNil(control.secret.url)
        XCTAssertNil(control.notice); XCTAssertNil(control.error)
        XCTAssertTrue(control.needsRefresh); XCTAssertFalse(control.busy)
        XCTAssertEqual(server.requests.count, 2, "No follow-up may start under \(reason)")
        let replay: HermesTriggerResult? = await control.change(store, "/triggers", [String: String]())
        XCTAssertNil(replay); XCTAssertEqual(server.requests.count, 2)
      }
    }
  }

  func testDismissalOrSessionChangeDuringFollowUpCannotPublishNoticeOrSecret() async throws {
    for reason in Invalidation.allCases {
      for resume in [false, true] {
        for failing in [false, true] {
          let server = AutomationFixtureServer(), store = try makeStore(client(server))
          defer { AutomationFixtureProtocol.remove(server) }
          let control = HermesAutomationControls(botId: "ranch"), gate = AutomationResponseGate()
          control.appear(foreground: true)
          server.enqueue("GET", path, try overview())
          _ = await control.refresh(store)
          let requestId = control.resumeIntent.prepare().requestId
          let data = resume ? try overview(resume: ["requestId": requestId, "status": "uncertain"])
            : try JSONSerialization.data(withJSONObject: ["subscription": subscription, "secret": "follow-up-secret"])
          server.enqueue("POST", path + (resume ? "/goal/resume" : "/triggers"), data)
          server.enqueue("GET", path, failing ? Data(#"{"error":"Follow-up failed"}"#.utf8) : try overview(goalStatus: "active"),
            status: failing ? 503 : 200, gate: gate)
          let task = Task { () -> Bool in
            if resume {
              await control.resume(store)
              return false
            }
            let result: HermesTriggerResult? = await control.change(store, "/triggers", [String: String]())
            return result != nil
          }
          try await until { server.requests.count == 3 }
          invalidate(reason, store: store, server: server, control: control)
          if reason == .cancellation { task.cancel() }
          gate.release()
          let changed = await task.value
          XCTAssertFalse(changed)
          XCTAssertNil(control.notice); XCTAssertNil(control.error)
          XCTAssertNil(control.secret.value); XCTAssertNil(control.secret.url)
          XCTAssertEqual(control.value?.goals.goal?.status, "paused")
          XCTAssertTrue(control.needsRefresh); XCTAssertFalse(control.busy); XCTAssertFalse(control.loading)
          if resume { XCTAssertEqual(control.resumeIntent.requestId, requestId) }
          XCTAssertEqual(server.requests.count, 3)
        }
      }
    }
  }

  func testClosingAndReopeningChildSheetDuringFollowUpDoesNotReviveMutation() async throws {
    let server = AutomationFixtureServer(), store = try makeStore(client(server))
    defer { AutomationFixtureProtocol.remove(server) }
    let control = HermesAutomationControls(botId: "ranch"), gate = AutomationResponseGate()
    let lifetime = HermesAutomationLifetime()
    server.enqueue("GET", path, try overview())
    _ = await control.refresh(store)
    server.enqueue("PUT", path + "/goal", try overview())
    server.enqueue("GET", path, try overview(goalStatus: "active"), gate: gate)
    let current = lifetime.current
    let task = Task {
      await control.changeOK(store, "/goal", HermesGoalInput(title: "New goal", maxTurns: 10), method: "PUT", current: current)
    }
    try await until { server.requests.count == 3 }
    lifetime.disappear(); lifetime.appear()
    gate.release()
    let changed = await task.value
    XCTAssertFalse(changed); XCTAssertNil(control.notice); XCTAssertNil(control.error)
    XCTAssertEqual(control.value?.goals.goal?.status, "paused")
    XCTAssertTrue(control.needsRefresh)
    server.enqueue("GET", path, try overview())
    let refreshed = await control.refresh(store)
    XCTAssertTrue(refreshed, "The parent remains usable after its child closes")
    XCTAssertFalse(control.disabled)
  }

  func testCancelledResumeRetainsDurableIntentAndRequiresReconciliationBeforeExplicitRetry() async throws {
    let server = AutomationFixtureServer(), store = try makeStore(client(server))
    let key = "automation-test.\(UUID().uuidString)"
    defer { AutomationFixtureProtocol.remove(server); UserDefaults.standard.removeObject(forKey: key) }
    let control = HermesAutomationControls(botId: "ranch"), gate = AutomationResponseGate()
    control.restoreResumeIntent(key: key)
    server.enqueue("GET", path, try overview())
    _ = await control.refresh(store)
    server.enqueue("POST", path + "/goal/resume", try overview(), gate: gate)
    let task = Task { await control.resume(store) }
    try await until { server.requests.count == 2 }
    let requestId = try XCTUnwrap(control.resumeIntent.requestId)
    XCTAssertEqual(UserDefaults.standard.string(forKey: key), requestId)
    task.cancel(); await task.value; gate.release()
    XCTAssertEqual(control.resumeIntent.requestId, requestId)
    XCTAssertTrue(control.needsRefresh); XCTAssertNil(control.error)
    await control.resume(store)
    XCTAssertEqual(server.requests.count, 2)
    let reopened = HermesAutomationControls(botId: "ranch")
    reopened.restoreResumeIntent(key: key)
    server.enqueue("GET", path, try overview(resume: ["requestId": requestId, "status": "uncertain"]))
    _ = await reopened.refresh(store)
    server.enqueue("POST", path + "/goal/resume", try overview(resume: ["requestId": requestId, "status": "accepted"]))
    server.enqueue("GET", path, try overview(resume: ["requestId": requestId, "status": "accepted"]))
    await reopened.resume(store)
    let writes = server.requests.filter { $0.httpMethod == "POST" }
    XCTAssertEqual(writes.count, 2)
    XCTAssertEqual(try body(writes[1])["requestId"] as? String, requestId)
    XCTAssertNil(UserDefaults.standard.string(forKey: key))
  }

  func testResumeReceiptRemainsDurableWhenDismissedDuringFollowUp() async throws {
    let server = AutomationFixtureServer(), store = try makeStore(client(server))
    let key = "automation-test.\(UUID().uuidString)"
    defer { AutomationFixtureProtocol.remove(server); UserDefaults.standard.removeObject(forKey: key) }
    let control = HermesAutomationControls(botId: "ranch"), gate = AutomationResponseGate()
    control.restoreResumeIntent(key: key)
    server.enqueue("GET", path, try overview())
    _ = await control.refresh(store)
    let requestId = control.resumeIntent.prepare().requestId
    let accepted = try overview(resume: ["requestId": requestId, "status": "accepted", "runId": "durable-run"])
    server.enqueue("POST", path + "/goal/resume", accepted)
    server.enqueue("GET", path, accepted, gate: gate)
    let task = Task { await control.resume(store) }
    try await until { server.requests.count == 3 }
    XCTAssertNil(UserDefaults.standard.string(forKey: key), "The write already confirmed its receipt")
    control.disappear(); gate.release(); await task.value
    XCTAssertNil(control.notice); XCTAssertNil(control.error)
    XCTAssertNil(control.resumeIntent.requestId)
    XCTAssertEqual(control.value?.goals.resume?.runId, "durable-run")
  }

  func testControlsWithOldDisplayedValuesCannotWriteThroughReplacementSession() async throws {
    for reason in [Invalidation.account, .client] {
      let server = AutomationFixtureServer(), store = try makeStore(client(server))
      defer { AutomationFixtureProtocol.remove(server) }
      let control = HermesAutomationControls(botId: "ranch")
      server.enqueue("GET", path, try overview())
      _ = await control.refresh(store)
      let originalScope = store.scope
      invalidate(reason, store: store, server: server, control: control)
      if reason == .client { XCTAssertEqual(originalScope, store.scope) }
      let changed = await control.changeOK(store, "/goal", HermesGoalInput(title: "Old form", maxTurns: 10), method: "PUT")
      await control.resume(store)
      XCTAssertFalse(changed); XCTAssertNil(control.resumeIntent.requestId)
      XCTAssertEqual(server.requests.count, 1)
      // A new root gets a new controls instance even when only the client changed.
      let replacement = HermesAutomationControls(botId: "ranch")
      server.enqueue("GET", path, try overview())
      let refreshed = await replacement.refresh(store)
      XCTAssertTrue(refreshed)
    }
  }

  func testBackgroundingAndReturningBeforeDelayedResponseNeverRestoresSecret() async throws {
    for delayWrite in [false, true] {
      let server = AutomationFixtureServer(), store = try makeStore(client(server))
      defer { AutomationFixtureProtocol.remove(server) }
      let control = HermesAutomationControls(botId: "ranch"), gate = AutomationResponseGate()
      control.appear(foreground: true)
      server.enqueue("GET", path, try overview())
      _ = await control.refresh(store)
      server.enqueue("POST", path + "/triggers", try JSONSerialization.data(withJSONObject: [
        "subscription": subscription, "secret": "background-response-secret"]), gate: delayWrite ? gate : nil)
      server.enqueue("GET", path, try overview(), gate: delayWrite ? nil : gate)
      let task = Task { () -> HermesTriggerResult? in await control.change(store, "/triggers", [String: String]()) }
      try await until { server.requests.count == (delayWrite ? 2 : 3) }
      control.foreground(false); control.foreground(true)
      gate.release()
      let result = await task.value
      XCTAssertNotNil(result, "A confirmed write still succeeds")
      XCTAssertNil(control.secret.value); XCTAssertNil(control.secret.url); XCTAssertFalse(control.secret.revealed)
      XCTAssertEqual(control.notice, "Saved in Hermes.")
    }
  }

  func testLearningContentAndDiffIgnoreDelayedResponsesAfterInvalidation() async throws {
    for reason in Invalidation.allCases {
      for failing in [false, true] {
        let server = AutomationFixtureServer(), store = try makeStore(client(server))
        defer { AutomationFixtureProtocol.remove(server) }
        let control = HermesAutomationControls(botId: "ranch")
        server.enqueue("GET", path, try overview())
        _ = await control.refresh(store)
        let content = HermesLearningLoader<HermesSkillContent>(), diff = HermesLearningLoader<HermesSkillDiff>()
        let contentGate = AutomationResponseGate(), diffGate = AutomationResponseGate()
        let failure = Data(#"{"error":"Old learning session failed"}"#.utf8)
        server.enqueue("GET", path + "/skills/content", failing ? failure : Data(#"{"name":"ranch/fences","content":"Old skill","truncated":false}"#.utf8),
          status: failing ? 503 : 200, gate: contentGate)
        server.enqueue("GET", path + "/skills/pending/deadbeef", failing ? failure : Data(#"{"id":"deadbeef","diff":"Old diff","revision":"old-revision","truncated":false}"#.utf8),
          status: failing ? 503 : 200, gate: diffGate)
        let contentTask = Task { await content.load(store, control: control, suffix: "/skills/content") { _ in } }
        let diffTask = Task { await diff.load(store, control: control, suffix: "/skills/pending/deadbeef") { _ in } }
        try await until { server.requests.count == 3 }
        if reason == .dismissal {
          content.lifetime.disappear(); diff.lifetime.disappear()
          content.lifetime.appear(); diff.lifetime.appear()
        } else { invalidate(reason, store: store, server: server, control: control) }
        if reason == .cancellation { contentTask.cancel(); diffTask.cancel() }
        contentGate.release(); diffGate.release()
        await contentTask.value; await diffTask.value
        XCTAssertNil(content.value); XCTAssertNil(diff.value)
        XCTAssertNil(content.error); XCTAssertNil(diff.error)
        XCTAssertFalse(content.loading); XCTAssertFalse(diff.loading)
        XCTAssertTrue(content.needsReload); XCTAssertTrue(diff.needsReload)
      }
    }
  }

  func testLearningLoadValidatesCurrentDetailAndCanReloadAfterDismissal() async throws {
    let server = AutomationFixtureServer(), store = try makeStore(client(server))
    defer { AutomationFixtureProtocol.remove(server) }
    let control = HermesAutomationControls(botId: "ranch"), loader = HermesLearningLoader<HermesSkillDiff>()
    server.enqueue("GET", path, try overview())
    _ = await control.refresh(store)
    server.enqueue("GET", path + "/skills/pending/deadbeef", Data(#"{"id":"wrong","diff":"Different diff","revision":"revision","truncated":false}"#.utf8))
    await loader.load(store, control: control, suffix: "/skills/pending/deadbeef") { next in
      guard next.id == "deadbeef" else { throw APIError(message: "Mismatched diff", status: 502) }
    }
    XCTAssertNil(loader.value); XCTAssertEqual(loader.error, "Mismatched diff"); XCTAssertTrue(loader.needsReload)
    loader.lifetime.disappear(); loader.lifetime.appear()
    server.enqueue("GET", path + "/skills/pending/deadbeef", Data(#"{"id":"deadbeef","diff":"Reviewed diff","revision":"reviewed-revision","truncated":false}"#.utf8))
    await loader.load(store, control: control, suffix: "/skills/pending/deadbeef") { _ in }
    XCTAssertEqual(loader.value?.decision(.approve)?.revision, "reviewed-revision")
    XCTAssertNil(loader.error); XCTAssertFalse(loader.needsReload)
  }

}
