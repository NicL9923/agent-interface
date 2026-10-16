import SwiftUI
import UserNotifications

@main struct AgentInterfaceApp: App {
  @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
  @StateObject private var store = AppStore()
  @Environment(\.scenePhase) private var scenePhase
  var body: some Scene {
    WindowGroup {
      RootView().environmentObject(store)
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
        .onOpenURL { url in
          guard let path = DeepLink.relativePath(for: url) else { return }
          NotificationController.shared.pendingURL = path
          Task { await NotificationController.shared.openPendingConversation() }
        }
    }
  }
}
class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    UNUserNotificationCenter.current().delegate = self
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
      NotificationController.shared.store?.notificationStatus =
        "Device registration failed: \(error.localizedDescription)"
    }
  }
  func userNotificationCenter(
    _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    completionHandler([.banner, .sound, .badge])
  }
  func userNotificationCenter(
    _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    let info = response.notification.request.content.userInfo
    Task { @MainActor in
      if let relativeURL = info["url"] as? String {
        NotificationController.shared.pendingURL = relativeURL
        await NotificationController.shared.openPendingConversation()
      }
      completionHandler()
    }
  }
}
@MainActor final class NotificationController {
  static let shared = NotificationController()
  weak var store: AppStore?
  var token: String?
  var pendingBotId: String?
  var pendingRoutineId: String?
  var pendingURL: String?
  private let permissions: NotificationPermissions
  private let register: @MainActor () -> Void
  private let unregister: @MainActor () -> Void
  private var synchronizing = false
  private var synchronizeAgain = false
  init(permissions: NotificationPermissions = .system,
    register: @escaping @MainActor () -> Void = { UIApplication.shared.registerForRemoteNotifications() },
    unregister: @escaping @MainActor () -> Void = { UIApplication.shared.unregisterForRemoteNotifications() }) {
    self.permissions = permissions; self.register = register; self.unregister = unregister
  }
  static func botId(from value: String, origin: URL) -> String? {
    guard value.hasPrefix("/"), !value.hasPrefix("//"),
      let url = URL(string: value, relativeTo: origin)?.absoluteURL, url.scheme == origin.scheme,
      url.host == origin.host, url.port == origin.port, url.path == "/",
      let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
    else { return nil }
    return components.queryItems?.first { $0.name == "bot" }?.value
  }
  var deviceId: String {
    if let value = UserDefaults.standard.string(forKey: "push.deviceId") { return value }
    let value = UUID().uuidString.lowercased()
    UserDefaults.standard.set(value, forKey: "push.deviceId")
    return value
  }
  /// iOS owns permission. Ask once after household sign-in, then reconcile on foreground.
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
  private func synchronizeDevice() async {
    guard let store, let api = store.api, let currentScope = store.scope,
      api.token != nil, store.bootstrap != nil, !store.sessionExpired else { return }
    let currentToken = api.token
    func current() -> Bool { store.api === api && api.token == currentToken && store.scope == currentScope }
    do {
      var status = await permissions.status()
      guard current() else { return }
      if status == .denied {
        unregister()
        token = nil
        let _: EmptyResponse = try await api.write("/native/push/device", ["deviceId": deviceId], method: "DELETE")
        if current() { store.notificationStatus = "Notifications are managed in iOS Settings" }
        return
      }
      let config: PushConfig = try await api.get("/native/push/config")
      guard current() else { return }
      guard config.available else {
        store.notificationStatus = "Apple push notifications are unavailable on this server"
        return
      }
      if status == .notDetermined {
        let allowed = try await permissions.request()
        guard current() else { return }
        status = allowed ? .authorized : .denied
      }
      guard status == .authorized || status == .provisional || status == .ephemeral else {
        store.notificationStatus = "Notifications are managed in iOS Settings"
        return
      }
      if let token {
        let _: EmptyResponse = try await api.write("/native/push/device", PushDevice(deviceId: deviceId, token: token), method: "PUT")
        if current() { store.notificationStatus = "Notifications enabled on this device" }
      } else {
        register()
        store.notificationStatus = "Registering this device…"
      }
    } catch { if current() { store.notificationStatus = error.localizedDescription } }
  }
  func openPendingConversation() async {
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
