import UserNotifications
import XCTest
@testable import AgentInterface

@MainActor final class NotificationActionTests: XCTestCase {
  private let approvalInfo: [AnyHashable: Any] = [
    "aps": ["alert": ["title": "Kitchen", "body": "Needs your approval to continue."], "category": "APPROVAL"],
    "url": "/?bot=kitchen", "tag": "event-1", "botId": "kitchen", "approvalId": "request:7", "account": "e4081c9638bd1ba7",
  ]

  func testCategoriesAskForUnlockAndKeepRepliesForReview() throws {
    let categories = Dictionary(uniqueKeysWithValues: NotificationActions.categories.map { ($0.identifier, $0) })
    XCTAssertEqual(Set(categories.keys), ["APPROVAL", "REPLY"])
    let approval = try XCTUnwrap(categories["APPROVAL"]).actions
    XCTAssertEqual(approval.map(\.identifier), ["APPROVE", "DENY"])
    XCTAssertEqual(approval.map(\.title), ["Approve", "Deny"])
    XCTAssertTrue(approval.allSatisfy { $0.options.contains(.authenticationRequired) }, "Both authorize assistant actions")
    XCTAssertFalse(approval[0].options.contains(.destructive))
    XCTAssertTrue(approval[1].options.contains(.destructive))
    XCTAssertFalse(approval.contains { $0.options.contains(.foreground) }, "Decisions finish without opening the app")
    let reply = try XCTUnwrap(categories["REPLY"]?.actions.first as? UNTextInputNotificationAction)
    XCTAssertEqual([reply.identifier, reply.title], ["REPLY", "Reply"])
    XCTAssertTrue(reply.options.contains(.foreground), "The reply is reviewed in the app, never sent unseen")
  }

  func testLaunchRegistersTheCategories() async {
    // The test host is the app, so its launch already ran.
    let registered = await UNUserNotificationCenter.current().notificationCategories()
    XCTAssertTrue(Set(registered.map(\.identifier)).isSuperset(of: ["APPROVAL", "REPLY"]))
  }

  func testAccountMarkerMatchesTheServer() {
    // `accountMarker("one")` in src/server/apns.ts.
    XCTAssertEqual(NotificationActions.accountMarker("one"), "e4081c9638bd1ba7")
    XCTAssertNotEqual(NotificationActions.accountMarker("two"), NotificationActions.accountMarker("one"))
  }

  func testActionsRouteToDecisionsRepliesOrTheChat() {
    let approve = NotificationActions.route(action: "APPROVE", userInfo: approvalInfo)
    XCTAssertEqual(approve, .decide(ApprovalDecision(botId: "kitchen", approvalId: "request:7", account: "e4081c9638bd1ba7", approve: true, url: "/?bot=kitchen", title: "Kitchen")))
    guard case .decide(let deny) = NotificationActions.route(action: "DENY", userInfo: approvalInfo) else { return XCTFail("Deny decides") }
    XCTAssertFalse(deny.approve)
    XCTAssertEqual(NotificationActions.route(action: UNNotificationDefaultActionIdentifier, userInfo: approvalInfo), .open("/?bot=kitchen"))
    XCTAssertEqual(NotificationActions.route(action: UNNotificationDismissActionIdentifier, userInfo: approvalInfo), NotificationRoute.none)
    // A payload missing what the server needs only opens the chat; it never guesses which approval.
    var unnamed = approvalInfo; unnamed["approvalId"] = nil
    XCTAssertEqual(NotificationActions.route(action: "APPROVE", userInfo: unnamed), .open("/?bot=kitchen"))
    var noAccount = approvalInfo; noAccount["account"] = nil
    XCTAssertEqual(NotificationActions.route(action: "DENY", userInfo: noAccount), .open("/?bot=kitchen"))
    let replyInfo: [AnyHashable: Any] = ["url": "/?bot=kitchen", "botId": "kitchen", "account": "e4081c9638bd1ba7"]
    XCTAssertEqual(NotificationActions.route(action: "REPLY", userInfo: replyInfo, text: "Bring rope"),
      .reply(NotificationReply(botId: "kitchen", account: "e4081c9638bd1ba7", text: "Bring rope", url: "/?bot=kitchen")))
    XCTAssertEqual(NotificationActions.route(action: "REPLY", userInfo: replyInfo, text: "  \n"), .open("/?bot=kitchen"), "An empty reply just opens the chat")
  }

  func testDecisionUsesTheApprovalCardsEndpointWithItsAccount() {
    let decision = ApprovalDecision(botId: "kitchen helper", approvalId: "request:7/a", account: "e4081c9638bd1ba7", approve: false, url: nil, title: nil)
    XCTAssertEqual(decision.path, "/bots/kitchen%20helper/approvals/request%3A7%2Fa")
    XCTAssertEqual(decision.path, ApprovalDecision.path(botId: "kitchen helper", approvalId: "request:7/a"))
    XCTAssertEqual(decision.body, ["decision": "denied", "account": "e4081c9638bd1ba7"])
  }

  func testOutcomesTellRefusedFromUnknown() {
    XCTAssertEqual(ApprovalDecision.outcome(of: APIError(message: "This approval is no longer pending", status: 409)), .refused("This approval is no longer pending"))
    XCTAssertEqual(ApprovalDecision.outcome(of: APIError(message: "Assistant not found", status: 404)), .refused("Assistant not found"))
    XCTAssertEqual(ApprovalDecision.outcome(of: APIError(message: "Sign in required", status: 401, code: "session_expired")), .signedOut)
    XCTAssertEqual(ApprovalDecision.outcome(of: APIError(message: "Can't reach the app server.", status: 503, code: "CONNECTION_UNAVAILABLE")), .uncertain)
    XCTAssertEqual(ApprovalDecision.outcome(of: APIError(message: "Hermes failed", status: 500)), .uncertain)
    XCTAssertEqual(ApprovalDecision.outcome(of: CancellationError()), .uncertain)
  }

  func testFailureNoticesSayWhatHappenedAndOpenTheChat() throws {
    let decision = ApprovalDecision(botId: "kitchen", approvalId: "request:7", account: "a", approve: true, url: "/?bot=kitchen", title: "Kitchen")
    XCTAssertNil(decision.failureNotice(.decided))
    let refused = try XCTUnwrap(decision.failureNotice(.refused("This approval is no longer pending")))
    XCTAssertEqual(refused.content.title, "Your approval didn't go through")
    XCTAssertEqual(refused.content.body, "This approval is no longer pending. Tap to open the chat.")
    XCTAssertEqual(refused.content.subtitle, "Kitchen")
    XCTAssertEqual(refused.content.threadIdentifier, "kitchen")
    XCTAssertEqual(refused.content.userInfo["url"] as? String, "/?bot=kitchen")
    XCTAssertEqual(NotificationController.chatBotId(refused.content.userInfo["url"] as? String), "kitchen", "Opening the chat clears it")
    let uncertain = try XCTUnwrap(ApprovalDecision(botId: "kitchen", approvalId: "request:7", account: "a", approve: false, url: nil, title: nil).failureNotice(.uncertain))
    XCTAssertEqual(uncertain.content.title, "Your denial may not have gone through")
    XCTAssertEqual(uncertain.content.userInfo["url"] as? String, "/?bot=kitchen")
    XCTAssertEqual(decision.failureNotice(.signedOut)?.content.body, "Sign in to WildBots again, then decide in the chat.")
    XCTAssertEqual(refused.identifier, uncertain.identifier, "A later notice for the same approval replaces the earlier one")
  }
}
