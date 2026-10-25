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
}

extension AppStore {
  /// The badge for the signed-in account, from what home shows. The open chat is never unread,
  /// and its own loaded state says whether a decision waits there.
  var badgeCount: Int {
    guard let bootstrap, !sessionExpired else { return 0 }
    return AppBadge.count(bots: bootstrap.bots, unread: unread) { bot in
      if bot.id == followedBotId, let conversation {
        return !(conversation.attention ?? []).isEmpty || conversation.approvals.contains { $0.status == "pending" }
      }
      return AppBadge.deciding(bot.activity)
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
