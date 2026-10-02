import SwiftUI

struct PreferencesView: View {
  @EnvironmentObject private var store: AppStore
  @Environment(\.dismiss) private var dismiss
  @State private var preferences = Preferences()
  @State private var sectionName = ""
  @State private var saving = false
  @State private var signOutConfirm = false
  @State private var changeServerConfirm = false
  @State private var notificationBusy = false
  var body: some View {
    NavigationStack {
      Form {
        if let error = store.error {
          Section { ErrorBanner(message: error, dismiss: { store.error = nil }) }
        }
        Section("Your preferences") {
          Picker("Presentation", selection: $preferences.presentation) {
            Text("Simple").tag("simple")
            Text("Advanced").tag("advanced")
          }
          Picker("Theme", selection: $preferences.theme) {
            Text("System").tag("system")
            Text("Light").tag("light")
            Text("Dark").tag("dark")
          }
          defaultPicker
        }
        Section("Favorites") {
          ForEach(store.bootstrap?.bots ?? []) { bot in
            Toggle(bot.name, isOn: membership(bot.id, \Preferences.favorites))
          }
        }
        ForEach(preferences.sections) { section in sectionEditor(section) }
        Section("Add section") {
          TextField("Section name", text: $sectionName)
          Button("Add section") {
            preferences.sections.append(
              BotSection(
                id: UUID().uuidString,
                name: sectionName.trimmingCharacters(in: .whitespacesAndNewlines), botIds: []))
            sectionName = ""
          }.disabled(
            sectionName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
              || preferences.sections.count >= 30)
        }
        Section {
          Text(store.notificationStatus).font(.footnote).foregroundStyle(.secondary)
          Button("Enable device notifications") {
            notification { await NotificationController.shared.enable() }
          }
          Button("Disable device notifications") {
            notification { await NotificationController.shared.disable() }
          }
          if let id = store.selectedBotId {
            Button("Send test notification") {
              notification { await NotificationController.shared.test(botId: id) }
            }
          }
          Button("Open iOS notification settings") {
            if let url = URL(string: UIApplication.openSettingsURLString) {
              UIApplication.shared.open(url)
            }
          }
          ForEach(store.bootstrap?.bots ?? []) { bot in
            Toggle(
              "Follow all \(bot.name) activity", isOn: membership(bot.id, \Preferences.followBots))
          }
        } header: {
          Text("Notifications")
        } footer: {
          Text(
            "By default, completion and approval notifications go to task participants. Following an assistant includes all its activity. Routine recipients are selected in each routine."
          )
        }
        .disabled(notificationBusy || store.sessionExpired)
        if let url = try? store.api?.url("/?computer=1") {
          Section {
            Link(destination: url) {
              Label("Open computer in browser", systemImage: "desktopcomputer")
            }.accessibilityIdentifier("sharedComputer")
          } header: {
            Text("Computer")
          } footer: {
            Text(
              "Use the shared desktop and VPS terminal in your browser. Sign in there with your household account if asked."
            )
          }
        }
        Section("Connection") {
          LabeledContent("Server", value: store.host)
          if let version = store.bootstrap?.connection.version {
            LabeledContent("Hermes", value: version)
          }
          if let detail = store.bootstrap?.connection.detail {
            Text(detail).font(.footnote).foregroundStyle(.secondary)
          }
          Button("Reconnect now") { Task { await store.reconnect() } }
          NavigationLink("Integrations") { IntegrationsView() }
          NavigationLink("Passwords & logins") { VaultView() }
          NavigationLink("Hermes updates") { HermesUpgradeView() }
          Button("Change server") { changeServerConfirm = true }
        }
        Section("Account") {
          Text(store.bootstrap?.user.name ?? "")
          Text(store.bootstrap?.user.email ?? "").font(.footnote).foregroundStyle(.secondary)
          if store.sessionExpired { Button("Sign in again") { Task { await store.signIn() } } }
          Button("Sign out", role: .destructive) { signOutConfirm = true }
        }
        #if DEBUG
          Section("Development") { NavigationLink("Avatar specimen") { AvatarSpecimenView() } }
        #endif
      }.navigationTitle("Your preferences").navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
          ToolbarItem(placement: .confirmationAction) {
            Button(saving ? "Saving…" : "Save") {
              saving = true
              Task {
                await store.setPreferences(preferences)
                saving = false
              }
            }.disabled(saving || store.sessionExpired)
          }
        }
        .onAppear { preferences = store.bootstrap?.preferences ?? Preferences() }
        .confirmationDialog(
          "Sign out on this device? Your personal drafts stay saved for your next sign-in.",
          isPresented: $signOutConfirm, titleVisibility: .visible
        ) {
          Button("Sign out", role: .destructive) { Task { if await store.signOut() { dismiss() } } }
        }
        .confirmationDialog(
          "Change the app server? Sign-out will revoke this device's session and notifications first.",
          isPresented: $changeServerConfirm, titleVisibility: .visible
        ) {
          Button("Change server") {
            Task {
              await store.changeConnection()
              if store.api == nil { dismiss() }
            }
          }
        }
    }
  }
  private func membership(_ id: String, _ keyPath: WritableKeyPath<Preferences, [String]>)
    -> Binding<Bool>
  {
    Binding(
      get: { preferences[keyPath: keyPath].contains(id) },
      set: {
        if $0 {
          if !preferences[keyPath: keyPath].contains(id) {
            preferences[keyPath: keyPath].append(id)
          }
        } else {
          preferences[keyPath: keyPath].removeAll { $0 == id }
        }
      })
  }
  private var defaultPicker: some View {
    let selection = Binding<String>(
      get: { preferences.defaultBotId ?? "" },
      set: { value in preferences.defaultBotId = value.isEmpty ? nil : value })
    return Picker("Default assistant", selection: selection) {
      Text("First available").tag("")
      ForEach(store.bootstrap?.bots ?? []) { bot in Text(bot.name).tag(bot.id) }
    }
  }
  private func sectionEditor(_ section: BotSection) -> some View {
    Section {
      TextField(
        "Section name",
        text: Binding(
          get: { preferences.sections.first { $0.id == section.id }?.name ?? "" },
          set: { name in
            if let index = preferences.sections.firstIndex(where: { $0.id == section.id }) {
              preferences.sections[index].name = name
            }
          }))
      ForEach(store.bootstrap?.bots ?? []) { bot in
        Toggle(bot.name, isOn: sectionMembership(section.id, bot.id))
      }
      Button("Delete section", role: .destructive) {
        preferences.sections.removeAll { $0.id == section.id }
      }
    } header: {
      Text(section.name.isEmpty ? "Untitled section" : section.name)
    }
  }
  private func sectionMembership(_ sectionId: String, _ botId: String) -> Binding<Bool> {
    Binding(
      get: { preferences.sections.first { $0.id == sectionId }?.botIds.contains(botId) == true },
      set: { selected in
        guard let index = preferences.sections.firstIndex(where: { $0.id == sectionId }) else {
          return
        }
        if selected {
          preferences.sections[index].botIds.append(botId)
        } else {
          preferences.sections[index].botIds.removeAll { $0 == botId }
        }
      })
  }
  private func notification(_ operation: @escaping () async -> Void) {
    notificationBusy = true
    Task {
      await operation()
      notificationBusy = false
    }
  }
}

