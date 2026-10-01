import SwiftUI

struct RootView: View {
  @EnvironmentObject private var store: AppStore
  @Environment(\.colorScheme) private var scheme
  @State private var settingsBot: Bot?
  @State private var creatingBot = false
  @State private var preferencesOpen = false
  @State private var columnVisibility: NavigationSplitViewVisibility = .automatic
  @State private var compactColumn: NavigationSplitViewColumn = .sidebar
  var body: some View {
    Group {
      if store.bootstrap == nil {
        ConnectionView()
      } else {
        NavigationSplitView(
          columnVisibility: $columnVisibility, preferredCompactColumn: $compactColumn
        ) {
          BotListView(
            openPreferences: { preferencesOpen = true }, create: { creatingBot = true },
            openBot: { compactColumn = .detail })
        } detail: {
          if let bot = store.bot {
            ConversationView(bot: bot, edit: { settingsBot = bot }).id(bot.id)
          } else {
            ContentUnavailableView(
              "Choose an assistant", systemImage: "bubble.left.and.bubble.right",
              description: Text("Your assistants keep their conversations here."))
          }
        }
      }
    }
    .background(Palette.surface(scheme))
    .sheet(item: $settingsBot) { bot in BotSettingsView(bot: bot).environmentObject(store) }
    .sheet(isPresented: $creatingBot) { BotSettingsView(bot: nil).environmentObject(store) }
    .sheet(isPresented: $preferencesOpen) { PreferencesView().environmentObject(store) }
    .sheet(item: $store.openedFile) { FilePreview(file: $0).ignoresSafeArea() }
    .onReceive(store.$selectedBotId) { id in if id != nil { compactColumn = .detail } }
    .onChange(of: store.bootstrap?.user.id) { old, new in
      if let old, old != new {
        preferencesOpen = false
        settingsBot = nil
        creatingBot = false
        store.openedFile = nil
      }
    }
  }
}
struct ConnectionView: View {
  @EnvironmentObject private var store: AppStore
  @Environment(\.colorScheme) private var scheme
  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 24) {
          AvatarTrio().padding(.top, 28)
          VStack(alignment: .leading, spacing: 8) {
            Text(store.api == nil ? "Bring your assistants along" : "Your household, connected")
              .font(.largeTitle.bold())
            Text(
              store.api == nil
                ? "Connect to the Agent Interface app server your self-hoster set up. Your assistants and their work stay on that server."
                : "Sign in with an allowed household account. This device connects through the app server."
            ).foregroundStyle(.secondary)
          }
          if store.api == nil {
            VStack(alignment: .leading, spacing: 10) {
              Text("App server address").font(.headline)
              TextField("https://assistants.example.com", text: $store.host).textContentType(.URL)
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
            if store.authConfig?.localDevAuth == true {
              Text(
                "This development server also offers local test accounts in the sign-in browser."
              ).font(.footnote).foregroundStyle(.secondary)
            }
            Button("Change server") { Task { await store.changeConnection() } }.disabled(
              store.signingIn)
          }
          if let error = store.error { ErrorBanner(message: error, dismiss: { store.error = nil }) }
          Text(
            "Provider credentials and the Hermes gateway token are configured by the self-hoster on the server."
          ).font(.footnote).foregroundStyle(.secondary)
        }.padding(24).frame(maxWidth: 560)
      }.frame(maxWidth: .infinity).background(Palette.surface(scheme)).navigationTitle(
        "Agent Interface"
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
/// A small household of assistants, so the first screen shows who is waiting.
struct AvatarTrio: View {
  var body: some View {
    HStack(alignment: .bottom, spacing: 6) {
      AvatarView(
        avatar: AvatarConfig(shape: "blob", color: "#1084FE", eyes: "oval"), size: 64
      ).rotationEffect(.degrees(-6))
      AvatarView(
        avatar: AvatarConfig(mode: "mascot", shape: nil, family: "bear", color: "#FF9800", eyes: "round"),
        size: 84)
      AvatarView(
        avatar: AvatarConfig(shape: "triangle", color: "#FF309B", eyes: "oval"), size: 64
      ).rotationEffect(.degrees(5))
    }.accessibilityHidden(true)
  }
}
struct BotListView: View {
  @EnvironmentObject private var store: AppStore
  @Environment(\.colorScheme) private var scheme
  var openPreferences: () -> Void
  var create: () -> Void
  var openBot: () -> Void
  var body: some View {
    List {
      if let bootstrap = store.bootstrap {
        if !store.connected {
          Section {
            Text(
              store.sessionExpired
                ? "Sign in again to continue"
                : "Connection lost. Loaded conversations and drafts are kept."
            ).font(.footnote).foregroundStyle(.secondary)
            Button(store.sessionExpired ? "Sign in again" : "Reconnect now") {
              Task {
                if store.sessionExpired { await store.signIn() } else { await store.reconnect() }
              }
            }
          }
        }
        if !bootstrap.preferences.favorites.isEmpty {
          section("Favorites", ids: bootstrap.preferences.favorites)
        }
        ForEach(bootstrap.preferences.sections) { section in
          self.section(section.name, ids: section.botIds)
        }
        Section("Assistants") {
          ForEach(bootstrap.bots) { bot in row(bot) }
          if bootstrap.bots.isEmpty {
            Text("Create your first assistant.").foregroundStyle(.secondary)
          }
        }
      }
    }.scrollContentBackground(.hidden).background(Palette.surface(scheme))
      .navigationTitle("Your assistants")
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          Button(action: openPreferences) { Image(systemName: "slider.horizontal.3") }
            .accessibilityLabel("Your preferences")
        }
        ToolbarItem(placement: .topBarTrailing) {
          Button(action: create) { Image(systemName: "plus") }.accessibilityLabel(
            "Create assistant"
          ).disabled(!store.supports("botConfiguration") || !store.connected)
        }
      }
      .refreshable { await store.refreshBootstrap() }
  }
  @ViewBuilder private func section(_ title: String, ids: [String]) -> some View {
    Section(title) {
      ForEach(store.bootstrap?.bots.filter { ids.contains($0.id) } ?? []) { row($0) }
    }
  }
  private func row(_ bot: Bot) -> some View {
    let state =
      !store.connected
      ? ActivityState.disconnected : bot.id == store.selectedBotId ? store.activity : bot.activity
    // The list says what each assistant is doing in words, not only through motion.
    let reportsActivity = store.connected && state != .idle
    return Button {
      openBot()
      Task { await store.select(bot.id) }
    } label: {
      HStack(spacing: 12) {
        AvatarView(avatar: bot.avatar ?? AvatarConfig(), state: state, name: bot.name)
        VStack(alignment: .leading, spacing: 3) {
          Text(bot.name).foregroundStyle(.primary).font(.headline)
          if reportsActivity {
            ActivityLabel(state: state)
          } else {
            Text(bot.shared ? "Shared assistant" : "Personal assistant")
              .font(.caption).foregroundStyle(.secondary)
          }
        }
        Spacer(minLength: 0)
        if bot.id == store.selectedBotId {
          Image(systemName: "checkmark").foregroundStyle(Palette.accent)
        }
      }.padding(.vertical, 4)
    }.accessibilityIdentifier("bot.\(bot.id)").listRowBackground(Palette.raised(scheme))
      .contextMenu {
        Button(
          store.bootstrap?.preferences.favorites.contains(bot.id) == true
            ? "Remove favorite" : "Favorite", systemImage: "star"
        ) {
          Task {
            guard var p = store.bootstrap?.preferences else { return }
            if p.favorites.contains(bot.id) {
              p.favorites.removeAll { $0 == bot.id }
            } else {
              p.favorites.append(bot.id)
            }
            await store.setPreferences(p)
          }
        }
        Button("Open conversation", systemImage: "bubble.left") {
          Task { await store.select(bot.id) }
        }
      }
  }
}

/// An assistant's current activity in words, with a dot in the state's color.
struct ActivityLabel: View {
  var state: ActivityState
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  private var color: Color {
    switch state {
    case .blocked: Palette.attention
    case .failed: Palette.danger
    case .waiting, .interrupted, .disconnected: Palette.muted
    default: Palette.accent
    }
  }
  var body: some View {
    let breathes = !reduceMotion && (state == .thinking || state == .working)
    HStack(spacing: 6) {
      TimelineView(.animation(minimumInterval: 1 / 20, paused: !breathes)) { timeline in
        let phase = timeline.date.timeIntervalSinceReferenceDate / 1.8 * 2 * .pi
        Circle().fill(color).frame(width: 6, height: 6)
          .opacity(breathes ? 0.675 + 0.325 * cos(phase) : 1)
      }.frame(width: 6, height: 6)
      Text(state.label).fontWeight(.medium)
    }.font(.caption).foregroundStyle(color)
  }
}
