import XCTest

@testable import WildBotsMacCore

/// A server-side socket stand-in. It refuses anything a test did not script: a send after
/// close throws, as a real socket would.
final class FakeSocket: LinkSocket, @unchecked Sendable {
  private let lock = NSLock()
  private var inbox: [Result<String, LinkClosed>] = []
  private var waiter: CheckedContinuation<String, Error>?
  private var _sent: [String] = []
  private var _closedByClient: Int?
  var pingSucceeds = true

  var sent: [JSONValue] { lock.withLock { _sent.compactMap { try? JSONValue.parse($0) } } }
  var closedByClient: Int? { lock.withLock { _closedByClient } }

  func send(_ text: String) async throws {
    try lock.withLock {
      if _closedByClient != nil { throw LinkClosed(code: nil) }
      _sent.append(text)
    }
  }

  func receive() async throws -> String {
    try await withCheckedThrowingContinuation { continuation in
      lock.lock()
      if !inbox.isEmpty {
        let next = inbox.removeFirst()
        lock.unlock()
        continuation.resume(with: next.mapError { $0 as Error })
      } else {
        waiter = continuation
        lock.unlock()
      }
    }
  }

  func ping() async throws {
    if !pingSucceeds { try await Task.sleep(nanoseconds: 3_600_000_000_000) }
  }

  func close(code: Int) {
    lock.withLock { if _closedByClient == nil { _closedByClient = code } }
    deliver(.failure(LinkClosed(code: nil)))
  }

  func push(_ frame: String) { deliver(.success(frame)) }
  func serverClose(_ code: Int) { deliver(.failure(LinkClosed(code: code))) }

  private func deliver(_ item: Result<String, LinkClosed>) {
    lock.lock()
    if let waiter {
      self.waiter = nil
      lock.unlock()
      waiter.resume(with: item.mapError { $0 as Error })
    } else {
      inbox.append(item)
      lock.unlock()
    }
  }
}

final class FakeConnector: LinkConnector, @unchecked Sendable {
  private let lock = NSLock()
  private var _sockets: [FakeSocket] = []
  private var failures: Int
  var pingSucceeds = true
  private(set) var authorizations: [String] = []
  init(failFirst: Int = 0) { failures = failFirst }
  var sockets: [FakeSocket] { lock.withLock { _sockets } }

  func connect(url: URL, authorization: String) async throws -> LinkSocket {
    try lock.withLock {
      authorizations.append(authorization)
      if failures > 0 {
        failures -= 1
        throw LinkClosed(code: nil)
      }
      let socket = FakeSocket()
      socket.pingSucceeds = pingSucceeds
      _sockets.append(socket)
      return socket
    }
  }
}

final class MemoryCredentials: CredentialStore, @unchecked Sendable {
  private let lock = NSLock()
  private var value: DeviceCredential?
  init(_ value: DeviceCredential?) { self.value = value }
  func load() -> DeviceCredential? { lock.withLock { value } }
  func save(_ credential: DeviceCredential) throws { lock.withLock { value = credential } }
  func delete() { lock.withLock { value = nil } }
}

final class StatusLog: @unchecked Sendable {
  private let lock = NSLock()
  private var items: [LinkStatus] = []
  private var revoked = 0
  func record(_ status: LinkStatus) { lock.withLock { items.append(status) } }
  func revoke() { lock.withLock { revoked += 1 } }
  var last: LinkStatus? { lock.withLock { items.last } }
  var revocations: Int { lock.withLock { revoked } }
}

final class LinkClientTests: XCTestCase {
  var box: Sandbox!
  var journal: InvocationJournal!
  var credentials: MemoryCredentials!
  var statuses: StatusLog!

  override func setUpWithError() throws {
    box = try Sandbox()
    journal = try InvocationJournal(url: URL(fileURLWithPath: box.appData + "/journal.jsonl"))
    credentials = MemoryCredentials(
      DeviceCredential(server: "https://agentui.example", deviceId: "mac_1", credential: "secret", name: "Test Mac"))
    statuses = StatusLog()
  }

  func client(_ connector: FakeConnector, timing: LinkClient.Timing? = nil, screenshots: HeldScreenshots? = nil) throws -> LinkClient {
    var policy = PolicyDocument()
    policy.folders = [FolderGrant(name: "dev", path: box.granted)]
    policy.grants = [Grant(assistantId: "patch", assistantName: "Patch", abilities: [.filesRead, .screenshot])]
    let snapshot = LiveSnapshot(policy: policy, folders: [try box.folder()], screenPermission: .granted)
    let dispatcher = Dispatcher(
      journal: journal, activity: ActivityLog(url: URL(fileURLWithPath: box.appData + "/activity.jsonl")),
      environment: box.environment, screenshots: screenshots, snapshot: { snapshot })
    var defaults = LinkClient.Timing()
    defaults.backoffScale = 0.001
    let statuses = self.statuses!
    return LinkClient(
      connector: connector, credentials: credentials, dispatcher: dispatcher, journal: journal, appVersion: "1.0",
      timing: timing ?? defaults, state: { snapshot.macState }, onStatus: { statuses.record($0) },
      onRevoked: { statuses.revoke() })
  }

