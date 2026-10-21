import Network
import SwiftUI

enum HomeDestination { case conversation, today, groups, find }

struct RootView: View {
  @Environment(AppStore.self) private var store
  @Environment(\.colorScheme) private var scheme
  @State private var settingsBot: Bot?
  @State private var creatingBot = false
  @State private var preferencesOpen = false
  @State private var destination: HomeDestination = .conversation
  @State private var sharedCapture: SharedCapture?
  @Environment(\.scenePhase) private var scenePhase
  @State private var tab = "assistants"
  @State private var assistantPath: [String] = []
  @State private var initialScope: String?
  @State private var columnVisibility: NavigationSplitViewVisibility = .automatic
  @State private var compactColumn: NavigationSplitViewColumn = .sidebar
  var body: some View {
    Group {
      if store.bootstrap == nil {
        if store.connectingToHousehold { LaunchStateView() } else { ConnectionView() }
      } else {
        household
      }
    }
    .background(Palette.surface(scheme))
    .homeSignals(haptic: store.haptic, command: store.keyboardCommand, run: run)
    .modifier(sheets)
    .onAppear { checkShares() }
    .onChange(of:store.sessionExpired) { _,_ in checkShares() }
    .onChange(of:scenePhase) { _, phase in if phase == .active { checkShares() } }
    .onChange(of:store.scope) { _, scope in scopeChanged(scope) }
    // Initial too: a notification or Siri can ask before this view first appears.
    .onChange(of: store.todayRequest, initial: true) { _, request in if request != nil { destination = .today; tab = "today"; compactColumn = .detail } }
    .onChange(of: store.leftBotId, initial: true) { _, id in if let id { left(id) } }
    .onChange(of: store.conversationRequest, initial: true) { _, request in
      if request != nil { destination = .conversation; tab = "assistants"; assistantPath = ["chat"]; compactColumn = .detail }
    }
    .onChange(of: store.bootstrap?.user.id) { old, new in if let old, old != new { accountChanged() } }
  }
  /// Above the split view, not a safe-area inset: an inset would sit over its navigation bars.
  private var household: some View {
    VStack(spacing: 0) {
      if case .available(let url) = store.appUpdate { AppUpdateBanner(url: url) }
      if let date = store.offlineSavedAt {
        Text("Saved on this device \(date.formatted(date: .abbreviated, time: .shortened)). Reconnecting…")
          .font(.caption).foregroundStyle(.secondary).padding(8)
      }
      if UIDevice.current.userInterfaceIdiom == .phone { compactNavigation } else { splitNavigation }
    }
  }
  private var splitNavigation: some View {
    NavigationSplitView(columnVisibility: $columnVisibility, preferredCompactColumn: $compactColumn) {
      BotListView(
        destination: destination, openPreferences: { preferencesOpen = true }, edit: { settingsBot = $0 }, create: { creatingBot = true },
        openBot: { destination = .conversation; compactColumn = .detail },
        openToday: { destination = .today; compactColumn = .detail },
        openGroups: { destination = .groups; compactColumn = .detail },
        openDiscovery: { destination = .find; compactColumn = .detail })
    } detail: { detail }
  }
  @ViewBuilder private var detail: some View {
    if destination == .find {
      DiscoveryView()
    } else if destination == .groups {
      GroupChatsView()
    } else if destination == .today {
      TodayView(openBot: { destination = .conversation; compactColumn = .detail })
    } else if let bot = store.bot {
      ConversationView(bot: bot, edit: { settingsBot = bot }).id(bot.id)
    } else if store.bootstrap?.bots.isEmpty == true {
      HomeEmptyDetail(create: { creatingBot = true })
    } else {
      ContentUnavailableView(
        "Choose an assistant", systemImage: "bubble.left.and.bubble.right",
        description: Text("Your assistants keep their conversations here."))
    }
  }
  private var sheets: RootSheets {
    RootSheets(store: store, sharedCapture: $sharedCapture, settingsBot: $settingsBot, creatingBot: $creatingBot, preferencesOpen: $preferencesOpen)
  }
  private func scopeChanged(_ scope: String?) {
    checkShares()
    guard let scope, scope != initialScope else { return }
    initialScope = scope
    let preferences = store.bootstrap?.preferences
    let today = (preferences?.startPage == "today" || preferences?.startPage != "assistant" && preferences?.defaultBotId == nil) && store.routineResult == nil
    destination = today ? .today : .conversation
    tab = today ? "today" : "assistants"
    assistantPath = []
    compactColumn = .sidebar
  }
  private func left(_ id: String) {
    if settingsBot?.id == id { settingsBot = nil }
    if store.routineResult?.botId == id { store.routineResult = nil }
    // Only a person looking at its conversation is taken home; Today and the other views stay.
    if UIDevice.current.userInterfaceIdiom == .phone { assistantPath.removeAll { $0 == "chat" } }
    if destination == .conversation { compactColumn = .sidebar }
  }
  private func accountChanged() {
    destination = .conversation
    tab = "assistants"
    assistantPath = []
    preferencesOpen = false
    settingsBot = nil
    creatingBot = false
    store.openedFile = nil
    store.routineResult = nil
  }
  private var compactNavigation: some View {
    TabView(selection: $tab) {
      NavigationStack(path: $assistantPath) {
        BotListView(destination: destination, openPreferences: { preferencesOpen = true },
          edit: { settingsBot = $0 }, create: { creatingBot = true },
          openBot: { destination = .conversation; assistantPath = ["chat"] },
          openToday: { tab = "today" }, openGroups: { assistantPath = ["groups"] },
          openDiscovery: { tab = "search" })
          .navigationDestination(for: String.self) { route in
            if route == "groups" { GroupChatsView() }
            else if let bot = store.bot { ConversationView(bot: bot, edit: { settingsBot = bot }).id(bot.id) }
          }
      }.tabItem { Label("Assistants", systemImage: "bubble.left.and.bubble.right") }.tag("assistants")
      NavigationStack {
        TodayView(openBot: { tab = "assistants"; assistantPath = ["chat"]; destination = .conversation })
      }.tabItem { Label("Today", systemImage: "calendar") }.tag("today")
      NavigationStack { DiscoveryView() }
        .tabItem { Label("Search", systemImage: "magnifyingglass") }.tag("search")
    }
  }
  /// Hardware keyboard shortcuts that belong to home. An open chat takes Find and Stop itself.
  private func run(_ command: KeyboardCommand) {
    switch command.kind {
    case .pinned(let index):
      guard store.pinnedForShortcuts.indices.contains(index) else { return }
      let id = store.pinnedForShortcuts[index].id
      Task { await store.select(id) }
    case .find:
      guard store.viewingBotId == nil else { return }
      store.searchFocusPending = true
      destination = .find; tab = "search"; compactColumn = .detail
    case .stop: break
    }
  }
  private func checkShares() {
    guard let scope=store.scope,!store.sessionExpired,let bootstrap=store.bootstrap else { ShareInbox.setContext(nil);sharedCapture=nil;return }
    ShareInbox.setContext(ShareContext(scope:scope,bots:bootstrap.bots.map { ShareContext.Assistant(id:$0.id,name:$0.name) }))
    if sharedCapture == nil { sharedCapture=ShareInbox.pending(scope:scope).first }
  }
}
/// Home's sheets, in their own modifier so the root body stays quick to type-check.
private struct RootSheets: ViewModifier {
  let store: AppStore
  @Binding var sharedCapture: SharedCapture?
  @Binding var settingsBot: Bot?
  @Binding var creatingBot: Bool
  @Binding var preferencesOpen: Bool
  func body(content: Content) -> some View {
    @Bindable var store = store
    content
      .sheet(item: $sharedCapture) { capture in ShareCaptureView(capture: capture).appStore(store).coveringChat(store) }
      .sheet(item: $settingsBot) { bot in BotSettingsView(bot: bot, close: { settingsBot = nil }).appStore(store).coveringChat(store) }
      .sheet(isPresented: $creatingBot) { BotSettingsView(bot: nil, close: { creatingBot = false }).appStore(store).coveringChat(store) }
      .sheet(isPresented: $preferencesOpen) { PreferencesView(close: { preferencesOpen = false }).appStore(store).coveringChat(store) }
      .sheet(item: $store.openedFile) { FilePreview(file: $0).ignoresSafeArea().coveringChat(store) }
      .sheet(item: $store.routineResult) { target in
        NavigationStack { RoutineResultsView(botId: target.botId, routineId: target.routineId, resultId: target.resultId) }.appStore(store).coveringChat(store)
      }
  }
}
struct ConnectionView: View {
  @Environment(AppStore.self) private var store
  @Environment(\.colorScheme) private var scheme
  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 24) {
          AvatarTrio().padding(.top, 28)
          VStack(alignment: .leading, spacing: 8) {
            Text(store.api == nil ? WelcomeCopy.heading.replacingOccurrences(of: "\n", with: " ") : WelcomeCopy.signInHeading)
              .font(.largeTitle.bold())
            Text(
              store.api == nil
                ? "Connect to the WildBots app server your self-hoster set up. Your assistants and their work stay on that server."
                : WelcomeCopy.signInDetail
            ).foregroundStyle(.secondary)
          }
          if store.api == nil {
            VStack(alignment: .leading, spacing: 10) {
              Text("App server address").font(.headline)
              TextField("https://assistants.example.com", text: Bindable(store).host).textContentType(.URL)
                .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                .padding(14).background(
                  Palette.raised(scheme), in: RoundedRectangle(cornerRadius: 12)
                ).accessibilityIdentifier("serverAddress")
              Button {
                Task { await store.connect() }
              } label: {
                HStack {
                  if store.loading { ProgressView() }
                  Text(store.loading ? "Checking server…" : "Connect to server").frame(
                    maxWidth: .infinity)
                }
              }.buttonStyle(.borderedProminent).controlSize(.large).disabled(
                store.loading || store.host.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
              ).accessibilityIdentifier("connectServer")
            }
          } else {
            Label(store.host, systemImage: "server.rack").font(.footnote).textSelection(.enabled)
            if store.authConfig == nil && store.error == nil {
              Text(WelcomeCopy.checkingSignIn).font(.footnote).foregroundStyle(.secondary).accessibilityIdentifier("checkingSignIn")
            }
            Button {
              Task { await store.signIn() }
            } label: {
              HStack {
                if store.signingIn { ProgressView() }
                Text(store.signingIn ? "Signing in…" : "Sign in to your household").frame(
                  maxWidth: .infinity)
              }
            }.buttonStyle(.borderedProminent).controlSize(.large).disabled(store.signingIn)
              .accessibilityIdentifier("householdSignIn")
            Button {
              Task { await store.restore() }
            } label: {
              HStack {
                if store.restoring { ProgressView() }
                Text(store.restoring ? "Checking server…" : "Retry connection").frame(
                  maxWidth: .infinity)
              }
            }.buttonStyle(.bordered).controlSize(.large).disabled(store.restoring || store.signingIn)
              .accessibilityIdentifier("retryConnection")
            if store.authConfig?.localDevAuth == true {
              Text(
                "This development server also offers local test accounts in the sign-in browser."
              ).font(.footnote).foregroundStyle(.secondary)
            }
            ChangeServerButton()
          }
          if let error = store.error { ErrorBanner(message: error, dismiss: { store.error = nil }) }
          Text(
            "Provider credentials and the Hermes gateway token are configured by the self-hoster on the server."
          ).font(.footnote).foregroundStyle(.secondary)
        }.padding(24).frame(maxWidth: 560)
      }.frame(maxWidth: .infinity).background(Palette.surface(scheme)).navigationTitle(
        "WildBots"
      ).navigationBarTitleDisplayMode(.inline)
    }
  }
}
struct ErrorBanner: View {
  var message: String
  var dismiss: (() -> Void)? = nil
  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: "exclamationmark.circle")
      Text(message).font(.footnote).frame(maxWidth: .infinity, alignment: .leading).textSelection(
        .enabled)
      if let dismiss {
        Button(action: dismiss) { Image(systemName: "xmark") }.accessibilityLabel("Dismiss error")
      }
    }.foregroundStyle(.red).padding(12).background(
      Color.red.opacity(0.07), in: RoundedRectangle(cornerRadius: 10)
    ).accessibilityElement(children: .contain)
  }
}
/// A small household of assistants, so the first screen shows who is waiting. Distinct names give
/// each its own idle gesture timing.
struct AvatarTrio: View {
  var body: some View {
    HStack(alignment: .bottom, spacing: 6) {
      AvatarView(
        avatar: AvatarConfig(shape: "blob", color: "#1084FE", eyes: "oval"), size: 64, name: "Welcome 1"
      ).rotationEffect(.degrees(-6))
      AvatarView(
        avatar: AvatarConfig(mode: "mascot", shape: nil, family: "bear", color: "#FF9800", eyes: "round"),
        size: 84, name: "Welcome 2")
      AvatarView(
        avatar: AvatarConfig(shape: "triangle", color: "#FF309B", eyes: "oval"), size: 64, name: "Welcome 3"
      ).rotationEffect(.degrees(5))
    }.accessibilityHidden(true)
  }
}
struct BotListView: View {
  @Environment(AppStore.self) private var store
  @Environment(\.colorScheme) private var scheme
  @Environment(\.horizontalSizeClass) private var sizeClass
  var destination: HomeDestination
  var openPreferences: () -> Void
  var edit: (Bot) -> Void
  var create: () -> Void
  var openBot: () -> Void
  var openToday: () -> Void
  var openGroups: () -> Void
  var openDiscovery: () -> Void
  private let reachability = NetworkReachability.shared
  @State private var checkingConnection = false
  @ScaledMetric(relativeTo: .caption2) private var pinBadge: CGFloat = 11
  private var lost: Bool { store.connectionLost(offline: reachability.offline) }
  private var selectionVisible: Bool { sizeClass != .compact }
  private var homeBackground: Color { sizeClass == .compact ? Palette.surface(scheme) : Palette.rail(scheme) }
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        if let notice = store.notice {
          HStack(alignment: .top) {
            Text(notice).font(.footnote).frame(maxWidth: .infinity, alignment: .leading)
            Button { store.notice = nil } label: { Image(systemName: "xmark") }
              .accessibilityLabel("Dismiss")
          }.padding(12).background(Palette.raised(scheme), in: RoundedRectangle(cornerRadius: 12))
            .accessibilityIdentifier("homeNotice")
        }
        NotificationOnboardingCard()
        if store.sessionExpired {
          VStack(alignment: .leading, spacing: 8) {
            Text("Sign in again to continue").font(.footnote).foregroundStyle(.secondary)
            Button("Sign in again") { Task { await store.signIn() } }
          }
        }
        if let bootstrap = store.bootstrap {
          let pinned = bootstrap.preferences.pinnedAssistants(bootstrap.bots)
          if !pinned.isEmpty {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: sizeClass == .compact ? 100 : 76), spacing: 8)], alignment: .center, spacing: 12) {
              ForEach(pinned) { bot in pinnedTile(bot) }
            }.frame(maxWidth: CGFloat(min(pinned.count, sizeClass == .compact ? 3 : 2)) * (sizeClass == .compact ? 112 : 86))
              .frame(maxWidth: .infinity)
              .accessibilityElement(children: .contain).accessibilityLabel("Pinned assistants")
          }
          ViewThatFits(in: .horizontal) {
            HStack(spacing: 10) { householdLinks }
            VStack(alignment: .leading, spacing: 8) { householdLinks }
          }
          ForEach(bootstrap.preferences.assistantGroups(bootstrap.bots)) { group in
            VStack(alignment: .leading, spacing: 4) {
              if !group.title.isEmpty {
                Text(group.title).font(.caption2.weight(.semibold)).tracking(1.1).textCase(.uppercase)
                  .foregroundStyle(Palette.muted).padding(.horizontal, 10).padding(.bottom, 8).accessibilityAddTraits(.isHeader)
              }
              LazyVStack(spacing: 2) { ForEach(group.bots) { bot in row(bot) } }
            }
          }
          if bootstrap.bots.isEmpty { emptyHome }
        }
      }.padding(16)
    }.background(homeBackground)
      .navigationTitle("Your assistants").navigationBarTitleDisplayMode(.inline).homeTitleHidden()
      .toolbarBackground(homeBackground, for: .navigationBar)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          Button(action: openPreferences) {
            AccountAvatar(member: store.bootstrap?.user, size: 40)
              .overlay(alignment: .bottomTrailing) {
                Circle().fill(HomeConnectionStatus.of(lost: lost, offline: reachability.offline).color)
                  .frame(width: 10, height: 10).overlay(Circle().stroke(homeBackground, lineWidth: 2))
              }
          }.accessibilityLabel("Settings").accessibilityIdentifier("openSettings")
        }
        if lost {
          ToolbarItem(placement: .topBarLeading) { syncPill }
        }
        ToolbarItemGroup(placement: .topBarTrailing) {
          Button(action: openDiscovery) { Image(systemName: "magnifyingglass") }
            .accessibilityLabel("Search & saved").accessibilityIdentifier("openDiscovery")
          Button(action: createOrExplain) { Image(systemName: "plus") }.accessibilityLabel("New assistant")
            .opacity(store.assistantSetupBlock == nil ? 1 : 0.4).accessibilityHint(store.assistantSetupBlock ?? "")
            .accessibilityIdentifier("newAssistant")
        }
      }.refreshable { await store.refreshBootstrap() }
  }
  /// Home while there are no assistants: the setup panel if Hermes is out of reach, else the web's empty list.
  @ViewBuilder private var emptyHome: some View {
    if lost {
      HermesConnectionPanel(connection: store.bootstrap?.connection, offline: reachability.offline,
        appUnavailable: store.appUnavailable, busy: checkingConnection) {
          checkingConnection = true
          Task { await store.reconnect(); checkingConnection = false }
        }
    } else {
      VStack(spacing: 12) {
        Text("No assistants are available from Hermes yet.").foregroundStyle(.secondary)
        Button("Create an assistant", action: createOrExplain).buttonStyle(.borderedProminent)
          .opacity(store.assistantSetupBlock == nil ? 1 : 0.4).accessibilityHint(store.assistantSetupBlock ?? "")
          .accessibilityIdentifier("createAssistant")
        if let reason = store.assistantSetupBlock { Text(reason).font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center) }
      }.frame(maxWidth: .infinity)
    }
  }
  /// A disabled button gives no reason on a touch screen, so a blocked tap says why.
  private func createOrExplain() {
    if let reason = store.assistantSetupBlock { store.notice = reason } else { create() }
  }
  /// Web's header status while the connection is down: a spinner while retrying, still when the device is offline.
  private var syncPill: some View {
    Button { Task { await store.reconnect() } } label: {
      HStack(spacing: 7) {
        SyncSpinner(spinning: !reachability.offline)
        Text(reachability.offline ? "Offline" : "Reconnecting").font(.subheadline).foregroundStyle(Palette.muted)
      }
    }.buttonStyle(.plain).accessibilityIdentifier("homeSync")
      .accessibilityHint("Loaded conversations and drafts are kept. Tap to reconnect now.")
  }
  @ViewBuilder private var householdLinks: some View {
    Button(action: openToday) { Label("Today", systemImage: "calendar") }.buttonStyle(HomeLinkStyle(selected: destination == .today)).accessibilityIdentifier("openToday")
    Button(action: openGroups) { Label("Group chats", systemImage: "bubble.left.and.bubble.right") }.buttonStyle(HomeLinkStyle(selected: destination == .groups)).accessibilityIdentifier("openGroups")
  }
  private func state(_ bot: Bot) -> ActivityState {
    // The open conversation is read only while on screen; otherwise the roster's state is the current one.
    lost ? .disconnected : bot.id == store.followedBotId ? store.activity : bot.activity
  }
  private func open(_ bot: Bot) { openBot(); Task { await store.select(bot.id) } }
  private func pinnedTile(_ bot: Bot) -> some View {
    let activity = state(bot)
    return Button { open(bot) } label: {
      VStack(spacing: 8) {
        AvatarView(avatar: bot.avatar ?? AvatarConfig(), state: activity == .done ? .idle : activity,
          size: sizeClass == .compact ? 92 : 60, name: bot.name, forceReducedMotion: true)
          .overlay(alignment: .bottomTrailing) {
            Image(systemName: "pin.fill").font(.system(size: pinBadge)).padding(5)
              .background(Palette.raised(scheme), in: Circle()).foregroundStyle(Palette.accent)
          }
        Text(bot.name).font(.subheadline.weight(.semibold)).foregroundStyle(.primary)
          .lineLimit(2).multilineTextAlignment(.center)
        if activity != .idle && activity != .done { ActivityLabel(state: activity) }
      }.frame(maxWidth: .infinity).padding(.vertical, 10).padding(.horizontal, 4)
        .contentShape(RoundedRectangle(cornerRadius: 16))
    }.buttonStyle(.plain)
      .background(selectionVisible && destination == .conversation && bot.id == store.selectedBotId ? Palette.accentSoft : Color.clear, in: RoundedRectangle(cornerRadius: 16))
      .accessibilityAddTraits(destination == .conversation && bot.id == store.selectedBotId ? .isSelected : [])
      .accessibilityIdentifier("bot.\(bot.id)")
      .contextMenu { botMenu(bot) }
  }
  private func row(_ bot: Bot) -> some View {
    let activity = state(bot)
    return Button { open(bot) } label: {
      HStack(spacing: 12) {
        AvatarView(avatar: bot.avatar ?? AvatarConfig(), state: activity == .done ? .idle : activity,
          size: 52, name: bot.name, forceReducedMotion: true)
        VStack(alignment: .leading, spacing: 5) {
          HStack(alignment: .firstTextBaseline) {
            Text(bot.name).font(.subheadline.weight(.semibold)).foregroundStyle(.primary).lineLimit(1)
            Spacer(minLength: 8)
            if let at = bot.lastMessage?.at, let date = ServerDate.parse(at) { AssistantListDate(date: date) }
          }
          if activity != .idle && activity != .done { ActivityLabel(state: activity) }
          else {
            Text(bot.lastMessage?.text.isEmpty == false ? bot.lastMessage!.text : bot.shared ? "Shared assistant" : "Personal assistant")
              .font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
          }
        }
      }.padding(.horizontal, 10).padding(.vertical, 12).contentShape(Rectangle())
    }.buttonStyle(.plain)
      .background(selectionVisible && destination == .conversation && bot.id == store.selectedBotId ? Palette.accentSoft : Color.clear, in: RoundedRectangle(cornerRadius: 16))
      .accessibilityAddTraits(destination == .conversation && bot.id == store.selectedBotId ? .isSelected : [])
      .accessibilityIdentifier("bot.\(bot.id)")
      .contextMenu { botMenu(bot) }
      .swipeAction(isPinned(bot) ? "Unpin" : "Pin", symbol: isPinned(bot) ? "pin.slash" : "pin", enabled: canPin) { Task { await store.togglePin(bot.id) } }
  }
  private func isPinned(_ bot: Bot) -> Bool { store.bootstrap?.preferences.favorites.contains(bot.id) == true }
  private var canPin: Bool { store.connected && !store.sessionExpired }
  @ViewBuilder private func botMenu(_ bot: Bot) -> some View {
    Button(isPinned(bot) ? "Unpin" : "Pin to top", systemImage: "pin") {
      Task { await store.togglePin(bot.id) }
    }.disabled(!canPin)
    Button("Assistant settings", systemImage: "gearshape") { edit(bot) }
  }
}
private struct HomeLinkStyle: ButtonStyle {
  var selected: Bool
  func makeBody(configuration: Configuration) -> some View {
    configuration.label.font(.subheadline).padding(.horizontal, 14).frame(minHeight: 44)
      .foregroundStyle(selected ? Palette.accent : Palette.muted)
      .background(selected || configuration.isPressed ? Palette.accentSoft : Color.clear, in: Capsule())
      .overlay(Capsule().stroke(Palette.line, lineWidth: 1))
  }
}
/// Web's `spinner` icon: an open arc that turns while the app retries.
private struct SyncSpinner: View {
  var spinning: Bool
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var turn = false
  var body: some View {
    Circle().trim(from: 0, to: 0.75).stroke(Palette.muted, style: StrokeStyle(lineWidth: 1.8, lineCap: .round))
      .frame(width: 16, height: 16).rotationEffect(.degrees(spinning && !reduceMotion && turn ? 360 : 0))
      .animation(spinning && !reduceMotion ? .linear(duration: 0.9).repeatForever(autoreverses: false) : .default, value: turn)
      .onAppear { turn = true }.accessibilityHidden(true)
  }
}
@MainActor @Observable final class NetworkReachability {
  /// One monitor for every screen that shows the connection.
  static let shared = NetworkReachability()
  private(set) var offline = false
  @ObservationIgnored private let monitor = NWPathMonitor()
  init() {
    monitor.pathUpdateHandler = { [weak self] path in Task { @MainActor in self?.offline = path.status != .satisfied } }
    monitor.start(queue: DispatchQueue(label: "dev.agentinterface.reachability"))
  }
  deinit { monitor.cancel() }
}
/// Lays children left to right and wraps to a new line when the row is full, like a flex-wrap container.
struct WrapLayout: Layout {
  var spacing: CGFloat = 8
  var lineSpacing: CGFloat = 8
  private func arrange(_ width: CGFloat, _ subviews: Subviews) -> (frames: [CGRect], size: CGSize) {
    var frames: [CGRect] = []
    var x: CGFloat = 0, y: CGFloat = 0, lineHeight: CGFloat = 0, widest: CGFloat = 0
    for subview in subviews {
      let size = subview.sizeThatFits(ProposedViewSize(width: width.isFinite ? width : nil, height: nil))
      if x > 0 && x + size.width > width { x = 0; y += lineHeight + lineSpacing; lineHeight = 0 }
      frames.append(CGRect(origin: CGPoint(x: x, y: y), size: size))
      x += size.width + spacing; lineHeight = max(lineHeight, size.height); widest = max(widest, x - spacing)
    }
    return (frames, CGSize(width: widest, height: y + lineHeight))
  }
  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    arrange(proposal.width ?? .infinity, subviews).size
  }
  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    for (subview, frame) in zip(subviews, arrange(bounds.width, subviews).frames) {
      subview.place(at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY), proposal: ProposedViewSize(frame.size))
    }
  }
}
extension View {
  /// Home has no title in the web app; the string stays as the name of the back button on pushed screens.
  @ViewBuilder func homeTitleHidden() -> some View {
    if #available(iOS 26, *) { toolbar(removing: .title) } else { self }
  }
  /// The web's two-line view header: title over a one-line subtitle, with the title kept for navigation and accessibility.
  func viewHeader(_ title: String, _ subtitle: String) -> some View {
    navigationTitle(title).navigationBarTitleDisplayMode(.inline).toolbar {
      ToolbarItem(placement: .principal) {
        VStack(spacing: 1) {
          Text(title).font(.headline).lineLimit(1)
          Text(subtitle).font(.caption2).foregroundStyle(Palette.muted).lineLimit(1).minimumScaleFactor(0.8)
        }.accessibilityElement(children: .ignore).accessibilityLabel(title + ". " + subtitle)
      }
    }
  }
}
struct AccountAvatar: View {
  var member: Member?
  var size: CGFloat = 44
  var body: some View {
    let initials = (member?.name ?? "").split(separator: " ").prefix(2).compactMap(\.first).map(String.init).joined().uppercased()
    ZStack {
      Circle().fill(Palette.accentSoft)
      Text(initials).font(.system(size: size * 0.34, weight: .semibold)).foregroundStyle(Palette.accent)
      if let picture = member?.picture, let url = URL(string: picture), url.scheme == "https" {
        AsyncImage(url: url) { image in image.resizable().scaledToFill() } placeholder: { Color.clear }
      }
    }.frame(width: size, height: size).clipShape(Circle()).accessibilityHidden(true)
  }
}
private struct AssistantListDate: View {
  var date: Date
  private let clock = MinuteClock.shared
  var body: some View {
    Text(When.listDate(date, now: clock.now)).font(.caption).foregroundStyle(.secondary).fixedSize()
  }
}

