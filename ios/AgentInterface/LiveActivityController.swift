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

/// The ActivityKit calls the device switch relies on, so tests can stand in for iOS.
struct LiveActivitySystem {
  struct Running: Equatable {
    var id: String
    var scope: String
    var token: String?
  }
  /// Whether iOS allows this app's Live Activities. The person can turn them off in iOS Settings.
  var allowed: @MainActor () -> Bool
  /// Every activity iOS has not ended or dismissed.
  var running: @MainActor () -> [Running]
  var end: @MainActor (_ id: String) async -> Void
  /// iOS 18's push-to-start token. Nil before iOS 18 or until iOS issues one.
  var startToken: @MainActor () -> String?

  static var live: LiveActivitySystem {
    LiveActivitySystem(
      allowed: { ActivityAuthorizationInfo().areActivitiesEnabled },
      running: {
        LiveActivityController.Live.activities.filter { $0.activityState != .ended && $0.activityState != .dismissed }
          .map { Running(id: $0.id, scope: $0.attributes.scope, token: $0.pushToken.map(LiveActivityController.hex)) }
      },
      end: { id in await LiveActivityController.Live.activities.first { $0.id == id }?.end(nil, dismissalPolicy: .immediate) },
      startToken: {
        guard #available(iOS 18.0, *) else { return nil }
        return LiveActivityController.Live.pushToStartToken.map(LiveActivityController.hex)
      })
  }
}

