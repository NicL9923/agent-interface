import Foundation
import WatchConnectivity

/// Injectable `WCSession` transport so unit tests verify Watch snapshot sync, sign-out clearing,
/// scope enforcement, and action handling without needing a paired Watch simulator.
@MainActor protocol WatchTransport: AnyObject {
  var isSupported: Bool { get }
  func activate(delegate: @escaping @MainActor ([String: Any]) async -> [String: Any])
  func updateApplicationContext(_ context: [String: Any])
}

@MainActor final class SystemWatchTransport: NSObject, WatchTransport, WCSessionDelegate {
  private var onMessage: (@MainActor ([String: Any]) async -> [String: Any])?

  var isSupported: Bool { WCSession.isSupported() }

  func activate(delegate: @escaping @MainActor ([String: Any]) async -> [String: Any]) {
    onMessage = delegate
    guard WCSession.isSupported() else { return }
    let session = WCSession.default
    session.delegate = self
    session.activate()
  }

  func updateApplicationContext(_ context: [String: Any]) {
    guard WCSession.isSupported() else { return }
    let session = WCSession.default
    guard session.activationState == .activated, session.isPaired, session.isWatchAppInstalled else { return }
    try? session.updateApplicationContext(context)
  }

  nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {}
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
/// - Immediately clears Watch state on sign-out or account change.
/// - Verifies `action.scope == signedInScope` on every incoming Watch command.
@MainActor final class WatchBridge {
  static let shared = WatchBridge()

  weak var store: AppStore?
  var transport: WatchTransport
  /// Injectable handlers for unit testing without hitting real system services.
  var actHandler: @MainActor (ActivityAction) async -> Void = { await NotificationController.shared.act($0) }
  var openHandler: @MainActor (URL) async -> Void = { await NotificationController.shared.open($0) }
  var refreshHandler: @MainActor () async -> WidgetSnapshot? = {
    await BackgroundRefresh.refreshWidgets()
    return WidgetSnapshotStore.read()
  }
  var savedScope: @MainActor () -> String? = { UserDefaults.standard.string(forKey: DeviceDefaults.signedInScope) }

  init(transport: WatchTransport = SystemWatchTransport()) {
    self.transport = transport
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
    guard transport.isSupported else { return }
    if let snapshot, let data = try? JSONEncoder().encode(snapshot) {
      transport.updateApplicationContext([WatchPayload.snapshotKey: data, WatchPayload.signedOutKey: false])
    } else {
      transport.updateApplicationContext([WatchPayload.signedOutKey: true])
    }
  }

  func handle(rawMessage: [String: Any]) async -> [String: Any] {
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
    switch action.kind {
    case .stop(let botId, let name):
      await actHandler(ActivityAction(kind: .stop, botId: botId, scope: activeScope, name: name))
      return ["ok": true, "message": "Stop requested for \(name)."]

    case .decline(let botId, let name, let approvalId):
      await actHandler(ActivityAction(kind: .decline(approvalId: approvalId), botId: botId, scope: activeScope, name: name))
      return ["ok": true, "message": "Decline sent for \(name)."]

    case .review(let botId):
      await openHandler(DeepLink.bot(botId))
      return ["ok": true, "message": "Opening chat on iPhone."]

    case .queueDraft(let botId, let text):
      let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !trimmed.isEmpty else { return ["ok": false, "error": "Draft text is empty."] }
      guard trimmed.utf16.count <= AppStore.maxMessageLength else {
        return ["ok": false, "error": "Draft exceeds the 50,000 character limit."]
      }
      guard let store else {
        // Store isn't mounted yet; hand off as an Ask request (never auto-sent).
        NotificationController.shared.ask(AskRequest(botId: botId, text: trimmed, scope: activeScope, at: Date()))
        return ["ok": true, "message": "Draft queued for review on iPhone."]
      }
      guard store.knownBot(botId) != nil else {
        return ["ok": false, "error": "That assistant is no longer available."]
      }
      let held = store.hold(DraftAddition(source: .watch, botId: botId, text: trimmed, scope: activeScope, opens: false))
      return held
        ? ["ok": true, "message": "Draft queued for review on iPhone."]
        : ["ok": false, "error": "Account changed before the draft could be queued."]

    case .refresh:
      let latest = await refreshHandler()
      sync(latest)
      if let latest, let encoded = try? JSONEncoder().encode(latest) {
        return ["ok": true, WatchPayload.snapshotKey: encoded]
      }
      return ["ok": true]
    }
  }
}
