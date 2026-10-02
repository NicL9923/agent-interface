import XCTest
@testable import AgentInterface

private final class VaultProtocol: URLProtocol, @unchecked Sendable {
  nonisolated(unsafe) static var observed: URLRequest?
  nonisolated(unsafe) static var status = 200
  nonisolated(unsafe) static var cancelled = false
  nonisolated(unsafe) static var payload = #"{"status":"ok","ok":true,"id":"new","removed":true}"#
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    Self.observed = request
    if Self.cancelled { client?.urlProtocol(self, didFailWithError: URLError(.cancelled)); return }
    let response = HTTPURLResponse(url: request.url!, statusCode: Self.status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(Self.payload.utf8)); client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}
@MainActor final class VaultTests: XCTestCase {
  override func setUp() { VaultProtocol.cancelled = false; VaultProtocol.status = 200; VaultProtocol.payload = #"{"status":"ok","ok":true,"id":"new","removed":true}"#; VaultProtocol.observed = nil }
  private func api() -> APIClient {
    let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [VaultProtocol.self]
    let api = APIClient(baseURL: URL(string: "https://vault.example.test")!, session: URLSession(configuration: configuration)); api.token = "fixture-session-token"; return api
  }
  private func body() throws -> [String: Any] {
    let request = try XCTUnwrap(VaultProtocol.observed)
    var data = request.httpBody ?? Data()
    if let stream = request.httpBodyStream {
      stream.open(); defer { stream.close() }
      var buffer = [UInt8](repeating: 0, count: 4096)
      while stream.hasBytesAvailable { let count = stream.read(&buffer, maxLength: buffer.count); if count <= 0 { break }; data.append(buffer, count: count) }
    }
    return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
  }
  private func request(_ method: String = "vault.save_login") -> SecureRequest {
    SecureRequest(epoch: "native-epoch", sessionId: "native-session", method: method, origin: "https://school.example.test", site: "School")
  }
  func testSecureLoginUsesDedicatedAuthenticatedEndpointAndExactBinding() async throws {
    let client = api(); let result = try await client.answerSecureRequest(botId: "ranch/bot", requestId: "request/1", answer: SecureRequestAnswer(request: request(), identifier: "fixture-parent", value: "fixture-password", cancel: false))
    XCTAssertEqual(result.status, "ok")
    let observed = try XCTUnwrap(VaultProtocol.observed)
    XCTAssertEqual(observed.url?.absoluteString, "https://vault.example.test/api/bots/ranch%2Fbot/secure-requests/request%2F1")
    XCTAssertEqual(observed.value(forHTTPHeaderField: "Authorization"), "Bearer fixture-session-token")
    XCTAssertEqual(observed.value(forHTTPHeaderField: "Cache-Control"), "no-store")
    let payload = try body()
    XCTAssertEqual(Set(payload.keys), ["epoch", "sessionId", "method", "identifier", "password"])
    XCTAssertEqual(payload["epoch"] as? String, "native-epoch"); XCTAssertEqual(payload["password"] as? String, "fixture-password")
  }
  func testCancellationOmitsAllEnteredCredentialFields() async throws {
    let client = api(); _ = try await client.answerSecureRequest(botId: "bot", requestId: "request", answer: SecureRequestAnswer(request: request(), identifier: "fixture-parent", value: "fixture-password", cancel: true))
    let payload = try body(); XCTAssertEqual(Set(payload.keys), ["epoch", "sessionId", "method", "cancel"]); XCTAssertEqual(payload["cancel"] as? Bool, true)
  }
  func testOtherSecureMethodsSendValueWithoutLoginFields() async throws {
    for method in ["vault.code", "vault.unlock_prompt", "secret"] {
      _ = try await api().answerSecureRequest(botId: "bot", requestId: "request", answer: SecureRequestAnswer(request: request(method), identifier: "not-sent", value: "fixture-value", cancel: false))
      let payload = try body(); XCTAssertEqual(Set(payload.keys), ["epoch", "sessionId", "method", "value"]); XCTAssertEqual(payload["method"] as? String, method)
    }
  }
  func testVaultManagementRoutesNativeOperationsWithoutChat() async throws {
    let client = api()
    try await client.addVaultLogin(botId: "bot", login: AddVaultLogin(label: "Fixture", origin: "https://example.test", identifierType: "email", identifier: "fixture@example.test", password: "fixture-password"))
    XCTAssertEqual(VaultProtocol.observed?.url?.path, "/api/bots/bot/vault/logins"); XCTAssertEqual(try body()["identifierType"] as? String, "email")
    try await client.removeVaultLogin(botId: "bot", itemId: "login/1"); XCTAssertEqual(VaultProtocol.observed?.httpMethod, "DELETE"); XCTAssertTrue(VaultProtocol.observed?.url?.absoluteString.hasSuffix("login%2F1") == true)
    try await client.setVaultSource(botId: "bot", source: "bitwarden", enabled: true); XCTAssertEqual(VaultProtocol.observed?.httpMethod, "PUT"); XCTAssertEqual(try body()["enabled"] as? Bool, true)
    try await client.unlockVaultSource(botId: "bot", source: "bitwarden", password: "fixture-password"); XCTAssertEqual(try body()["password"] as? String, "fixture-password")
    try await client.lockVaultSource(botId: "bot", source: "bitwarden"); XCTAssertTrue(try body().isEmpty)
  }
  func testUpstreamCredentialEchoIsSanitizedAndUncertain() async {
    VaultProtocol.status = 502; VaultProtocol.payload = #"{"error":"fixture-password echoed by upstream"}"#
    do { _ = try await api().answerSecureRequest(botId: "bot", requestId: "request", answer: SecureRequestAnswer(request: request(), identifier: "fixture-parent", value: "fixture-password", cancel: false)); XCTFail("Expected upstream failure") }
    catch { XCTAssertFalse(error.localizedDescription.contains("fixture-password")); XCTAssertTrue(VaultSafety.uncertain(error)) }
  }
  func testInputClearsOnSubmissionAndUncertainBindingCannotReplay() async {
    let input = SecureRequestInput(), client = api(), key = UUID().uuidString
    VaultProtocol.status = 502; VaultProtocol.payload = #"{"error":"fixture-password"}"#
    input.bind(key); input.identifier = "fixture-parent"; input.value = "fixture-password"
    input.submit(api: client, botId: "bot", requestId: "request", request: request(), key: key, cancel: false, current: { true }, refresh: {})
    XCTAssertEqual(input.identifier, ""); XCTAssertEqual(input.value, "")
    for _ in 0..<100 { if !input.busy { break }; try? await Task.sleep(for: .milliseconds(10)) }
    XCTAssertTrue(input.blocked); XCTAssertTrue(SecureRequestOutcomes.uncertain.contains(key)); XCTAssertFalse(input.message?.contains("fixture-password") == true)
    let reopened = SecureRequestInput(); reopened.bind(key); XCTAssertTrue(reopened.blocked)
    reopened.bind(key + "new-epoch"); XCTAssertFalse(reopened.blocked)
    input.value = "fixture-password"; input.teardown(); XCTAssertEqual(input.value, "")
  }
  func testDefiniteBadFieldsAllowReentryWhileExpiredRequestRequiresRefresh() async {
    for status in [400, 409] {
      let input = SecureRequestInput(), key = UUID().uuidString
      VaultProtocol.status = status; VaultProtocol.payload = #"{"error":"fixture-password"}"#
      input.bind(key); input.value = "fixture-password"; input.identifier = "fixture-parent"
      input.submit(api: api(), botId: "bot", requestId: "request", request: request(), key: key, cancel: false, current: { true }, refresh: {})
      for _ in 0..<100 { if !input.busy { break }; try? await Task.sleep(for: .milliseconds(10)) }
      XCTAssertEqual(input.blocked, status == 409); XCTAssertFalse(SecureRequestOutcomes.uncertain.contains(key)); XCTAssertEqual(input.value, "")
    }
  }
  func testCurrentRequestTransportCancellationStopsBusyAndRequiresRefresh() async {
    VaultProtocol.cancelled = true
    let input = SecureRequestInput(), key = UUID().uuidString
    input.bind(key); input.identifier = "fixture-parent"; input.value = "fixture-password"
    input.submit(api: api(), botId: "bot", requestId: "request", request: request(), key: key, cancel: false, current: { true }, refresh: {})
    for _ in 0..<100 { if !input.busy { break }; try? await Task.sleep(for: .milliseconds(10)) }
    XCTAssertFalse(input.busy); XCTAssertTrue(input.blocked); XCTAssertTrue(SecureRequestOutcomes.uncertain.contains(key))
    XCTAssertEqual(input.value, ""); XCTAssertTrue(input.message?.contains("Refresh") == true)
  }
  func testLateResponseCannotReplaceInputAfterIdentityTeardown() async {
    let input = SecureRequestInput(), key = UUID().uuidString
    input.bind(key); input.identifier = "fixture-parent"; input.value = "fixture-password"
    input.submit(api: api(), botId: "bot", requestId: "request", request: request(), key: key, cancel: false, current: { false }, refresh: {})
    input.teardown(); input.value = "new-identity-input"
    for _ in 0..<100 { if !SecureRequestOutcomes.uncertain.contains(key) { break }; try? await Task.sleep(for: .milliseconds(10)) }
    XCTAssertFalse(SecureRequestOutcomes.uncertain.contains(key)); XCTAssertNil(input.message)
    XCTAssertEqual(input.value, "new-identity-input"); XCTAssertFalse(input.busy); XCTAssertFalse(input.blocked)
  }
  func testUnsupportedSecureMetadataStaysOfficialAndCredentialOriginsRejectEmbeddedPasswords() {
    XCTAssertTrue(request().supported); XCTAssertFalse(request("sudo").supported)
    var invalid = request(); invalid.origin = nil; XCTAssertFalse(invalid.supported)
    XCTAssertTrue(VaultSafety.validOrigin("https://school.example.test"))
    XCTAssertFalse(VaultSafety.validOrigin("https://school.example.test/login")); XCTAssertFalse(VaultSafety.validOrigin("https://school.example.test?token=secret"))
    XCTAssertFalse(VaultSafety.validOrigin("https://username:password@school.example.test")); XCTAssertFalse(VaultSafety.validOrigin("file:///tmp/secret"))
  }
}
