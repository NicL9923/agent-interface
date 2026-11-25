import SwiftUI

extension View {
  /// The one confirmation every sign-out goes through, from Settings and from the profile menu.
  /// Nothing signs out until the person confirms; `signedOut` runs once the sign-out went through.
  func signOutConfirmation(isPresented: Binding<Bool>, store: AppStore, signedOut: @escaping () -> Void = {}) -> some View {
    confirmationDialog("Sign out on this device? Your personal drafts stay saved for your next sign-in.", isPresented: isPresented, titleVisibility: .visible) {
      Button("Sign out", role: .destructive) { Task { if await store.signOut() { signedOut() } } }
    }
  }
}

/// What Settings shows. Each edit is queued the moment the person makes it, with the chat style choice it
/// changed, so no later view update can replace it first, and an edit back to what the server held before
/// still goes out. The server's copy replaces the form only while the queue holds no edit made here.
@MainActor @Observable final class SettingsForm {
  var shown = Preferences()
  func load(_ store: AppStore) { shown = store.preferencesDraft ?? store.bootstrap?.preferences ?? Preferences() }
  /// Shows and queues `value`. `changed` names the chat style choice the edit made; other edits change none.
  func edit(_ value: Preferences, changed: Set<PreferenceChoice> = [], store: AppStore) {
    guard value != shown else { return }
    shown = value
    store.queuePreferences(value, changed: changed)
  }
  /// After the server's copy changes or saves finish: what the server holds, unless an edit is still unsaved.
  func resync(_ store: AppStore) {
    guard let server = store.bootstrap?.preferences else { return }
    shown = store.preferencesDraft ?? server
  }
}

