import SwiftUI

/// What the home screen's account dot shows, like the web's `home-status-*` classes.
enum HomeConnectionStatus: Equatable {
  case connected, reconnecting, offline
  static func of(lost: Bool, offline: Bool) -> HomeConnectionStatus { lost ? (offline ? .offline : .reconnecting) : .connected }
  var color: Color {
    switch self {
    case .connected: Palette.accent
    case .reconnecting: Palette.attention
    case .offline: Palette.muted
    }
  }
}

extension AppStore {
  /// A saved sign-in whose first household read has not finished: the web's "Connecting to your household" screen.
  var connectingToHousehold: Bool { api?.token != nil && bootstrap == nil && !sessionExpired }
  /// The web's `connectionLost`: Hermes or the app cannot be reached, or the device is offline.
  /// An expired sign-in is a different state with its own prompt.
  func connectionLost(offline: Bool) -> Bool { offline || (!connected && !sessionExpired) }
  /// Why a new assistant cannot be created now, or nil when it can.
  var assistantSetupBlock: String? {
    if !connected { return "Assistant setup is unavailable while Hermes is disconnected." }
    return supports("botConfiguration") ? nil : reason("botConfiguration")
  }
}

/// One shared minute tick for every time label on a screen, instead of a timeline per row.
@MainActor final class MinuteClock: ObservableObject {
  static let shared = MinuteClock()
  @Published private(set) var now: Date
  private let date: () -> Date
  private var timer: Timer?
  private var foreground: NSObjectProtocol?
  init(date: @escaping () -> Date = { Date() }, interval: TimeInterval = 60) {
    self.date = date
    now = date()
    timer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
      Task { @MainActor in self?.tick() }
    }
    // Timers stand still in the background; a returning app should not show a stale "Just now".
    foreground = NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
      Task { @MainActor in self?.tick() }
    }
  }
  deinit {
    timer?.invalidate()
    if let foreground { NotificationCenter.default.removeObserver(foreground) }
  }
  func tick() { now = date() }
}

/// The first screen while a saved sign-in loads, or while the app server is out of reach, as on the web.
struct LaunchStateView: View {
  @EnvironmentObject private var store: AppStore
  @Environment(\.colorScheme) private var scheme
  var body: some View {
    VStack(spacing: 20) {
      Spacer(minLength: 0)
      Text("WildBots").font(.caption.weight(.semibold)).tracking(1.4).textCase(.uppercase).foregroundStyle(Palette.muted)
      AvatarTrio()
      Text(WelcomeCopy.heading).font(.largeTitle.bold()).multilineTextAlignment(.center)
      status
      if store.appUnavailable { actions }
      Spacer(minLength: 0)
    }.padding(24).frame(maxWidth: 560).frame(maxWidth: .infinity, maxHeight: .infinity)
      .background(Palette.surface(scheme)).accessibilityIdentifier("launchState")
  }
  private var status: some View {
    HStack(spacing: 8) {
      if !store.appUnavailable { ProgressView() }
      Text(WelcomeCopy.status(unavailable: store.appUnavailable)).foregroundStyle(.secondary).multilineTextAlignment(.center)
    }.accessibilityElement(children: .combine).accessibilityIdentifier("launchStatus")
  }
  /// A wrong or retired server address would otherwise strand a person here.
  private var actions: some View {
    VStack(spacing: 12) {
      Button {
        Task { await store.restore() }
      } label: {
        Text(store.restoring ? "Checking connection…" : "Try again").frame(maxWidth: 260)
      }.buttonStyle(.borderedProminent).controlSize(.large).disabled(store.restoring).accessibilityIdentifier("retryConnection")
      ChangeServerButton()
    }
  }
}

/// The web's welcome and sign-in copy.
enum WelcomeCopy {
  static let heading = "Your assistants,\nin one familiar place."
  static func status(unavailable: Bool) -> String { unavailable ? "Can't reach the app right now. We'll keep trying." : "Connecting to your household…" }
  static let signInHeading = "Your assistants are waiting."
  static let signInDetail = "Sign in to return to your household conversations."
  static let checkingSignIn = "Checking sign-in…"
}

/// Leaves this server. If the server cannot confirm the sign-out, asks before forgetting it locally.
struct ChangeServerButton: View {
  @EnvironmentObject private var store: AppStore
  @State private var offline = false
  var body: some View {
    Button("Change server") {
      Task { if !(await store.changeConnection()) { offline = true } }
    }.disabled(store.signingIn).accessibilityIdentifier("changeServer")
      .confirmationDialog(
        "The server didn't confirm sign-out, so it may be unreachable. If you change servers anyway, this device forgets its sign-in, but the session stays valid on the server until it expires.",
        isPresented: $offline, titleVisibility: .visible
      ) {
        Button("Change server anyway", role: .destructive) {
          Task { await store.changeConnection(localOnly: true) }
        }
      }
  }
}

