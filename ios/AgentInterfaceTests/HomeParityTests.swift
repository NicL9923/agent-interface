import XCTest
@testable import AgentInterface

@MainActor final class HomeParityTests: XCTestCase {
  private func hit(_ session: String, _ title: String) throws -> SearchHit {
    let json = #"{"botId":"ranch","botName":"Ranch","sessionId":"\#(session)","title":"\#(title)","snippet":""}"#
    return try JSONDecoder().decode(SearchHit.self, from: Data(json.utf8))
  }
  func testSavedConversationKeepsTheSearchHitTitle() throws {
    let hits = [try hit("a", "Dinner plan"), try hit("b", String(repeating: "x", count: 200))]
    XCTAssertEqual(DiscoveryView.conversationTitle(hits, "a"), "Dinner plan")
    XCTAssertEqual(DiscoveryView.conversationTitle(hits, "b").count, 120)
    XCTAssertEqual(DiscoveryView.conversationTitle(hits, "missing"), "Saved conversation")
  }
  func testSavedReplyTitleStripsMarkdownSymbolsLikeTheWeb() {
    XCTAssertEqual(DiscoveryView.replyTitle("## **Gate**"), "Gate")
    XCTAssertEqual(DiscoveryView.replyTitle("a_b"), "a b")
    XCTAssertEqual(DiscoveryView.replyTitle(" ** "), "Saved reply")
  }

