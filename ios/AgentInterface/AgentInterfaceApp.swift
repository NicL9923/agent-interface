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
          #if DEBUG
            if await DebugFixtures.configure(store) { return }
          #endif
          await store.restore()
        }
        .onChange(of: scenePhase) { _, phase in
          if phase == .active && store.bootstrap != nil && !store.sessionExpired {
            store.startPolling()
          } else if phase != .active {
            store.suspend()
          }
        }
        .onChange(of: store.bootstrap?.user.id) { _, id in
          if id != nil { Task { await NotificationController.shared.synchronize() } }
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
  private var preferenceKey: String? { store?.scope.map { "push.enabled.\($0)" } }
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
  func enable() async {
    guard let store, let api = store.api else { return }
    let currentToken = api.token
    let currentScope = store.scope
    let enabledKey = preferenceKey
    do {
      let config: PushConfig = try await api.get("/native/push/config")
      guard config.available else {
        store.notificationStatus =
          "The self-hoster must configure Apple push notifications on this server."
        return
      }
      let allowed = try await UNUserNotificationCenter.current().requestAuthorization(options: [
        .alert, .sound, .badge,
      ])
      guard currentToken == api.token, currentScope == store.scope else { return }
      if allowed {
        if let key = enabledKey { UserDefaults.standard.set(true, forKey: key) }
        UIApplication.shared.registerForRemoteNotifications()
        store.notificationStatus = "Registering this device…"
      } else {
        store.notificationStatus = "Notifications are denied. Enable them in iOS Settings."
      }
    } catch {
      if currentToken == api.token, currentScope == store.scope {
        store.notificationStatus = error.localizedDescription
      }
    }
  }
  func synchronize() async {
    guard let store, let api = store.api, api.token != nil, store.bootstrap != nil else { return }
    let currentToken = api.token
    let settings = await UNUserNotificationCenter.current().notificationSettings()
    guard currentToken == api.token else { return }
    if let key = preferenceKey, UserDefaults.standard.bool(forKey: key),
      settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional
    {
      if let token {
        do {
          let _: EmptyResponse = try await api.write(
            "/native/push/device", PushDevice(deviceId: deviceId, token: token), method: "PUT")
          if currentToken == api.token {
            store.notificationStatus = "Notifications enabled on this device"
          }
        } catch {
          if currentToken == api.token { store.notificationStatus = error.localizedDescription }
        }
      } else {
        UIApplication.shared.registerForRemoteNotifications()
      }
    } else {
      store.notificationStatus =
        settings.authorizationStatus == .denied
        ? "Notifications are denied in iOS Settings" : "Notifications are off"
    }
    await openPendingConversation()
  }
  func disable() async {
    guard let store, let api = store.api else { return }
    let currentToken = api.token
    let currentScope = store.scope
    let enabledKey = preferenceKey
    do {
      let _: EmptyResponse = try await api.write(
        "/native/push/device", ["deviceId": deviceId], method: "DELETE")
      guard currentToken == api.token, currentScope == store.scope else { return }
      if let key = enabledKey { UserDefaults.standard.set(false, forKey: key) }
      UIApplication.shared.unregisterForRemoteNotifications()
      store.notificationStatus = "Notifications disabled on this device"
    } catch { if currentToken == api.token, currentScope == store.scope { store.report(error) } }
  }
  func test(botId: String) async {
    guard let store else { return }
    do {
      try await store.perform("/native/push/test", ["botId": botId])
      store.notificationStatus = "Test queued. Confirm its arrival on this device."
    } catch { store.report(error) }
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
