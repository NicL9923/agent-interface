import XCTest
@testable import AgentInterface

@MainActor final class ConnectionRequestTests: XCTestCase {
  private func conversation(_ attention: String) throws -> Conversation {
    let json = #"{"botId":"kitchen","messages":[],"activity":{"state":"blocked"},"approvals":[],"files":[],"attention":[\#(attention)]}"#
    return try JSONDecoder().decode(Conversation.self, from: Data(json.utf8))
  }
  func testConnectionRequestDecodesAndAMessageStillClosesIt() throws {
    let json = #"{"id":"r1","kind":"connection","title":"Set up a connection?","detail":"I need your calendar.","connection":{"epoch":"e","sessionId":"s","connectionId":"google_workspace","reason":"I need your calendar."}}"#
    let waiting = try conversation(json)
    let request = try XCTUnwrap(waiting.attention?.first)
    XCTAssertEqual(request.kind, "connection")
    XCTAssertEqual(request.connection, ConnectionRequest(epoch: "e", sessionId: "s", connectionId: "google_workspace", reason: "I need your calendar."))
    XCTAssertNil(request.computer); XCTAssertNil(request.secure)
    XCTAssertTrue(WaitingInput.closes(request, userId: "one"))
    XCTAssertEqual(WaitingInput.placeholder(waiting, userId: "one"), "Or reply here instead…")
  }
  func testDecisionBodyCarriesTheRequestsEpochAndSession() throws {
    let request = ConnectionRequest(epoch: "e", sessionId: "s", connectionId: "key:brave", reason: "Why")
    for decision in [ConnectionDecision.connected, ConnectionDecision.decline] {
      let data = try JSONEncoder().encode(ConnectionDecision(decision, for: request))
      let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: String])
      XCTAssertEqual(body, ["decision": decision, "epoch": "e", "sessionId": "s", "connection": "key:brave"])
    }
    XCTAssertEqual(ConnectionDecision.connected, "connected"); XCTAssertEqual(ConnectionDecision.decline, "decline")
    XCTAssertEqual(try JSONDecoder().decode(ConnectionRequestResult.self, from: Data(#"{"status":"expired"}"#.utf8)).status, "expired")
  }
  private func item(_ status: String) throws -> IntegrationConnection {
    let json = #"{"id":"key:brave","name":"Brave Search","category":"providers","owner":"Hermes","profile":"kitchen","status":"\#(status)","detail":"","permissions":[],"actions":{"connect":true,"check":false,"disconnect":false},"setup":[],"capabilities":[],"botIds":["kitchen"]"#
    return try JSONDecoder().decode(IntegrationConnection.self, from: Data((json + "}").utf8))
  }
  func testOnlyConnectedAndConfiguredAreReady() throws {
    for status in ["connected", "configured"] { XCTAssertTrue(ConnectionReadiness.isReady(try item(status))) }
    for status in ["not_connected", "expired", "missing_permission", "unavailable", "unsupported"] { XCTAssertFalse(ConnectionReadiness.isReady(try item(status))) }
    XCTAssertFalse(ConnectionReadiness.isReady(nil))
  }
  func testAFlowNamesItsConnection() throws {
    let flow = try JSONDecoder().decode(IntegrationFlow.self, from: Data(#"{"kind":"redirect","status":"approved","flowId":"f","connectionId":"github","message":"Done."}"#.utf8))
    XCTAssertEqual(flow.connectionId, "github")
  }
  func testAConnectionAlreadyReadyWhenTheCardLoadsWaitsForContinue() {
    var readiness = ConnectionReadiness()
    XCTAssertFalse(readiness.observe(ready: true))
    XCTAssertFalse(readiness.observe(ready: true))
  }
  func testBecomingReadyWhileShownSendsAndRetriesOnLaterReadyReads() {
    var readiness = ConnectionReadiness()
    XCTAssertFalse(readiness.observe(ready: false))
    XCTAssertFalse(readiness.observe(ready: false))
    XCTAssertTrue(readiness.observe(ready: true))
    // The card's autoSent flag stops a second send while one is in flight; after a refused send, the next read retries.
    XCTAssertTrue(readiness.observe(ready: true))
  }
  func testAnUnsignedServerThatFinishesSigningInSendsOnceItIsReady() throws {
    var readiness = ConnectionReadiness()
    XCTAssertFalse(readiness.observe(ready: ConnectionReadiness.isReady(try item("not_connected"))))
    XCTAssertTrue(readiness.observe(ready: ConnectionReadiness.isReady(try item("configured"))))
  }
  func testItsOwnFinishedFlowSendsEvenFromAReadyStart() {
    var readiness = ConnectionReadiness()
    XCTAssertFalse(readiness.observe(ready: true))
    readiness.flowFinished()
    XCTAssertTrue(readiness.observe(ready: true))
  }
  func testAFinishedFlowWaitsForTheStatusToCatchUp() {
    var readiness = ConnectionReadiness()
    XCTAssertFalse(readiness.observe(ready: false))
    readiness.flowFinished()
    XCTAssertFalse(readiness.observe(ready: false))
    XCTAssertTrue(readiness.observe(ready: true))
  }
}
