@preconcurrency import UserNotifications

/// Shows each assistant's notification as a message from that assistant, with its avatar, and
/// prefetches the latest conversation page into the App Group so opening the app shows the new
/// message immediately. Both run in parallel with a short timeout on the network fetch; if time
/// runs out or anything is missing, iOS still shows the decorated (or original) notification.
final class NotificationService: UNNotificationServiceExtension, @unchecked Sendable {
  private let lock = NSLock()
  private var deliver: ((UNNotificationContent) -> Void)?
  private var fallback: UNNotificationContent?
  private var work: Task<Void, Never>?

  override func didReceive(
    _ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    let original = request.content
    let target = NotificationPrefetchTarget(userInfo: original.userInfo)
    lock.withLock { deliver = contentHandler; fallback = original }
    let task = Task { [weak self] in
      async let decorated: UNNotificationContent = withCheckedContinuation { done in
        NotificationSenders.decorate(original) { content in done.resume(returning: content) }
      }
      async let prefetched: Bool = NotificationPrefetcher.prefetch(target: target)
      let content = await decorated
      self?.lock.withLock { self?.fallback = content }
      _ = await prefetched
      self?.finish(content)
    }
    lock.withLock { work = task }
  }
  override func serviceExtensionTimeWillExpire() {
    let (task, content) = lock.withLock { (work, fallback) }
    task?.cancel()
    if let content { finish(content) }
  }
  /// Delivers once, whichever of the work and the deadline comes first.
  private func finish(_ content: UNNotificationContent) {
    let handler: ((UNNotificationContent) -> Void)? = lock.withLock {
      defer { deliver = nil; work = nil }
      return deliver
    }
    handler?(content)
  }
}
