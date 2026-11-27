import Foundation
import UIKit
import UserNotifications
import WatchConnectivity

/// Authoritative context queued for delivery to Apple Watch. Typed as `Sendable` so it can be
/// retained across inactive `WCSession` states and replayed immediately on activation or install.
enum WatchContext: Equatable, Sendable {
  case signedOut
  case snapshot(Data)

  var dictionary: [String: Any] {
    switch self {
    case .signedOut:
      [WatchPayload.signedOutKey: true]
    case .snapshot(let data):
      [WatchPayload.snapshotKey: data, WatchPayload.signedOutKey: false]
    }
  }
}

/// Injectable `WCSession` transport so unit tests verify Watch snapshot sync, inactive-session
/// replay, sign-out clearing, scope enforcement, and action deduplication without a paired Watch.
@MainActor protocol WatchTransport: AnyObject {
  var isSupported: Bool { get }
  func activate(delegate: @escaping @MainActor ([String: Any]) async -> [String: Any])
  func updateApplicationContext(_ context: [String: Any])
}

@MainActor final class SystemWatchTransport: NSObject, WatchTransport, WCSessionDelegate {
  private var onMessage: (@MainActor ([String: Any]) async -> [String: Any])?
  private var pendingContext: WatchContext?

  var isSupported: Bool { WCSession.isSupported() }

  func activate(delegate: @escaping @MainActor ([String: Any]) async -> [String: Any]) {
    onMessage = delegate
    guard WCSession.isSupported() else { return }
    let session = WCSession.default
    session.delegate = self
    session.activate()
    flushPendingContext(on: session)
  }

  func updateApplicationContext(_ context: [String: Any]) {
    if context[WatchPayload.signedOutKey] as? Bool == true {
      pendingContext = .signedOut
    } else if let data = context[WatchPayload.snapshotKey] as? Data {
      pendingContext = .snapshot(data)
    }
    guard WCSession.isSupported() else { return }
    flushPendingContext(on: WCSession.default)
  }

  private func flushPendingContext(on session: WCSession) {
    guard let pending = pendingContext,
      session.activationState == .activated,
      session.isPaired,
      session.isWatchAppInstalled
    else { return }
    do {
      try session.updateApplicationContext(pending.dictionary)
      pendingContext = nil
    } catch {
      // Retain pendingContext so the next activation/watch-state change retries.
    }
  }

  nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
    Task { @MainActor [weak self] in
      self?.flushPendingContext(on: WCSession.default)
    }
  }
  nonisolated func sessionWatchStateDidChange(_ session: WCSession) {
    Task { @MainActor [weak self] in
      self?.flushPendingContext(on: WCSession.default)
    }
  }
  nonisolated func sessionDidBecomeInactive(_ session: WCSession) {}
  nonisolated func sessionDidDeactivate(_ session: WCSession) { session.activate() }

  nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any], replyHandler: @escaping ([String: Any]) -> Void) {
    let actionData = message[WatchPayload.actionKey] as? Data
    let reply = SentReply(replyHandler)
    Task { @MainActor [weak self] in
      let payload: [String: Any] = actionData.map { [WatchPayload.actionKey: $0] } ?? [:]
      let response = await self?.onMessage?(payload) ?? ["ok": false, "error": "WildBots is unavailable."]
      reply.send(response)
    }
  }

  nonisolated func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any]) {
    let actionData = userInfo[WatchPayload.actionKey] as? Data
    Task { @MainActor [weak self] in
      let payload: [String: Any] = actionData.map { [WatchPayload.actionKey: $0] } ?? [:]
      _ = await self?.onMessage?(payload)
    }
  }
}

/// Wraps WatchConnectivity's reply callback so it crosses safely to the main actor in Swift 6.
private final class SentReply: @unchecked Sendable {
  private let handler: ([String: Any]) -> Void
  init(_ handler: @escaping ([String: Any]) -> Void) { self.handler = handler }
  func send(_ response: [String: Any]) { handler(response) }
}

