import Foundation
import WidgetKit

extension WidgetSnapshot {
  /// What widgets and Apple Watch may show for this account: names, states, message previews,
  /// pending approval IDs, and active run IDs — never a sign-in token.
  init(
    bootstrap: Bootstrap,
    scope: String,
    at now: Date,
    pendingApprovals: [String: String] = [:],
    activeRuns: [String: String] = [:]
  ) {
    let favorites = Set(bootstrap.preferences.favorites)
    self.init(scope: scope, generatedAt: now, assistants: bootstrap.bots.map { bot in
      let working = bot.activity == .thinking || bot.activity == .working
      return Assistant(
        id: bot.id, name: bot.name, activity: bot.activity.rawValue,
        lastMessage: bot.lastMessage.map { String($0.text.prefix(200)) },
        lastMessageAt: bot.lastMessage?.at.flatMap(ServerDate.parse),
        color: bot.avatar?.mode == .portrait ? nil : bot.avatar?.color, pinned: favorites.contains(bot.id),
        approvalId: bot.activity == .waiting ? pendingApprovals[bot.id] : nil,
        runId: working ? activeRuns[bot.id] : nil)
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
    if let bootstrap, !sessionExpired, !signingIn {
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
      var approvals = LiveActivityController.shared.latestApprovals(for: scope)
      var runs: [String: String] = [:]
      for (cachedBotId, cached) in conversationCache {
        if let pending = cached.approvals.first(where: { $0.status == "pending" }) {
          approvals[cachedBotId] = pending.id
        }
        if let runId = cached.activity.runId, !runId.isEmpty {
          runs[cachedBotId] = runId
        }
      }
      if let open = conversation {
        if let pending = open.approvals.first(where: { $0.status == "pending" }) {
          approvals[open.botId] = pending.id
        }
        if let runId = open.activity.runId, !runId.isEmpty {
          runs[open.botId] = runId
        }
      }
      next = WidgetSnapshot(bootstrap: bootstrap, scope: scope, at: now, pendingApprovals: approvals, activeRuns: runs)
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
      let targetScope = next.scope
      let assistants = next.assistants
      let startEpoch = CriticalAlarmManager.shared.currentEpoch
      Task {
        guard self.scope == targetScope else { return }
        await CriticalAlarmManager.shared.escalateWaitingBatch(
          assistants,
          scope: targetScope,
          expectedEpoch: startEpoch
        )
      }
    }
  }
  /// Publishes non-secret routine metadata for Shortcuts (`TryOnceIntent`), Core Spotlight, and
  /// opt-in AlarmKit escalations.
  func publishRoutinesSnapshot(_ routines: [Routine]) {
    guard let scope = publishableScope, let bootstrap else { return }
    let names = Dictionary(bootstrap.bots.map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first })
    let items = routines.map {
      RoutineSnapshot.Item(id: $0.id, botId: $0.botId, botName: names[$0.botId] ?? "Assistant", name: $0.name, enabled: $0.enabled)
    }
    RoutineSnapshotStore.write(RoutineSnapshot(scope: scope, updatedAt: Date(), routines: items))
    if spotlight?.syncRoutines(routines, scope: scope) == true {
      WildBotsShortcuts.updateAppShortcutParameters()
    }
    let targetScope = scope
    let startEpoch = CriticalAlarmManager.shared.currentEpoch
    Task {
      guard self.publishableScope == targetScope else { return }
      await CriticalAlarmManager.shared.reconcile(
        routines: routines,
        scope: targetScope,
        expectedEpoch: startEpoch
      )
    }
  }
  /// Publishes saved-item titles to Core Spotlight only when the request's scope and credential
  /// are still active (never after sign-out or session expiry).
  func publishSavedSpotlight(_ items: [SavedItem], expectedScope: String?, expectedToken: String?) {
    guard let activeScope = publishableScope,
      activeScope == expectedScope,
      api?.token == expectedToken
    else { return }
    spotlight?.syncSaved(items, scope: activeScope)
  }
  /// Refreshes account routines on foreground/launch when opt-in AlarmKit escalation is enabled so
  /// recurring or paused/deleted routines reconcile without requiring the user to open Routine settings.
  func refreshRoutinesForAlarms() async {
    guard let scope = publishableScope, let api, supports(.routines), CriticalAlarmManager.shared.isEnabled(for: scope) else { return }
    let startScope = scope
    let startedToken = api.token
    guard let routines: [Routine] = try? await api.get("/routines"),
      self.publishableScope == startScope, self.api === api, api.token == startedToken
    else { return }
    publishRoutinesSnapshot(routines)
  }
  private func syncSystemSearch(_ snapshot: WidgetSnapshot?) {
    if spotlight?.sync(snapshot) == true { WildBotsShortcuts.updateAppShortcutParameters() }
  }
}
