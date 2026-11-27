import Foundation
import Observation
import WatchConnectivity
import WidgetKit

/// Manages WatchConnectivity state on Apple Watch. Stores only the non-secret `WidgetSnapshot`
/// in the shared App Group so Smart Stack / Complication widgets stay in sync, and wipes it
/// immediately when the paired iPhone signs out or switches accounts.
@MainActor @Observable final class WatchSessionManager: NSObject {
  static let shared = WatchSessionManager()

  private(set) var snapshot: WidgetSnapshot?
  private(set) var reachable = false
  private(set) var busy = false
  var statusMessage: String?

  @ObservationIgnored private var started = false
  @ObservationIgnored var snapshotURL: URL? = WidgetSnapshotStore.defaultURL

  override init() {
    super.init()
    snapshot = WidgetSnapshotStore.read(from: snapshotURL)
  }

  func start() {
    guard !started else { return }
    started = true
    guard WCSession.isSupported() else { return }
    let session = WCSession.default
    session.delegate = self
    session.activate()
    applyContext(session.receivedApplicationContext)
  }

  /// Applies an application context pushed from the paired iPhone. Sign-out immediately clears
  /// the watch snapshot and reloads watch complications/widgets.
  func applyContext(_ context: [String: Any]) {
    apply(
      signedOut: context[WatchPayload.signedOutKey] as? Bool == true,
      snapshotData: context[WatchPayload.snapshotKey] as? Data
    )
  }

  func apply(signedOut: Bool, snapshotData: Data?) {
    if signedOut {
      replaceSnapshot(nil)
      return
    }
    if let snapshotData,
      let decoded = try? JSONDecoder().decode(WidgetSnapshot.self, from: snapshotData)
    {
      replaceSnapshot(decoded)
    }
  }

  private func replaceSnapshot(_ next: WidgetSnapshot?) {
    if snapshot != next { snapshot = next }
    if WidgetSnapshotStore.write(next, to: snapshotURL) {
      WidgetCenter.shared.reloadAllTimelines()
    }
  }

  func stop(_ assistant: WidgetSnapshot.Assistant) {
    guard let scope = snapshot?.scope else { return }
    send(WatchAction(scope: scope, kind: .stop(botId: assistant.id, name: assistant.name)), fallbackNotice: "Stop queued for iPhone.")
  }

  func decline(_ assistant: WidgetSnapshot.Assistant, approvalId: String) {
    guard let scope = snapshot?.scope else { return }
    send(WatchAction(scope: scope, kind: .decline(botId: assistant.id, name: assistant.name, approvalId: approvalId)), fallbackNotice: "Decline queued for iPhone.")
  }

  func review(_ assistant: WidgetSnapshot.Assistant) {
    guard let scope = snapshot?.scope else { return }
    send(WatchAction(scope: scope, kind: .review(botId: assistant.id)), fallbackNotice: "Open WildBots on iPhone to review.")
  }

  func queueDraft(to assistant: WidgetSnapshot.Assistant, text: String) {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, let scope = snapshot?.scope else { return }
    send(WatchAction(scope: scope, kind: .queueDraft(botId: assistant.id, text: trimmed)), fallbackNotice: "Draft queued for iPhone.")
  }

  func refresh() {
    guard let scope = snapshot?.scope else { return }
    send(WatchAction(scope: scope, kind: .refresh), fallbackNotice: "Waiting for iPhone…")
  }

  private func send(_ action: WatchAction, fallbackNotice: String) {
    guard WCSession.isSupported(), let data = try? JSONEncoder().encode(action) else { return }
    let session = WCSession.default
    let payload: [String: Any] = [WatchPayload.actionKey: data]
    busy = true
    statusMessage = nil
    if session.isReachable {
      session.sendMessage(payload, replyHandler: { reply in
        let ok = reply["ok"] as? Bool ?? false
        let message = (reply["message"] as? String) ?? (reply["error"] as? String)
        let snapData = reply[WatchPayload.snapshotKey] as? Data
        Task { @MainActor [weak self] in
          guard let self else { return }
          self.busy = false
          if let snapData, let decoded = try? JSONDecoder().decode(WidgetSnapshot.self, from: snapData) {
            self.replaceSnapshot(decoded)
          }
          self.statusMessage = message ?? (ok ? "Sent to iPhone." : "Could not reach WildBots on iPhone.")
        }
      }, errorHandler: { _ in
        Task { @MainActor [weak self] in
          guard let self else { return }
          WCSession.default.transferUserInfo([WatchPayload.actionKey: data])
          self.busy = false
          self.statusMessage = fallbackNotice
        }
      })
    } else {
      session.transferUserInfo(payload)
      busy = false
      statusMessage = fallbackNotice
    }
  }
}

extension WatchSessionManager: WCSessionDelegate {
  nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
    let isReachable = session.isReachable
    let raw = session.receivedApplicationContext
    let signedOut = raw[WatchPayload.signedOutKey] as? Bool == true
    let snapshotData = raw[WatchPayload.snapshotKey] as? Data
    Task { @MainActor [weak self] in
      self?.reachable = isReachable
      self?.apply(signedOut: signedOut, snapshotData: snapshotData)
    }
  }

  nonisolated func sessionReachabilityDidChange(_ session: WCSession) {
    let isReachable = session.isReachable
    Task { @MainActor [weak self] in
      self?.reachable = isReachable
    }
  }

  nonisolated func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
    let signedOut = applicationContext[WatchPayload.signedOutKey] as? Bool == true
    let snapshotData = applicationContext[WatchPayload.snapshotKey] as? Data
    Task { @MainActor [weak self] in
      self?.apply(signedOut: signedOut, snapshotData: snapshotData)
    }
  }
}