/// Bridges the iPhone app to the Apple Watch companion over `WatchConnectivity`.
/// Strict security boundaries:
/// - Never transmits sign-in tokens, Keychain credentials, or vault secrets to Watch.
/// - Sends only the non-secret `WidgetSnapshot` scoped to the active account.
/// - Immediately clears Watch state on sign-out or account change (and replays if session activates later).
/// - Verifies `action.scope == signedInScope` on every incoming Watch command.
/// - Deduplicates `WatchAction.id` across `sendMessage` and `transferUserInfo` fallbacks.
@MainActor final class WatchBridge {
  static let shared = WatchBridge()

  weak var store: AppStore?
  var transport: WatchTransport
  var defaults: UserDefaults
  /// Monotonic counter bumped on every `sync(_:)` so an in-flight refresh can never overwrite a sign-out.
  private var syncEpoch: UInt64 = 0

  /// Injectable handlers for unit testing without hitting real system services.
  var actHandler: @MainActor (ActivityAction) async -> ActivityActionResult = {
    await NotificationController.shared.performAction($0)
  }
  var openHandler: @MainActor (URL) async -> Void = { await NotificationController.shared.open($0) }
  var isForegroundActive: @MainActor () -> Bool = { UIApplication.shared.applicationState == .active }
  var notifyReview: @MainActor (String) async -> Void = { botId in
    let content = UNMutableNotificationContent()
    content.title = "Review in WildBots"
    content.body = "Tap to open the assistant chat on iPhone."
    content.sound = .default
    content.userInfo = ["url": "/?bot=\(APIClient.component(botId))"]
    let request = UNNotificationRequest(identifier: "watch-review-\(botId)", content: content, trigger: nil)
    try? await UNUserNotificationCenter.current().add(request)
  }
  var refreshHandler: @MainActor () async -> WidgetSnapshot? = {
    await BackgroundRefresh.refreshWidgets()
    return WidgetSnapshotStore.read()
  }
  var savedScope: @MainActor () -> String? = { UserDefaults.standard.string(forKey: DeviceDefaults.signedInScope) }

  private static let dedupKey = "native.watch.handledActions"
  private static let dedupTTL: TimeInterval = 15 * 60
  private static let dedupLimit = 128

  private struct HandledAction: Codable {
    var id: UUID
    var ok: Bool
    var message: String
    var at: Date
  }

  init(transport: WatchTransport = SystemWatchTransport(), defaults: UserDefaults = .standard) {
    self.transport = transport
    self.defaults = defaults
  }

  func start() {
    guard transport.isSupported else { return }
    transport.activate { [weak self] message in
      guard let self else { return ["ok": false, "error": "WildBots is unavailable."] }
      return await self.handle(rawMessage: message)
    }
  }

  /// Pushes the latest non-secret snapshot to Watch, or wipes Watch state when `snapshot` is nil.
  func sync(_ snapshot: WidgetSnapshot?) {
    syncEpoch &+= 1
    guard transport.isSupported else { return }
    if let snapshot, let data = try? JSONEncoder().encode(snapshot) {
      transport.updateApplicationContext([WatchPayload.snapshotKey: data, WatchPayload.signedOutKey: false])
    } else {
      transport.updateApplicationContext([WatchPayload.signedOutKey: true])
    }
  }

  private func previousOutcome(for actionId: UUID, now: Date) -> HandledAction? {
    guard let data = defaults.data(forKey: Self.dedupKey),
      let list = try? JSONDecoder().decode([HandledAction].self, from: data)
    else { return nil }
    return list.first { $0.id == actionId && now.timeIntervalSince($0.at) <= Self.dedupTTL }
  }

  private func recordOutcome(id: UUID, ok: Bool, message: String, now: Date) {
    var list: [HandledAction] = []
    if let data = defaults.data(forKey: Self.dedupKey),
      let decoded = try? JSONDecoder().decode([HandledAction].self, from: data)
    {
      list = decoded.filter { now.timeIntervalSince($0.at) <= Self.dedupTTL && $0.id != id }
    }
    list.append(HandledAction(id: id, ok: ok, message: message, at: now))
    if list.count > Self.dedupLimit {
      list = Array(list.suffix(Self.dedupLimit))
    }
    if let encoded = try? JSONEncoder().encode(list) {
      defaults.set(encoded, forKey: Self.dedupKey)
    }
  }

