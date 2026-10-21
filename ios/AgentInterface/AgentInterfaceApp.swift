import CoreSpotlight
import SwiftUI
import UserNotifications

@main struct AgentInterfaceApp: App {
  @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
  @State private var store = AppStore()
  @Environment(\.scenePhase) private var scenePhase
  var body: some Scene {
    WindowGroup {
      RootView().appStore(store)
        .fontDesign(.rounded).tint(Palette.accent)
        .preferredColorScheme(
          store.bootstrap?.preferences.theme == "dark"
            ? .dark : store.bootstrap?.preferences.theme == "light" ? .light : nil
        )
        .task {
          NotificationController.shared.store = store
          LiveActivityController.shared.store = store
          #if DEBUG
            if await DebugFixtures.configure(store) { return }
          #endif
          await store.restore()
        }
        .onChange(of: scenePhase) { _, phase in
          if phase == .active {
            Task {
              await store.resume()
              await NotificationController.shared.synchronize()
              await LiveActivityController.shared.foreground()
            }
          } else {
            store.suspend()
            LiveActivityController.shared.background()
          }
        }
        .onChange(of: store.connected) { _, connected in
          if connected { Task { await NotificationController.shared.synchronize() } }
        }
        // Sign-out, another account or another server: the old account's activity ends, and
        // the new one starts from its own state.
        .onChange(of: store.scope) { old, new in
          store.deviceNotifications = DeviceNotificationState()
          Task {
            if old != nil { await LiveActivityController.shared.endAll(unregister: false) }
            if new != nil {
              await NotificationController.shared.synchronize()
              await LiveActivityController.shared.foreground()
            }
          }
        }
        // Widget and Live Activity taps. The sign-in callback never arrives here: the
        // authentication session receives it directly, and `DeepLink` ignores it anyway.
        .onOpenURL { url in Task { await NotificationController.shared.open(url) } }
        // A Spotlight result for an assistant opens its chat like a widget row.
        .onContinueUserActivity(CSSearchableItemActionType) { activity in
          guard let id = activity.userInfo?[CSSearchableItemActivityIdentifier] as? String else { return }
          Task { await NotificationController.shared.open(DeepLink.bot(id)) }
        }
    }
    .commands { AssistantCommands(store: store) }
  }
}
class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    UNUserNotificationCenter.current().delegate = self
    // Before any notification can be shown, so its actions are always there.
    UNUserNotificationCenter.current().setNotificationCategories(NotificationActions.categories)
    return true
  }
  func application(
    _ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
  ) {
    let token = deviceToken.map { String(format: "%02x", $0) }.joined()
    Task { @MainActor in
      NotificationController.shared.token = token
      await NotificationController.shared.synchronize()
    }
  }
  func application(
    _ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error
  ) {
    Task { @MainActor in
      NotificationController.shared.store?.deviceNotifications =
        .failed("Device registration failed: \(error.localizedDescription)")
    }
  }
  func userNotificationCenter(
    _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    let info = notification.request.content.userInfo
    let botId = NotificationController.chatBotId(info["url"] as? String), notice = info["decisionNotice"] != nil
    Task { @MainActor in
      // The chat on screen already shows this news. A decision that did not go through is not news it shows.
      let reading = !notice && botId != nil && botId == NotificationController.shared.store?.viewingBotId
      completionHandler(reading ? [] : [.banner, .sound, .badge])
    }
  }
  /// A silent push after the person read chats on another device or in the browser.
  func application(
    _ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable: Any],
    fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
  ) {
    let tags = (userInfo["clear"] as? [String: Any])?["tags"] as? [String] ?? []
    guard !tags.isEmpty else { completionHandler(.noData); return }
    Task { @MainActor in
      await NotificationController.shared.removeDelivered(tags: Set(tags))
      completionHandler(.newData)
    }
  }
  func userNotificationCenter(
    _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    let route = NotificationActions.route(action: response.actionIdentifier, userInfo: response.notification.request.content.userInfo,
      text: (response as? UNTextInputNotificationResponse)?.userText)
    Task { @MainActor in
      // Approve and Deny can run with the app in the background; this keeps it awake for the server's answer.
      let background = UIApplication.shared.beginBackgroundTask(withName: "Notification action")
      await NotificationController.shared.handle(route)
      if background != .invalid { UIApplication.shared.endBackgroundTask(background) }
      completionHandler()
    }
  }
}
@MainActor final class NotificationController {
  static let shared = NotificationController()
  weak var store: AppStore? { didSet { if let store, let earlyAsk { self.earlyAsk = nil; store.queueAsk(earlyAsk) } } }
  /// A Siri or Shortcuts question that arrived before the store was ready.
  var earlyAsk: AskRequest?
  var token: String?
  var pendingBotId: String?
  var pendingRoutineId: String?
  var pendingURL: String?
  /// Text typed into notifications' Reply, in arrival order, until a signed-in store can hold it for its draft.
  var pendingReplies: [NotificationReply] = []
  /// The sign-in a notification action uses. After a launch in the background just for the action, the
  /// store has not restored, so this falls back to the saved server address and the Keychain sign-in.
  var actionClient: @MainActor () -> APIClient? = {
    guard let host = UserDefaults.standard.string(forKey: "connection.host"), let url = try? ConnectionAddress.parse(host) else { return nil }
    let api = APIClient(baseURL: url)
    return api.token == nil ? nil : api
  }
  var deliverNotice: @MainActor (UNNotificationRequest) async -> Void = { try? await UNUserNotificationCenter.current().add($0) }
  /// Approvals being decided from a notification, so the same one is never sent twice at once.
  private var deciding: Set<String> = []
  private(set) var permissions: NotificationPermissions
  private(set) var register: @MainActor () -> Void
  private(set) var unregister: @MainActor () -> Void
  private var busy = false
  /// A sync asked for while Enable or Disable ran, such as after an account switch. It runs when they finish.
  private var syncAfterBusy = false
  private var synchronizing = false
  private var synchronizeAgain = false
  init(permissions: NotificationPermissions = .system,
    register: @escaping @MainActor () -> Void = { UIApplication.shared.registerForRemoteNotifications() },
    unregister: @escaping @MainActor () -> Void = { UIApplication.shared.unregisterForRemoteNotifications() }) {
    self.permissions = permissions; self.register = register; self.unregister = unregister
  }
  #if DEBUG
    /// UI tests stand in for iOS permission and APNs, which a simulator cannot grant.
    func useFixtureSystem(permissions: NotificationPermissions) {
      self.permissions = permissions
      register = {}
      unregister = {}
      token = String(repeating: "ab", count: 32)
    }
  #endif
  static func botId(from value: String, origin: URL) -> String? {
    guard value.hasPrefix("/"), !value.hasPrefix("//"),
      let url = URL(string: value, relativeTo: origin)?.absoluteURL, url.scheme == origin.scheme,
      url.host == origin.host, url.port == origin.port, url.path == "/",
      let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
    else { return nil }
    return components.queryItems?.first { $0.name == "bot" }?.value
  }
  /// The chat a notification belongs to. Digests and routine results open elsewhere, so they have none.
  nonisolated static func chatBotId(_ url: String?) -> String? {
    guard let url, let components = URLComponents(string: url), components.path == "/",
      components.queryItems?.contains(where: { $0.name == "routine" }) != true
    else { return nil }
    return components.queryItems?.first { $0.name == "bot" }?.value
  }
  /// Removes every delivered notification for chats opened here.
  func removeDelivered(bots: Set<String>) async {
    await removeDelivered { Self.chatBotId($0["url"] as? String).map(bots.contains) == true }
  }
  /// Removes the delivered notifications another device read. Newer ones for the same chat stay.
  func removeDelivered(tags: Set<String>) async {
    await removeDelivered { ($0["tag"] as? String).map(tags.contains) == true }
  }
  private func removeDelivered(where matches: ([AnyHashable: Any]) -> Bool) async {
    let center = UNUserNotificationCenter.current()
    let ids = await center.deliveredNotifications()
      .filter { matches($0.request.content.userInfo) }
      .map(\.request.identifier)
    if !ids.isEmpty { center.removeDeliveredNotifications(withIdentifiers: ids) }
  }
  var deviceId: String {
    if let value = UserDefaults.standard.string(forKey: "push.deviceId") { return value }
    let value = UUID().uuidString.lowercased()
    UserDefaults.standard.set(value, forKey: "push.deviceId")
    return value
  }
  /// Brings this device's registration in line with what the person chose and what iOS allows.
  /// It never asks iOS for permission: that happens only after Enable, from the in-app card or Settings.
  func synchronize() async {
    guard !synchronizing else { synchronizeAgain = true; return }
    synchronizing = true
    defer { synchronizing = false }
    repeat {
      synchronizeAgain = false
      await synchronizeDevice()
    } while synchronizeAgain
    await openPendingConversation()
  }
  /// Asks the person's account to act on this device only while the sign-in and account are the ones that began the work.
  @MainActor private struct Session {
    let store: AppStore, api: APIClient, scope: String, token: String?
    var current: Bool { store.api === api && api.token == token && store.scope == scope }
  }
  private func session() -> Session? {
    guard let store, let api = store.api, let scope = store.scope, api.token != nil, store.bootstrap != nil, !store.sessionExpired else { return nil }
    return Session(store: store, api: api, scope: scope, token: api.token)
  }
  private func isGranted(_ status: UNAuthorizationStatus) -> Bool { status == .authorized || status == .provisional || status == .ephemeral }
  private func synchronizeDevice() async {
    if busy { syncAfterBusy = true; return }
    guard let session = session() else { return }
    let store = session.store, api = session.api
    do {
      let status = await permissions.status()
      guard session.current else { return }
      if status == .denied {
        unregister()
        token = nil
        let _: EmptyResponse = try await api.write("/native/push/device", ["deviceId": deviceId], method: "DELETE")
        if session.current && !busy { store.deviceNotifications = .blocked }
        return
      }
      let config: PushConfig = try await api.get("/native/push/config")
      guard session.current, !busy else { return }
      guard config.available else { store.deviceNotifications = .unconfigured; return }
      let intent = NotificationIntent.read(store)
      if status == .notDetermined {
        store.deviceNotifications = .ready(prompt: intent == nil && !NotificationIntent.prompted(store))
        return
      }
      // Someone who allowed notifications before the switch existed keeps them until they turn them off.
      if intent == .off {
        // Removing again is harmless and clears a registration a failed cleanup left behind.
        let _: EmptyResponse = try await api.write("/native/push/device", ["deviceId": deviceId], method: "DELETE")
        guard session.current else { return }
        // Enable may have run while this removal was in flight; check again so its registration stands.
        if busy { syncAfterBusy = true } else if NotificationIntent.read(store) != .off { synchronizeAgain = true } else { store.deviceNotifications = .disabledByChoice }
        return
      }
      try await sendRegistration(with: session)
    } catch { if session.current && !busy { store.deviceNotifications = .failed(error.localizedDescription) } }
  }
  /// Sends this device's token to the server, or asks iOS for one first.
  private func sendRegistration(with session: Session) async throws {
    if let token {
      let _: EmptyResponse = try await session.api.write("/native/push/device", PushDevice(deviceId: deviceId, token: token), method: "PUT")
      guard session.current else { return }
      // Turned off while this registration was in flight: the server must end without it.
      if NotificationIntent.read(session.store) == .off {
        let _: EmptyResponse = try await session.api.write("/native/push/device", ["deviceId": deviceId], method: "DELETE")
        if session.current { session.store.deviceNotifications = .disabledByChoice }
        return
      }
      session.store.deviceNotifications = .enabledState
    } else {
      register()
      session.store.deviceNotifications = .registering
    }
  }
  /// The person tapped Enable, on the in-app card or the Settings switch. This is the only place iOS is asked for permission.
  func enable() async {
    guard !busy, let session = session(), session.store.deviceNotifications.canEnable else { return }
    let store = session.store
    busy = true
    NotificationIntent.rememberPrompt(store)
    store.deviceNotifications.busy = true
    store.deviceNotifications.error = nil
    defer { finishBusy(session) }
    do {
      var status = await permissions.status()
      guard session.current else { return }
      if status == .notDetermined {
        let allowed = try await permissions.request()
        guard session.current else { return }
        status = allowed ? .authorized : .denied
      }
      guard isGranted(status) else { store.deviceNotifications = .blocked; return }
      NotificationIntent.write(.on, store)
      try await sendRegistration(with: session)
      if session.current { store.deviceNotifications.prompt = false }
    } catch { if session.current { store.deviceNotifications.enabled = false; store.deviceNotifications.error = error.localizedDescription } }
  }
  /// Turns notifications off for this account on this device and removes the registration from the server.
  func disable() async {
    guard !busy, let session = session() else { return }
    let store = session.store
    busy = true
    store.deviceNotifications.busy = true
    store.deviceNotifications.error = nil
    defer { finishBusy(session) }
    let intent = NotificationIntent.key(store)
    NotificationIntent.write(.off, key: intent)
    do {
      let _: EmptyResponse = try await session.api.write("/native/push/device", ["deviceId": deviceId], method: "DELETE")
      guard session.current else { return }
      unregister()
      token = nil
      store.deviceNotifications = .disabledByChoice
    } catch {
      // The server may still deliver here, so the switch stays on and the check can be retried.
      NotificationIntent.write(.on, key: intent)
      if session.current { store.deviceNotifications.error = error.localizedDescription }
    }
  }
  private func finishBusy(_ session: Session) {
    busy = false
    if session.current { session.store.deviceNotifications.busy = false }
    if syncAfterBusy || !session.current {
      syncAfterBusy = false
      Task { await synchronize() }
    }
  }
  /// The person answered "Not now". The card does not return for this account on this device.
  func dismissPrompt() {
    guard let store else { return }
    NotificationIntent.rememberPrompt(store)
    store.deviceNotifications.prompt = false
  }
  func retry() async {
    guard let store, !busy else { return }
    store.deviceNotifications.checking = true
    store.deviceNotifications.error = nil
    await synchronize()
  }
  /// A notification tap or one of its actions.
  func handle(_ route: NotificationRoute) async {
    switch route {
    case .open(let url):
      guard let url else { return }
      pendingURL = url
      await openPendingConversation()
    case .decide(let decision): await decide(decision)
    case .reply(let reply):
      pendingReplies.append(reply)
      pendingURL = reply.url
      await openPendingConversation()
    case .none: return
    }
  }
  /// Approve or Deny from a notification, possibly with the app in the background. It is sent once; when it
  /// does not go through, a notification says so and opens the chat, where the approval card shows its state.
  func decide(_ decision: ApprovalDecision) async {
    guard deciding.insert(decision.approvalId).inserted else { return }
    defer { deciding.remove(decision.approvalId) }
    let api = store?.api.flatMap { $0.token != nil || $0.localCookieAuth ? $0 : nil } ?? actionClient()
    let outcome = await decision.send(with: api)
    if outcome == .decided {
      if let store, store.selectedBotId == decision.botId, store.api === api { await store.refreshConversation() }
    } else if let notice = decision.failureNotice(outcome) {
      await deliverNotice(notice)
    }
  }
  func openPendingConversation() async {
    // Held by the store before anything awaits, so a second reply arriving meanwhile queues behind this one.
    if let store, store.bootstrap != nil, !pendingReplies.isEmpty {
      let replies = pendingReplies
      pendingReplies = []
      for reply in replies { store.addNotificationReply(reply.text, botId: reply.botId, account: reply.account) }
    }
    if let pendingURL, let origin = store?.api?.baseURL, store?.bootstrap != nil {
      if let url=URL(string:pendingURL,relativeTo:origin)?.absoluteURL,url.scheme==origin.scheme,url.host==origin.host,url.port==origin.port,url.path=="/",URLComponents(url:url,resolvingAgainstBaseURL:false)?.queryItems?.first(where:{$0.name=="view"})?.value=="today" {
        guard let store,store.bootstrap != nil else { return }
        store.todayRequest=UUID();self.pendingURL=nil;pendingBotId=nil;pendingRoutineId=nil;return
      }
      pendingBotId = Self.botId(from: pendingURL, origin: origin)
      pendingRoutineId = nil
      if pendingBotId != nil, let url = URL(string: pendingURL, relativeTo: origin), let components = URLComponents(url: url, resolvingAgainstBaseURL: true) {
        pendingRoutineId = components.queryItems?.first { $0.name == "routine" }?.value
      }
      self.pendingURL = nil
    }
    guard let store, let botId = pendingBotId,
      store.bootstrap?.bots.contains(where: { $0.id == botId }) == true
    else { return }
    pendingBotId = nil
    await store.select(botId)
    if let routineId = pendingRoutineId { store.routineResult = RoutineResultDestination(botId: botId, routineId: routineId) }
    pendingRoutineId = nil
  }
}

/// Injectable system boundary lets tests exercise grant, denial, and account changes without
/// displaying an OS alert. Production always uses UNUserNotificationCenter.
struct NotificationPermissions {
  var status: () async -> UNAuthorizationStatus
  var request: () async throws -> Bool
  static let system = NotificationPermissions(
    status: { await UNUserNotificationCenter.current().notificationSettings().authorizationStatus },
    request: { try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) })
}
