import XCTest
@testable import AgentInterface

/// Conversation copy that must read the same as the web client (src/app/Conversation.tsx and friends).
final class ConversationParityTests: XCTestCase {
  private func sentence(_ state: ActivityState, _ detail: String? = nil, lost: Bool = false) -> String {
    ActivitySentence.text(name: "Ranch hand", state: state, detail: detail, connectionLost: lost)
  }

  func testWorkingLineNamesTheCurrentStepInOneSentence() {
    XCTAssertEqual(sentence(.working, "Creating a shared reminder"), "Ranch hand is creating a shared reminder...")
    XCTAssertEqual(sentence(.working, "  Checking the latest forecast…  "), "Ranch hand is checking the latest forecast...")
    XCTAssertEqual(sentence(.working, "Saving the list..."), "Ranch hand is saving the list...")
    XCTAssertEqual(sentence(.working, "   "), "Ranch hand is working...")
    XCTAssertEqual(sentence(.working), "Ranch hand is working...")
  }

  func testOtherStatesUseTheWebVerbsAndIgnoreTheDetail() {
    XCTAssertEqual(sentence(.thinking, "Planning"), "Ranch hand is thinking...")
    XCTAssertEqual(sentence(.waiting, "Order hay"), "Ranch hand is waiting for approval...")
    XCTAssertEqual(sentence(.blocked), "Ranch hand is waiting for your input...")
    XCTAssertEqual(sentence(.failed), "Ranch hand is having trouble...")
    XCTAssertEqual(sentence(.interrupted), "Ranch hand is stopped...")
    XCTAssertEqual(sentence(.disconnected), "Ranch hand is reconnecting...")
    XCTAssertEqual(sentence(.working, "Creating a reminder", lost: true), "Ranch hand is reconnecting...")
    XCTAssertEqual(sentence(.unknown), "Ranch hand's status is unknown")
  }

  func testDiscussRoleAppendsToTypedText() {
    XCTAssertEqual(RoleDiscussion.draft(appendingTo: "", description: nil),
      "Let's discuss your role. Ask me what I need help with and how I like to work.")
    XCTAssertEqual(RoleDiscussion.draft(appendingTo: "", description: ""),
      "Let's discuss your role. Ask me what I need help with and how I like to work.")
    XCTAssertEqual(RoleDiscussion.draft(appendingTo: "Fence notes", description: "Keeps the ranch running"),
      "Fence notes\n\nLet's discuss your role: Keeps the ranch running.")
  }

  func testOutgoingHandoffReadsTargetAndMessageFromTheCall() {
    let sent = AgentHandoff(message: Message(id: "a", role: "assistant", text: "", toolCall: ToolCall(
      id: "c", name: "message_agent", arguments: #"{"target":"Kitchen companion","message":"Plan dinners"}"#, status: "completed", result: "Delivered")))
    XCTAssertNil(sent.incoming)
    XCTAssertEqual(sent.target, "Kitchen companion")
    XCTAssertEqual(sent.body, "Plan dinners")
    XCTAssertEqual(sent.summary, "View handoff and response")
    XCTAssertEqual(sent.response, "Delivered")

    let sending = AgentHandoff(message: Message(id: "b", role: "assistant", text: "", toolCall: ToolCall(
      id: "d", name: "message_agent", arguments: "not json", status: "running")))
    XCTAssertEqual(sending.target, "another assistant")
    XCTAssertEqual(sending.summary, "Sending message…")
    XCTAssertEqual(sending.response, "Waiting for Hermes to report delivery.")

    let failed = AgentHandoff(message: Message(id: "e", role: "assistant", text: "", toolCall: ToolCall(
      id: "f", name: "message_agent", status: "failed", error: "Unknown assistant")))
    XCTAssertEqual(failed.summary, "Delivery failed")
    XCTAssertEqual(failed.response, "Unknown assistant")
  }

  func testIncomingHandoffUsesTheEnvelope() {
    let received = AgentHandoff(message: Message(id: "g", role: "user", text: "Message from Kitchen companion: Dinner is planned"))
    XCTAssertEqual(received.incoming?.name, "Kitchen companion")
    XCTAssertEqual(received.incoming?.body, "Dinner is planned")
  }

  func testConnectionCardCopyFollowsTheConnectionCode() {
    XCTAssertEqual(ConnectionCopy.compact(code: "reconnecting", appUnavailable: false).title, "Reconnecting to Hermes")
    XCTAssertEqual(ConnectionCopy.compact(code: nil, appUnavailable: false).title, "Hermes is temporarily unavailable")
    XCTAssertEqual(ConnectionCopy.compact(code: "something_new", appUnavailable: false).title, "Hermes is temporarily unavailable")
    XCTAssertTrue(ConnectionCopy.compact(code: "unauthorized", appUnavailable: false).setup)
    XCTAssertEqual(ConnectionCopy.compact(code: "reconnecting", appUnavailable: true).title, "Reconnecting to the app")
  }
}