  func handle(rawMessage: [String: Any], now: Date = Date()) async -> [String: Any] {
    guard let data = rawMessage[WatchPayload.actionKey] as? Data,
      let action = try? JSONDecoder().decode(WatchAction.self, from: data)
    else {
      return ["ok": false, "error": "Unrecognized Watch request."]
    }
    let activeScope = store?.scope ?? savedScope()
    guard let activeScope, activeScope == action.scope else {
      sync(nil)
      return ["ok": false, "error": "Sign in to this account on iPhone first."]
    }
    if case .refresh = action.kind {} else if let prior = previousOutcome(for: action.id, now: now) {
      return prior.ok
        ? ["ok": true, "message": prior.message]
        : ["ok": false, "error": prior.message]
    }
    switch action.kind {
    case .stop(let botId, let name, let runId):
      guard !runId.isEmpty else {
        return ["ok": false, "error": "Run details are unavailable. Refresh on Watch first."]
      }
      let result = await actHandler(ActivityAction(kind: .stop, botId: botId, scope: activeScope, name: name, runId: runId))
      recordOutcome(id: action.id, ok: result.ok, message: result.message, now: now)
      return result.ok
        ? ["ok": true, "message": result.message]
        : ["ok": false, "error": result.message]

    case .decline(let botId, let name, let approvalId):
      let result = await actHandler(ActivityAction(kind: .decline(approvalId: approvalId), botId: botId, scope: activeScope, name: name))
      recordOutcome(id: action.id, ok: result.ok, message: result.message, now: now)
      return result.ok
        ? ["ok": true, "message": result.message]
        : ["ok": false, "error": result.message]

    case .review(let botId):
      await openHandler(DeepLink.bot(botId))
      let msg: String
      if isForegroundActive() {
        msg = "Opened on iPhone."
      } else {
        await notifyReview(botId)
        msg = "Open WildBots on iPhone to review."
      }
      recordOutcome(id: action.id, ok: true, message: msg, now: now)
      return ["ok": true, "message": msg]

    case .queueDraft(let botId, let text):
      let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !trimmed.isEmpty else { return ["ok": false, "error": "Draft text is empty."] }
      guard trimmed.utf16.count <= AppStore.maxMessageLength else {
        return ["ok": false, "error": "Draft exceeds the 50,000 character limit."]
      }
      guard let store else {
        // Store isn't mounted yet; hand off as an Ask request (never auto-sent).
        NotificationController.shared.ask(AskRequest(botId: botId, text: trimmed, scope: activeScope, at: now))
        let msg = "Draft queued for review on iPhone."
        recordOutcome(id: action.id, ok: true, message: msg, now: now)
        return ["ok": true, "message": msg]
      }
      guard store.knownBot(botId) != nil else {
        return ["ok": false, "error": "That assistant is no longer available."]
      }
      let held = store.hold(DraftAddition(source: .watch, botId: botId, text: trimmed, scope: activeScope, opens: false))
      let msg = held ? "Draft queued for review on iPhone." : "Account changed before the draft could be queued."
      if held { recordOutcome(id: action.id, ok: true, message: msg, now: now) }
      return held ? ["ok": true, "message": msg] : ["ok": false, "error": msg]

    case .refresh:
      let startEpoch = syncEpoch
      let latest = await refreshHandler()
      // Reject stale refresh replies if sign-out or account change occurred while awaiting.
      let currentScope = store?.scope ?? savedScope()
      guard syncEpoch == startEpoch, currentScope == activeScope else {
        return ["ok": false, "error": "Account changed while refreshing."]
      }
      guard let latest, latest.scope == activeScope else {
        sync(nil)
        return ["ok": false, "error": "Sign in to this account on iPhone first."]
      }
      sync(latest)
      if let encoded = try? JSONEncoder().encode(latest) {
        return ["ok": true, WatchPayload.snapshotKey: encoded]
      }
      return ["ok": true]
    }
  }
}
