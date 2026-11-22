import Foundation
import WidgetKit

extension WidgetSnapshot {
  /// What widgets may show for this account: names, states and message previews, never a token.
  init(bootstrap: Bootstrap, scope: String, at now: Date) {
    let favorites = Set(bootstrap.preferences.favorites)
    self.init(scope: scope, generatedAt: now, assistants: bootstrap.bots.map { bot in
      Assistant(
        id: bot.id, name: bot.name, activity: bot.activity.rawValue,
        lastMessage: bot.lastMessage.map { String($0.text.prefix(200)) },
        lastMessageAt: bot.lastMessage?.at.flatMap(ServerDate.parse),
        color: bot.avatar?.mode == .portrait ? nil : bot.avatar?.color, pinned: favorites.contains(bot.id))
    })
  }
}
extension AppStore {
  /// Called whenever bootstrap changes. Signing out removes the snapshot. A roster from the server's cache,
  /// while Hermes is down or after its roster read failed, keeps the last good snapshot whole, with its real
  /// age: that roster can be stale either way, so an assistant it leaves out may not have left. A connected
  /// roster replaces the snapshot with a newer `generatedAt`, which a background read that started earlier
  /// cannot overwrite. Spotlight, Siri's assistant names and notification sender pictures follow it.
  func publishWidgetSnapshot(at now: Date = Date()) {
    let next: WidgetSnapshot?
    if let bootstrap {
      guard let scope else { return }
      if !bootstrap.connection.connected || rosterFromCache {
        // Only this account's snapshot is kept. Signing in as somebody else must clear the previous
        // person's names and previews even while Hermes is down.
        if WidgetSnapshotStore.read(from: widgetSnapshotURL)?.scope != scope {
          if WidgetSnapshotStore.write(nil, to: widgetSnapshotURL) { WidgetCenter.shared.reloadAllTimelines() }
          syncSystemSearch(nil)
          syncSenderAvatars(nil)
        }
        clearOtherAccountPrefetch(bootstrap)
        return
      }
      next = WidgetSnapshot(bootstrap: bootstrap, scope: scope, at: now)
    } else {
      next = nil
    }
    if WidgetSnapshotStore.write(next, to: widgetSnapshotURL) { WidgetCenter.shared.reloadAllTimelines() }
    syncSystemSearch(next)
    syncSenderAvatars(next == nil ? nil : bootstrap)
    syncNotificationPrefetch(next == nil ? nil : bootstrap)
  }
  private func syncSystemSearch(_ snapshot: WidgetSnapshot?) {
    if spotlight?.sync(snapshot) == true { WildBotsShortcuts.updateAppShortcutParameters() }
  }
}
