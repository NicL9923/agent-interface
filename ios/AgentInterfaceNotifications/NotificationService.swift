@preconcurrency import UserNotifications

/// Shows each assistant's notification as a message from that assistant, with its avatar. It reads
/// only pictures the app left in the App Group and never holds a sign-in token. If anything is
/// missing, or time runs out, iOS shows the notification as the server sent it.
final class NotificationService: UNNotificationServiceExtension, @unchecked Sendable {
  private let lock = NSLock()
  private var deliver: ((UNNotificationContent) -> Void)?
  private var original: UNNotificationContent?

  override func didReceive(
    _ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    lock.withLock { deliver = contentHandler; original = request.content }
    NotificationSenders.decorate(request.content) { [weak self] content in self?.finish(content) }
  }
  override func serviceExtensionTimeWillExpire() {
    if let original = lock.withLock({ original }) { finish(original) }
  }
  /// Delivers once, whichever of the donation and the deadline comes first.
  private func finish(_ content: UNNotificationContent) {
    let handler: ((UNNotificationContent) -> Void)? = lock.withLock {
      defer { deliver = nil }
      return deliver
    }
    handler?(content)
  }
}
