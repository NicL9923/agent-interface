import SwiftUI

/// What the web's `useDeviceNotifications` exposes, for this account on this device.
struct DeviceNotificationState: Equatable {
  var enabled = false
  var checking = true
  var busy = false
  var canEnable = false
  /// iOS permission is denied, so only iOS Settings can change it.
  var blockedInSettings = false
  var message = "Checking notifications on this device…"
  var error: String?
  var prompt = false

  static let unconfigured = DeviceNotificationState(checking: false, message: "Notifications are not configured on this installation.")
  static let blocked = DeviceNotificationState(checking: false, blockedInSettings: true, message: "Notifications are blocked for this app. Allow them in iOS Settings, then return here.")
  static func ready(prompt: Bool) -> DeviceNotificationState {
    DeviceNotificationState(checking: false, canEnable: true, message: "Enable notifications for completed work and requests that need your attention.", prompt: prompt)
  }
  static let enabledState = DeviceNotificationState(enabled: true, checking: false, canEnable: true, message: "Notifications are enabled for your account on this device.")
  static let registering = DeviceNotificationState(enabled: true, checking: false, canEnable: true, message: "Registering this device…")
  static let disabledByChoice = DeviceNotificationState(checking: false, canEnable: true, message: "Notifications are disabled on this device. You can enable them here later.")
  static func failed(_ error: String) -> DeviceNotificationState {
    DeviceNotificationState(checking: false, message: "Couldn't check notifications on this device. Retry before changing them.", error: error)
  }
}

/// Whether this person turned notifications on for this account on this device. Unset means they were never asked,
/// which iOS permission alone then decides, as before the switch existed.
@MainActor enum NotificationIntent: String {
  case on, off
  static func key(_ store: AppStore) -> String? { store.key("notifications") }
  static func read(_ store: AppStore) -> NotificationIntent? {
    key(store).flatMap { UserDefaults.standard.string(forKey: $0) }.flatMap(NotificationIntent.init)
  }
  static func write(_ value: NotificationIntent, _ store: AppStore) {
    if let key = key(store) { UserDefaults.standard.set(value.rawValue, forKey: key) }
  }
  static func promptKey(_ store: AppStore) -> String? { store.key("notificationPrompt") }
  static func prompted(_ store: AppStore) -> Bool { promptKey(store).flatMap { UserDefaults.standard.string(forKey: $0) } != nil }
  static func rememberPrompt(_ store: AppStore) {
    if let key = promptKey(store) { UserDefaults.standard.set("shown", forKey: key) }
  }
}

/// The web's one-time "Enable notifications on this device?" card. iOS asks for permission only after Enable.
struct NotificationOnboardingCard: View {
  @EnvironmentObject private var store: AppStore
  @Environment(\.colorScheme) private var scheme
  var body: some View {
    let state = store.deviceNotifications
    if state.prompt {
      VStack(alignment: .leading, spacing: 10) {
        Text("Enable notifications on this device?").font(.headline)
        Text("Get notified when work finishes or an assistant needs your attention. You can change this later in Settings > Notifications.")
          .font(.footnote)
        if !state.canEnable { Text(state.message).font(.footnote).foregroundStyle(Palette.muted) }
        if let error = state.error { Text(error).font(.footnote).foregroundStyle(Palette.danger) }
        HStack {
          Button(state.busy ? "Enabling…" : "Enable notifications") { Task { await NotificationController.shared.enable() } }
            .buttonStyle(.borderedProminent).disabled(!state.canEnable || state.busy).accessibilityIdentifier("enableNotifications")
          Button("Not now") { NotificationController.shared.dismissPrompt() }
            .buttonStyle(.bordered).disabled(state.busy).accessibilityIdentifier("notNowNotifications")
        }
      }.padding(14).frame(maxWidth: .infinity, alignment: .leading)
        .background(Palette.raised(scheme), in: RoundedRectangle(cornerRadius: 14))
        .accessibilityElement(children: .contain).accessibilityIdentifier("notificationOnboarding")
    }
  }
}

/// The Settings switch for this device, with the web's states: checking, busy, error and retry.
struct DeviceNotificationSettings: View {
  @EnvironmentObject private var store: AppStore
  var body: some View {
    let state = store.deviceNotifications
    Toggle(isOn: Binding(
      get: { state.enabled },
      set: { on in Task { if on { await NotificationController.shared.enable() } else { await NotificationController.shared.disable() } } }
    )) {
      VStack(alignment: .leading, spacing: 2) {
        Text("Notifications on this device")
        Text(state.enabled ? "Enabled" : "Disabled").font(.caption).foregroundStyle(Palette.muted)
      }
    }.disabled(state.checking || state.busy || (!state.enabled && !state.canEnable) || store.sessionExpired)
      .accessibilityIdentifier("deviceNotifications")
    Text(state.message).font(.footnote).foregroundStyle(Palette.muted)
    if state.busy { Text("Updating notifications…").font(.footnote).accessibilityIdentifier("notificationsBusy") }
    if let error = state.error {
      ErrorBanner(message: error)
      Button("Retry checking notifications") { Task { await NotificationController.shared.retry() } }
        .disabled(state.busy).accessibilityIdentifier("retryNotifications")
    }
    if state.blockedInSettings, let url = URL(string: UIApplication.openSettingsURLString) { Link("Open iOS Settings", destination: url) }
    Text("This setting applies to your account on this device.").font(.footnote).foregroundStyle(Palette.muted)
  }
}
