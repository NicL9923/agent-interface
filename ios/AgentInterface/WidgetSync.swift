import Foundation
import WidgetKit

extension WidgetSnapshot {
  /// What widgets and Apple Watch may show for this account: names, states, message previews, and
  /// pending approval IDs, never a sign-in token.
  init(bootstrap: Bootstrap, scope: String, at now: Date, pendingApprovals: [String: String] = [:]) {
    let favorites = Set(bootstrap.preferences.favorites)
    self.init(scope: scope, generatedAt: now, assistants: bootstrap.bots.map { bot in
      Assistant(
        id: bot.id, name: bot.name, activity: bot.activity.rawValue,
        lastMessage: bot.lastMessage.map { String($0.text.prefix(200)) },
        lastMessageAt: bot.lastMessage?.at.flatMap(ServerDate.parse),
        color: bot.avatar?.mode == .portrait ? nil : bot.avatar?.color, pinned: favorites.contains(bot.id),
        approvalId: bot.activity == .waiting ? pendingApprovals[bot.id] : nil)
    })
  }
}
extension AppStore {
  /// Called whenever bootstrap changes. Signing out removes the snapshot. A roster from the server's cache,
  /// while Hermes is down or after its roster read failed, keeps the last good snapshot whole, with its real
  /// age: that roster can be stale either way, so an assistant it leaves out may not have left. A connected
  /// roster replaces the snapshot with a newer `generatedAt`, which a background read that started earlier
  /// cannot overwrite. Spotlight, Siri's assistant names, Quick Actions, Apple Watch, and notification
  /// sender pictures follow it.
  func publishWidgetSnapshot(at now: Date = Date()) {
    let next: WidgetSnapshot?
    if let bootstrap {
      guard let scope else { return }
      if !bootstrap.connection.connected || rosterFromCache {
        // Only this account's snapshot is kept. Signing in as somebody else must clear the previous
        // person's names and previews even while Hermes is down.
        if WidgetSnapshotStore.read(from: widgetSnapshotURL)?.scope != scope {
          if WidgetSnapshotStore.write(nil, to: widgetSnapshotURL) { WidgetCenter.shared.reloadAllTimelines() }
          RoutineSnapshotStore.write(nil)
          WatchBridge.shared.sync(nil)
          QuickActions.sync(nil)
          syncSystemSearch(nil)
          syncSenderAvatars(nil)
        }
        clearOtherAccountPrefetch(bootstrap)
        return
      }
      var approvals: [String: String] = [:]
      if let open = conversation, let pending = open.approvals.first(where: { $0.status == "pending" }) {
        approvals[open.botId] = pending.id
      }
      next = WidgetSnapshot(bootstrap: bootstrap, scope: scope, at: now, pendingApprovals: approvals)
    } else {
      next = nil
    }
    if WidgetSnapshotStore.write(next, to: widgetSnapshotURL) { WidgetCenter.shared.reloadAllTimelines() }
    if next == nil { RoutineSnapshotStore.write(nil) }
    WatchBridge.shared.sync(next)
    QuickActions.sync(next == nil ? nil : bootstrap)
    syncSystemSearch(next)
    syncSenderAvatars(next == nil ? nil : bootstrap)
    syncNotificationPrefetch(next == nil ? nil : bootstrap)
    if let next {
      for assistant in next.assistants where assistant.needsAttention {
        let dedup = assistant.approvalId ?? assistant.lastMessage ?? assistant.activity
        let reason = assistant.activity == "waiting" ? "Needs your approval" : "Needs your input"
        Task {
          await CriticalAlarmManager.shared.escalateWaitingIfOptedIn(
            botId: assistant.id,
            botName: assistant.name,
            reason: reason,
            dedupKey: dedup,
            scope: next.scope
          )
        }
      }
    }
  }
  /// Publishes non-secret routine metadata for Shortcuts (`TryOnceIntent`), Core Spotlight, and
  /// opt-in AlarmKit escalations.
  func publishRoutinesSnapshot(_ routines: [Routine]) {
    guard let scope, let bootstrap else { return }
    let names = Dictionary(bootstrap.bots.map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first })
    let items = routines.map {
      RoutineSnapshot.Item(id: $0.id, botId: $0.botId, botName: names[$0.botId] ?? "Assistant", name: $0.name, enabled: $0.enabled)
    }
    RoutineSnapshotStore.write(RoutineSnapshot(scope: scope, updatedAt: Date(), routines: items))
    if spotlight?.syncRoutines(routines, scope: scope) == true {
      WildBotsShortcuts.updateAppShortcutParameters()
    }
    for routine in routines {
      Task { await CriticalAlarmManager.shared.scheduleRoutineAlarmIfOptedIn(routine: routine, scope: scope) }
    }
  }
  private func syncSystemSearch(_ snapshot: WidgetSnapshot?) {
    if spotlight?.sync(snapshot) == true { WildBotsShortcuts.updateAppShortcutParameters() }
  }
}
