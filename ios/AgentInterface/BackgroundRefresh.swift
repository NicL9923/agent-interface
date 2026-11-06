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
  private static func read(at now: @MainActor () -> Date) async -> Bool {
    guard let api = client(), let token = api.token else { return false }
    do {
      let bootstrap: Bootstrap = try await api.get("/bootstrap?roster=lean")
      // An outage keeps the last good snapshot, as the open app does.
      guard bootstrap.connection.connected else { return false }
      // Signed out or into another account while this read was out: it is not theirs to show.
      guard let current = client(), current.baseURL == api.baseURL, current.token == token else { return false }
      let snapshot = WidgetSnapshot(bootstrap: bootstrap, scope: AppStore.scope(server: api.baseURL, userId: bootstrap.user.id), at: now())
      if WidgetSnapshotStore.write(snapshot, to: snapshotURL) { WidgetCenter.shared.reloadAllTimelines() }
      return true
    } catch { return false }
  }

  /// Registers the refresh task. iOS requires this before launch finishes.
  nonisolated static func register() {
    BGTaskScheduler.shared.register(forTaskWithIdentifier: taskIdentifier, using: .main) { task in
      let box = SentTask(task)
      MainActor.assumeIsolated {
        schedule()
        let work = Task { @MainActor in box.task.setTaskCompleted(success: await refreshWidgets()) }
        box.task.expirationHandler = { work.cancel() }
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
private final class SentTask: @unchecked Sendable {
  let task: BGTask
  init(_ task: BGTask) { self.task = task }
}

/// Resumes a wait once, for whichever of two tasks finishes first.
@MainActor private final class FirstFinish {
  private var continuation: CheckedContinuation<Void, Never>?
  init(_ continuation: CheckedContinuation<Void, Never>) { self.continuation = continuation }
  func finish() { continuation?.resume(); continuation = nil }
}