/// An assistant's current activity in words, with a dot in the state's color.
struct ActivityLabel: View {
  var state: ActivityState
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var dim = false
  private var color: Color {
    switch state {
    case .blocked: Palette.attention
    case .failed: Palette.danger
    case .waiting, .interrupted, .disconnected, .unknown: Palette.muted
    default: Palette.accent
    }
  }
  var body: some View {
    let breathes = !reduceMotion && (state == .thinking || state == .working)
    HStack(spacing: 6) {
      // One repeating animation that Core Animation drives, not a timeline redrawn 20 times a second.
      Circle().fill(color).frame(width: 6, height: 6).opacity(breathes && dim ? 0.35 : 1)
        .animation(breathes ? .easeInOut(duration: 0.9).repeatForever(autoreverses: true) : .default, value: dim)
        .onAppear { dim = true }
      Text(state.label).fontWeight(.medium)
    }.font(.caption).foregroundStyle(color)
  }
}

extension View {
  /// Lists sit on the app's surface color, like the assistant list.
  func householdListBackground() -> some View { modifier(HouseholdListBackground()) }
}
private struct HouseholdListBackground: ViewModifier {
  @Environment(\.colorScheme) private var scheme
  func body(content: Content) -> some View {
    content.scrollContentBackground(.hidden).background(Palette.surface(scheme))
  }
}
