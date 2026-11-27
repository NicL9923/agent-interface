import Foundation
import UIKit
import UserNotifications
import WatchConnectivity

/// Authoritative context queued for delivery to Apple Watch. Codable + `Sendable` so a pending
/// sign-out clear survives app termination before `WCSession` activates.
enum WatchContext: Codable, Equatable, Sendable {
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
  private static let pendingKey = "native.watch.pendingContext"
  private var onMessage: (@MainActor ([String: Any]) async -> [String: Any])?
  private let defaults: UserDefaults
  private let savedScope: @MainActor () -> String?
  private var pendingContext: WatchContext? {
    didSet { persistPendingContext() }
  }

  init(
    defaults: UserDefaults = .standard,
    savedScope: @escaping @MainActor () -> String? = { UserDefaults.standard.string(forKey: DeviceDefaults.signedInScope) }
  ) {
    self.defaults = defaults
    self.savedScope = savedScope
    super.init()
    if let data = defaults.data(forKey: Self.pendingKey),
      let decoded = try? JSONDecoder().decode(WatchContext.self, from: data)
    {
      self.pendingContext = decoded
    }
  }

  private func persistPendingContext() {
    if let pendingContext, let encoded = try? JSONEncoder().encode(pendingContext) {
      defaults.set(encoded, forKey: Self.pendingKey)
    } else {
      defaults.removeObject(forKey: Self.pendingKey)
    }
  }

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

  /// Resolves the context that should be pushed when `WCSession` activates: a persisted snapshot
  /// is replayed ONLY when its account scope still matches the current signed-in scope; otherwise
  /// any stale snapshot is replaced by an authoritative `.signedOut` clear.
  func authoritativeContextToFlush() -> WatchContext? {
    let currentScope = savedScope()
    if let pendingContext {
      switch pendingContext {
      case .signedOut:
        return .signedOut
      case .snapshot(let data):
        guard let currentScope,
          let snapshot = try? JSONDecoder().decode(WidgetSnapshot.self, from: data),
          snapshot.scope == currentScope
        else {
          self.pendingContext = .signedOut
          return .signedOut
        }
        return .snapshot(data)
      }
    }
    if currentScope == nil { return .signedOut }
    return nil
  }

  private func flushPendingContext(on session: WCSession) {
    guard let pending = authoritativeContextToFlush(),
      session.activationState == .activated,
      session.isPaired,
      session.isWatchAppInstalled
    else { return }
    do {
      try session.updateApplicationContext(pending.dictionary)
      pendingContext = nil
    } catch {
      // Retain pendingContext on disk so the next activation/watch-state change retries.
      pendingContext = pending
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
  /// Monotonic counter bumped ONLY on account boundaries (sign-out or switching to a different scope),
  /// NOT on same-scope refreshes, so `BackgroundRefresh.refreshWidgets()` calling `sync(latest)`
  /// never makes a Watch `.refresh` fail with "Account changed".
  private var accountEpoch: UInt64 = 0
  private var lastSyncedScope: String?
  /// In-flight non-refresh Watch actions keyed by `WatchAction.id`, so a `transferUserInfo` fallback
  /// arriving while the original `sendMessage` is still suspended joins the same result without running twice.
  private var inFlightActions: [UUID: Task<WatchActionReply, Never>] = [:]

  private struct WatchActionReply: Sendable {
    var ok: Bool
    var message: String
    var dictionary: [String: Any] {
      ok ? ["ok": true, "message": message] : ["ok": false, "error": message]
    }
  }

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
    if let snapshot {
      if let previous = lastSyncedScope, previous != snapshot.scope {
        accountEpoch &+= 1
      }
      lastSyncedScope = snapshot.scope
    } else {
      accountEpoch &+= 1
      lastSyncedScope = nil
    }
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
    if case .refresh = action.kind {
      // Seed `lastSyncedScope` on cold background launch so the refresh handler's own same-scope
      // `sync(latest)` does not bump `accountEpoch`, while any sign-out or switch to another scope
      // still bumps `accountEpoch` and invalidates this reply.
      if lastSyncedScope != activeScope {
        lastSyncedScope = activeScope
      }
      let startEpoch = accountEpoch
      let latest = await refreshHandler()
      // Reject stale refresh replies if sign-out or account change occurred while awaiting.
      let currentScope = store?.scope ?? savedScope()
      guard accountEpoch == startEpoch, currentScope == activeScope else {
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
    if let prior = previousOutcome(for: action.id, now: now) {
      return prior.ok
        ? ["ok": true, "message": prior.message]
        : ["ok": false, "error": prior.message]
    }
    if let running = inFlightActions[action.id] {
      return (await running.value).dictionary
    }
    let task = Task<WatchActionReply, Never> { @MainActor in
      await self.executeAction(action, activeScope: activeScope, now: now)
    }
    inFlightActions[action.id] = task
    let reply = await task.value
    inFlightActions.removeValue(forKey: action.id)
    return reply.dictionary
  }

  private func executeAction(_ action: WatchAction, activeScope: String, now: Date) async -> WatchActionReply {
    switch action.kind {
    case .stop(let botId, let name, let runId):
      guard !runId.isEmpty else {
        return WatchActionReply(ok: false, message: "Run details are unavailable. Refresh on Watch first.")
      }
      let result = await actHandler(ActivityAction(kind: .stop, botId: botId, scope: activeScope, name: name, runId: runId))
      recordOutcome(id: action.id, ok: result.ok, message: result.message, now: now)
      return WatchActionReply(ok: result.ok, message: result.message)

    case .decline(let botId, let name, let approvalId):
      let result = await actHandler(ActivityAction(kind: .decline(approvalId: approvalId), botId: botId, scope: activeScope, name: name))
      recordOutcome(id: action.id, ok: result.ok, message: result.message, now: now)
      return WatchActionReply(ok: result.ok, message: result.message)

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
      return WatchActionReply(ok: true, message: msg)

    case .queueDraft(let botId, let text):
      let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !trimmed.isEmpty else { return WatchActionReply(ok: false, message: "Draft text is empty.") }
      guard trimmed.utf16.count <= AppStore.maxMessageLength else {
        return WatchActionReply(ok: false, message: "Draft exceeds the 50,000 character limit.")
      }
      guard let store else {
        // Store isn't mounted yet; hand off as an Ask request (never auto-sent).
        NotificationController.shared.ask(AskRequest(botId: botId, text: trimmed, scope: activeScope, at: now))
        let msg = "Draft queued for review on iPhone."
        recordOutcome(id: action.id, ok: true, message: msg, now: now)
        return WatchActionReply(ok: true, message: msg)
      }
      guard store.knownBot(botId) != nil else {
        return WatchActionReply(ok: false, message: "That assistant is no longer available.")
      }
      let held = store.hold(DraftAddition(source: .watch, botId: botId, text: trimmed, scope: activeScope, opens: false))
      let msg = held ? "Draft queued for review on iPhone." : "Account changed before the draft could be queued."
      if held { recordOutcome(id: action.id, ok: true, message: msg, now: now) }
      return WatchActionReply(ok: held, message: msg)

    case .refresh:
      return WatchActionReply(ok: false, message: "Refresh is handled directly.")
    }
  }
}
