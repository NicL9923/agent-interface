import XCTest
@testable import AgentInterface

private final class ExperienceProtocol: URLProtocol, @unchecked Sendable {
  nonisolated(unsafe) static var observed: URLRequest?
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    Self.observed = request
    let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data((request.url?.path == "/api/today/seen" ? #"{"ok":true}"# : #"{"text":"Check the pasture gate","provider":"fixture"}"#).utf8))
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}
final class ExperienceTests: XCTestCase {
  private func fence(_ payload: String) -> String { "Before\n```agent-ui\n" + payload + "\n```\nAfter" }
  func testReplyCardsRetainProseAndSeparateInteractiveChecklist() {
    let parts = ReplyCards.parse(fence(#"{"version":1,"cards":[{"id":"shopping","type":"checklist","title":"Groceries","items":[{"id":"milk","text":"Milk"}]}]}"#))
    XCTAssertEqual(parts.count, 3)
    XCTAssertEqual(parts.first?.markdown, "Before\n")
    XCTAssertEqual(parts[1].cards?.first?.items?.first?.text, "Milk")
    XCTAssertEqual(parts.last?.markdown, "After")
  }
  func testInvalidOrAmbiguousCardDataStaysReadableCode() {
    let payloads = [
      #"{"version":1,"cards":[{"id":"bad id","type":"checklist","title":"List","items":[{"id":"one","text":"A"}]}]}"#,
      #"{"version":1,"cards":[{"id":"list","type":"checklist","title":"List","url":"https://example.com","items":[{"id":"one","text":"A"}]}]}"#,
      #"{"version":1,"cards":[{"id":"list","type":"checklist","title":"List","items":[{"id":"one","text":"A"},{"id":"one","text":"B"}]}]}"#,
      #"{"version":1,"cards":[{"id":"trip","type":"itinerary","title":"Trip","items":[{"id":"one","title":"Stop","url":"javascript:alert(1)"}]}]}"#,
      #"{"version":1,"cards":[{"id":"dinner","type":"event","title":"Dinner","start":"2026-10-03T18:00:00","end":"2026-10-03T19:00:00"}]}"#,
      #"{"version":1,"cards":[{"id":"dinner","type":"event","title":"Dinner","start":"2026-10-03T18:00:00Z","end":"2026-10-03T17:00:00Z"}]}"#,
    ]
    for payload in payloads {
      let text = fence(payload)
      XCTAssertEqual(ReplyCards.parse(text).first?.markdown, text)
      XCTAssertTrue(ReplyCards.parse(text).allSatisfy { $0.cards == nil })
    }
    let valid = #"{"version":1,"cards":[{"id":"shopping","type":"checklist","title":"Groceries","items":[{"id":"milk","text":"Milk"}]}]}"#
    let duplicate = fence(valid) + "\n" + fence(valid)
    XCTAssertEqual(ReplyCards.parse(duplicate).first?.markdown, duplicate)
  }
  func testAbsoluteCalendarProposalCarriesConfirmedOffset() {
    let parts = ReplyCards.parse(fence(#"{"version":1,"cards":[{"id":"dinner","type":"event","title":"Dinner","start":"2026-10-03T18:00:00-05:00","end":"2026-10-03T19:00:00-05:00"}]}"#))
    XCTAssertEqual(parts[1].cards?.first?.type, "event")
    XCTAssertNotNil(parts[1].cards?.first?.start.flatMap(ServerDate.parse))
  }
  @MainActor func testNativeVoiceSendsBoundedAuthenticatedAudioToSelectedBot() async throws {
    let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [ExperienceProtocol.self]
    let api = APIClient(baseURL: URL(string: "https://experience.example.test")!, session: URLSession(configuration: config))
    api.token = "fixture-token"
    let result = try await api.transcribe(botId: "ranch/bot", audio: Data([1, 2, 3]))
    XCTAssertEqual(result.text, "Check the pasture gate")
    let request = try XCTUnwrap(ExperienceProtocol.observed)
    XCTAssertEqual(request.url?.absoluteString, "https://experience.example.test/api/bots/ranch%2Fbot/voice/transcribe")
    XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer fixture-token")
    XCTAssertTrue(request.value(forHTTPHeaderField: "Content-Type")?.hasPrefix("multipart/form-data; boundary=") == true)
    var data = request.httpBody ?? Data()
    if let stream = request.httpBodyStream {
      stream.open(); defer { stream.close() }
      var buffer = [UInt8](repeating: 0, count: 4096)
      while stream.hasBytesAvailable { let count = stream.read(&buffer, maxLength: buffer.count); if count <= 0 { break }; data.append(buffer, count: count) }
    }
    XCTAssertTrue(String(decoding: data, as: UTF8.self).contains("name=\"audio\"; filename=\"voice.m4a\""))
    XCTAssertTrue(String(decoding: data, as: UTF8.self).contains("Content-Type: audio/mp4"))
    do { _ = try await api.transcribe(botId: "ranch", audio: Data(repeating: 0, count: 8 * 1024 * 1024 + 1)); XCTFail("Oversized audio must be refused before network upload") } catch { XCTAssertEqual((error as? APIError)?.status, 400) }
  }
  func testProfileMemoryAndUncertainRunDecodeActualServerContracts() throws {
    let memory = try JSONDecoder().decode(ProfileMemory.self, from: Data(#"{"botId":"ranch","profile":"default","scope":"profile","owner":"Hermes","documents":[{"target":"memory","label":"Memory","revision":"rev1","enabled":true,"entries":[{"id":"m1","text":"Weeknight dinners under 30 minutes"}],"charLimit":2200,"charCount":42}],"notice":"Edits apply to new sessions."}"#.utf8))
    XCTAssertEqual(memory.profile, "default"); XCTAssertEqual(memory.documents.first?.entries.first?.id, "m1")
    let receipt = RoutineRunReceipt(requestId: UUID().uuidString, routineId: "morning", botId: "ranch", status: "uncertain", message: "Check receipt before retrying", startedAt: "2026-10-01T12:00:00Z")
    let decoded = try JSONDecoder().decode(RoutineRunReceipt.self, from: JSONEncoder().encode(receipt))
    XCTAssertEqual(decoded.requestId, receipt.requestId); XCTAssertEqual(decoded.status, "uncertain")
  }
  func testSavingOneMemoryDocumentPreservesUnsavedRevisionForCAS() {
    let document = MemoryDocument(target: "memory", label: "Memory", revision: "original-memory", enabled: true, entries: [], charLimit: 2200, charCount: 0)
    var original = ProfileMemory(botId: "ranch", profile: "default", scope: "profile", owner: "Hermes", documents: [document, MemoryDocument(target: "user", label: "About you", revision: "original-user", enabled: true, entries: [], charLimit: 1400, charCount: 0)], notice: "")
    let updated = ProfileMemory(botId: "ranch", profile: "default", scope: "profile", owner: "Hermes", documents: [MemoryDocument(target: "memory", label: "Memory", revision: "saved-memory", enabled: true, entries: [], charLimit: 2200, charCount: 0), MemoryDocument(target: "user", label: "About you", revision: "concurrent-user", enabled: true, entries: [], charLimit: 1400, charCount: 0)], notice: "")
    original.acceptSavedDocument("memory", from: updated)
    XCTAssertEqual(original.documents[0].revision, "saved-memory")
    XCTAssertEqual(original.documents[1].revision, "original-user")
  }
  func testTodaySummaryExcludesHistoricalAndUndatedReplies() {
    var item = TodayItem(botId: "ranch", botName: "Ranch", activity: Activity(state: .idle), approvals: [], attention: [], latestMessage: TodayMessage(id: "old", text: "Old result", createdAt: "2026-09-29T12:00:00Z"), files: [])
    let overview = TodayOverview(generatedAt: "2026-10-01T13:00:00Z", since: "2026-10-01T12:00:00Z", items: [item], events: [], unavailableBots: [], frontier: "100", hasMore: false)
    XCTAssertNil(overview.recentMessage(item))
    item.latestMessage?.createdAt = nil; XCTAssertNil(overview.recentMessage(item))
    item.latestMessage?.createdAt = "2026-10-01T12:30:00Z"; XCTAssertEqual(overview.recentMessage(item)?.id, "old")
  }

  @MainActor func testTodayAcknowledgementCarriesExactSnapshotFrontier() async throws {
    let snapshot = try JSONDecoder().decode(TodayOverview.self, from: Data(#"{"generatedAt":"2026-10-01T13:30:00Z","since":"2026-10-01T12:00:00Z","items":[],"events":[{"id":"late","botId":"ranch","kind":"completed","title":"Late imported completion","occurredAt":"2026-09-28T12:00:00Z"}],"unavailableBots":[],"frontier":"42","hasMore":true}"#.utf8))
    XCTAssertTrue(snapshot.hasMore)
    XCTAssertEqual(snapshot.events.first?.occurredAt, "2026-09-28T12:00:00Z")
    let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [ExperienceProtocol.self]
    let api = APIClient(baseURL: URL(string: "https://experience.example.test")!, session: URLSession(configuration: config)); api.token = "fixture-token"
    try await api.markTodaySeen(snapshot)
    let request = try XCTUnwrap(ExperienceProtocol.observed)
    XCTAssertEqual(request.url?.path, "/api/today/seen"); XCTAssertEqual(request.httpMethod, "PUT")
    XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer fixture-token")
    var data = request.httpBody ?? Data()
    if let stream = request.httpBodyStream {
      stream.open(); defer { stream.close() }
      var buffer = [UInt8](repeating: 0, count: 4096)
      while stream.hasBytesAvailable { let count = stream.read(&buffer, maxLength: buffer.count); if count <= 0 { break }; data.append(buffer, count: count) }
    }
    let body = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: String])
    XCTAssertEqual(body, ["seenAt": snapshot.generatedAt, "frontier": "42"])
  }

}