struct PreferencesView: View {
  var close: (() -> Void)? = nil
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @Environment(\.colorScheme) private var scheme
  @State private var form = SettingsForm()
  private var preferences: Preferences { form.shown }
  @State private var reachability = NetworkReachability()
  private var saving: Bool { store.preferencesSaving }
  private var hermesUpdates: Bool { store.bootstrap?.showsHermesUpdates ?? true }
  private var saveFailed: Bool { store.preferencesSaveFailed }
  @State private var discardConfirm = false
  @State private var signOutConfirm = false
  @State private var changeServerConfirm = false
  @State private var quietError: String?
  @State private var macs: MacDeviceList?
  #if DEBUG
    @State private var captureComputerOpen = false
    @State private var captureUpgradeOpen = false
  #endif
  var body: some View {
    NavigationStack {
      ScrollViewReader { captureScroll in
      Form {
        Group {
        Section {
          HStack(spacing: 14) {
            AccountAvatar(member: store.bootstrap?.user, size: 52)
            VStack(alignment: .leading, spacing: 4) {
              Text(store.bootstrap?.user.name ?? "").font(.headline)
              Text(store.bootstrap?.user.email ?? "").font(.subheadline).foregroundStyle(.secondary)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Signed in as \(store.bootstrap?.user.name ?? ""), \(store.bootstrap?.user.email ?? "")")
            .accessibilityIdentifier("signedInAccount")
          }.padding(.vertical, 8)
        }
        Section {
          // Gone once a harness server's known roster has no Hermes assistant left; see `showsHermesUpdates`.
          if hermesUpdates {
            NavigationLink {
              HermesUpgradeView()
            } label: {
              settingsRow("Hermes and updates", icon: "arrow.triangle.2.circlepath",
                detail: store.householdReachable ? "Connected" + (store.bootstrap?.connection.hermesLabel.map { " · \($0)" } ?? "") : reachability.offline ? "Offline" : "Reconnecting",
                status: store.householdReachable ? Palette.accent : Palette.attention)
            }.accessibilityIdentifier("Hermes updates")
          }
          // The desktop opens in the app; its screen has the terminal button. The terminal runs without
          // the desktop, so the row stays open while either works.
          NavigationLink { ComputerView() } label: {
            settingsRow("Computer", icon: "desktopcomputer", detail: store.computerStatus?.detail ?? "Shared desktop and terminal")
          }.disabled(store.computerStatus.map { !$0.available && $0.terminal?.available != true } ?? false)
            .accessibilityIdentifier("sharedComputer")
          // Hidden while the server has no Mac link key, and on servers from before Mac links.
          if let macs, macs.available {
            NavigationLink { MacsView(list: $macs) } label: {
              settingsRow("Macs", icon: "laptopcomputer", detail: macs.summary)
            }.accessibilityIdentifier("macs")
          }
        }.task { await watchComputer() }
          .task(id: store.scope) { if let api = store.api { macs = try? await MacDeviceList.load(api) } }
        if let error = store.error {
          Section {
            ErrorBanner(message: error, dismiss: { store.dismissError() })
          }
        }
        if saveFailed { Section { Button("Retry saving settings") { enqueueSave() } } }
        if let notice = store.preferencesNotice {
          Section { NoticeBanner(message: notice) { store.preferencesNotice = nil }.accessibilityIdentifier("preferencesNotice") }
        }
        Section("Display") {
          Picker("Appearance", selection: edited().theme) {
            Text("Follow device").tag("system"); Text("Light").tag("light"); Text("Dark").tag("dark")
          }
          Picker("Chat style", selection: edited([.chatStyle]).chatStyleChoice) {
            Text("Bubbles").tag(ChatStyle.bubbles); Text("Classic").tag(ChatStyle.classic)
          }.accessibilityIdentifier("chatStyle")
          VStack(alignment: .leading, spacing: 4) {
            Picker("Your messages", selection: edited([.ownBubble]).ownBubbleChoice) {
              Text("Tinted").tag(OwnBubble.tint); Text("Solid color").tag(OwnBubble.solid)
            }.accessibilityIdentifier("ownBubble")
            Text("Solid color uses each assistant's color. Assistants with a photo keep the tint.").font(.caption).foregroundStyle(Palette.muted)
              .fixedSize(horizontal: false, vertical: true)
          }
          HStack {
            VStack(alignment: .leading, spacing: 4) {
              Text("Advanced details")
              Text("Reasoning, tool inputs and the model menu").font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            Toggle("Advanced details", isOn: Binding(get: { preferences.presentation == "advanced" }, set: { on in update { $0.presentation = on ? "advanced" : "simple" } }))
              .labelsHidden().fixedSize().accessibilityIdentifier("advancedDetails")
          }
          Picker("Start page", selection: Binding(get: { preferences.startPage ?? (preferences.defaultBotId == nil ? "today" : "assistant") }, set: { page in update { $0.startPage = page } })) {
            Text("Today").tag("today"); Text("Assistant").tag("assistant")
          }
          defaultPicker
        }.disabled(store.sessionExpired)
        Section {
          DeviceNotificationSettings().id("captureNotifications")
          LiveActivitySettings()
        } header: { Text("Notifications") }
          .disabled(store.sessionExpired)
        Section {
          VStack(alignment: .leading, spacing: 4) {
            Picker("Batching", selection: Binding(get: { preferences.notifications?.batchMinutes ?? 0 }, set: { value in
              var settings = notificationPreferences; settings.batchMinutes = value; update { $0.notifications = settings }
            })) {
              Text("As updates arrive").tag(0); Text("Every 5 minutes").tag(5); Text("Every 15 minutes").tag(15); Text("Hourly").tag(60)
            }
            Text("Decisions and failures skip batching.").font(.caption).foregroundStyle(Palette.muted)
              .fixedSize(horizontal: false, vertical: true)
          }
          if !bots.isEmpty { followRow }
          Toggle("Quiet hours", isOn: Binding(get: { preferences.notifications?.quietStart != nil }, set: { enabled in
            quietError = nil
            var settings = notificationPreferences; settings.quietStart = enabled ? "22:00" : nil
            settings.quietEnd = enabled ? "07:00" : nil; update { $0.notifications = settings }
          }))
          if preferences.notifications?.quietStart != nil {
            DatePicker("From", selection: quietTime(start: true), displayedComponents: .hourAndMinute).environment(\.timeZone, TimeZone(identifier: notificationPreferences.timezone) ?? .current)
            DatePicker("Until", selection: quietTime(start: false), displayedComponents: .hourAndMinute).environment(\.timeZone, TimeZone(identifier: notificationPreferences.timezone) ?? .current)
            if let quietError { Text(quietError).font(.footnote).foregroundStyle(Palette.danger).accessibilityIdentifier("quietHoursError") }
          }
        } header: { Text("Notifications on all your devices") } footer: {
          VStack(alignment: .leading, spacing: 6) {
            Text("These apply wherever you get notifications.")
            if preferences.notifications?.quietStart != nil {
              Text("Times are in \(notificationPreferences.timezone). During quiet hours, alerts wait until the end, except security alerts.")
            }
          }.fixedSize(horizontal: false, vertical: true)
        }.disabled(store.sessionExpired)
        if !bots.isEmpty {
          Section {
            HomeSectionRows(preferences: edited(), bots: bots)
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
            if hermesUpdates, let label = store.bootstrap?.connection.hermesLabel { Text(label).font(.caption).foregroundStyle(.secondary) }
            if hermesUpdates, let detail = store.bootstrap?.connection.hermesDetail {
              Text(detail).font(.caption2.monospaced()).foregroundStyle(.tertiary).textSelection(.enabled)
            }
          }.frame(maxWidth: .infinity).padding(.vertical, 12)
        }.listRowBackground(Color.clear)
        }.listRowBackground(Palette.raised(scheme))
      }.listSectionSpacing(18).contentMargins(.top, 12, for: .scrollContent)
        .householdListBackground().navigationTitle("Settings").navigationBarTitleDisplayMode(.inline)
        #if DEBUG
        .navigationDestination(isPresented: $captureComputerOpen) { ComputerView() }
        .navigationDestination(isPresented: $captureUpgradeOpen) { HermesUpgradeView() }
        .onAppear {
          captureComputerOpen = DebugFixtures.captureComputerPage; captureUpgradeOpen = DebugFixtures.captureUpgradePage
          if DebugFixtures.captureNotificationsPage {
            Task { try? await Task.sleep(for: .milliseconds(500)); captureScroll.scrollTo("captureNotifications", anchor: .top) }
          }
        }
        #endif
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("Close") { if saveFailed { discardConfirm = true } else { closeSheet() } } }
          ToolbarItem(placement: .status) {
            if saving { ProgressView("Saving…") }
            else if saveFailed { Text("Settings not saved").foregroundStyle(Palette.danger) }
          }
        }
        .onAppear { form.load(store) }
        // Once every save is in, the controls show what the server kept, which a server from before a
        // setting, or another device, may have answered differently. The end of the saves resyncs too,
        // because a server that drops a choice can answer with a copy equal to the one already read.
        .onChange(of: store.bootstrap?.preferences) { _, _ in form.resync(store) }
        .onChange(of: saving) { _, _ in form.resync(store) }
        .interactiveDismissDisabled(saveFailed)
        .confirmationDialog("Settings could not be saved. Discard these changes?", isPresented: $discardConfirm, titleVisibility: .visible) {
          Button("Discard changes", role: .destructive) { store.discardPreferenceChanges(); closeSheet() }
        }
        .onChange(of: store.scope) { _, _ in dismiss() }
        .signOutConfirmation(isPresented: $signOutConfirm, store: store) { closeSheet() }
        .confirmationDialog("Change the app server? Sign-out will revoke this device's session and notifications first.", isPresented: $changeServerConfirm, titleVisibility: .visible) {
          Button("Change server") { Task { await store.changeConnection(); if store.api == nil { closeSheet() } } }
        }
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
        if hermesUpdates { NavigationLink("Hermes updates") { HermesUpgradeView() } }
        LabeledContent("Server", value: store.host)
        if let detail = store.bootstrap?.connection.detail { Text(detail).font(.footnote).foregroundStyle(.secondary) }
        Button("Reconnect now") { Task { await store.reconnect() } }
        NavigationLink("Passwords & logins") { VaultView() }
        Button("Change server") { changeServerConfirm = true }
      }
    }.householdListBackground().navigationTitle("Connection").navigationBarTitleDisplayMode(.inline)
  }
  private func closeSheet() { if let close { close() } else { dismiss() } }
  /// Retries the failed save. The chat style choices it held stay queued.
  private func enqueueSave() { store.queuePreferences(preferences, changed: []) }
  /// The form, for a control whose edits are queued as they happen. `changed` names the chat style choice it sets.
  private func edited(_ changed: Set<PreferenceChoice> = []) -> Binding<Preferences> {
    Binding(get: { form.shown }, set: { form.edit($0, changed: changed, store: store) })
  }
  private func update(_ change: (inout Preferences) -> Void) {
    var next = form.shown; change(&next); form.edit(next, store: store)
  }
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
      guard settings.quietStart != settings.quietEnd else { quietError = "Start and end times can't match."; return }
      quietError = nil
      update { $0.notifications = settings }
    })
  }
  private var bots: [Bot] { store.bootstrap?.bots ?? [] }
  /// One summary row instead of a switch per assistant; the list it opens is a single multi-select.
  private var followRow: some View {
    NavigationLink {
      FollowedAssistantsView(preferences: edited(), bots: bots)
    } label: {
      VStack(alignment: .leading, spacing: 4) {
        Text(HomeSummary.following(bots.filter { preferences.isFollowing($0.id) }.count))
        Text("Choose whose activity you want to follow").font(.caption).foregroundStyle(.secondary)
      }
    }.accessibilityIdentifier("followedAssistants")
  }
  private var defaultPicker: some View {
    let selection = Binding<String>(
      get: { preferences.defaultBotId ?? "" },
      set: { value in update { $0.defaultBotId = value.isEmpty ? nil : value } })
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
    /// The color each object and creature is shown in, as on the web specimen. In the app a shape
    /// takes the color already chosen, and a seasonal one its own.
    private static let showcase: [AvatarShape: String] = {
      let shown: [AvatarShape: String] = [
        .cloud: "#00BCA6", .star: "#FF6700", .egg: "#F4F4F4", .shield: "#1084FE", .chat: "#9159FE",
        .lightbulb: "#FF9800", .mug: "#F4F4F4", .book: "#97683D", .camera: "#7A7A7A",
        .magnifier: "#1084FE", .controller: "#FF6700", .barbell: "#FF263C", .brain: "#FF309B",
        .rocket: "#7A7A7A", .palette: "#97683D", .paintBrush: "#1FBF68", .wateringCan: "#00BCA6",
        .sprout: "#1FBF68", .cactus: "#1FBF68", .witchHat: "#9159FE", .ghost: "#F4F4F4",
        .cat: "#FF9800", .bunny: "#FF309B", .bull: "#FF263C", .bear: "#97683D", .fox: "#FF6700",
        .owl: "#9159FE", .dino: "#1FBF68", .tars: "#7A7A7A", .rocky: "#97683D",
      ]
      return shown.merging(AvatarCatalog.seasonalColors) { $1 }
    }()
    static func shown(_ shape: AvatarShape) -> AvatarConfig {
      let index = AvatarConfig.shapes.firstIndex(of: shape) ?? 0
      return AvatarConfig(shape: shape, color: showcase[shape] ?? AvatarConfig.colors[index % AvatarConfig.colors.count])
    }
    /// The web specimen's state matrix across every activity state.
    private let matrix: [(String, AvatarConfig)] = {
      func with(_ shape: AvatarShape, _ change: (inout AvatarConfig) -> Void = { _ in }) -> AvatarConfig {
        var avatar = AvatarSpecimenView.shown(shape)
        change(&avatar)
        return avatar
      }
      return [
        ("Blob", AvatarConfig()),
        ("Triangle", AvatarConfig(shape: .triangle, color: "#FF309B", eyes: .visor)),
        ("Drop", AvatarConfig(shape: .drop, color: "#97683D", accessory: .hat)),
        ("Hex", AvatarConfig(shape: .hex, color: "#9159FE", accessory: .glasses)),
        ("Sprout", with(.sprout)),
        ("Mug", with(.mug) { $0.eyes = .round }),
        ("Ghost", with(.ghost)),
        ("Cactus", with(.cactus) { $0.accessory = .hat }),
        ("Dino", with(.dino)),
        ("TARS", with(.tars)),
        ("Rocky", with(.rocky) { $0.accessory = .glasses }),
        ("Pumpkin", with(.pumpkin)),
        ("Portrait", AvatarConfig(mode: .portrait, shape: nil, origin: "uploaded")),
      ]
    }()
    var body: some View {
      ScrollView {
        // Lazy, so offscreen specimens stop their animation timelines.
        LazyVStack(spacing: 24) {
          Picker("Mode", selection: $avatar.mode) {
            Text("Character").tag(AvatarMode.geometric)
            Text("Portrait").tag(AvatarMode.portrait)
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
          // The picker's four groups, each shape in its showcase color. Tapping one previews it above.
          ForEach(AvatarCatalog.groups, id: \.id) { group in
            VStack(alignment: .leading, spacing: 12) {
              Text(group.label).font(.headline)
              LazyVGrid(columns: [GridItem(.adaptive(minimum: 72), spacing: 8)], spacing: 12) {
                ForEach(group.shapes, id: \.self) { shape in
                  Button {
                    avatar = Self.shown(shape)
                  } label: {
                    VStack(spacing: 4) {
                      AvatarView(avatar: Self.shown(shape), size: 56, name: shape.label, forceReducedMotion: reduced)
                      Text(shape.label).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                    }
                  }.buttonStyle(.plain).accessibilityIdentifier("specimenShape.\(shape.rawValue)")
                }
              }
            }.accessibilityElement(children: .contain).accessibilityIdentifier("specimenGroup.\(group.id)")
          }
        }.padding(20)
      }.navigationTitle("Avatar specimen")
    }
  }
#endif
