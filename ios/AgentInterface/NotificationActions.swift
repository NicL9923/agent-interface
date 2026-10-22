import CryptoKit
import Foundation
import UserNotifications

/// The actions on WildBots notifications. The server picks a category per notification: APPROVAL for an approval
/// request it can name, REPLY for an assistant's finished reply in a one-to-one chat, and none otherwise.
enum NotificationActions {
  static let approvalCategory = "APPROVAL", replyCategory = "REPLY"
  static let review = "REVIEW", deny = "DENY", reply = "REPLY"
  /// The payload leaves out what an approval would run, since it can hold credentials, so approving from the
  /// notification would be blind: Review opens the chat to see it first. Decline needs no detail and works from
  /// the notification once the phone is unlocked. Reply opens the app, because the text only joins the draft.
  static var categories: Set<UNNotificationCategory> { [
    UNNotificationCategory(identifier: approvalCategory, actions: [
      UNNotificationAction(identifier: review, title: "Review", options: [.foreground, .authenticationRequired]),
      UNNotificationAction(identifier: deny, title: "Decline", options: [.authenticationRequired, .destructive]),
    ], intentIdentifiers: [], options: []),
    UNNotificationCategory(identifier: replyCategory, actions: [
      UNTextInputNotificationAction(identifier: reply, title: "Reply", options: [.foreground, .authenticationRequired],
        textInputButtonTitle: "Add to draft", textInputPlaceholder: "Review it in the chat before sending"),
    ], intentIdentifiers: [], options: []),
  ] }
  /// The server's `accountMarker`: names the account a notification went to without sending its ID through Apple.
  static func accountMarker(_ userId: String) -> String {
    String(SHA256.hash(data: Data("wildbots-account:\(userId)".utf8)).map { String(format: "%02x", $0) }.joined().prefix(16))
  }
  /// What a tap or an action on a notification asks for.
  static func route(action: String, userInfo: [AnyHashable: Any], text: String? = nil) -> NotificationRoute {
    let url = userInfo["url"] as? String
    let botId = userInfo["botId"] as? String, account = userInfo["account"] as? String
    switch action {
    case deny:
      guard let botId, let account, let approvalId = userInfo["approvalId"] as? String, !botId.isEmpty, !approvalId.isEmpty
      else { return .open(url) }
      let title = ((userInfo["aps"] as? [String: Any])?["alert"] as? [String: Any])?["title"] as? String
      return .decide(ApprovalDecision(botId: botId, approvalId: approvalId, account: account, url: url, title: title))
    case reply:
      guard let botId, let account, let text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return .open(url) }
      return .reply(NotificationReply(botId: botId, account: account, text: text, url: url ?? "/?bot=\(APIClient.component(botId))"))
    case UNNotificationDismissActionIdentifier: return .none
    default: return .open(url)
    }
  }
}

enum NotificationRoute: Equatable {
  case open(String?)
  case decide(ApprovalDecision)
  case reply(NotificationReply)
  case none
}

struct NotificationReply: Equatable {
  let botId: String, account: String, text: String, url: String
}

/// A Decline from a notification. It uses the in-app approval card's endpoint and is sent once:
/// the server refuses a second decision, and an unconfirmed one is never retried.
struct ApprovalDecision: Equatable {
  let botId: String, approvalId: String, account: String, url: String?, title: String?
  static func path(botId: String, approvalId: String) -> String {
    "/bots/\(APIClient.component(botId))/approvals/\(APIClient.component(approvalId))"
  }
  var path: String { Self.path(botId: botId, approvalId: approvalId) }
  /// The account lets the server refuse a decision when someone else is signed in on this phone now.
  var body: [String: String] { ["decision": "denied", "account": account] }
  enum Outcome: Equatable {
    case decided
    /// The server answered and did not apply it, such as an approval already decided or expired.
    case refused(String)
    /// No answer arrived, so it may or may not have been applied.
    case uncertain
    case signedOut
  }
  static func outcome(of error: Error) -> Outcome {
    guard let failure = error as? APIError else { return .uncertain }
    if failure.status == 401 { return .signedOut }
    // As for messages, any answer below 500 is the server refusing; anything else leaves it unknown.
    return (400..<500).contains(failure.status) ? .refused(failure.message) : .uncertain
  }
  @MainActor func send(with api: APIClient?) async -> Outcome {
    guard let api else { return .signedOut }
    do {
      let _: EmptyResponse = try await api.write(path, body)
      return .decided
    } catch { return Self.outcome(of: error) }
  }
  /// The local notification that says a decision did not go through. Tapping it opens the chat.
  func failureNotice(_ outcome: Outcome) -> UNNotificationRequest? {
    let content = UNMutableNotificationContent()
    switch outcome {
    case .decided: return nil
    case .refused(let reason):
      content.title = "Your decline didn't go through"
      content.body = (reason.hasSuffix(".") ? reason : reason + ".") + " Tap to open the chat."
    case .uncertain:
      content.title = "Your decline may not have gone through"
      content.body = "WildBots couldn't confirm it with the server. Tap to open the chat and check before deciding again."
    case .signedOut:
      content.title = "Your decline didn't go through"
      content.body = "Sign in to WildBots again, then decide in the chat."
    }
    if let title { content.subtitle = title }
    content.sound = .default
    content.threadIdentifier = botId
    // Shown even over the chat itself, which would otherwise hide news for the chat on screen.
    content.userInfo = ["url": url ?? "/?bot=\(APIClient.component(botId))", "tag": "decision-\(approvalId)", "decisionNotice": true]
    return UNNotificationRequest(identifier: "decision-\(approvalId)", content: content, trigger: nil)
  }
}
