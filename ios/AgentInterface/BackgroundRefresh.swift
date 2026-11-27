import BackgroundTasks
import UIKit
import WidgetKit

/// Keeps the widgets' snapshot current while the app is closed. The server wakes the app with a
/// background push when what the widgets show changes, and iOS runs a refresh task now and then.
/// Either way the app reads the household with its own sign-in and rewrites the snapshot; the
/// widget extension still never holds a token. iOS decides when, and may skip both, so widgets keep
/// saying "Open WildBots to refresh" once the snapshot is 30 minutes old.
@MainActor enum BackgroundRefresh {
  nonisolated static let taskIdentifier = "dev.agentinterface.ios.widgets"
  /// The earliest iOS may run the next refresh task. It usually waits longer.
  static let interval: TimeInterval = 15 * 60
  /// The saved server and Keychain sign-in, as a notification action uses after a background launch.
  static var client: @MainActor () -> APIClient? = { NotificationController.shared.actionClient() }
  static var snapshotURL: URL? = WidgetSnapshotStore.defaultURL
  /// One read at a time: a push and the refresh task can arrive together.
  private static var running: Task<Bool, Never>?

  /// Whether a background push asks for this.
  nonisolated static func requested(by userInfo: [AnyHashable: Any]) -> Bool {
    (userInfo["refresh"] as? [String])?.contains("widgets") == true
  }

  /// Reads the household and rewrites the snapshot. Returns whether it read anything new enough to write.
  @discardableResult static func refreshWidgets(at now: @escaping @MainActor () -> Date = Date.init) async -> Bool {
    if let running { return await running.value }
    let task = Task { await read(at: now) }
    running = task
    defer { running = nil }
    return await task.value
  }
  /// Refreshes, waiting no longer than `patience`. A slower read carries on and writes when it finishes.
  static func refreshWidgets(waitingAtMost patience: Duration) async {
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      let first = FirstFinish(continuation)
      Task { @MainActor in await refreshWidgets(); first.finish() }
      Task { @MainActor in try? await Task.sleep(for: patience); first.finish() }
    }
  }
  /// Stops a read in flight, as when iOS ends the refresh task's time.
  static func cancel() { running?.cancel() }
  private static func read(at now: @MainActor () -> Date) async -> Bool {
    guard let api = client(), let token = api.token else { return false }
    // The roster is at least this old. A snapshot written since, such as by the app opening meanwhile,
    // is newer and stays.
    let started = now()
    let startEpoch = CriticalAlarmManager.shared.currentEpoch
    do {
      let bootstrap: Bootstrap = try await api.get("/bootstrap?roster=lean")
      // An outage, or a roster from the server's cache, keeps the last good snapshot, as the open app does:
      // a cached roster can be stale either way.
      guard !Task.isCancelled, !bootstrap.servedFromCache else { return false }
      // Signed out or into another account while this read was out: it is not theirs to show.
      guard let current = client(), current.baseURL == api.baseURL, current.token == token else { return false }
      let scope = AppStore.scope(server: api.baseURL, userId: bootstrap.user.id)
      let stored = WidgetSnapshotStore.read(from: snapshotURL)
      if let stored, stored.generatedAt > started { return false }
      // Carry forward known pending approval IDs for the same account scope from LiveActivityController
      // and the prior snapshot so background refresh never strips Decline metadata without making an
      // extra network round-trip. Never copy stale runIds across lean refreshes: run A may have ended
      // and run B started, so Stop is offered only when live activity confirms the current runId.
      var pendingApprovals = LiveActivityController.shared.latestApprovals(for: scope)
      if let stored, stored.scope == scope {
        for prev in stored.assistants {
          if prev.activity == "waiting", let ap = prev.approvalId, !ap.isEmpty, pendingApprovals[prev.id] == nil {
            pendingApprovals[prev.id] = ap
          }
        }
      }
      let snapshot = WidgetSnapshot(
        bootstrap: bootstrap,
        scope: scope,
        at: started,
        pendingApprovals: pendingApprovals
      )
      if WidgetSnapshotStore.write(snapshot, to: snapshotURL) { WidgetCenter.shared.reloadAllTimelines() }
      WatchBridge.shared.sync(snapshot)
      await CriticalAlarmManager.shared.escalateWaitingBatch(
        snapshot.assistants,
        scope: snapshot.scope,
        expectedEpoch: startEpoch
      )
      return true
    } catch {
      // Explicit server session rejection must clear the rejected token and cross-process previews
      // immediately so a cold Watch refresh or widget timeline never replays expired household data.
      if (error as? APIError)?.isSessionExpired == true,
        let current = client(), current.baseURL == api.baseURL, current.token == token
      {
        try? SecureToken.save(nil, host: api.baseURL.absoluteString)
        api.token = nil
        current.token = nil
        if WidgetSnapshotStore.write(nil, to: snapshotURL) { WidgetCenter.shared.reloadAllTimelines() }
        RoutineSnapshotStore.write(nil)
        WatchBridge.shared.sync(nil)
        CriticalAlarmManager.shared.cancelAll()
        if let store = WatchBridge.shared.store, store.api?.baseURL == api.baseURL, store.api?.token == token {
          store.report(error)
        }
      }
      return false
    }
  }

  /// Registers the refresh task. iOS requires this before launch finishes.
  nonisolated static func register() {
    BGTaskScheduler.shared.register(forTaskWithIdentifier: taskIdentifier, using: .main) { task in
      let box = SentTask(task)
      MainActor.assumeIsolated {
        schedule()
        let work = Task { @MainActor in box.complete(await refreshWidgets()) }
        // Out of time: the read stops and the task ends unsuccessfully, once, right away.
        box.task.expirationHandler = { @Sendable in
          Task { @MainActor in work.cancel(); cancel(); box.complete(false) }
        }
      }
    }
  }
  /// Asks for the next refresh, as the app leaves the screen and after each run.
  static func schedule() {
    let request = BGAppRefreshTaskRequest(identifier: taskIdentifier)
    request.earliestBeginDate = Date(timeIntervalSinceNow: interval)
    // Refused in the simulator and when Background App Refresh is off; the push still works.
    try? BGTaskScheduler.shared.submit(request)
  }
}

/// A refresh task handed to the main actor; iOS calls the launch handler on the main queue asked for.
/// It is completed once, by whichever of the read and the expiration comes first.
private final class SentTask: @unchecked Sendable {
  let task: BGTask
  @MainActor private var completed = false
  init(_ task: BGTask) { self.task = task }
  @MainActor func complete(_ success: Bool) {
    guard !completed else { return }
    completed = true
    task.setTaskCompleted(success: success)
  }
}

/// Resumes a wait once, for whichever of two tasks finishes first.
@MainActor private final class FirstFinish {
  private var continuation: CheckedContinuation<Void, Never>?
  init(_ continuation: CheckedContinuation<Void, Never>) { self.continuation = continuation }
  func finish() { continuation?.resume(); continuation = nil }
}
