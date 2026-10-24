// ActivityKit's Activity predates Sendable annotations; its update and end are safe from any task.
@preconcurrency import ActivityKit
import Foundation

struct LiveActivityStatus: Decodable {
  var available: Bool
  var state: AssistantActivityState
}
struct LiveActivityRegistration: Encodable {
  var deviceId: String
  var token: String
  var botIds: [String]
  /// Sent only from a background launch, before the account has loaded; the server checks it is this sign-in's.
  var scope: String?
}
struct LiveActivityStartRegistration: Encodable {
  var deviceId: String
  var token: String
  var scope: String
}

/// Starts, feeds and ends the one aggregate Live Activity. Everything here is best effort: a
/// failure never interrupts the conversation, it only leaves the activity to its stale date.
@MainActor final class LiveActivityController {
  static let shared = LiveActivityController()
  typealias Live = ActivityKit.Activity<AssistantsActivityAttributes>
  weak var store: AppStore?
  /// Assistants just sent to, and when, whose `starting` grace the server has not been asked
  /// for yet, because the push token can arrive after the send. Like the server's grace, a
  /// send counts for two minutes.
  private var unregisteredSends: [String: Date] = [:]
  private var unregisteredBotIds: [String] {
    unregisteredSends.filter { Date().timeIntervalSince($0.value) < 120 }.sorted { $0.value < $1.value }.suffix(10).map(\.key)
  }
  /// The server's state plus local `starting` rows for sends it has not heard about yet.
  private func seeded(_ state: AssistantActivityState) -> AssistantActivityState {
    unregisteredBotIds.reduce(state) { state, botId in
      let bot = store?.bootstrap?.bots.first { $0.id == botId }
      return state.seeded(
        botId: botId, name: bot?.name ?? botId, color: bot?.avatar?.mode == .portrait ? nil : bot?.avatar?.color,
        at: unregisteredSends[botId] ?? Date())
    }
  }
  /// The activity whose token the server holds, so ending an extra one does not unregister it.
  private var registeredActivityId: String?
  private var registeredToken: String?
  private var observed: Set<String> = []
  private var foregroundTask: Task<Void, Never>?
  private var watchingSystem = false
  /// The device's push-to-start token, which lets the server start the activity when work begins
  /// somewhere else, and the account it was last registered for.
  private var startToken: String?
  private var registeredStart: (scope: String, token: String)?
  /// How often a foreground app refreshes its own activity instead of waiting for a push.
  static let foregroundInterval: Duration = .seconds(15)
  static let staleAfter: TimeInterval = 15 * 60

  /// An offline sign-out cannot revoke the old server session. A separate installation ID
  /// per account lets the next account register without taking over that old registration.
  static func deviceId(for scope: String) -> String {
    let key = "liveActivity.deviceId.\(scope)"
    if let value = UserDefaults.standard.string(forKey: key) { return value }
    let value = UUID().uuidString.lowercased()
    UserDefaults.standard.set(value, forKey: key)
    return value
  }
  private func statePath(scope: String) -> String {
    "/native/live-activity?deviceId=\(Self.deviceId(for: scope))"
  }

  /// The operating system owns the device preference, as it does notification permission.
  var enabled: Bool { store?.scope != nil }
  var systemAllowed: Bool { ActivityAuthorizationInfo().areActivitiesEnabled }
  private var running: [Live] { Live.activities.filter { $0.activityState == .active || $0.activityState == .stale } }
  private func content(_ state: AssistantActivityState) -> ActivityContent<AssistantActivityState> {
    ActivityContent(state: state, staleDate: Date().addingTimeInterval(Self.staleAfter))
  }