  // MARK: Launch and connection states
  @MainActor private func store(connected: Bool = true, push: Bool = true, token: String? = "synthetic", bootstrap: Bool = true, setup: Bool = true) throws -> AppStore {
    let value = AppStore()
    let api = APIClient(baseURL: URL(string: "https://home-parity.example.test")!)
    api.token = token
    value.api = api
    if bootstrap {
      let capabilities = setup ? #"{"botConfiguration":{"supported":true}}"# : #"{"botConfiguration":{"supported":false,"reason":"Hermes is too old for assistant setup."}}"#
      let json = #"{"user":{"id":"one","name":"One","email":"one@example.test"},"household":[],"preferences":{"presentation":"simple","theme":"system","favorites":[],"sections":[],"followBots":[]},"bots":[],"capabilities":\#(capabilities),"connection":{"connected":\#(connected)},"csrfToken":null}"#
      value.bootstrap = try JSONDecoder().decode(Bootstrap.self, from: Data(json.utf8))
    }
    return value
  }
  @MainActor func testSavedSignInWaitsForTheHouseholdInsteadOfShowingSignInControls() throws {
    XCTAssertTrue(try store(bootstrap: false).connectingToHousehold)
    XCTAssertFalse(try store(bootstrap: true).connectingToHousehold, "Once the household loads, the app shows it")
    XCTAssertFalse(try store(token: nil, bootstrap: false).connectingToHousehold, "No sign-in means the sign-in screen")
    let expired = try store(bootstrap: false)
    expired.sessionExpired = true
    XCTAssertFalse(expired.connectingToHousehold)
  }
  @MainActor func testConnectionLostCoversHermesTheAppAndTheDeviceButNotAnExpiredSignIn() throws {
    XCTAssertFalse(try store().connectionLost(offline: false))
    XCTAssertTrue(try store().connectionLost(offline: true), "Offline counts even before a request fails")
    XCTAssertTrue(try store(connected: false).connectionLost(offline: false))
    let unreachable = try store()
    unreachable.appUnavailable = true
    XCTAssertTrue(unreachable.connectionLost(offline: false))
    let expired = try store(connected: false)
    expired.sessionExpired = true
    XCTAssertFalse(expired.connectionLost(offline: false), "An expired sign-in has its own prompt")
  }
  func testHomeStatusDotIsMutedOfflineAndAttentiveWhileReconnecting() {
    XCTAssertEqual(HomeConnectionStatus.of(lost: false, offline: false), .connected)
    XCTAssertEqual(HomeConnectionStatus.of(lost: true, offline: false), .reconnecting)
    XCTAssertEqual(HomeConnectionStatus.of(lost: true, offline: true), .offline)
    XCTAssertNotEqual(HomeConnectionStatus.offline.color, HomeConnectionStatus.reconnecting.color)
  }
  func testOfflineCopyComesFirstAndMatchesTheWeb() {
    let offline = ConnectionCopy.compact(code: "unauthorized", appUnavailable: true, offline: true)
    XCTAssertEqual(offline.title, "You're offline")
    XCTAssertEqual(offline.detail, "Your draft is kept on this device. We'll reconnect when you're back online.")
    XCTAssertFalse(offline.setup, "Setup steps don't help someone who is offline")
    XCTAssertEqual(ConnectionCopy.compact(code: "unauthorized", appUnavailable: false).title, "Hermes didn't accept the connection")
  }
  func testWelcomeAndSignInCopyMatchTheWeb() {
    XCTAssertEqual(WelcomeCopy.status(unavailable: false), "Connecting to your household…")
    XCTAssertEqual(WelcomeCopy.status(unavailable: true), "Can't reach the app right now. We'll keep trying.")
    XCTAssertEqual(WelcomeCopy.heading, "Your assistants,\nin one familiar place.")
    XCTAssertEqual(WelcomeCopy.signInHeading, "Your assistants are waiting.")
    XCTAssertEqual(WelcomeCopy.signInDetail, "Sign in to return to your household conversations.")
    XCTAssertEqual(WelcomeCopy.checkingSignIn, "Checking sign-in…")
    XCTAssertEqual(HomeCopy.emptyTitle, "Welcome home")
    XCTAssertEqual(HomeCopy.emptySubtitle, "Your assistants will appear here when Hermes is connected.")
  }
  @MainActor func testBlockedAssistantSetupAlwaysSaysWhy() throws {
    XCTAssertNil(try store().assistantSetupBlock)
    XCTAssertEqual(try store(connected: false).assistantSetupBlock, "Assistant setup is unavailable while Hermes is disconnected.")
    XCTAssertEqual(try store(setup: false).assistantSetupBlock, "Hermes is too old for assistant setup.")
  }
  @MainActor func testOneMinuteClockUpdatesEveryLabelAtOnce() {
    var current = Date(timeIntervalSince1970: 1_000)
    let clock = MinuteClock(date: { current }, interval: 3600)
    XCTAssertEqual(clock.now, current)
    current = current.addingTimeInterval(60)
    clock.tick()
    XCTAssertEqual(clock.now, current)
  }
  // MARK: Today, discovery and groups
  func testTodayErrorsWarnThatResultsMayBeOld() {
    XCTAssertEqual(TodayCopy.failure("The server is busy."), "The server is busy. Loaded results may be out of date.")
  }
  func testSearchQueryIsCappedAndTrimmedLikeTheWebInput() {
    XCTAssertEqual(DiscoveryView.clip(String(repeating: "a", count: 250)).count, 200)
    XCTAssertEqual(DiscoveryView.clip("short"), "short")
    XCTAssertEqual(DiscoveryView.trimmed("  gate battery \n"), "gate battery")
  }
  func testGroupInputLimitsClipWhatIsTypedRatherThanWhatIsSent() {
    XCTAssertEqual(GroupLimits.clip(String(repeating: "n", count: 130), to: GroupLimits.name).count, 100)
    XCTAssertEqual(GroupLimits.clip(String(repeating: "m", count: 17_000), to: GroupLimits.message).count, 16_000)
    XCTAssertEqual(GroupLimits.clip("fits", to: GroupLimits.message), "fits")
    // The server counts UTF-16 units, so each emoji uses two and is never split.
    XCTAssertEqual(GroupLimits.clip(String(repeating: "🐴", count: 9), to: 5), "🐴🐴")
    XCTAssertFalse(GroupLimits.fits(String(repeating: "🐴", count: 8_001), GroupLimits.message), "A restored long draft cannot send")
  }
  func testGroupAuthorMatchesTheEventActorAsWellAsThePayloadMember() throws {
    let room = try JSONDecoder().decode(GroupRoom.self, from: Data(#"{"room_id":"r","name":"Gate","members":[{"member_id":"m1","profile":"ranch","handle":"ranch","display_name":"Ranch hand"},{"member_id":"m2","profile":"kitchen","handle":"kitchen"}]}"#.utf8))
    func event(_ json: String) throws -> GroupEvent { try JSONDecoder().decode(GroupEvent.self, from: Data(json.utf8)) }
    let byActor = try event(#"{"event_id":"e1","seq":1,"kind":"message.member","created_at":1,"actor":{"kind":"member","id":"m1"},"payload":{"text":"Hi"}}"#)
    let byPayload = try event(#"{"event_id":"e2","seq":2,"kind":"message.member","created_at":2,"payload":{"text":"Hi","member_id":"m2"}}"#)
    let unknown = try event(#"{"event_id":"e3","seq":3,"kind":"message.member","created_at":3,"actor":{"kind":"member","id":"gone"},"payload":{"text":"Hi"}}"#)
    XCTAssertEqual(GroupConversationView.assistantName(byActor, in: room), "Ranch hand")
    XCTAssertEqual(GroupConversationView.assistantName(byPayload, in: room), "kitchen")
    XCTAssertEqual(GroupConversationView.assistantName(unknown, in: room), "gone", "The web shows the actor id when no member matches")
  }

  @MainActor func testGroupCreationKeepsItsRequestUntilHermesAnswersAndSendsAssistantsInPickOrder() async throws {
    GroupStub.reset()
    let scope = "home-parity-\(UUID().uuidString)"
    defer { GroupCreation.clear(scope: scope) }
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [GroupStub.self]; config.urlCache = nil
    let api = APIClient(baseURL: URL(string: "https://groups.example.test")!, session: URLSession(configuration: config))
    api.token = "synthetic"
    let request = GroupCreate(requestId: "request-1", name: "Gate planning", botIds: ["zed", "alpha", "mid"])
    GroupStub.status = 503
    do { _ = try await GroupCreation.submit(request, api: api, scope: scope); XCTFail("The outage must surface") } catch {
      XCTAssertTrue(GroupCreation.failure(error).hasSuffix("Retry the saved request to check this room's creation."))
    }
    XCTAssertEqual(GroupCreation.pending(scope: scope)?.requestId, "request-1", "A request that may have arrived is kept for the retry")
    GroupStub.status = 200
    let room = try await GroupCreation.submit(GroupCreation.pending(scope: scope)!, api: api, scope: scope)
    XCTAssertEqual(room.name, "Gate planning")
    XCTAssertNil(GroupCreation.pending(scope: scope), "Hermes answered, so the saved request is done")
    let bodies = GroupStub.bodies.compactMap { try? JSONDecoder().decode(GroupCreate.self, from: $0) }
    XCTAssertEqual(bodies.map(\.requestId), ["request-1", "request-1"], "The retry reuses the request ID so Hermes cannot make a second room")
    XCTAssertEqual(bodies.last?.botIds, ["zed", "alpha", "mid"])
  }
}

private final class GroupStub: URLProtocol, @unchecked Sendable {
  nonisolated(unsafe) static var status = 200
  nonisolated(unsafe) static var bodies: [Data] = []
  static func reset() { status = 200; bodies = [] }
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    var body = request.httpBody
    if body == nil, let stream = request.httpBodyStream {
      stream.open(); defer { stream.close() }
      var data = Data(), buffer = [UInt8](repeating: 0, count: 4096)
      while stream.hasBytesAvailable { let count = stream.read(&buffer, maxLength: buffer.count); if count <= 0 { break }; data.append(buffer, count: count) }
      body = data
    }
    Self.bodies.append(body ?? Data())
    let payload = Self.status == 200
      ? #"{"room":{"room_id":"room-1","name":"Gate planning","members":[]}}"#
      : #"{"error":"Synthetic outage"}"#
    let response = HTTPURLResponse(url: request.url!, statusCode: Self.status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(payload.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}
