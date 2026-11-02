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
  func testOnlyConnectedAndConfiguredCountAsReady() {
    for status in ["connected", "configured"] { XCTAssertTrue(ConnectionReadiness.isReady(status)) }
    for status in ["not_connected", "expired", "missing_permission", "unavailable", "unsupported", nil] { XCTAssertFalse(ConnectionReadiness.isReady(status)) }
  }
  func testAConnectionAlreadyReadyWhenTheCardLoadsWaitsForContinue() {
    var readiness = ConnectionReadiness()
    XCTAssertFalse(readiness.observe(status: "connected"))
    XCTAssertFalse(readiness.observe(status: "connected"))
  }
  func testBecomingReadyWhileShownSendsOnce() {
    var readiness = ConnectionReadiness()
    XCTAssertFalse(readiness.observe(status: "not_connected"))
    XCTAssertFalse(readiness.observe(status: "not_connected"))
    XCTAssertTrue(readiness.observe(status: "connected"))
    XCTAssertFalse(readiness.observe(status: "connected"))
  }
  func testAFinishedFlowSendsOnTheNextReadyReadEvenFromAReadyStart() {
    var readiness = ConnectionReadiness()
    XCTAssertFalse(readiness.observe(status: "configured"))
    readiness.flowFinished()
    XCTAssertTrue(readiness.observe(status: "connected"))
    XCTAssertFalse(readiness.observe(status: "connected"))
  }
  func testAFinishedFlowWaitsForTheStatusToCatchUp() {
    var readiness = ConnectionReadiness()
    XCTAssertFalse(readiness.observe(status: "expired"))
    readiness.flowFinished()
    XCTAssertFalse(readiness.observe(status: "expired"))
    XCTAssertTrue(readiness.observe(status: "connected"))
  }
  func testAFirstReadWithoutTheConnectionIsANotReadyBaseline() {
    var readiness = ConnectionReadiness()
    XCTAssertFalse(readiness.observe(status: nil))
    XCTAssertTrue(readiness.observe(status: "connected"))
  }
}