  /// From launch, including a background launch for an activity the server started: adopts every
  /// activity iOS creates and follows the push-to-start token. Push-to-start needs iOS 18, which
  /// wakes the app with the new activity's update token.
  func watchSystem() {
    guard !watchingSystem else { return }
    watchingSystem = true
    Task { [weak self] in
      for await activity in Live.activityUpdates {
        guard let self else { return }
        // A pushed start can land just after the app started its own; the newcomer goes.
        let others = self.running.filter { $0.id != activity.id }.map { (id: $0.id, scope: $0.attributes.scope) }
        if Self.isDuplicate(scope: activity.attributes.scope, among: others) {
          await activity.end(nil, dismissalPolicy: .immediate)
          continue
        }
        self.observe(activity)
        await self.register(activity)
      }
    }
    if #available(iOS 18.0, *) {
      Task { [weak self] in
        for await data in Live.pushToStartTokenUpdates {
          guard let self else { return }
          self.startToken = data.map { String(format: "%02x", $0) }.joined()
          await self.registerStartToken()
        }
      }
    }
  }

  /// One activity per account on a device: a new one is a duplicate when the account already has one.
  nonisolated static func isDuplicate(scope: String, among running: [(id: String, scope: String)]) -> Bool {
    running.contains { $0.scope == scope }
  }

  /// After a send the server accepted: show the assistant as starting right away.
  func sent(to botId: String) async {
    guard let store, let api = store.api, let scope = store.scope, enabled, systemAllowed else { return }
    unregisteredSends[botId] = Date()
    let token = api.token
    // A server that can start activities by push holds off while this app starts its own.
    let path = statePath(scope: scope) + (registeredStart?.scope == scope ? "&local=1" : "")
    guard let status: LiveActivityStatus = try? await api.get(path),
      token == api.token, scope == store.scope, status.available
    else { return }
    await show(seeded(status.state), scope: scope)
    startForegroundUpdates()
  }
  /// On every foreground: end what no longer belongs, refresh or start from the server's
  /// state, re-register the token, and keep refreshing while the app stays open.
  func foreground() async {
    guard let store, let api = store.api, let scope = store.scope else { return }
    guard enabled, systemAllowed else {
      if !enabled { await endAll(unregister: false) } else { await unregisterStartToken() }
      return
    }
    let token = api.token
    guard let status: LiveActivityStatus = try? await api.get(statePath(scope: scope)),
      token == api.token, scope == store.scope
    else { return }
    guard status.available else { await endAll(unregister: false); return }
    await registerStartToken()
    let state = seeded(status.state)
    if state.activeCount > 0 {
      await show(state, scope: scope)
      startForegroundUpdates()
    } else if let activity = keepOne(scope: scope) {
      // Finished while the app was away and the end push did not arrive.
      await activity.end(ActivityContent(state: status.state, staleDate: nil), dismissalPolicy: .after(Date().addingTimeInterval(5 * 60)))
    }
  }
  func background() {
    foregroundTask?.cancel()
    foregroundTask = nil
  }
  /// Sign-out and account changes. The server already drops the registration with the session.
  func endAll(unregister: Bool) async {
    background()
    unregisteredSends = [:]
    // The server drops the old account's start token with its session, or when the next account registers it.
    registeredStart = nil
    let activities = Live.activities
    let token = registeredToken
    registeredActivityId = nil
    registeredToken = nil
    if unregister, let token, let api = store?.api, let scope = store?.scope, api.token != nil {
      let _: EmptyResponse? = try? await api.write(
        "/native/live-activity", ["deviceId": Self.deviceId(for: scope), "token": token], method: "DELETE")
    }
    for activity in activities { await activity.end(nil, dismissalPolicy: .immediate) }
  }
  private func startForegroundUpdates() {
    foregroundTask?.cancel()
    foregroundTask = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(for: Self.foregroundInterval)
        guard let self, !Task.isCancelled, let store = self.store, let api = store.api, let scope = store.scope,
          let activity = self.running.first(where: { $0.attributes.scope == scope })
        else { return }
        let token = api.token
        guard let status: LiveActivityStatus = try? await api.get(self.statePath(scope: scope)),
          token == api.token, scope == store.scope, status.available, activity.activityState == .active || activity.activityState == .stale
        else { continue }
        let state = self.seeded(status.state)
        if state.activeCount > 0 {
          await activity.update(self.content(state))
        } else {
          // Ends the same way the server's end push does, in case that push never arrives.
          await activity.end(ActivityContent(state: state, staleDate: nil), dismissalPolicy: .after(Date().addingTimeInterval(5 * 60)))
          return
        }
      }
    }
  }
  /// One activity per device, for the signed-in account. Others end now.
  private func keepOne(scope: String) -> Live? {
    let candidates = running
    let kept = candidates.first { $0.attributes.scope == scope }
    for activity in candidates where activity.id != kept?.id {
      Task { await activity.end(nil, dismissalPolicy: .immediate) }
    }
    if let kept { observe(kept) }
    return kept
  }
  /// Updates the account's activity, or starts one. The check and the request run without a
  /// suspension point between them, so overlapping calls cannot start two.
  private func show(_ state: AssistantActivityState, scope: String) async {
    if let activity = keepOne(scope: scope) {
      await activity.update(content(state))
      await register(activity)
    } else {
      start(state, scope: scope)
    }
  }
  private func start(_ state: AssistantActivityState, scope: String) {
    let attributes = AssistantsActivityAttributes(scope: scope)
    let activity: Live
    do {
      activity = try Live.request(attributes: attributes, content: content(state), pushType: .token)
    } catch {
      // Without a push entitlement (unsigned simulator builds) the activity still follows the
      // foreground app and then goes stale honestly.
      guard let local = try? Live.request(attributes: attributes, content: content(state), pushType: nil) else { return }
      activity = local
    }
    observe(activity)
  }
  /// Registers each token as iOS provides it, and unregisters when the activity goes away.
  private func observe(_ activity: Live) {
    guard observed.insert(activity.id).inserted else { return }
    Task { [weak self] in
      for await data in activity.pushTokenUpdates {
        guard let self else { return }
        await self.register(activity, token: data)
      }
    }
    Task { [weak self] in
      for await state in activity.activityStateUpdates where state == .ended || state == .dismissed {
        guard let self else { return }
        self.observed.remove(activity.id)
        if self.registeredActivityId == activity.id {
          let token = self.registeredToken
          self.registeredActivityId = nil
          self.registeredToken = nil
          if let token, let api = self.store?.api, self.store?.scope == activity.attributes.scope, api.token != nil {
            let _: EmptyResponse? = try? await api.write(
              "/native/live-activity", ["deviceId": Self.deviceId(for: activity.attributes.scope), "token": token], method: "DELETE")
          }
        }
        return
      }
    }
  }
  /// The sign-in that registers an activity of `scope`. Woken in the background for an activity
  /// the server started, the store has no account yet, so the saved Keychain sign-in registers it
  /// and names the activity's scope for the server to check.
  private func client(for scope: String) -> (api: APIClient, background: Bool)? {
    if let store, let current = store.scope {
      guard current == scope, let api = store.api, api.token != nil else { return nil }
      return (api, false)
    }
    return backgroundClient().map { ($0, true) }
  }
  /// The same saved sign-in a notification action uses after a background launch.
  var backgroundClient: @MainActor () -> APIClient? = { NotificationController.shared.actionClient() }
  private func register(_ activity: Live, token: Data? = nil) async {
    let scope = activity.attributes.scope
    guard let data = token ?? activity.pushToken, let client = client(for: scope),
      activity.activityState == .active || activity.activityState == .stale
    else { return }
    let (api, background) = client
    let botIds = background ? [] : unregisteredBotIds
    let body = LiveActivityRegistration(
      deviceId: Self.deviceId(for: scope), token: data.map { String(format: "%02x", $0) }.joined(), botIds: botIds,
      scope: background ? scope : nil)
    do {
      let _: EmptyResponse = try await api.write("/native/live-activity", body, method: "PUT")
      guard store?.scope == nil || store?.scope == scope,
        activity.activityState == .active || activity.activityState == .stale
      else {
        let _: EmptyResponse? = try? await api.write(
          "/native/live-activity", ["deviceId": body.deviceId, "token": body.token], method: "DELETE")
        return
      }
      registeredActivityId = activity.id
      registeredToken = body.token
      for botId in botIds { unregisteredSends[botId] = nil }
    } catch let error as APIError where background && error.status == 400 {
      // The server started this activity for an account other than the one signed in here now.
      await activity.end(nil, dismissalPolicy: .immediate)
    } catch {}
  }
  /// Lets the server start this device's activity. Sent once per launch, account and token, so a
  /// server that lost the token learns it again the next time the app opens.
  private func registerStartToken() async {
    guard #available(iOS 18.0, *) else { return }
    // The stream may not repeat a token it already gave an earlier launch; ActivityKit keeps the current one.
    if startToken == nil, let current = Live.pushToStartToken { startToken = current.map { String(format: "%02x", $0) }.joined() }
    guard let token = startToken, let store, let api = store.api, api.token != nil, let scope = store.scope, systemAllowed
    else { return }
    if let registeredStart, registeredStart.scope == scope, registeredStart.token == token { return }
    let body = LiveActivityStartRegistration(deviceId: Self.deviceId(for: scope), token: token, scope: scope)
    do {
      let _: EmptyResponse = try await api.write("/native/live-activity/start", body, method: "PUT")
      if store.scope == scope, startToken == token { registeredStart = (scope, token) }
    } catch {}
  }
  /// Live Activities turned off in iOS Settings: the server stops trying to start them here.
  private func unregisterStartToken() async {
    guard let registered = registeredStart, let store, let api = store.api, api.token != nil, store.scope == registered.scope else { return }
    registeredStart = nil
    let _: EmptyResponse? = try? await api.write(
      "/native/live-activity/start", ["deviceId": Self.deviceId(for: registered.scope)], method: "DELETE")
  }
}