#if DEBUG
  struct AvatarSpecimenView: View {
    @State private var avatar = AvatarConfig()
    @State private var reduced = false
    @State private var matrixWidth: CGFloat = 353
    /// The web specimen's state matrix across every activity state.
    private let matrix: [(String, AvatarConfig)] = [
      ("Blob", AvatarConfig()),
      ("Triangle", AvatarConfig(shape: "triangle", color: "#FF309B", eyes: "visor")),
      ("Drop", AvatarConfig(shape: "drop", color: "#97683D", accessory: "hat")),
      ("Hex", AvatarConfig(shape: "hex", color: "#9159FE", accessory: "glasses")),
      ("Bear", AvatarConfig(mode: "mascot", shape: nil, family: "bear", color: "#FF9800", eyes: "round")),
      ("Fox", AvatarConfig(mode: "mascot", shape: nil, family: "fox", color: "#FF6700")),
      ("Sprout", AvatarConfig(mode: "mascot", shape: nil, family: "sprout", color: "#00BCA6", accessory: "hat")),
      ("Portrait", AvatarConfig(mode: "portrait", shape: nil, origin: "uploaded")),
    ] + AvatarConfig.families.filter { AvatarConfig.seasonalColors[$0.id] != nil }.map {
      ($0.label, AvatarConfig(mode: "mascot", shape: nil, eyes: "round").selectingFamily($0.id))
    }
    var body: some View {
      ScrollView {
        // Lazy, so offscreen specimens stop their animation timelines.
        LazyVStack(spacing: 24) {
          Picker("Mode", selection: $avatar.mode) {
            Text("Geometric").tag("geometric")
            Text("Mascot").tag("mascot")
            Text("Portrait").tag("portrait")
          }.pickerStyle(.segmented)
          Toggle("Reduced motion", isOn: $reduced)
          LazyVGrid(columns: [GridItem(.adaptive(minimum: 120))], spacing: 24) {
            ForEach(ActivityState.allCases, id: \.self) { state in
              VStack(spacing: 8) {
                AvatarView(avatar: avatar, state: state, size: 100, forceReducedMotion: reduced)
                Text(state.label).font(.caption)
              }
            }
          }
          VStack(alignment: .leading, spacing: 12) {
            Text("State matrix").font(.headline)
            // One row per character, one column per state, sized to fit the width.
            let cell = min(64, max(28, (matrixWidth - 8 * 8) / 9))
            Grid(horizontalSpacing: 8, verticalSpacing: 12) {
              GridRow {
                ForEach(ActivityState.allCases, id: \.self) { state in
                  Text(state.label.replacingOccurrences(of: " ", with: "\n"))
                    .font(.system(size: 9)).foregroundStyle(.secondary).lineLimit(3)
                    .minimumScaleFactor(0.5).multilineTextAlignment(.center).frame(width: cell)
                }
              }
              ForEach(matrix, id: \.0) { label, config in
                GridRow {
                  ForEach(ActivityState.allCases, id: \.self) { state in
                    AvatarView(
                      avatar: config, state: state, size: cell, name: label,
                      forceReducedMotion: reduced)
                  }
                }
              }
            }.frame(maxWidth: .infinity)
          }.onGeometryChange(for: CGFloat.self) { $0.size.width } action: { matrixWidth = $0 }
            .accessibilityElement(children: .contain).accessibilityIdentifier("avatarMatrix")
          ForEach(AvatarConfig.shapes, id: \.self) { shape in
            HStack {
              AvatarView(avatar: AvatarConfig(shape: shape), size: 64)
              Text(shape.capitalized)
              Spacer()
            }
          }
        }.padding(20)
      }.navigationTitle("Avatar specimen")
    }
  }
#endif