  func types(_ socket: FakeSocket) -> [String] { socket.sent.compactMap { $0["type"]?.stringValue } }

  func testSaysHelloResendsUnacknowledgedResultsThenAnswersAndAcknowledges() async throws {
    _ = try journal.begin(id: "old", fingerprint: "f")
    try journal.finish(id: "old", outcome: .success("earlier"))
    let connector = FakeConnector()
    let link = try client(connector)
    await link.start()
    try await waitUntil { connector.sockets.count == 1 && connector.sockets[0].sent.count == 2 }
    let socket = connector.sockets[0]
    XCTAssertEqual(connector.authorizations, ["Device mac_1.secret"])
    XCTAssertEqual(socket.sent[0]["type"], "hello")
    XCTAssertEqual(socket.sent[0]["state"]?["folders"]?.arrayValue?.count, 1)
    XCTAssertEqual(socket.sent[1], ["type": "result", "id": "old", "ok": true, "value": "earlier"])

    socket.push(#"{"type":"welcome","protocol":1}"#)
    try await waitUntil { self.statuses.last == .linked }
    socket.push(#"{"type":"invoke","id":"n1","assistantId":"patch","scheduled":false,"action":"list_dir","args":{}}"#)
    try await waitUntil { socket.sent.count == 3 }
    XCTAssertEqual(socket.sent[2]["id"], "n1")
    XCTAssertEqual(socket.sent[2]["ok"], true)
    socket.push(#"{"type":"ack","id":"old"}"#)
    socket.push(#"{"type":"ack","id":"n1"}"#)
    try await waitUntil { self.journal.unacknowledged().isEmpty }
    await link.stop()
  }

  func testADroppedSocketReconnectsAndResendsWhatWasNotAcknowledged() async throws {
    let connector = FakeConnector()
    let link = try client(connector)
    await link.start()
    try await waitUntil { connector.sockets.count == 1 }
    let first = connector.sockets[0]
    first.push(#"{"type":"invoke","id":"n1","assistantId":"patch","scheduled":false,"action":"list_dir","args":{}}"#)
    try await waitUntil { first.sent.count == 2 }
    first.serverClose(1006)
    try await waitUntil { connector.sockets.count == 2 && connector.sockets[1].sent.count == 2 }
    let second = connector.sockets[1]
    XCTAssertEqual(types(second), ["hello", "result"])
    XCTAssertEqual(second.sent[1], first.sent[1])
    await link.stop()
  }

  static let screenshotInvoke = #"{"type":"invoke","id":"s1","assistantId":"patch","scheduled":false,"action":"screenshot","args":{}}"#

  /// The server's call is still waiting after a reconnect; a result that finishes then goes out
  /// on the new socket, not on the one after it.
  func testAResultThatFinishesAfterAReconnectGoesOutOnTheNewSocket() async throws {
    let shots = HeldScreenshots()
    let connector = FakeConnector()
    let link = try client(connector, screenshots: shots)
    await link.start()
    try await waitUntil { connector.sockets.count == 1 }
    let first = connector.sockets[0]
    first.push(Self.screenshotInvoke)
    try await waitUntil { shots.count == 1 }
    first.serverClose(1006)
    try await waitUntil { connector.sockets.count == 2 && connector.sockets[1].sent.count == 1 }
    let second = connector.sockets[1]
    shots.release()
    try await waitUntil { second.sent.count == 2 }
    XCTAssertEqual(types(second), ["hello", "result"])
    XCTAssertEqual(second.sent[1]["id"], "s1")
    XCTAssertEqual(second.sent[1]["ok"], true)
    await link.stop()
  }

  /// After wake or a network change an open socket may be dead. It is replaced at once, with no
  /// backoff, and an action still running answers on the replacement.
  func testANudgeReplacesAnOpenSocketAndKeepsRunningResults() async throws {
    let shots = HeldScreenshots()
    let connector = FakeConnector()
    var timing = LinkClient.Timing()
    timing.backoffScale = 1000
    let link = try client(connector, timing: timing, screenshots: shots)
    await link.start()
    try await waitUntil { connector.sockets.count == 1 }
    let first = connector.sockets[0]
    first.push(#"{"type":"welcome","protocol":1}"#)
    try await waitUntil { self.statuses.last == .linked }
    first.push(Self.screenshotInvoke)
    try await waitUntil { shots.count == 1 }
    await link.nudge()
    try await waitUntil(timeout: 5) { connector.sockets.count == 2 }
    XCTAssertEqual(first.closedByClient, 1000)
    let second = connector.sockets[1]
    shots.release()
    try await waitUntil { second.sent.contains { $0["id"] == "s1" } }
    XCTAssertEqual(types(second).first, "hello")
    await link.stop()
  }

  func testRevokedDeletesTheCredentialStopsWorkAndDoesNotReconnect() async throws {
    for ending in ["message", "close"] {
      credentials = MemoryCredentials(DeviceCredential(server: "https://a.example", deviceId: "mac_1", credential: "c", name: "M"))
      statuses = StatusLog()
      let connector = FakeConnector()
      let link = try client(connector)
      await link.start()
      try await waitUntil { connector.sockets.count == 1 }
      if ending == "message" {
        connector.sockets[0].push(#"{"type":"revoked"}"#)
      } else {
        connector.sockets[0].serverClose(LinkCloseCode.unauthorized)
      }
      try await waitUntil { self.statuses.revocations == 1 }
      XCTAssertNil(credentials.load(), ending)
      XCTAssertEqual(statuses.last, .unlinked(reason: "This Mac was unlinked from WildBots."), ending)
      try await Task.sleep(nanoseconds: 100_000_000)
      XCTAssertEqual(connector.sockets.count, 1, "\(ending): reconnected after revocation")
    }
  }

  func testRefusalsThatRetryingCannotFixStopWithoutDeletingTheCredential() async throws {
    for (code, reason) in [(LinkCloseCode.notMember, "no longer in the household"), (LinkCloseCode.replaced, "Another copy")] {
      statuses = StatusLog()
      let connector = FakeConnector()
      let link = try client(connector)
      await link.start()
      try await waitUntil { connector.sockets.count == 1 }
      connector.sockets[0].serverClose(code)
      try await waitUntil {
        if case .stopped = self.statuses.last { return true }
        return false
      }
      guard case .stopped(let message) = statuses.last else { return XCTFail("\(code) did not stop") }
      XCTAssertTrue(message.contains(reason), message)
      XCTAssertNotNil(credentials.load())
      try await Task.sleep(nanoseconds: 100_000_000)
      XCTAssertEqual(connector.sockets.count, 1)
    }
  }

  func testLinksTurnedOffOnTheServerKeepRetrying() async throws {
    let connector = FakeConnector()
    let link = try client(connector)
    await link.start()
    try await waitUntil { connector.sockets.count == 1 }
    connector.sockets[0].serverClose(LinkCloseCode.unavailable)
    try await waitUntil { connector.sockets.count == 2 }
    XCTAssertNotNil(credentials.load())
    await link.stop()
  }

  func testASilentSocketIsDroppedAfterTheHeartbeatTimeout() async throws {
    let connector = FakeConnector()
    connector.pingSucceeds = false
    var timing = LinkClient.Timing()
    timing.heartbeatInterval = 0.05
    timing.heartbeatTimeout = 0.3
    timing.backoffScale = 0.001
    let link = try client(connector, timing: timing)
    await link.start()
    try await waitUntil { connector.sockets.count == 2 }
    XCTAssertEqual(connector.sockets[0].closedByClient, LinkCloseCode.heartbeatTimeout)
    await link.stop()
  }

  func testAnsweredPingsKeepTheSocketOpen() async throws {
    let connector = FakeConnector()
    var timing = LinkClient.Timing()
    timing.heartbeatInterval = 0.05
    timing.heartbeatTimeout = 0.3
    let link = try client(connector, timing: timing)
    await link.start()
    try await Task.sleep(nanoseconds: 800_000_000)
    XCTAssertEqual(connector.sockets.count, 1)
    XCTAssertNil(connector.sockets[0].closedByClient)
    await link.stop()
  }

  func testANudgeEndsTheBackoffWait() async throws {
    let connector = FakeConnector(failFirst: 1)
    var timing = LinkClient.Timing()
    timing.backoffScale = 1000
    let link = try client(connector, timing: timing)
    await link.start()
    try await waitUntil {
      if case .retrying = self.statuses.last { return true }
      return false
    }
    XCTAssertTrue(connector.sockets.isEmpty)
    await link.nudge()
    try await waitUntil(timeout: 5) { connector.sockets.count == 1 }
    await link.stop()
  }

  func testStateChangesAreSentWhileLinked() async throws {
    let connector = FakeConnector()
    let link = try client(connector)
    await link.start()
    try await waitUntil { connector.sockets.count == 1 }
    await link.sendState()
    XCTAssertEqual(types(connector.sockets[0]), ["hello"], "no state before welcome")
    connector.sockets[0].push(#"{"type":"welcome","protocol":1}"#)
    try await waitUntil { self.statuses.last == .linked }
    await link.sendState()
    XCTAssertEqual(types(connector.sockets[0]), ["hello", "state"])
    await link.stop()
  }

  func testWithoutACredentialItStaysUnlinked() async throws {
    credentials = MemoryCredentials(nil)
    let connector = FakeConnector()
    let link = try client(connector)
    await link.start()
    try await waitUntil { self.statuses.last == .unlinked(reason: nil) }
    XCTAssertTrue(connector.authorizations.isEmpty)
  }

  func testBackoffDoublesFromOneSecondUpToSixty() {
    XCTAssertEqual((1...9).map { Backoff.delay(afterFailures: $0) }, [1, 2, 4, 8, 16, 32, 60, 60, 60])
    XCTAssertEqual(Backoff.delay(afterFailures: 0), 0)
  }
}