/// The web's full connection panel: what is wrong, the steps to fix it, and the setup command.
struct HermesConnectionPanel: View {
  var connection: RuntimeStatus?
  var offline: Bool
  var appUnavailable: Bool
  var busy: Bool
  var retry: () -> Void
  @State private var copied = false
  private var copy: ConnectionCopy { ConnectionCopy.compact(code: connection?.code, appUnavailable: appUnavailable, offline: offline) }
  var body: some View {
    VStack(spacing: 16) {
      AvatarView(avatar: AvatarConfig(), state: .disconnected, size: 84, name: "Assistant", forceReducedMotion: true).accessibilityHidden(true)
      VStack(spacing: 8) {
        Text("Your household workspace").font(.caption.weight(.semibold)).tracking(1.1).textCase(.uppercase).foregroundStyle(Palette.muted)
        Text(copy.title).font(.title2.bold()).multilineTextAlignment(.center)
        Text(copy.detail).foregroundStyle(.secondary).multilineTextAlignment(.center)
      }
      if copy.setup { steps }
      Button(action: retry) {
        Text(busy ? "Checking connection…" : copy.setup ? "Check connection" : "Reconnect now").frame(maxWidth: 260)
      }.buttonStyle(.borderedProminent).controlSize(.large).disabled(busy || offline).accessibilityIdentifier("reconnectNow")
      details
    }.frame(maxWidth: 520).frame(maxWidth: .infinity).accessibilityElement(children: .contain).accessibilityLabel("Hermes connection")
      .accessibilityIdentifier("connectionPanel")
  }
  private var steps: some View {
    VStack(alignment: .leading, spacing: 12) {
      step("✓", "You're signed in", "Your household account is ready.")
      step("2", "Connect the app to Hermes", "Guided setup checks the address, access and compatibility before saving.")
      step("3", "Pick up with your assistants", "Their existing conversations stay in Hermes.")
    }.frame(maxWidth: .infinity, alignment: .leading)
  }
  private func step(_ mark: String, _ title: String, _ detail: String) -> some View {
    HStack(alignment: .top, spacing: 12) {
      Text(mark).font(.footnote.weight(.semibold)).frame(width: 26, height: 26)
        .background(Palette.accentSoft, in: Circle()).foregroundStyle(Palette.accent).accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 2) {
        Text(title).font(.subheadline.weight(.semibold))
        Text(detail).font(.footnote).foregroundStyle(.secondary)
      }
    }.accessibilityElement(children: .combine)
  }
  private var details: some View {
    DisclosureGroup(copy.setup ? "Set up this installation" : "Connection details") {
      VStack(alignment: .leading, spacing: 8) {
        if let address = connection?.address { Text("Hermes address: \(address)").textSelection(.enabled) }
        if let detail = connection?.detail, !detail.isEmpty { Text(detail) }
        if let last = connection?.lastConnectedAt, !When.format(last).isEmpty { Text("Last connected \(When.format(last, inline: true)).") }
        if copy.setup { setupCommand }
        Text("For a read-only connection check on that computer, run `npm run doctor`.")
      }.font(.footnote).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading).padding(.top, 6)
    }.font(.subheadline).frame(maxWidth: .infinity, alignment: .leading)
  }
  @ViewBuilder private var setupCommand: some View {
    Text("On the computer running WildBots, open its project folder and run:")
    HStack {
      Text("npm run setup").font(.system(.footnote, design: .monospaced)).textSelection(.enabled)
      Spacer(minLength: 8)
      Button(copied ? "Copied" : "Copy command") { UIPasteboard.general.string = "npm run setup"; copied = true }
        .buttonStyle(.bordered).controlSize(.small)
    }.padding(10).background(Palette.line.opacity(0.35), in: RoundedRectangle(cornerRadius: 10))
    Text("Setup keeps the connection token on that computer. Restart this app after saving; everyone else can simply sign in.")
  }
}

/// The detail pane when there are no assistants: the setup panel while Hermes is out of reach,
/// otherwise the web's empty home.
struct HomeEmptyDetail: View {
  var create: () -> Void
  @EnvironmentObject private var store: AppStore
  @ObservedObject private var reachability = NetworkReachability.shared
  @Environment(\.colorScheme) private var scheme
  @State private var checking = false
  var body: some View {
    ScrollView {
      Group {
        if store.connectionLost(offline: reachability.offline) {
          HermesConnectionPanel(connection: store.bootstrap?.connection, offline: reachability.offline,
            appUnavailable: store.appUnavailable, busy: checking) {
              checking = true
              Task { await store.reconnect(); checking = false }
            }
        } else { emptyState }
      }.padding(24)
    }.background(Palette.surface(scheme)).viewHeader(HomeCopy.emptyTitle, HomeCopy.emptySubtitle)
  }
  private var emptyState: some View {
    VStack(spacing: 14) {
      AvatarView(avatar: AvatarConfig(), size: 100, name: "Assistant", forceReducedMotion: true).accessibilityHidden(true)
      Text("A little less to carry.").font(.title2.bold())
      Text("Return to the same assistants, with the context and conversations you share.").foregroundStyle(.secondary).multilineTextAlignment(.center)
      Button("Create an assistant", action: create).buttonStyle(.borderedProminent).controlSize(.large)
        .disabled(store.assistantSetupBlock != nil).accessibilityIdentifier("createAssistant")
      if let reason = store.assistantSetupBlock { Text(reason).font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center) }
    }.frame(maxWidth: 520).frame(maxWidth: .infinity)
  }
}

enum HomeCopy {
  static let emptyTitle = "Welcome home"
  static let emptySubtitle = "Your assistants will appear here when Hermes is connected."
}
