import XCTest
import SwiftUI
@testable import AgentInterface

@MainActor final class VaultTests: XCTestCase {
  /// Each test gets its own server, so none inherits another's status or payload.
  private let server = FakeServer()
  override func setUp() { server.reply = .init(body: #"{"status":"ok","ok":true,"id":"new","removed":true}"#) }
  private func api() -> APIClient { server.api(token: "fixture-session-token") }
  private func body() throws -> [String: Any] {
    _ = try XCTUnwrap(server.lastRequest)
    return try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(server.lastBody ?? Data())) as? [String: Any])
  }
  private func request(_ method: String = "vault.save_login") -> SecureRequest {
    SecureRequest(epoch: "native-epoch", sessionId: "native-session", method: method, origin: "https://school.example.test", site: "School")
  }
  func testSecureLoginUsesDedicatedAuthenticatedEndpointAndExactBinding() async throws {
    let client = api(); let result = try await client.answerSecureRequest(botId: "ranch/bot", requestId: "request/1", answer: SecureRequestAnswer(request: request(), identifier: "fixture-parent", value: "fixture-password", cancel: false))
    XCTAssertEqual(result.status, "ok")
    let observed = try XCTUnwrap(server.lastRequest)
    XCTAssertEqual(observed.url?.absoluteString, server.origin.absoluteString + "/api/bots/ranch%2Fbot/secure-requests/request%2F1")
    XCTAssertEqual(observed.value(forHTTPHeaderField: "Authorization"), "Bearer fixture-session-token")
    XCTAssertEqual(observed.value(forHTTPHeaderField: "Cache-Control"), "no-store")
    let payload = try body()
    XCTAssertEqual(Set(payload.keys), ["epoch", "sessionId", "method", "identifier", "password"])
    XCTAssertEqual(payload["epoch"] as? String, "native-epoch"); XCTAssertEqual(payload["password"] as? String, "fixture-password")
  }
  func testExplicitLoginRepeatsTheAddressItShowedAndCancelsWithoutIt() async throws {
    var explicit = request(); explicit.origin = "https://kvm.example.test"
    explicit.explicit = ExplicitLoginRequest(label: "Comet KVM", purpose: "Check the console.", profile: "patch", requestedBy: .init(id: "one", name: "One"))
    _ = try await api().answerSecureRequest(botId: "patch", requestId: "request", answer: SecureRequestAnswer(request: explicit, identifier: "kvm-admin", value: "fixture-password", cancel: false))
    var payload = try body()
    XCTAssertEqual(Set(payload.keys), ["epoch", "sessionId", "method", "identifier", "password", "origin"])
    XCTAssertEqual(payload["origin"] as? String, "https://kvm.example.test")
    _ = try await api().answerSecureRequest(botId: "patch", requestId: "request", answer: SecureRequestAnswer(request: explicit, identifier: "kvm-admin", value: "fixture-password", cancel: true))
    payload = try body(); XCTAssertEqual(Set(payload.keys), ["epoch", "sessionId", "method", "cancel"])
  }
  func testExplicitLoginDecodesAndOnlyItsRequesterMayAnswer() throws {
    let json = #"{"epoch":"e","sessionId":"s","method":"vault.save_login","origin":"https://kvm.example.test","site":"kvm.example.test","explicit":{"label":"Comet KVM","purpose":"Why","profile":"patch","requestedBy":{"id":"one","name":"One"}}}"#
    let decoded = try JSONDecoder().decode(SecureRequest.self, from: Data(json.utf8))
    let explicit = try XCTUnwrap(decoded.explicit)
    XCTAssertTrue(decoded.supported); XCTAssertEqual(explicit.label, "Comet KVM")
    XCTAssertTrue(explicit.answerable(by: "one")); XCTAssertFalse(explicit.answerable(by: "two")); XCTAssertFalse(explicit.answerable(by: nil))
    XCTAssertTrue(ExplicitLoginRequest(label: "KVM", purpose: "Why", profile: "patch").answerable(by: "two"))
    XCTAssertNil(try JSONDecoder().decode(SecureRequest.self, from: Data(#"{"epoch":"e","sessionId":"s","method":"vault.save_login","origin":"https://a.test","site":"a.test"}"#.utf8)).explicit)
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
    XCTAssertEqual(server.lastRequest?.url?.path, "/api/bots/bot/vault/logins"); XCTAssertEqual(try body()["identifierType"] as? String, "email")
    try await client.removeVaultLogin(botId: "bot", itemId: "login/1"); XCTAssertEqual(server.lastRequest?.httpMethod, "DELETE"); XCTAssertTrue(server.lastRequest?.url?.absoluteString.hasSuffix("login%2F1") == true)
    try await client.setVaultSource(botId: "bot", source: "bitwarden", enabled: true); XCTAssertEqual(server.lastRequest?.httpMethod, "PUT"); XCTAssertEqual(try body()["enabled"] as? Bool, true)
    try await client.unlockVaultSource(botId: "bot", source: "bitwarden", password: "fixture-password"); XCTAssertEqual(try body()["password"] as? String, "fixture-password")
    try await client.lockVaultSource(botId: "bot", source: "bitwarden"); XCTAssertTrue(try body().isEmpty)
  }
  func testUpstreamCredentialEchoIsSanitizedAndUncertain() async {
    server.reply = .init(status: 502, body: #"{"error":"fixture-password echoed by upstream"}"#)
    do { _ = try await api().answerSecureRequest(botId: "bot", requestId: "request", answer: SecureRequestAnswer(request: request(), identifier: "fixture-parent", value: "fixture-password", cancel: false)); XCTFail("Expected upstream failure") }
    catch { XCTAssertFalse(error.localizedDescription.contains("fixture-password")); XCTAssertTrue(VaultSafety.uncertain(error)) }
  }
  func testInputClearsOnSubmissionAndUncertainBindingCannotReplay() async throws {
    let input = SecureRequestInput(), client = api(), key = UUID().uuidString
    server.reply = .init(status: 502, body: #"{"error":"fixture-password"}"#)
    input.bind(key); input.identifier = "fixture-parent"; input.value = "fixture-password"
    input.submit(api: client, botId: "bot", requestId: "request", request: request(), key: key, cancel: false, current: { true }, refresh: {})
    XCTAssertEqual(input.identifier, ""); XCTAssertEqual(input.value, "")
    try await until { !input.busy }
    XCTAssertTrue(input.blocked); XCTAssertTrue(SecureRequestOutcomes.uncertain.contains(key)); XCTAssertFalse(input.message?.contains("fixture-password") == true)
    let reopened = SecureRequestInput(); reopened.bind(key); XCTAssertTrue(reopened.blocked)
    reopened.bind(key + "new-epoch"); XCTAssertFalse(reopened.blocked)
    input.value = "fixture-password"; input.teardown(); XCTAssertEqual(input.value, "")
  }
  func testTemporaryInactivityPreservesSecureEntryUntilBackground() {
    let input = SecureRequestInput()
    input.identifier = "fixture-parent"; input.value = "fixture-password"
    for phase in [ScenePhase.inactive, .active] {
      input.sceneChanged(to: phase)
      XCTAssertEqual(input.identifier, "fixture-parent"); XCTAssertEqual(input.value, "fixture-password")
    }
    input.sceneChanged(to: .background)
    XCTAssertEqual(input.identifier, ""); XCTAssertEqual(input.value, "")
  }
  func testExpiredAndChangedRequestsRefreshWithoutReusingTheAnswer() async throws {
    for status in [200, 404, 409] {
      server.reply = .init(status: status, body: status == 200 ? #"{"status":"expired"}"# : #"{"error":"Request changed"}"#)
      let input = SecureRequestInput(), key = UUID().uuidString
      var refreshes = 0
      input.bind(key); input.identifier = "fixture-parent"; input.value = "fixture-password"
      input.submit(api: api(), botId: "bot", requestId: "request", request: request(), key: key, cancel: false, current: { true }, refresh: { refreshes += 1 })
      try await until { refreshes > 0 }
      XCTAssertEqual(refreshes, 1); XCTAssertTrue(input.blocked)
      XCTAssertEqual(input.identifier, ""); XCTAssertEqual(input.value, "")
      input.submit(api: api(), botId: "bot", requestId: "request", request: request(), key: key, cancel: false, current: { true }, refresh: { refreshes += 1 })
      XCTAssertEqual(refreshes, 1)
    }
  }
  func testDefiniteBadFieldsAllowReentryWhileExpiredRequestRequiresRefresh() async throws {
    for status in [400, 409] {
      let input = SecureRequestInput(), key = UUID().uuidString
      server.reply = .init(status: status, body: #"{"error":"fixture-password"}"#)
      input.bind(key); input.value = "fixture-password"; input.identifier = "fixture-parent"
      input.submit(api: api(), botId: "bot", requestId: "request", request: request(), key: key, cancel: false, current: { true }, refresh: {})
      try await until { !input.busy }
      XCTAssertEqual(input.blocked, status == 409); XCTAssertFalse(SecureRequestOutcomes.uncertain.contains(key)); XCTAssertEqual(input.value, "")
    }
  }
  func testCurrentRequestTransportCancellationStopsBusyAndRequiresRefresh() async throws {
    server.failing = URLError(.cancelled)
    let input = SecureRequestInput(), key = UUID().uuidString
    input.bind(key); input.identifier = "fixture-parent"; input.value = "fixture-password"
    input.submit(api: api(), botId: "bot", requestId: "request", request: request(), key: key, cancel: false, current: { true }, refresh: {})
    try await until { !input.busy }
    XCTAssertFalse(input.busy); XCTAssertTrue(input.blocked); XCTAssertTrue(SecureRequestOutcomes.uncertain.contains(key))
    XCTAssertEqual(input.value, ""); XCTAssertTrue(input.message?.contains("Refresh") == true)
  }
  func testLateResponseCannotReplaceInputAfterIdentityTeardown() async throws {
    let input = SecureRequestInput(), key = UUID().uuidString
    input.bind(key); input.identifier = "fixture-parent"; input.value = "fixture-password"
    input.submit(api: api(), botId: "bot", requestId: "request", request: request(), key: key, cancel: false, current: { false }, refresh: {})
    input.teardown(); input.value = "new-identity-input"
    try await until { !SecureRequestOutcomes.uncertain.contains(key) }
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
