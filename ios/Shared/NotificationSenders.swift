import CryptoKit
import Foundation
@preconcurrency import Intents
@preconcurrency import UserNotifications

/// Assistants as notification senders. The app draws each assistant's avatar into the App Group;
/// the notification service extension shows the assistant as the sender with that picture, like a
/// person in Messages. Pictures are kept per account marker, so a notification meant for another
/// sign-in on this device finds none and keeps the assistant's name alone.
enum NotificationSenders {
  static var root: URL? {
    FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: ShareInbox.group)?
      .appendingPathComponent("NotificationSenders", isDirectory: true)
  }
  /// The server's account marker: 16 lowercase hex characters. Anything else never becomes a path.
  static func isAccountMarker(_ value: String) -> Bool {
    value.utf8.count == 16 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
  }
  static func directory(account: String, root: URL? = root) -> URL? {
    guard isAccountMarker(account) else { return nil }
    return root?.appendingPathComponent(account, isDirectory: true)
  }
  /// Assistant IDs are server data, so file names are their hashes.
  static func avatarURL(account: String, botId: String, root: URL? = root) -> URL? {
    let name = SHA256.hash(data: Data(botId.utf8)).prefix(16).map { String(format: "%02x", $0) }.joined()
    return directory(account: account, root: root)?.appendingPathComponent(name + ".png")
  }

  /// Shows an assistant's notification as a message from it, once its donation is recorded, as
  /// iOS requires. A notification without an assistant, or for an account that is not signed in
  /// here (its folder is gone), stays as sent. Donations are grouped by account so signing out
  /// can delete them.
  static func decorate(
    _ content: UNNotificationContent, root: URL? = root, completion: @escaping @Sendable (UNNotificationContent) -> Void
  ) {
    let info = content.userInfo
    guard let botId = info["botId"] as? String, let account = info["account"] as? String, !botId.isEmpty,
      let folder = directory(account: account, root: root), FileManager.default.fileExists(atPath: folder.path),
      let avatar = avatarURL(account: account, botId: botId, root: root)
    else { return completion(content) }
    let image = (try? Data(contentsOf: avatar)).map { INImage(imageData: $0) }
    let sender = INPerson(
      personHandle: INPersonHandle(value: "wildbots:\(account):\(botId)", type: .unknown), nameComponents: nil,
      displayName: content.title.isEmpty ? "Assistant" : content.title, image: image, contactIdentifier: nil,
      customIdentifier: "\(account):\(botId)")
    let intent = INSendMessageIntent(
      recipients: nil, outgoingMessageType: .outgoingMessageText, content: content.body, speakableGroupName: nil,
      conversationIdentifier: botId, serviceName: "WildBots", sender: sender, attachments: nil)
    if let image { intent.setImage(image, forParameterNamed: \.sender) }
    let interaction = INInteraction(intent: intent, response: nil)
    interaction.direction = .incoming
    interaction.groupIdentifier = account
    interaction.donate { error in
      completion(error == nil ? (try? content.updating(from: intent)) ?? content : content)
    }
  }
  /// Removes an account's donated messages, as Apple asks when a person signs out.
  static func forget(account: String) {
    guard isAccountMarker(account) else { return }
    INInteraction.delete(with: account)
  }
}
