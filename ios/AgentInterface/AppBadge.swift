import SwiftUI
import UserNotifications

/// The app icon's number, the same count the server sends with pushes: assistants home marks
/// unread, plus assistants waiting on a decision (an approval, question or secure request) that
/// are not unread already. Each assistant counts once.
enum AppBadge {
  static func count(bots: [Bot], unread: (Bot) -> Bool, deciding: (Bot) -> Bool) -> Int {
    bots.filter { unread($0) || deciding($0) }.count
  }
  /// Whether an assistant's roster state is a decision this person has to make.
  static func deciding(_ state: ActivityState) -> Bool { state == .waiting || state == .blocked }
  /// The badge a read-elsewhere clear push carries. A background push's `aps` may hold only
  /// `content-available`, so the server puts the count in a top-level `badge` beside it.
  static func cleared(_ userInfo: [AnyHashable: Any]) -> Int? {
    guard let value = userInfo["badge"] as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(), value.intValue >= 0,
      Double(value.intValue) == value.doubleValue
    else { return nil }
    return value.intValue
  }
}

extension AppStore {
  /// The badge for the signed-in account while the app is open, from what home shows: the server's
  /// rule (`src/server/badge.ts`) on the roster, plus the open chat's loaded questions and pending
  /// approvals. The server also counts approvals it notified about that are still unresolved while
  /// the roster shows the assistant idle; the app cannot see those, so its pushes can count one more.
  /// The open chat is never unread.
  var badgeCount: Int {
    guard let bootstrap, !sessionExpired else { return 0 }
    return AppBadge.count(bots: bootstrap.bots, unread: unread) { bot in
      if AppBadge.deciding(bot.activity) { return true }
      guard bot.id == followedBotId, let conversation else { return false }
      return !(conversation.attention ?? []).isEmpty || conversation.approvals.contains { $0.status == "pending" }
    }
  }
}

/// Keeps the app icon's badge on the local count while the app is open and as it goes to the
/// background; APNs keeps it current while the app is closed. A view of its own, so the open
/// conversation's changes render only it.
struct AppBadgeSync: View {
  @Environment(AppStore.self) private var store
  @Environment(\.scenePhase) private var scenePhase
  var body: some View {
    Color.clear.frame(width: 0, height: 0).accessibilityHidden(true)
      .onChange(of: store.badgeCount, initial: true) { _, count in if scenePhase == .active { set(count) } }
      .onChange(of: scenePhase) { _, _ in set(store.badgeCount) }
  }
  private func set(_ count: Int) {
    // Unit tests run inside the app; they leave the real badge alone.
    guard ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] == nil else { return }
    UNUserNotificationCenter.current().setBadgeCount(count) { _ in }
  }
}
