import SwiftUI

struct PreferencesView: View {
  var close: (() -> Void)? = nil
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @Environment(\.colorScheme) private var scheme
  @State private var preferences = Preferences()
  @State private var reachability = NetworkReachability()
  private var saving: Bool { store.preferencesSaving }
  private var saveFailed: Bool { store.preferencesSaveFailed }
  @State private var discardConfirm = false
  @State private var loaded = false
  @State private var signOutConfirm = false
  @State private var changeServerConfirm = false
  var body: some View {
    NavigationStack {
      Form {
        Group {
        Section {
          HStack(spacing: 14) {
            AccountAvatar(member: store.bootstrap?.user, size: 52)
            VStack(alignment: .leading, spacing: 4) {
              Text(store.bootstrap?.user.name ?? "").font(.headline)
              Text(store.bootstrap?.user.email ?? "").font(.subheadline).foregroundStyle(.secondary)
            }
          }.padding(.vertical, 8)
        }
        Section {
          NavigationLink {
            HermesUpgradeView()
          } label: {
            settingsRow("Hermes and updates", icon: "arrow.triangle.2.circlepath",
              detail: store.connected ? "Connected" + (store.bootstrap?.connection.hermesLabel.map { " · \($0)" } ?? "") : reachability.offline ? "Offline" : "Reconnecting",
              status: store.connected ? Palette.accent : Palette.attention)
          }.accessibilityIdentifier("Hermes updates")
          if let url = try? store.api?.url("/?computer=1") {
            Link(destination: url) {
              settingsRow("Computer", icon: "desktopcomputer", detail: store.computerStatus?.detail ?? "Shared desktop and terminal")
            }.disabled(store.computerStatus?.available == false).accessibilityIdentifier("sharedComputer")
          }
          NavigationLink { IntegrationsView() } label: {
            settingsRow("Integrations", icon: "powerplug", detail: "Accounts your assistants can use")
          }.accessibilityIdentifier("Integrations")
        }.task { await watchComputer() }
        if let error = store.error {
          Section {
            ErrorBanner(message: error, dismiss: { store.error = nil })
          }
        }
        if saveFailed { Section { Button("Retry saving settings") { enqueueSave() } } }
        Section("Display") {
          Picker("Appearance", selection: $preferences.theme) {
            Text("Follow device").tag("system"); Text("Light").tag("light"); Text("Dark").tag("dark")
          }
          HStack {
            VStack(alignment: .leading, spacing: 4) {
              Text("Advanced details")
              Text("Reasoning, tool inputs and the model menu").font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            Toggle("Advanced details", isOn: Binding(get: { preferences.presentation == "advanced" }, set: { preferences.presentation = $0 ? "advanced" : "simple" }))
              .labelsHidden().fixedSize().accessibilityIdentifier("advancedDetails")
          }
          Picker("Start page", selection: Binding(get: { preferences.startPage ?? (preferences.defaultBotId == nil ? "today" : "assistant") }, set: { preferences.startPage = $0 })) {
            Text("Today").tag("today"); Text("Assistant").tag("assistant")
          }
          defaultPicker
        }.disabled(store.sessionExpired)
        Section {
          DeviceNotificationSettings()
          Picker("Batching", selection: Binding(get: { preferences.notifications?.batchMinutes ?? 0 }, set: { value in
            var settings = notificationPreferences; settings.batchMinutes = value; preferences.notifications = settings
          })) {
            Text("As updates arrive").tag(0); Text("Every 5 minutes").tag(5); Text("Every 15 minutes").tag(15); Text("Hourly").tag(60)
          }
          Toggle("Quiet hours", isOn: Binding(get: { preferences.notifications?.quietStart != nil }, set: { enabled in
            var settings = notificationPreferences; settings.quietStart = enabled ? "22:00" : nil
            settings.quietEnd = enabled ? "07:00" : nil; preferences.notifications = settings
          }))
          if preferences.notifications?.quietStart != nil {
            DatePicker("From", selection: quietTime(start: true), displayedComponents: .hourAndMinute).environment(\.timeZone, TimeZone(identifier: notificationPreferences.timezone) ?? .current)
            DatePicker("Until", selection: quietTime(start: false), displayedComponents: .hourAndMinute).environment(\.timeZone, TimeZone(identifier: notificationPreferences.timezone) ?? .current)
          }
          if !bots.isEmpty { followRow }
        } header: { Text("Notifications") } footer: {
          if preferences.notifications?.quietStart != nil {
            Text("\(notificationPreferences.timezone). Other notifications wait until quiet hours end; security alerts arrive right away. Decisions and failures skip batching outside quiet hours.")
          }
        }.disabled(store.sessionExpired)
        if !bots.isEmpty {
          Section {
            HomeSectionRows(preferences: $preferences, bots: bots)
          } header: { Text("Home sections") } footer: {
            Text("Group assistants on home. Each assistant can be in one section.")
          }.disabled(store.sessionExpired)
        }
        Section {
          if store.sessionExpired { Button("Sign in again") { Task { await store.signIn() } } }
          Button("Sign out", role: .destructive) { signOutConfirm = true }
        }
        Section("About") { AppVersionRows(update: store.appUpdate); NavigationLink("Connection") { connection } }
        #if DEBUG
          Section("Development") { NavigationLink("Avatar specimen") { AvatarSpecimenView() } }
        #endif
        Section {
          VStack(spacing: 6) {
            Text("w.").font(.largeTitle.bold()).foregroundStyle(Palette.accent)
            Text("WildBots").font(.headline)
            if let label = store.bootstrap?.connection.hermesLabel { Text(label).font(.caption).foregroundStyle(.secondary) }
            if let detail = store.bootstrap?.connection.hermesDetail {
              Text(detail).font(.caption2.monospaced()).foregroundStyle(.tertiary).textSelection(.enabled)
            }
          }.frame(maxWidth: .infinity).padding(.vertical, 12)
        }.listRowBackground(Color.clear)
        }.listRowBackground(Palette.raised(scheme))
      }.listSectionSpacing(18).contentMargins(.top, 12, for: .scrollContent)
        .householdListBackground().navigationTitle("Settings").navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("Close") { if saveFailed { discardConfirm = true } else { closeSheet() } } }
          ToolbarItem(placement: .status) {
            if saving { ProgressView("Saving…") }
            else if saveFailed { Text("Settings not saved").foregroundStyle(Palette.danger) }
          }
        }
        .onAppear { preferences = store.preferencesDraft ?? store.bootstrap?.preferences ?? Preferences(); loaded = true }
        .onChange(of: store.bootstrap?.preferences) { _, value in
          if let value, !saving && !saveFailed { preferences = value }
        }
        .onChange(of: preferences) { _, value in
          if loaded && value != store.preferencesDraft && value != store.bootstrap?.preferences { enqueueSave() }
        }
        .interactiveDismissDisabled(saveFailed)
        .confirmationDialog("Settings could not be saved. Discard these changes?", isPresented: $discardConfirm, titleVisibility: .visible) {
          Button("Discard changes", role: .destructive) { store.discardPreferenceChanges(); closeSheet() }
        }
        .onChange(of: store.scope) { _, _ in dismiss() }
        .confirmationDialog("Sign out on this device? Your personal drafts stay saved for your next sign-in.", isPresented: $signOutConfirm, titleVisibility: .visible) {
          Button("Sign out", role: .destructive) { Task { if await store.signOut() { closeSheet() } } }
        }
        .confirmationDialog("Change the app server? Sign-out will revoke this device's session and notifications first.", isPresented: $changeServerConfirm, titleVisibility: .visible) {
          Button("Change server") { Task { await store.changeConnection(); if store.api == nil { closeSheet() } } }
        }
    }
  }
  /// The web panel polls the shared computer every few seconds while open; Settings checks while it is shown.
  private func watchComputer() async {
    while !Task.isCancelled {
      await store.refreshComputer()
      do { try await Task.sleep(for: .seconds(10)) } catch { return }
    }
  }
  private var notificationPreferences: NotificationPreferences {
    preferences.notifications ?? NotificationPreferences(timezone: TimeZone.current.identifier, batchMinutes: 0)
  }
  private func settingsRow(_ title: String, icon: String, detail: String, status: Color? = nil) -> some View {
    HStack(spacing: 12) {
      Image(systemName: icon).foregroundStyle(Palette.accent).frame(width: 24)
        .overlay(alignment: .topTrailing) {
          if let status { Circle().fill(status).frame(width: 8, height: 8).offset(x: 3, y: -3).accessibilityHidden(true) }
        }
      VStack(alignment: .leading, spacing: 4) {
        Text(title).foregroundStyle(Color.primary)
        Text(detail).font(.caption).foregroundStyle(Palette.muted)
      }
    }.padding(.vertical, 4)
  }
  private var connection: some View {
    Form {
      Section {
        NavigationLink("Hermes updates") { HermesUpgradeView() }
        LabeledContent("Server", value: store.host)
        if let detail = store.bootstrap?.connection.detail { Text(detail).font(.footnote).foregroundStyle(.secondary) }
        Button("Reconnect now") { Task { await store.reconnect() } }
        NavigationLink("Passwords & logins") { VaultView() }
        Button("Change server") { changeServerConfirm = true }
      }
    }.householdListBackground().navigationTitle("Connection").navigationBarTitleDisplayMode(.inline)
  }
  private func closeSheet() { if let close { close() } else { dismiss() } }
  private func enqueueSave() { store.queuePreferences(preferences) }
  private func quietTime(start: Bool) -> Binding<Date> {
    Binding(get: {
      let value = (start ? preferences.notifications?.quietStart : preferences.notifications?.quietEnd) ?? (start ? "22:00" : "07:00")
      let parts = value.split(separator: ":").compactMap { Int($0) }
      var calendar = Calendar.current
      calendar.timeZone = TimeZone(identifier: notificationPreferences.timezone) ?? .current
      return calendar.date(from: DateComponents(year: 2026, month: 1, day: 1, hour: parts.first ?? 0, minute: parts.count > 1 ? parts[1] : 0)) ?? Date()
    }, set: { date in
      var calendar = Calendar.current
      calendar.timeZone = TimeZone(identifier: notificationPreferences.timezone) ?? .current
      let value = String(format: "%02d:%02d", calendar.component(.hour, from: date), calendar.component(.minute, from: date))
      var settings = notificationPreferences
      if start { settings.quietStart = value } else { settings.quietEnd = value }
      preferences.notifications = settings
    })
  }
  private var bots: [Bot] { store.bootstrap?.bots ?? [] }
  /// One summary row instead of a switch per assistant; the list it opens is a single multi-select.
  private var followRow: some View {
    NavigationLink {
      FollowedAssistantsView(preferences: $preferences, bots: bots)
    } label: {
      VStack(alignment: .leading, spacing: 4) {
        Text(HomeSummary.following(bots.filter { preferences.isFollowing($0.id) }.count))
        Text("All of their activity, not just shared tasks").font(.caption).foregroundStyle(.secondary)
      }
    }.accessibilityIdentifier("followedAssistants")
  }
  private var defaultPicker: some View {
    let selection = Binding<String>(
      get: { preferences.defaultBotId ?? "" },
      set: { value in preferences.defaultBotId = value.isEmpty ? nil : value })
    return Picker("Open by default", selection: selection) {
      Text("First assistant").tag("")
      ForEach(store.bootstrap?.bots ?? []) { bot in Text(bot.name).tag(bot.id) }
    }
  }
}

#if DEBUG
  struct AvatarSpecimenView: View {
    @State private var avatar = AvatarConfig()
    @State private var reduced = false
    @State private var matrixWidth: CGFloat = 353
    @ScaledMetric(relativeTo: .caption2) private var specimenLabel: CGFloat = 9
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
                    .font(.system(size: specimenLabel)).foregroundStyle(.secondary).lineLimit(3)
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
