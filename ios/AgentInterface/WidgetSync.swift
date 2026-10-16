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
        color: bot.avatar?.mode == "portrait" ? nil : bot.avatar?.color, pinned: favorites.contains(bot.id))
    })
  }
}
extension AppStore {
  /// Called whenever bootstrap changes. Signing out removes the snapshot; an outage keeps the
  /// last good one so widgets show its real age instead of refreshing stale states.
  func publishWidgetSnapshot(at now: Date = Date()) {
    let next: WidgetSnapshot?
    if let bootstrap {
      guard let scope else { return }
      if !bootstrap.connection.connected {
        // An outage preserves only this account's snapshot. Signing in as somebody else
        // must clear the previous person's names and previews even while Hermes is down.
        if WidgetSnapshotStore.read(from: widgetSnapshotURL)?.scope != scope,
          WidgetSnapshotStore.write(nil, to: widgetSnapshotURL) { WidgetCenter.shared.reloadAllTimelines() }
        return
      }
      next = WidgetSnapshot(bootstrap: bootstrap, scope: scope, at: now)
    } else {
      next = nil
    }
    if WidgetSnapshotStore.write(next, to: widgetSnapshotURL) { WidgetCenter.shared.reloadAllTimelines() }
  }
}
