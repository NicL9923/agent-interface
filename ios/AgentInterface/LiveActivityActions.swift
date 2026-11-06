import Foundation
import UserNotifications

/// The Live Activity's Stop and Decline. iOS runs them in the app, possibly launched in the background
/// just for this, so they use the same sign-in a notification's Decline does.
extension NotificationController {
  func act(_ action: ActivityAction) async {
    // Only the account the activity was started for acts on it. Before the account loads, the saved
    // sign-in names it, as when the activity decides whether to end.
    let signedIn = store?.scope ?? (actionClient() != nil ? savedScope() : nil)
    guard signedIn == action.scope, let userId = AppStore.userId(inScope: action.scope) else {
      await deliverNotice(Self.activityNotice(action, title: "\(action.name) wasn't changed",
        body: "This activity belongs to an account that isn't signed in here. Tap to open WildBots."))
      return
    }
    switch action.kind {
    case .decline(let approvalId):
      // The server also refuses a decision whose account is not the signed-in person's.
      await decide(ApprovalDecision(botId: action.botId, approvalId: approvalId, account: NotificationActions.accountMarker(userId),
        url: "/?bot=\(APIClient.component(action.botId))", title: action.name))
    case .stop:
      let api = store?.api.flatMap { $0.token != nil || $0.localCookieAuth ? $0 : nil } ?? actionClient()
      guard let api else {
        await deliverNotice(Self.activityNotice(action, title: "\(action.name) didn't stop", body: "Sign in to WildBots again, then stop it in the chat."))
        return
      }
      do {
        let _: EmptyResponse = try await api.write("/bots/\(APIClient.component(action.botId))/stop", [String: String]())
        if let store, store.selectedBotId == action.botId, store.api === api { await store.refreshConversation() }
      } catch {
        let reason = (error as? LocalizedError)?.errorDescription ?? "WildBots couldn't reach the server."
        await deliverNotice(Self.activityNotice(action, title: "\(action.name) didn't stop",
          body: (reason.hasSuffix(".") ? reason : reason + ".") + " Tap to open the chat."))
      }
    }
  }
  /// Says an action from the Lock Screen did not go through. Tapping it opens the chat.
  static func activityNotice(_ action: ActivityAction, title: String, body: String) -> UNNotificationRequest {
    let content = UNMutableNotificationContent()
    content.title = title
    content.body = body
    content.sound = .default
    content.threadIdentifier = action.botId
    let tag = "activity-\(action.botId)"
    content.userInfo = ["url": "/?bot=\(APIClient.component(action.botId))", "tag": tag, "decisionNotice": true]
    return UNNotificationRequest(identifier: tag, content: content, trigger: nil)
  }
}

extension AppStore {
  /// The user ID in an account scope, which is the base64url of the server address, `|`, and the ID.
  nonisolated static func userId(inScope scope: String) -> String? {
    var base64 = scope.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
    guard let data = Data(base64Encoded: base64), let text = String(data: data, encoding: .utf8),
      let bar = text.firstIndex(of: "|") else { return nil }
    let id = String(text[text.index(after: bar)...])
    return id.isEmpty ? nil : id
  }
}