/// What the device switch shows. iOS Settings wins over the app's own switch.
enum LiveActivitySwitch: Equatable {
  case on, off, offInSettings
  init(turnedOn: Bool, systemAllowed: Bool) {
    self = !systemAllowed ? .offInSettings : turnedOn ? .on : .off
  }
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
  nonisolated static func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }

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

  var system = LiveActivitySystem.live
  var defaults = UserDefaults.standard
  /// The Settings switch for this device. It is not per account, so it holds through sign-out and
  /// sign-in, and a background launch reads it before any account loads. Unset means on, as
  /// before the switch existed.
  var turnedOn: Bool { defaults.object(forKey: DeviceDefaults.liveActivities) as? Bool ?? true }
  var enabled: Bool { store?.scope != nil && turnedOn }
  var systemAllowed: Bool { system.allowed() }
  /// The last change the switch is carrying out. Each waits for the one before, so a quick off
  /// and on reaches the server in that order.
  private var switching: Task<Void, Never>?
  /// The account whose push-to-start token the server confirmed it removed during this launch.
  private var startForgotten: String?
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
        // A pushed start can land just after the app started its own, for an account that has
        // since signed out here, or after the switch went off; each goes at once.
        let others = self.running.filter { $0.id != activity.id }.map { (id: $0.id, scope: $0.attributes.scope) }
        if Self.shouldEnd(scope: activity.attributes.scope, signedIn: self.signedInScope(), turnedOn: self.turnedOn, among: others) {
          await activity.end(nil, dismissalPolicy: .immediate)
          // The server has not heard the switch went off, so it is told again now.
          if !self.turnedOn { await self.forgetStartToken(scope: activity.attributes.scope) }
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
          self.startToken = Self.hex(data)
          await self.settle()
        }
      }
    }
  }

  /// One activity per device, for the signed-in account: a new one ends when the switch is off,
  /// when nobody or another account is signed in, or when this account already has one.
  nonisolated static func shouldEnd(scope: String, signedIn: String?, turnedOn: Bool, among running: [(id: String, scope: String)]) -> Bool {
    !turnedOn || signedIn != scope || running.contains { $0.scope == scope }
  }
  /// The loaded account, or before it loads, the account the saved sign-in belongs to. Nil when
  /// nobody is signed in, as after an offline sign-out the server never heard about.
  private func signedInScope() -> String? {
    if let scope = store?.scope { return scope }
    guard backgroundClient() != nil else { return nil }
    return savedScope()
  }
  var savedScope: () -> String? = { UserDefaults.standard.string(forKey: DeviceDefaults.signedInScope) }

  /// After a send the server accepted: show the assistant as starting right away.
  func sent(to botId: String) async {
    guard let store, let api = store.api, let scope = store.scope, enabled, systemAllowed else { return }
    unregisteredSends[botId] = Date()
    let token = api.token
    // A server that can start activities by push holds off while this app starts its own.
    let path = statePath(scope: scope) + (registeredStart?.scope == scope ? "&local=1" : "")
    guard let status: LiveActivityStatus = try? await api.get(path),
      token == api.token, scope == store.scope, !store.suspended, status.available
    else { return }
    await show(seeded(status.state), scope: scope)
    startForegroundUpdates()
  }
  /// On every foreground: end what no longer belongs, refresh or start from the server's
  /// state, re-register the token, and keep refreshing while the app stays open.
  func foreground() async {
    guard let store, let api = store.api, let scope = store.scope else { return }
    // Before any request, which can fail: another account's activity never stays on this Lock Screen.
    for activity in running where activity.attributes.scope != scope {
      Task { await activity.end(nil, dismissalPolicy: .immediate) }
    }
    guard turnedOn else { await settle(); return }
    guard systemAllowed else { await unregisterStartToken(); return }
    let token = api.token
    guard let status: LiveActivityStatus = try? await api.get(statePath(scope: scope)),
      token == api.token, scope == store.scope, !store.suspended
    else { return }
    guard status.available else { await endAll(unregister: false); return }
    let state = seeded(status.state)
    if state.activeCount > 0 {
      await show(state, scope: scope)
      startForegroundUpdates()
    } else if let activity = keepOne(scope: scope) {
      // Finished while the app was away and the end push did not arrive.
      await activity.end(ActivityContent(state: status.state, staleDate: nil), dismissalPolicy: .after(Date().addingTimeInterval(5 * 60)))
    }
    // Last, so its request never sits between checking the account and using its state.
    await settle()
  }
  /// The Settings switch. Off ends every activity here and asks the server to stop updating and
  /// starting them. On hands the server the start token again; the next send, or a foreground
  /// with work under way, starts the activity.
  func setTurnedOn(_ on: Bool) async {
    defaults.set(on, forKey: DeviceDefaults.liveActivities)
    await settle()
  }
  /// Carries out the switch's current value, after any earlier change finishes.
  private func settle() async {
    let previous = switching
    let task = Task { [weak self] in
      await previous?.value
      guard let self else { return }
      if self.turnedOn {
        self.startForgotten = nil
        await self.registerStartToken()
      } else {
        await self.turnOff()
      }
    }
    switching = task
    await task.value
  }
  /// Ends every activity here, then asks the server to forget both tokens. Each foreground while
  /// the switch is off repeats the requests the server has not confirmed, so a switch turned off
  /// without a connection still reaches it.
  private func turnOff() async {
    background()
    unregisteredSends = [:]
    let activities = system.running()
    let registered = registeredToken
    registeredActivityId = nil
    registeredToken = nil
    registeredStart = nil
    // Nothing waits on the network before the activities leave the Lock Screen.
    for activity in activities { await system.end(activity.id) }
    guard let scope = store?.scope, let api = store?.api, api.token != nil else { return }
    for token in Self.tokensToForget(registered: registered, running: activities, scope: scope) {
      let _: EmptyResponse? = try? await api.write(
        "/native/live-activity", ["deviceId": Self.deviceId(for: scope), "token": token], method: "DELETE")
    }
    await forgetStartToken(scope: scope)
  }
  /// The update tokens the server may hold for this account here: the one this launch registered,
  /// and those of its running activities, which an earlier launch may have registered.
  nonisolated static func tokensToForget(registered: String?, running: [LiveActivitySystem.Running], scope: String) -> [String] {
    var tokens: [String] = []
    for token in [registered] + running.filter({ $0.scope == scope }).map(\.token) {
      if let token, !tokens.contains(token) { tokens.append(token) }
    }
    return tokens
  }
  /// Stops the server starting activities here by push, once per account and launch.
  private func forgetStartToken(scope: String) async {
    guard startForgotten != scope, let api = client(for: scope)?.api else { return }
    do {
      let _: EmptyResponse = try await api.write(
        "/native/live-activity/start", ["deviceId": Self.deviceId(for: scope)], method: "DELETE")
      if !turnedOn { startForgotten = scope }
    } catch {}
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
    guard store?.suspended == false else { return }
    foregroundTask?.cancel()
    foregroundTask = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(for: Self.foregroundInterval)
        guard let self, !Task.isCancelled, self.turnedOn, let store = self.store, let api = store.api, let scope = store.scope,
          let activity = self.running.first(where: { $0.attributes.scope == scope })
        else { return }
        let token = api.token
        guard let status: LiveActivityStatus = try? await api.get(self.statePath(scope: scope)),
          token == api.token, scope == store.scope, !store.suspended, status.available, activity.activityState == .active || activity.activityState == .stale
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
    guard savedScope() == scope else { return nil }
    return backgroundClient().map { ($0, true) }
  }
  /// The same saved sign-in a notification action uses after a background launch.
  var backgroundClient: @MainActor () -> APIClient? = { NotificationController.shared.actionClient() }
  private func register(_ activity: Live, token: Data? = nil) async {
    let scope = activity.attributes.scope
    guard turnedOn, let data = token ?? activity.pushToken, let client = client(for: scope),
      activity.activityState == .active || activity.activityState == .stale
    else { return }
    let (api, background) = client
    let botIds = background ? [] : unregisteredBotIds
    let body = LiveActivityRegistration(
      deviceId: Self.deviceId(for: scope), token: Self.hex(data), botIds: botIds,
      scope: background ? scope : nil)
    do {
      let _: EmptyResponse = try await api.write("/native/live-activity", body, method: "PUT")
      guard turnedOn, store?.scope == nil || store?.scope == scope,
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
    // The stream may not repeat a token it already gave an earlier launch; ActivityKit keeps the current one.
    if startToken == nil { startToken = system.startToken() }
    guard turnedOn, let token = startToken, let store, let api = store.api, api.token != nil, let scope = store.scope, systemAllowed
    else { return }
    if let registeredStart, registeredStart.scope == scope, registeredStart.token == token { return }
    let body = LiveActivityStartRegistration(deviceId: Self.deviceId(for: scope), token: token, scope: scope)
    do {
      let _: EmptyResponse = try await api.write("/native/live-activity/start", body, method: "PUT")
      if store.scope == scope, startToken == token, turnedOn { registeredStart = (scope, token) }
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
