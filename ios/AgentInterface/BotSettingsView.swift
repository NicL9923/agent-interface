import SwiftUI
import UniformTypeIdentifiers

/// The five parts of an assistant's settings, in the order the sheet lists them.
enum SettingsSection: String, CaseIterable, Identifiable, Hashable {
  case profile, behavior, access, automation, memory
  var id: String { rawValue }
  var label: String {
    switch self {
    case .profile: "Profile"
    case .behavior: "Behavior"
    case .access: "Access"
    case .automation: "Automation"
    case .memory: "Memory & learning"
    }
  }
  var systemImage: String {
    switch self {
    case .profile: "person.crop.circle"
    case .behavior: "slider.horizontal.3"
    case .access: "key"
    case .automation: "clock.arrow.circlepath"
    case .memory: "brain"
    }
  }
  /// The one-line summary under each section in the settings list.
  func summary(shared: Bool, modelName: String) -> String {
    switch self {
    case .profile: shared ? "Shared with your household" : "Personal"
    case .behavior: modelName
    case .access: "Connections and logins"
    case .automation: "Routines, goals, tasks and triggers"
    case .memory: "What it remembers and learns"
    }
  }
}

/// A page in the settings stack: one section, or a full list that a section opens.
enum SettingsRoute: Hashable {
  case section(SettingsSection)
  case connections, logins, approvals, work, memory, learning
  var title: String {
    switch self {
    case .section(let section): section.label
    case .connections: "Connections"
    case .logins: "Logins"
    case .approvals: "Always-allowed commands"
    case .work: "Work"
    case .memory: "Memory"
    case .learning: "Learning"
    }
  }
  /// The pages that show `name`, a section or the name of a former tab, for direct captures.
  static func path(for name: String) -> [SettingsRoute]? {
    switch name.lowercased() {
    case "profile", "details", "avatar": [.section(.profile)]
    case "behavior", "tools", "skills": [.section(.behavior)]
    case "access": [.section(.access)]
    case "connections": [.section(.access), .connections]
    case "logins": [.section(.access), .logins]
    case "approvals", "always-allowed commands": [.section(.access), .approvals]
    case "automation", "routines": [.section(.automation)]
    case "work": [.section(.automation), .work]
    case "memory & learning", "memoryandlearning": [.section(.memory)]
    case "memory": [.section(.memory), .memory]
    case "learning": [.section(.memory), .learning]
    default: nil
    }
  }
}

/// The MCP server switches: every server the profile has, plus any enabled one it no longer lists.
enum McpServerChoices {
  static func names(available: [String], enabled: [String]) -> [String] {
    Array(Set(available).union(enabled)).sorted()
  }
  /// Turning one server on or off keeps the others where they were.
  static func toggled(_ enabled: [String], _ name: String, on: Bool) -> [String] {
    on ? (enabled.contains(name) ? enabled : enabled + [name]) : enabled.filter { $0 != name }
  }
}

/// What one Save changes says when it finishes. Only the assistant's own fields mention sharing.
func settingsSavedNotice(patched: Bool, shared: Bool) -> String {
  guard patched else { return "Saved" }
  return shared ? "Changes saved for both household members." : "Assistant saved."
}

struct BotSettingsView: View {
  private let initialBot: Bot?
  var close: (() -> Void)?
  init(bot: Bot?, close: (() -> Void)? = nil) {
    initialBot = bot
    self.close = close
    #if DEBUG
    if let tab = DebugFixtures.captureSettingsTab, let route = SettingsRoute.path(for: tab) { _path = State(initialValue: route) }
    #endif
  }
  /// Set when creation succeeded but the avatar did not save, turning the sheet into that
  /// assistant's settings so the chosen look can be retried instead of lost.
  @State private var createdBot: Bot?
  /// The assistant being edited: the one opened, or the one this sheet just created.
  private var bot: Bot? { initialBot ?? createdBot }
  private var savedName: String { savedForm.name.isEmpty ? bot?.name ?? "New assistant" : savedForm.name }
  @State private var creationStep = CreationStep.look
  @State private var avatarFailure: String?
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @Environment(\.colorScheme) private var scheme
  @State private var form = BotInput()
  @State private var savedForm = BotInput()
  @State private var savedAvatar = AvatarConfig()
  @State private var savedCapabilities: [CatalogKind: Set<String>] = [:]
  @State private var confirmation: SettingsConfirmation?
  @State private var acceptedConfirmation: SettingsConfirmation?
  @State private var initialized = false
  @State private var detailLoaded = false
  /// Why the assistant's settings didn't load. Page messages clear on navigation; this stays until Retry.
  @State private var detailError: String?
  @State private var avatar = AvatarConfig()
  @State private var lastDrawn = AvatarConfig()
  @State private var lastPortrait: AvatarConfig?
  @State private var previewState: ActivityState = .idle
  @State private var path: [SettingsRoute] = []
  /// A page change normally clears the last message; creation's avatar failure keeps its own.
  @State private var keepMessages = false
  @State private var memoryDirty = false
  @State private var memorySaving = false
  @State private var tools: [CapabilityItem] = []
  @State private var skills: [CapabilityItem] = []
  @State private var routines: [Routine] = []
  @State private var busy = false
  @State private var error: String?
  @State private var notice: String?
  @State private var personalConfirmed = false
  @State private var portraitImport = false
  @FocusState private var portraitPromptFocused: Bool
  @FocusState private var nameFocused: Bool
  /// Raised when a save needs the name, so the Name field takes focus once Profile shows it.
  @State private var focusNameRequest = 0
  @State private var portraitPrompt = ""
  @State private var portraitOperation: String?
  @State private var editingRoutine: Routine?
  @State private var addingRoutine = false
  @State private var availableMcpServers: [String] = []
  @State private var templates: [RoutineTemplate] = []
  @State private var deletingRoutine: Routine?
  @State private var catalogReady: Set<CatalogKind> = []
  @State private var catalogLoading: Set<CatalogKind> = []
  /// Hermes's installed skills, for the lock and read actions on Behavior's skill rows.
  @State private var skillControl: HermesAutomationControls?
  @State private var readingSkill: HermesInstalledSkill?
  @State private var progress = SaveProgress()
  private var advanced: Bool { store.bootstrap?.preferences.presentation == "advanced" }

  var body: some View {
    routinePresentations(NavigationStack(path: $path) {
      editor.navigationDestination(for: SettingsRoute.self) { destination($0) }
    })
    .task { await loadDetail() }
    .onChange(of: path) { _, _ in
      // A message belongs to the screen that produced it, so it does not follow you to another page.
      if keepMessages { keepMessages = false } else { error = nil; notice = nil }
    }
    .interactiveDismissDisabled(dirty || busy || memorySaving)
    .onChange(of: avatar) { _, value in
      if value.mode != .portrait {
        lastDrawn = value
      } else if !(value.src ?? "").isEmpty {
        lastPortrait = value
      }
    }
    .sheet(item: $confirmation, onDismiss: performConfirmation) { item in
      AssistantConfirmationSheet(title: item.title, message: item.message,
        acceptLabel: item.acceptLabel, keepLabel: item.keepLabel, destructive: item.destructive,
        accept: { acceptedConfirmation = item; confirmation = nil },
        keep: { confirmation = nil })
    }
    .fileImporter(
      isPresented: $portraitImport, allowedContentTypes: [.png, .jpeg, .webP],
      allowsMultipleSelection: false
    ) { result in
      switch result {
      case .success(let urls): if let url = urls.first { uploadPortrait(url) }
      case .failure(let error): self.error = error.localizedDescription
      }
    }
  }
  enum CreationStep { case look, role }
  /// Creation is two short steps in one sheet: name and look, then role and model. Sections that
  /// need an existing assistant stay hidden until it exists.
  @ViewBuilder private var creationContent: some View {
    if let error { ErrorBanner(message: error, dismiss: { self.error = nil }).padding(.horizontal) }
    Form {
      creationHeader
      Section { unavailable(.botConfiguration) }
      if creationStep == .look {
        nameSection
        avatarPreview
        avatarControls
        Section {
          Button { creationStep = .role } label: {
            Text("Next: role and model").frame(maxWidth: .infinity, minHeight: 44)
          }.buttonStyle(.accentProminent).disabled(!nameReady)
            .accessibilityIdentifier("creationNextBottom")
        } footer: { if !nameReady { Text("Name the assistant to continue.").foregroundStyle(Palette.muted) } }
          .listRowBackground(Color.clear).listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
      } else {
        roleSections
        Section {
          Button { saveBot() } label: {
            Text(progress.label("details", idle: "Create assistant")).frame(maxWidth: .infinity, minHeight: 44)
          }.buttonStyle(.accentProminent).disabled(!canSave)
        }.listRowBackground(Color.clear).listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
      }
    }.id(creationStep) // Each step opens at its top, not at the last step's scroll position.
      .householdListBackground().disabled(busy).accessibilityIdentifier("assistantCreationForm")
  }
  private var creationHeader: some View {
    Section {
      VStack(alignment: .leading, spacing: 2) {
        Text(creationStep == .look ? "Step 1 of 2" : "Step 2 of 2").font(.subheadline).foregroundStyle(Palette.muted)
        Text(creationStep == .look ? "Name and look" : "Role and model").font(.title3.bold())
          .accessibilityAddTraits(.isHeader)
      }.accessibilityElement(children: .combine).accessibilityIdentifier("creationStep")
    }.listRowBackground(Color.clear).listRowInsets(EdgeInsets(top: 0, leading: 4, bottom: 0, trailing: 4))
  }
  private var closeButton: some View {
    Button("Close") { if dirty { confirmation = .discard } else { closeSheet() } }.disabled(busy || memorySaving)
  }
  @ToolbarContentBuilder private var editorToolbar: some ToolbarContent {
    ToolbarItem(placement: .cancellationAction) {
      if bot == nil && creationStep == .role {
        Button { creationStep = .look } label: { Label("Back", systemImage: "chevron.backward").labelStyle(.titleAndIcon) }
          .disabled(busy).accessibilityIdentifier("creationBack")
      } else {
        closeButton
      }
    }
    if bot == nil {
      ToolbarItem(placement: .confirmationAction) {
        if creationStep == .look {
          Button("Next") { creationStep = .role }.disabled(!nameReady).accessibilityIdentifier("creationNext")
        } else {
          Button(progress.label("details", idle: "Create")) { saveBot() }.disabled(busy || !canSave)
            .accessibilityIdentifier("creationCreate")
        }
      }
    } else {
      // The list's own title reads "All settings" so each page's back button does; the bar shows the name.
      ToolbarItem(placement: .principal) {
        Text(savedName).font(.headline).lineLimit(1).accessibilityAddTraits(.isHeader)
      }
    }
  }
  private var editor: some View {
    Group {
      if bot == nil {
        VStack(spacing: 0) { creationContent }
      } else {
        sectionList
      }
    }.navigationTitle(bot == nil ? "New assistant" : "All settings").navigationBarTitleDisplayMode(.inline)
      .toolbar { editorToolbar }
      .safeAreaInset(edge: .bottom, spacing: 0) { if bot != nil && configDirty { saveBar } }
      .onAppear {
        guard !initialized else { return }
        initialized = true
        form = BotInput(bot: bot, fallback: store.bootstrap?.bots.first)
        savedForm = form
        avatar = bot?.avatar ?? AvatarConfig()
        savedAvatar = avatar
        if avatar.mode != .portrait { lastDrawn = avatar } else { lastPortrait = avatar }
      }
  }

  // MARK: Sections

  /// The model name the Behavior row shows: the server's readable name while it still matches.
  private var modelName: String {
    let current = store.bootstrap?.bots.first { $0.id == bot?.id } ?? bot
    if let current, current.model == form.model, let name = current.modelName, !name.isEmpty { return name }
    return form.model
  }
  private var sectionList: some View {
    List {
      if !detailLoaded {
        Section {
          if let detailError {
            VStack(alignment: .leading, spacing: 12) {
              ErrorBanner(message: detailError)
              Button(action: retryDetail) {
                Text("Retry settings").frame(minHeight: 44).contentShape(Rectangle())
              }.buttonStyle(.accentProminent)
            }
          } else { ProgressView("Loading assistant settings…") }
        }
      } else if error != nil || notice != nil {
        Section { messageRows }
      }
      Section {
        ForEach(SettingsSection.allCases) { section in
          NavigationLink(value: SettingsRoute.section(section)) {
            Label {
              VStack(alignment: .leading, spacing: 2) {
                Text(section.label).foregroundStyle(Color.primary)
                Text(section.summary(shared: form.shared, modelName: modelName))
                  .font(.subheadline).foregroundStyle(Palette.muted).lineLimit(1)
              }
            } icon: { Image(systemName: section.systemImage).foregroundStyle(Palette.accent) }
              .padding(.vertical, 2)
          }.accessibilityIdentifier("settingsSection.\(section.rawValue)")
        }
      }
    }.householdListBackground().accessibilityIdentifier("settingsSections")
      .disabled(busy)
  }
  @ViewBuilder private var messageRows: some View {
    if let error { ErrorBanner(message: error, dismiss: { self.error = nil }) }
    if let notice { Text(notice).font(.footnote).foregroundStyle(Palette.accent).accessibilityIdentifier("settingsNotice") }
  }
  @ViewBuilder private var messages: some View {
    if let error { ErrorBanner(message: error, dismiss: { self.error = nil }).padding(.horizontal).padding(.top, 8) }
    if let notice {
      Text(notice).font(.footnote).foregroundStyle(Palette.accent).padding(10)
        .accessibilityIdentifier("settingsNotice")
    }
  }
  @ViewBuilder private func destination(_ route: SettingsRoute) -> some View {
    if let bot {
      page(route) {
        switch route {
        case .section(.profile): profilePage
        case .section(.behavior): behaviorPage
        case .section(.access): accessPage
        case .section(.automation): automationPage
        case .section(.memory): memoryAndLearningPage
        case .connections: IntegrationsView(botId: bot.id)
        case .logins: VaultView(botId: bot.id)
        case .approvals: ApprovalSettingsView(botId: bot.id, botName: bot.name).id("approvals|\(store.scope ?? "")|\(bot.id)")
        case .work:
          HermesWorkView(botId: bot.id).id("work|\(store.scope ?? "")|\(bot.id)").id(store.api.map(ObjectIdentifier.init))
        case .memory:
          MemoryDrawer(botId: bot.id, onDirtyChange: { memoryDirty = $0 }, onSavingChange: { memorySaving = $0 })
            .onDisappear { memoryDirty = false; memorySaving = false }
        case .learning:
          HermesLearningView(botId: bot.id).id("learning|\(store.scope ?? "")|\(bot.id)").id(store.api.map(ObjectIdentifier.init))
        }
      }
    }
  }
  /// Every page shares the sheet's messages, its Close button and, when needed, Save changes.
  private func page(_ route: SettingsRoute, @ViewBuilder _ content: () -> some View) -> some View {
    let guarded = route == .memory && (memoryDirty || memorySaving)
    return VStack(spacing: 0) {
      messages
      content()
    }.navigationTitle(route.title).navigationBarTitleDisplayMode(.inline)
      .navigationBarBackButtonHidden(guarded)
      .toolbar {
        if guarded {
          ToolbarItem(placement: .topBarLeading) {
            Button { confirmation = .leaveMemory } label: {
              Label(path.dropLast().last?.title ?? "All settings", systemImage: "chevron.backward").labelStyle(.titleAndIcon)
            }.disabled(memorySaving).accessibilityIdentifier("memoryBack")
          }
        }
        ToolbarItem(placement: .topBarTrailing) { closeButton }
      }
      .safeAreaInset(edge: .bottom, spacing: 0) { if showsSaveBar(route) { saveBar } }
  }
  /// Profile and Behavior always offer Save changes; other pages only while those edits are unsaved.
  private func showsSaveBar(_ route: SettingsRoute) -> Bool {
    if route == .section(.profile) { return !portraitPromptFocused }
    return route == .section(.behavior) || configDirty
  }
  private var profilePage: some View {
    Form {
      Section { unavailable(.botConfiguration) }
      if let avatarFailure { avatarFailureSection(avatarFailure) }
      nameSection
      avatarControls
      descriptionSection
      sharingSection
      Section {
        Button("Delete assistant", role: .destructive) { confirmation = .delete(name: savedName) }.disabled(
          !store.supports(.botConfiguration) || !store.connected)
      } header: { settingsHeader("Danger zone") }
    }.householdListBackground().accessibilityIdentifier("settings.profile")
      .safeAreaInset(edge: .top, spacing: 0) { compactAvatarPreview }
      .disabled(busy || !detailLoaded)
  }
  private var behaviorPage: some View {
    Form {
      Section { unavailable(.botConfiguration) }
      instructionsSection
      interactiveSection
      modelSection
      capabilities(.tools)
      capabilities(.skills)
    }.householdListBackground().accessibilityIdentifier("settings.behavior")
      .disabled(busy || !detailLoaded)
      .task(id: store.api.map(ObjectIdentifier.init)) { await loadBehavior() }
      .onDisappear { skillControl?.disappear() }
      .sheet(item: $readingSkill) { skill in
        if let skillControl { HermesSkillReader(control: skillControl, skill: skill).appStore(store) }
      }
  }
  private var accessPage: some View {
    Form {
      Section {
        pageLink(.connections, detail: "Accounts and services this assistant can use", systemImage: "link")
        pageLink(.logins, detail: "Passwords saved for this assistant's profile", systemImage: "person.badge.key")
        pageLink(.approvals, detail: "Commands it runs without asking, and auto-review", systemImage: "checkmark.shield")
      }
      if advanced { mcpSection.disabled(busy || !detailLoaded) }
    }.householdListBackground().accessibilityIdentifier("settings.access")
  }
  private var automationPage: some View {
    Form {
      routineList.disabled(busy || !detailLoaded)
      Section {
        pageLink(.work, detail: "Goals, tasks and event triggers", systemImage: "checklist")
      } header: { settingsHeader("Work") }
    }.householdListBackground().accessibilityIdentifier("settings.automation")
      .task(id: store.api.map(ObjectIdentifier.init)) { await loadRoutines() }
  }
  private var memoryAndLearningPage: some View {
    Form {
      Section {
        pageLink(.memory, detail: "What this assistant remembers", systemImage: "brain")
        pageLink(.learning, detail: "Skill changes waiting for review", systemImage: "graduationcap")
      }
    }.householdListBackground().accessibilityIdentifier("settings.memoryAndLearning")
  }
  private func pageLink(_ route: SettingsRoute, detail: String, systemImage: String) -> some View {
    NavigationLink(value: route) {
      Label {
        VStack(alignment: .leading, spacing: 2) {
          Text(route.title).foregroundStyle(Color.primary)
          Text(detail).font(.subheadline).foregroundStyle(Palette.muted)
        }
      } icon: { Image(systemName: systemImage).foregroundStyle(Palette.accent) }
    }.accessibilityIdentifier("settingsPage.\(route.title.lowercased())")
  }
  @ViewBuilder private var mcpSection: some View {
    let names = McpServerChoices.names(available: availableMcpServers, enabled: form.enabledMcpServers)
    Section {
      if names.isEmpty {
        Text("No MCP servers are configured for this assistant. Add one under Connections.").foregroundStyle(Palette.muted)
      }
      ForEach(names, id: \.self) { name in
        Toggle(name, isOn: Binding(
          get: { form.enabledMcpServers.contains(name) },
          set: { form.enabledMcpServers = McpServerChoices.toggled(form.enabledMcpServers, name, on: $0) }))
          .accessibilityIdentifier("mcpServer.\(name)")
      }
    } header: { settingsHeader("MCP servers") } footer: {
      Text("Choose which of this profile's MCP servers the assistant can use. Save changes to apply them.").foregroundStyle(Palette.muted)
    }.disabled(!store.supports(.botConfiguration))
  }

  // MARK: Fields

  /// Creation's second step: everything about the assistant's role, in one form.
  @ViewBuilder private var roleSections: some View {
    descriptionSection
    instructionsSection
    interactiveSection
    modelSection
    sharingSection
  }
  private var interactiveSection: some View {
    Section {
      Button(interactiveEnabled ? "Interactive replies enabled" : "Enable interactive replies") {
        form.instructions = (form.instructions.trimmingCharacters(in: .whitespacesAndNewlines) + "\n\n" + NativeInteractiveReplyInstructions)
          .trimmingCharacters(in: .whitespacesAndNewlines)
      }.disabled(busy || interactiveEnabled)
    } footer: {
      Text("Adds instructions for checklists, itineraries and calendar proposals. Save changes to apply them.").foregroundStyle(Palette.muted)
    }
  }
  private var modelSection: some View {
    Section {
      ModelSelectionRow(botId: bot?.id, selection: ModelChoice(provider: form.provider ?? "", model: form.model), disabled: busy || !store.supports(.botConfiguration)) {
        form.model = $0.model
        form.provider = $0.provider
        error = nil
      }
    } header: { settingsHeader("Model") } footer: {
      Text("Model choices come from your connected Hermes providers. Star models to keep them handy.").foregroundStyle(Palette.muted)
    }
  }
  private var sharingSection: some View {
    Section {
      Toggle("Shared with your household", isOn: $form.shared)
    } footer: {
      Text(
        form.shared
          ? "This assistant has one shared model. Provider and model changes are visible to both people."
          : "Only you see a personal assistant in WildBots. Anyone with Hermes dashboard access can still reach its memory and logins.").foregroundStyle(Palette.muted)
    }
  }
  private var nameReady: Bool { !form.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
  /// Whether the assistant's own fields can be sent: creation, or the PATCH step of Save changes.
  private var canSave: Bool {
    store.supports(.botConfiguration) && store.connected && nameReady
      && !form.model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      && form.instructions.count <= SettingsLimits.instructions
  }
  private var portraitMissing: Bool { avatar.mode == .portrait && (avatar.src ?? "").isEmpty }
  private var canSaveChanges: Bool {
    store.connected && !busy && configDirty && !portraitMissing && (form == savedForm || canSave)
  }
  private var saveBar: some View {
    VStack(alignment: .leading, spacing: 10) {
      if let portraitOperation {
        ProgressView(portraitOperation == "upload" ? "Uploading portrait…" : "Generating portrait…")
          .font(.footnote).foregroundStyle(Palette.muted).tint(Palette.accent)
      }
      if portraitMissing {
        Text(portraitNextStep).font(.footnote).foregroundStyle(Palette.muted)
      }
      if !store.connected { Text("Reconnect to save your changes.").font(.footnote).foregroundStyle(Palette.muted) }
      Button { saveChanges() } label: {
        Text(progress.label("changes", idle: "Save changes")).frame(maxWidth: .infinity, minHeight: 44)
      }.buttonStyle(.accentProminent).accessibilityIdentifier("saveChanges").disabled(!canSaveChanges)
    }.padding(.horizontal, 20).padding(.vertical, 12).background(Palette.surface(scheme))
      .overlay(alignment: .top) { Divider() }
      .accessibilityElement(children: .contain).accessibilityIdentifier("saveBar")
  }
  /// Split out so the type checker stays fast on slower CI machines.
  private var nameSection: some View {
    Section {
      TextField("Name", text: $form.name, prompt: Text("Name").foregroundColor(Palette.muted))
        .focused($nameFocused)
        .task(id: focusNameRequest) {
          guard focusNameRequest > 0 else { return }
          nameFocused = true
          focusNameRequest = 0
        }
        .onChange(of: form.name) { _, value in
          if value.count > SettingsLimits.name { form.name = String(value.prefix(SettingsLimits.name)) }
        }
    } header: { settingsHeader("Name") }
  }
  private func settingsHeader(_ title: String) -> some View {
    Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(Palette.muted)
  }
  private var descriptionSection: some View {
    Section {
      TextField("Description", text: $form.description, prompt: Text("Description").foregroundColor(Palette.muted), axis: .vertical).lineLimit(1...4)
    } header: { settingsHeader("Description") }
  }
  private var instructionsSection: some View {
    Section {
      TextEditor(text: $form.instructions).frame(minHeight: 180).accessibilityLabel("Assistant instructions")
        .overlay(alignment: .topLeading) {
          if form.instructions.isEmpty {
            Text("How should this assistant help?").foregroundStyle(Palette.muted).padding(.top, 8).padding(.leading, 5).allowsHitTesting(false)
          }
        }
    } header: { settingsHeader("Instructions") } footer: {
      if let limit = SettingsLimits.message("Instructions are", count: form.instructions.count, limit: SettingsLimits.instructions) {
        Text(limit).foregroundStyle(form.instructions.count > SettingsLimits.instructions ? Palette.danger : Palette.muted)
          .accessibilityIdentifier("instructionsLimit")
      }
    }
  }
  private var interactiveEnabled: Bool { form.instructions.contains(NativeInteractiveReplyInstructions) }
  private var compactAvatarPreview: some View {
    HStack(spacing: 16) {
      AvatarView(avatar: avatar, state: previewState, size: 64, name: savedName)
      VStack(alignment: .leading, spacing: 6) {
        Menu {
          ForEach([ActivityState.idle, .thinking, .working, .waiting, .blocked, .done], id: \.self) { state in
            Button { previewState = state } label: {
              if previewState == state { Label(state.label, systemImage: "checkmark") } else { Text(state.label) }
            }.accessibilityIdentifier("previewState.\(state.rawValue)")
          }
        } label: {
          HStack { Text("Preview: \(previewState.label)").multilineTextAlignment(.leading); Spacer(); Image(systemName: "chevron.down") }
            .font(.subheadline).padding(.horizontal, 12).frame(minHeight: 44)
            .background(Palette.raised(scheme), in: RoundedRectangle(cornerRadius: 10))
            .modifier(EnabledPrimaryMenuLabel())
        }.accessibilityIdentifier("avatarPreviewState")
          .accessibilityLabel("Preview state").accessibilityValue(previewState.label)
          .disabled(portraitMissing)
          .accessibilityHint("Preview only. Real activity comes from Hermes.")
        Text("Preview only").font(.caption).foregroundStyle(Palette.muted)
      }
    }.padding(.horizontal, 20).padding(.vertical, 12).background(Palette.surface(scheme))
      .overlay(alignment: .bottom) { Divider() }
      .accessibilityElement(children: .contain).accessibilityIdentifier("avatarPreviewBar")
  }
  private func routinePresentations(_ content: some View) -> some View {
    content
      .confirmationDialog(
        "Delete \(deletingRoutine?.name ?? "this routine")?",
        isPresented: Binding(get: { deletingRoutine != nil }, set: { if !$0 { deletingRoutine = nil } }),
        titleVisibility: .visible, presenting: deletingRoutine
      ) { routine in
        Button("Delete routine", role: .destructive) {
          action {
            try await store.api?.delete("/routines/\(APIClient.component(routine.id))")
            await loadRoutines()
          }
        }
      }
      .sheet(item: $editingRoutine) { routine in
        RoutineEditor(routine: routine, onSaved: { Task { await loadRoutines() } }).appStore(store)
      }
      .sheet(isPresented: $addingRoutine) {
        if let bot {
          RoutineEditor(routine: .empty(botId: bot.id), onSaved: { Task { await loadRoutines() } })
            .appStore(store)
        }
      }
  }
  private var portraitNextStep: String {
    if store.supports(.uploads) {
      return store.supports(.portraitGeneration) ? "Upload or generate a portrait before saving." : "Upload a portrait before saving."
    }
    return store.supports(.portraitGeneration) ? "Generate a portrait before saving." : "Portraits are unavailable. Choose Geometric or Mascot."
  }
  private var avatarPreview: some View {
    Section {
      AvatarStage(avatar: avatar, state: $previewState, name: bot?.name ?? form.name,
        caption: bot == nil ? form.name : nil)
    }.listRowInsets(EdgeInsets()).listRowBackground(Color.clear)
  }
  @ViewBuilder private var avatarControls: some View {
    Group {
      Section {
        Picker("Style", selection: Binding(get: { avatar.mode }, set: { switchAvatarMode($0) })) {
          Text("Geometric").tag(AvatarMode.geometric)
          Text("Mascot").tag(AvatarMode.mascot)
          if bot != nil { Text("Portrait").tag(AvatarMode.portrait) }
        }.pickerStyle(.segmented).accessibilityIdentifier("avatarStyle")
      } header: { settingsHeader(bot == nil ? "Style" : "Avatar") } footer: {
        // A portrait is stored with the assistant, so it can only be added once it exists.
        if bot == nil { Text("Want a portrait? Upload or generate one in Profile settings after you create the assistant.").foregroundStyle(Palette.muted) }
      }
      if avatar.mode == .portrait {
        Section {
          Text("Portraits stay still. Activity appears in a separate state indicator.")
            .font(.caption).foregroundStyle(Palette.muted)
          Button("Upload portrait") { beginPortraitImport() }.disabled(
            bot == nil || !store.supports(.uploads) || !store.connected)
          Text("PNG, JPEG, or WebP, up to 15 MB.").font(.caption).foregroundStyle(Palette.muted)
          unavailable(.uploads)
        } header: { settingsHeader("Upload a portrait") }
        Section {
          VStack(alignment: .leading, spacing: 8) {
            Text("Describe a portrait").font(.subheadline.weight(.medium)).accessibilityHidden(true)
            TextField("", text: $portraitPrompt, prompt: Text("Like a friendly ranch companion").foregroundStyle(Palette.muted), axis: .vertical)
              .lineLimit(2...5).focused($portraitPromptFocused).accessibilityLabel("Describe a portrait").accessibilityIdentifier("portraitPrompt")
          }
          if let limit = SettingsLimits.message("The description is", count: portraitPrompt.count, limit: SettingsLimits.portraitPrompt, action: "generate a portrait") {
            Text(limit).font(.caption).foregroundStyle(portraitPrompt.count > SettingsLimits.portraitPrompt ? Palette.danger : Palette.muted)
              .accessibilityIdentifier("portraitPromptLimit")
          }
          Button { generatePortrait() } label: { Text("Generate portrait").frame(maxWidth: .infinity, minHeight: 44, alignment: .leading) }.disabled(
            bot == nil || !store.supports(.portraitGeneration) || !store.connected
              || portraitPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
              || portraitPrompt.count > SettingsLimits.portraitPrompt)
          unavailable(.portraitGeneration)
        } header: { settingsHeader("Generate a portrait") }
      } else {
        if avatar.mode == .geometric {
          Section {
            AvatarTiles(
              group: "shape", options: AvatarConfig.shapes.map { ($0, $0.rawValue.capitalized) },
              selected: avatar.shape ?? .blob,
              preview: { var a = avatar; a.shape = $0; a.accessory = .plain; return a },
              select: { avatar.shape = $0 })
          } header: { settingsHeader("Shape") }
        } else {
          Section { characterTiles(AvatarConfig.everydayFamilies) } header: { settingsHeader("Character") }
          Section { characterTiles(AvatarConfig.seasonalFamilies) } header: { settingsHeader("Seasonal") }
        }
        Section { colorSwatches } header: { settingsHeader("Color") }
        Section {
          AvatarTiles(
            group: "eyes", options: AvatarEyes.all.map { ($0, $0.rawValue.capitalized) },
            selected: avatar.eyes ?? .oval,
            preview: { var a = avatar; a.eyes = $0; a.accessory = .plain; return a },
            select: { avatar.eyes = $0 })
        } header: { settingsHeader("Eyes") }
        Section {
          AvatarTiles(
            group: "accessory",
            options: [(.plain, "None"), (.hat, "Cowboy hat"), (.glasses, "Glasses")],
            selected: avatar.accessory ?? .plain,
            preview: { var a = avatar; a.accessory = $0; return a },
            select: { avatar.accessory = $0 })
        } header: { settingsHeader("Accessory") }
        Section {
          slider("Eye width", \AvatarConfig.eyeWidth)
          slider("Eye height", \AvatarConfig.eyeHeight)
          slider("Eye spacing", \AvatarConfig.eyeSpacing)
          if [avatar.eyeWidth, avatar.eyeHeight, avatar.eyeSpacing].contains(where: { ($0 ?? 1) != 1 }) {
            Button("Reset eyes") {
              avatar.eyeWidth = 1
              avatar.eyeHeight = 1
              avatar.eyeSpacing = 1
            }
          }
        } header: { settingsHeader("Fine-tune eyes") }
      }
    }
  }
  /// Creation went through but the look did not save: say so plainly and offer the retry here.
  private func avatarFailureSection(_ message: String) -> some View {
    Section {
      Label(message, systemImage: "exclamationmark.triangle").foregroundStyle(Palette.danger)
        .accessibilityIdentifier("avatarFailure")
      Button(progress.label("changes", idle: "Retry saving avatar")) { saveChanges() }
        .disabled(busy || !store.connected || portraitMissing).accessibilityIdentifier("retryAvatar")
    }
  }
  private func characterTiles(_ families: [(id: AvatarFamily, label: String)]) -> some View {
    AvatarTiles(
      group: "family", options: families.map { ($0.id, $0.label) },
      selected: avatar.family ?? .sprout,
      preview: { var a = avatar.selectingFamily($0); a.accessory = .plain; return a },
      select: { avatar = avatar.selectingFamily($0) })
  }
  private var colorSwatches: some View {
    let custom = !AvatarConfig.colors.contains { $0.lowercased() == (avatar.color ?? "#1084FE").lowercased() }
    return LazyVGrid(columns: [GridItem(.adaptive(minimum: 44), spacing: 6)], spacing: 8) {
      ForEach(AvatarConfig.colors, id: \.self) { hex in
        let selected = avatar.color?.lowercased() == hex.lowercased()
        Button {
          avatar.color = hex
        } label: {
          Circle().fill(Color(hex: hex)).padding(2)
            .overlay(Circle().strokeBorder(Palette.muted, lineWidth: 1))
            .frame(width: 36, height: 36).frame(width: 44, height: 44).contentShape(Rectangle())
            .overlay(Circle().strokeBorder(selected ? Palette.accent : .clear, lineWidth: 2))
        }.buttonStyle(.plain).accessibilityLabel("Color \(hex)")
          .accessibilityAddTraits(selected ? .isSelected : [])
      }
      ColorPicker(
        "Custom color",
        selection: Binding(
          get: { Color(hex: avatar.color ?? "#1084FE") },
          set: { color in
            var r: CGFloat = 0
            var g: CGFloat = 0
            var b: CGFloat = 0
            var a: CGFloat = 0
            if UIColor(color).getRed(&r, green: &g, blue: &b, alpha: &a) {
              func byte(_ v: CGFloat) -> Int { Int((min(max(v, 0), 1) * 255).rounded()) }
              avatar.color = String(format: "#%02X%02X%02X", byte(r), byte(g), byte(b))
            }
          }), supportsOpacity: false
      ).labelsHidden().frame(width: 44, height: 44)
        .overlay(Circle().strokeBorder(custom ? Palette.accent : .clear, lineWidth: 2).allowsHitTesting(false))
        .accessibilityAddTraits(custom ? .isSelected : [])
    }.padding(.vertical, 4)
  }
  /// Switching styles keeps the drawn character's color, eyes, accessory, and eye tuning,
  /// returning from Portrait restores the last drawn character, and returning to Portrait
  /// restores the last portrait.
  private func switchAvatarMode(_ mode: AvatarMode) {
    guard mode != avatar.mode else { return }
    if mode == .portrait {
      // Restore the last uploaded, generated, or saved portrait from this session.
      if let lastPortrait {
        avatar = lastPortrait
        return
      }
      var next = avatar
      next.mode = .portrait
      next.src = nil
      next.origin = "uploaded"
      avatar = next
      return
    }
    var next = lastDrawn
    next.mode = mode
    if mode == .geometric { next.shape = lastDrawn.shape ?? .blob }
    if mode == .mascot { next.family = lastDrawn.family ?? .bear }
    avatar = next
  }

  // MARK: Tools and skills

  private func items(_ kind: CatalogKind) -> [CapabilityItem] { kind == .tools ? tools : skills }
  private func selectedIds(_ kind: CatalogKind) -> [String] {
    items(kind).filter { $0.enabled || $0.required == true }.map(\.id)
  }
  /// A catalog counts as changed only once it has loaded, so an unloaded one is never sent.
  private func capabilityDirty(_ kind: CatalogKind) -> Bool {
    guard let saved = savedCapabilities[kind] else { return false }
    return Set(selectedIds(kind)) != saved
  }
  /// The installed skill a catalog skill row stands for, matched by name, when Hermes reports one.
  private func installedSkill(_ item: CapabilityItem) -> HermesInstalledSkill? {
    guard let state = skillControl?.value?.skills, state.supported else { return nil }
    return state.installed.first { $0.name == item.id }
  }
  @ViewBuilder private func capabilities(_ kind: CatalogKind) -> some View {
    let rows = items(kind)
    let skillState = kind == .skills ? skillControl?.value?.skills : nil
    Section {
      unavailable(kind.capability)
      if bot != nil {
        ForEach(rows) { item in
          let installed = kind == .skills ? installedSkill(item) : nil
          let control = Toggle(
            isOn: Binding(
              get: {
                self.items(kind).first { $0.id == item.id }?.enabled == true
                  || item.required == true
              },
              set: { selected in
                if kind == .tools, let i = tools.firstIndex(where: { $0.id == item.id }) {
                  tools[i].enabled = selected
                }
                if kind == .skills, let i = skills.firstIndex(where: { $0.id == item.id }) {
                  skills[i].enabled = selected
                }
              })
          ) {
            VStack(alignment: .leading, spacing: 4) {
              HStack(spacing: 6) {
                Text(item.name).font(.headline)
                if installed?.locked == true {
                  Label("Locked", systemImage: "lock.fill").font(.caption.weight(.semibold)).foregroundStyle(Palette.muted)
                    .accessibilityIdentifier("skill.locked.\(item.id)")
                }
              }
              let description = item.description.trimmingCharacters(in: .whitespacesAndNewlines)
              if !description.isEmpty && !["required by hermes", "hermes profile skill"].contains(description.lowercased()) {
                Text(description).font(.footnote).foregroundStyle(Palette.muted)
              }
            }
          }.disabled(item.required == true || !store.supports(kind.capability) || !catalogReady.contains(kind))
          if item.required == true || installed != nil {
            VStack(alignment: .leading, spacing: 6) {
              control
              if item.required == true { Text("Required by Hermes").font(.footnote).foregroundStyle(Palette.muted) }
              if let installed { installedSkillActions(installed) }
            }
          } else { control }
        }
        if catalogLoading.contains(kind) {
          ProgressView("Loading \(kind.rawValue)…")
        } else if !catalogReady.contains(kind) && store.supports(kind.capability) {
          Button("Retry loading \(kind.rawValue)") { Task { await loadCatalog(kind) } }
        }
        if rows.isEmpty && catalogReady.contains(kind) {
          Text("No \(kind.rawValue) were reported by Hermes.").foregroundStyle(Palette.muted)
        }
        if let skillControl, kind == .skills { skillLockStatus(skillControl) }
      }
    } header: { settingsHeader(kind.rawValue.capitalized) } footer: {
      VStack(alignment: .leading, spacing: 4) {
        Text(kind == .skills ? "Required skills stay enabled. Save changes to apply your choices." : "Save changes to apply your choices.")
        if skillState?.lockSupported == true {
          Text("Lock a skill to keep assistants from changing it. You can still edit it in Hermes.")
          if skillControl?.value?.canManageLearningPolicy == false { Text("Only an integration administrator can lock or unlock skills.") }
        }
      }.foregroundStyle(Palette.muted)
    }
  }
  /// Read and Lock or Unlock, from what was Learning's installed-skill list. Locks save at once.
  @ViewBuilder private func installedSkillActions(_ installed: HermesInstalledSkill) -> some View {
    let control = skillControl
    let lockable = control?.value?.skills.lockSupported == true
    if installed.locked == true { Text(hermesSkillLockedNote).font(.caption).foregroundStyle(Palette.muted) }
    HStack(spacing: 20) {
      Button { readingSkill = installed } label: {
        Text("Read skill").frame(minHeight: 44).contentShape(Rectangle())
      }
        .accessibilityLabel("Read \(installed.name)")
        .accessibilityIdentifier("skill.read.\(installed.name)")
      if lockable, let locked = installed.locked {
        Button { setSkillLock(installed, locked: !locked) } label: {
          Text(locked ? "Unlock skill" : "Lock skill").frame(minHeight: 44).contentShape(Rectangle())
        }
          .disabled(control?.disabled != false || !store.connected || control?.value?.canManageLearningPolicy == false)
          .accessibilityLabel("\(locked ? "Unlock" : "Lock") \(installed.name)")
          .accessibilityIdentifier("skill.lock.\(installed.name)")
      }
    }.buttonStyle(.borderless).font(.subheadline)
  }
  /// A lock change's outcome, and the refresh it needs before another change.
  @ViewBuilder private func skillLockStatus(_ control: HermesAutomationControls) -> some View {
    if let error = control.error { ErrorBanner(message: error) }
    if control.value != nil, let notice = control.notice { Text(notice).font(.footnote).accessibilityAddTraits(.updatesFrequently) }
    // A status that never loaded needs the same way back as one a change left uncertain.
    if control.needsRefresh || control.value == nil && control.error != nil {
      Button("Refresh skill status") { Task { await control.manualRefresh(store) } }
        .disabled(control.busy || control.loading)
        .accessibilityIdentifier("skill.refreshStatus")
    }
  }
  private func setSkillLock(_ skill: HermesInstalledSkill, locked: Bool) {
    guard let control = skillControl else { return }
    Task {
      let _: HermesSkillLock? = await control.change(
        store, "/skills/lock", HermesSkillLockInput(name: skill.name, locked: locked), method: "PUT")
    }
  }

  // MARK: Routines

  @ViewBuilder private var routineList: some View {
    Section {
      unavailable(.routines)
      Text("Routines keep working when you are away. Choose notification recipients explicitly.")
        .font(.footnote).foregroundStyle(Palette.muted)
    } header: { settingsHeader("Routines") }
    if let bot {
      if !templates.isEmpty {
        Section("Routine recipes") {
          ForEach(templates) { template in
            Button {
              editingRoutine = Routine(id: "", botId: bot.id, name: template.name, prompt: template.prompt, schedule: template.schedule, enabled: false, recipientIds: [store.bootstrap?.user.id].compactMap { $0 }, roomIds: [])
            } label: {
              VStack(alignment: .leading, spacing: 2) {
                Text(template.name).font(.headline)
                Text(template.description).font(.caption).foregroundStyle(Palette.muted)
              }
            }.disabled(!store.supports(.routines) || !store.connected).accessibilityIdentifier("routineTemplate.\(template.id)")
          }
        }
      }
      ForEach(routines) { routine in
        Section(routine.name) {
          LabeledContent("Schedule") { Text(routine.schedule).font(.subheadline).monospaced().foregroundStyle(Palette.muted) }
          LabeledContent("Status") {
            if routine.enabled { Text("Active").foregroundStyle(Palette.muted) }
            else {
              Text("Paused").font(.subheadline.weight(.semibold)).foregroundStyle(Palette.muted)
                .padding(.horizontal, 8).padding(.vertical, 2)
                .overlay(Capsule().strokeBorder(Palette.line))
            }
          }
          if let rooms = RoutineRooms.names(routine.roomIds, catalog: store.groupCatalog) { LabeledContent("Posts in") { Text(rooms).foregroundStyle(Palette.muted) } }
          Text(routine.prompt).font(.body).lineLimit(6)
          RoutineEnhancements(routine: routine, disabled: !store.supports(.routines))
          Button(routine.enabled ? "Pause" : "Resume") {
            action {
              guard let api = store.api else { return }
              var next = routine
              next.enabled.toggle()
              // Pausing leaves where it posts alone.
              next.roomIds = nil
              let _: Routine = try await api.write(
                "/routines/\(APIClient.component(routine.id))", next, method: "PUT")
              await loadRoutines()
            }
          }
          Button("Edit") { editingRoutine = routine }
          Button("Delete", role: .destructive) { deletingRoutine = routine }
        }
      }
      Section {
        Button("Add routine") { addingRoutine = true }.disabled(
          !store.supports(.routines) || !store.connected)
      }
      if routines.isEmpty && store.supports(.routines) {
        Section { Text("No routines for \(bot.name).") }
      }
    }
  }
  @ViewBuilder private func unavailable(_ key: CapabilityKey) -> some View {
    if !store.supports(key) { Text(store.reason(key)).font(.footnote).foregroundStyle(Palette.muted) }
  }
  private func slider(_ title: String, _ key: WritableKeyPath<AvatarConfig, Double?>) -> some View {
    let value = avatar[keyPath: key] ?? 1
    return VStack(alignment: .leading, spacing: 2) {
      HStack {
        Text(title)
        Spacer()
        Text("\(Int((value * 100).rounded()))%").monospacedDigit().foregroundStyle(Palette.muted)
      }.font(.subheadline)
      Slider(
        value: Binding(get: { value }, set: { avatar[keyPath: key] = ($0 * 20).rounded() / 20 }),
        in: 0.6...1.5, step: 0.05
      ).accessibilityLabel(title)
    }
  }

  // MARK: Saving

  private func action(progressKey: String? = nil, _ operation: @escaping () async throws -> Void) {
    guard !busy else { return }
    busy = true
    error = nil
    notice = nil
    if let progressKey { progress.begin(progressKey) }
    Task {
      defer { busy = false }
      do {
        try await operation()
        if let progressKey { confirmSaved(progressKey) }
      } catch {
        if let progressKey { progress.fail(progressKey) }
        self.error = error.localizedDescription
        if let e = error as? APIError {
          if e.code == "private_confirmation_required" {
            self.error = nil
            confirmation = .personal(name: savedName)
          } else if e.confirmRequired {
            self.error = nil
            confirmation = .model(warning: e.localizedDescription)
          }
        }
      }
    }
  }
  /// Wait for the child sheet to finish closing before another prompt or the editor can close.
  private func performConfirmation() {
    guard let choice = acceptedConfirmation else { return }
    acceptedConfirmation = nil
    switch choice {
    case .model: bot == nil ? saveBot(confirmed: true) : saveChanges(confirmed: true)
    case .personal: bot == nil ? saveBot(personal: true) : saveChanges(personal: true)
    case .discard: closeSheet()
    case .leaveMemory:
      memoryDirty = false
      if path.last == .memory { path.removeLast() }
    case .delete:
      action {
        guard let id = bot?.id, let api = store.api else { return }
        store.deletedBotId = id
        try await api.delete("/bots/\(APIClient.component(id))")
        await store.refreshBootstrap()
        closeSheet()
      }
    }
  }
  private func confirmSaved(_ key: String) {
    progress.succeed(key)
    Task {
      try? await Task.sleep(for: .seconds(2.5))
      progress.expire(key)
    }
  }
  /// Creation's Create button. An existing assistant saves through `saveChanges`.
  private func saveBot(confirmed: Bool = false, personal: Bool? = nil) {
    personalConfirmed = !form.shared && (personal ?? personalConfirmed)
    createBot(confirmed: confirmed)
  }
  /// One Save for every configuration edit: the assistant's fields, then its avatar, tools and
  /// skills, each only if it changed. Each part that saves becomes its new baseline, so after a
  /// failure the next Save sends only what is still unsaved. A model or make-personal
  /// confirmation stops at the first step and, once confirmed, continues the whole save.
  private func saveChanges(confirmed: Bool = false, personal: Bool? = nil) {
    // Every way to save, Retry included, checks the name before the fields are sent.
    if form != savedForm && !nameReady {
      if path != [.section(.profile)] { keepMessages = true; path = [.section(.profile)] }
      error = "Give your assistant a name."
      focusNameRequest += 1
      return
    }
    if form != savedForm && !canSave { return }
    let personal = !form.shared && (personal ?? personalConfirmed)
    if form != savedForm && form.hidesFromHousehold(bot) && !personal {
      confirmation = .personal(name: savedName)
      return
    }
    personalConfirmed = personal
    let retryingCreatedAvatar = avatarFailure != nil
    action(progressKey: "changes") {
      guard let bot, let api = store.api else { return }
      var patched = false
      var refresh = false
      do {
        if form != savedForm {
          let sent = form
          var value = sent
          value.confirmModel = confirmed
          if personal { value.confirmPrivate = true }
          let _: Bot = try await api.write("/bots/\(APIClient.component(bot.id))", value, method: "PATCH")
          savedForm = sent
          patched = true
          refresh = true
        }
        if avatar != savedAvatar || avatarFailure != nil {
          let sent = avatar
          try await putAvatar(bot.id, api, sent)
          savedAvatar = sent
          avatarFailure = nil
          refresh = true
        }
        for kind in CatalogKind.allCases where capabilityDirty(kind) {
          let ids = selectedIds(kind)
          try await store.perform("/bots/\(APIClient.component(bot.id))/\(kind.rawValue)", ["ids": ids], method: "PUT")
          savedCapabilities[kind] = Set(ids)
        }
      } catch {
        if refresh { await store.refreshBootstrap() }
        throw error
      }
      if refresh { await store.refreshBootstrap() }
      notice = settingsSavedNotice(patched: patched, shared: savedForm.shared)
      // A retried avatar from creation finishes the job the Create button started, unless
      // other edits made meanwhile still need saving.
      if retryingCreatedAvatar && !dirty { closeSheet() }
    }
  }
  /// Creates the assistant, then saves the look chosen on the first step. The server takes the
  /// avatar separately, so a failed avatar save keeps this sheet open on the new assistant's
  /// Profile with the choice intact and a retry.
  private func createBot(confirmed: Bool) {
    action(progressKey: "details") {
      guard let api = store.api else { return }
      var value = form
      value.confirmModel = confirmed
      let created: Bot = try await api.write("/bots", value, method: "POST")
      savedForm = form
      do {
        try await putAvatar(created.id, api, avatar)
      } catch {
        await store.refreshBootstrap()
        detailLoaded = true
        createdBot = created
        keepMessages = true
        path = [.section(.profile)]
        avatarFailure = "\(created.name) was created, but its avatar wasn't saved yet."
        self.error = error.localizedDescription
        return
      }
      savedAvatar = avatar
      await store.refreshBootstrap()
      closeSheet()
    }
  }
  private func putAvatar(_ id: String, _ api: APIClient, _ avatar: AvatarConfig) async throws {
    var value = avatar
    if value.mode == .mascot { value.family = value.family ?? .sprout }
    let _: AvatarConfig = try await api.write("/bots/\(APIClient.component(id))/avatar", value, method: "PUT")
  }
  private func generatePortrait() {
    portraitPromptFocused = false
    action {
      portraitOperation = "generate"
      defer { portraitOperation = nil }
      guard let bot, let api = store.api else { return }
      let file: FileRef = try await api.write(
        "/bots/\(APIClient.component(bot.id))/portrait", ["prompt": portraitPrompt])
      avatar.src = file.url ?? "/api/files/\(APIClient.component(file.id))"
      avatar.origin = "generated"
      notice = "Portrait generated. Save changes to apply it."
    }
  }
  private func beginPortraitImport() {
    #if DEBUG
      do {
        if let url = try DebugFixtures.portraitUploadURL() { uploadPortrait(url); return }
      } catch { self.error = error.localizedDescription; return }
    #endif
    portraitImport = true
  }
  private func uploadPortrait(_ url: URL) {
    action {
      portraitOperation = "upload"
      defer { portraitOperation = nil }

      guard let bot, let api = store.api else { return }
      let accessed = url.startAccessingSecurityScopedResource()
      defer { if accessed { url.stopAccessingSecurityScopedResource() } }
      let values = try url.resourceValues(forKeys: [.fileSizeKey, .contentTypeKey])
      guard (values.fileSize ?? 0) <= PortraitUpload.maxInputBytes else {
        throw APIError(message: "Choose a portrait no larger than 15 MB.", status: 400)
      }
      let mime = values.contentType?.preferredMIMEType ?? "application/octet-stream"
      guard ["image/png", "image/jpeg", "image/webp"].contains(mime) else {
        throw APIError(message: "Choose a PNG, JPEG, or WebP portrait.", status: 400)
      }
      let file = try await api.upload(
        botId: bot.id, name: "portrait.png", mime: "image/png", data: PortraitUpload.prepare(Data(contentsOf: url)))
      avatar.src = file.url ?? "/api/files/\(APIClient.component(file.id))"
      avatar.origin = "uploaded"
      notice = "Portrait uploaded. Save changes to apply it."
    }
  }
  private func closeSheet() { if let close { close() } else { dismiss() } }
  /// Edits that Save changes covers: the assistant's fields, avatar, tools, skills and MCP servers.
  private var configDirty: Bool {
    guard initialized else { return false }
    // An avatar whose first save failed still needs saving, even when it matches the default.
    return form != savedForm || avatar != savedAvatar || avatarFailure != nil || CatalogKind.allCases.contains(where: capabilityDirty)
  }
  /// Everything closing would lose, including unsaved memory.
  private var dirty: Bool { memoryDirty || configDirty }

  // MARK: Loading

  /// Every explicit retry dismisses the previous failure before starting the next load.
  private func retryDetail() {
    detailError = nil
    Task { await loadDetail() }
  }
  private func loadDetail() async {
    guard let bot, let api = store.api, !detailLoaded else { return }
    do {
      let detail: Bot = try await api.get("/bots/\(APIClient.component(bot.id))")
      guard !Task.isCancelled else { return }
      form = BotInput(bot: detail, fallback: store.bootstrap?.bots.first)
      savedForm = form
      availableMcpServers = detail.availableMcpServers ?? []
      detailLoaded = true
    } catch is CancellationError {} catch {
      if !Task.isCancelled { detailError = error.localizedDescription }
    }
  }
  /// Behavior's tools and skills, and Hermes's installed skills for their lock and read actions.
  private func loadBehavior() async {
    guard let bot else { return }
    // A fresh controls instance per visit belongs to the current session and client.
    let control = HermesAutomationControls(botId: bot.id)
    skillControl = control
    control.appear(foreground: false)
    async let installed = control.refresh(store)
    await loadCatalog(.tools)
    await loadCatalog(.skills)
    _ = await installed
  }
  private func loadCatalog(_ kind: CatalogKind) async {
    guard let bot, let api = store.api, store.supports(kind.capability), !catalogReady.contains(kind),
      !catalogLoading.contains(kind) else { return }
    catalogLoading.insert(kind)
    defer { catalogLoading.remove(kind) }
    do {
      let values: [CapabilityItem] = try await api.get("/bots/\(APIClient.component(bot.id))/\(kind.rawValue)")
      guard !Task.isCancelled else { return }
      if kind == .tools { tools = values } else { skills = values }
      savedCapabilities[kind] = Set(values.filter { $0.enabled || $0.required == true }.map(\.id))
      catalogReady.insert(kind)
    } catch is CancellationError {} catch {
      if !Task.isCancelled { self.error = error.localizedDescription }
    }
  }
  private func loadRoutines() async {
    guard let bot, let api = store.api, store.supports(.routines) else { return }
    do {
      let all: [Routine] = try await api.get("/routines")
      guard !Task.isCancelled else { return }
      routines = all.filter { $0.botId == bot.id }
      templates = try await api.get("/routines/templates")
    } catch is CancellationError {} catch {
      if !Task.isCancelled { self.error = error.localizedDescription }
    }
  }
}
struct RoutineEditor: View {
  @State var routine: Routine
  var onSaved: () -> Void
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State private var busy = false
  @State private var error: String?
  @State private var deleteConfirm = false
  @State private var previewedSchedule = ""
  private var schedulePreviewValid: Bool { previewedSchedule == routine.schedule }
  var body: some View {
    NavigationStack {
      Form {
        if let error { Section { ErrorBanner(message: error, dismiss: { self.error = nil }) } }
        Section("Routine") {
          TextField("Name", text: $routine.name)
          TextField("Instructions", text: $routine.prompt, axis: .vertical).lineLimit(4...12)
          TextField("Hermes schedule expression", text: $routine.schedule)
            .textInputAutocapitalization(.never).autocorrectionDisabled()
          Toggle("Enabled", isOn: $routine.enabled)
          if routine.enabled && !schedulePreviewValid { Text("Preview this schedule before saving an enabled routine.").font(.caption).foregroundStyle(.secondary) }
        }
        Section {
          RoutineSchedulePreview(botId: routine.botId, schedule: routine.schedule, onReady: { previewedSchedule = $0 })
        }
        // Simple presentation keeps saved overrides on the routine and sends them back unchanged.
        if store.bootstrap?.preferences.presentation == "advanced" { Section { RoutineAdvancedFields(routine: $routine) } }
        Section {
          ForEach(recipients) { user in
            Toggle(
              user.name,
              isOn: Binding(
                get: { routine.recipientIds?.contains(user.id) == true },
                set: { selected in
                  var ids = routine.recipientIds ?? []
                  if selected { ids.append(user.id) } else { ids.removeAll { $0 == user.id } }
                  routine.recipientIds = ids
                }))
          }
        } header: {
          Text("Notify these household members")
        } footer: {
          Text(
            "No selected recipients means no completion notification. Routine results remain in the assistant conversation."
          )
        }
        if RoutineRooms.shown(routine.roomIds, catalog: store.groupCatalog, choices: roomChoices) {
          Section {
            ForEach(roomChoices) { room in
              Toggle(room.name, isOn: Binding(
                get: { routine.roomIds?.contains(room.id) == true },
                set: { selected in
                  var ids = routine.roomIds ?? []
                  if selected { if !ids.contains(room.id) { ids.append(room.id) } } else { ids.removeAll { $0 == room.id } }
                  routine.roomIds = ids
                }))
            }
          } header: {
            Text("Also post results in these group chats")
          } footer: {
            Text("Results appear in the group as a message from this routine. Assistants answer it only when it @mentions them.")
          }
        }
        if !routine.id.isEmpty {
          Section { Button("Delete routine", role: .destructive) { deleteConfirm = true } }
        }
      }.accessibilityIdentifier("routineEditorForm").disabled(busy).navigationTitle(routine.id.isEmpty ? "New routine" : "Edit routine")
        .navigationBarTitleDisplayMode(.inline)
        // Home keeps the room catalog; read it here when the editor opens before home has.
        .task { if store.groupCatalog == nil { await store.refreshGroups() } }
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
          ToolbarItem(placement: .confirmationAction) {
            Button(busy ? "Saving…" : routine.id.isEmpty ? "Add routine" : "Save routine") { save() }.disabled(
              busy || !store.connected
                || routine.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                || !hasPayload
                || routine.noAgent == true && (routine.script ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                || routine.schedule.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                || routine.prompt.count > 50000 || routine.enabled && !schedulePreviewValid)
          }
        }
        .confirmationDialog(
          "Delete this routine?", isPresented: $deleteConfirm, titleVisibility: .visible
        ) {
          Button("Delete routine", role: .destructive) {
            busy = true
            Task {
              defer { busy = false }
              do {
                try await store.api?.delete("/routines/\(APIClient.component(routine.id))")
                onSaved()
                dismiss()
              } catch { self.error = error.localizedDescription }
            }
          }
        }
    }
  }
  private var recipients: [Member] {
    let household = store.bootstrap?.household ?? []
    return store.bootstrap?.bots.first { $0.id == routine.botId }?.routineRecipients(household) ?? household
  }
  private var roomChoices: [GroupRoom] {
    GroupActivity.routineRoomChoices(store.groupCatalog, bot: store.bootstrap?.bots.first { $0.id == routine.botId }, bots: store.bootstrap?.bots ?? [])
  }
  private var hasPayload: Bool {
    !routine.prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      || !(routine.script ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      || !(routine.skills ?? []).isEmpty
  }
  private func save() {
    busy = true
    error = nil
    var value = routine
    value.recipientIds = value.recipientIds?.filter { id in recipients.contains { $0.id == id } }
    value.roomIds = RoutineRooms.saved(value.roomIds, catalog: store.groupCatalog, choices: roomChoices)
    Task {
      defer { busy = false }
      do {
        guard let api = store.api else { return }
        let _: Routine = try await api.write(
          routine.id.isEmpty ? "/routines" : "/routines/\(APIClient.component(routine.id))",
          value, method: routine.id.isEmpty ? "POST" : "PUT")
        onSaved()
        dismiss()
      } catch { self.error = error.localizedDescription }
    }
  }
}

/// Where a routine posts besides its assistant's chat, as the web's routine editor decides it.
enum RoutineRooms {
  /// The editor offers rooms only when Hermes can post in them and the server said where this routine posts.
  static func shown(_ roomIds: [String]?, catalog: GroupCatalog?, choices: [GroupRoom]) -> Bool {
    guard catalog?.routineDelivery == true, let roomIds else { return false }
    return !choices.isEmpty || !roomIds.isEmpty
  }
  /// The rooms a save sends: the chosen ones still offered, or nil (leave them unchanged) when none were shown.
  static func saved(_ roomIds: [String]?, catalog: GroupCatalog?, choices: [GroupRoom]) -> [String]? {
    guard shown(roomIds, catalog: catalog, choices: choices), let roomIds else { return nil }
    return roomIds.filter { id in choices.contains { $0.id == id } }
  }
  /// "Weekend plans, Barn crew", or nil when the routine posts in no room this person can name.
  static func names(_ roomIds: [String]?, catalog: GroupCatalog?) -> String? {
    let names = (roomIds ?? []).compactMap { id in catalog?.rooms.first { $0.id == id }?.name }
    return names.isEmpty ? nil : names.joined(separator: ", ")
  }
}

/// Per-routine overrides. Collapsed by default; catalogs never seed a model pin.
private struct RoutineAdvancedFields: View {
  @Binding var routine: Routine
  @Environment(AppStore.self) private var store
  @State private var expanded = false
  @State private var skills: [CapabilityItem] = []
  @State private var tools: [CapabilityItem] = []
  @State private var sources: [Routine] = []
  @State private var providers: [ModelProviderInfo] = []
  @State private var loading = false
  @State private var loaded = false
  @State private var errors: [String] = []
  private var selectedProvider: ModelProviderInfo? { providers.first { $0.matches(routine.provider) } }
  var body: some View {
    DisclosureGroup("Advanced", isExpanded: $expanded) {
      Text("Overrides apply only to this routine. Saved settings stay in place unless you change them.")
        .font(.caption).foregroundStyle(.secondary)
      if loading { ProgressView("Loading advanced choices") }
      ForEach(errors, id: \.self) { message in
        Text(message).foregroundStyle(Palette.danger).accessibilityAddTraits(.updatesFrequently)
      }
      if !errors.isEmpty { Button("Retry advanced choices") { Task { await load() } } }
      Toggle("Run the script without a model", isOn: Binding(
        get: { routine.noAgent == true }, set: { routine.noAgent = $0 }))
        .accessibilityIdentifier("routine.runScriptWithoutModel")
      TextField("Profile script, e.g. reports/morning.py", text: Binding(
        get: { routine.script ?? "" }, set: { routine.script = $0.isEmpty ? nil : $0 }))
        .textInputAutocapitalization(.never).autocorrectionDisabled()
      Text("Use an existing file in this assistant's Hermes scripts directory. With a model, its output becomes context. This option skips the model for script execution. Delivery to WildBots Bot Chat starts a separate model turn. Shell commands are not supported.")
        .font(.caption).foregroundStyle(.secondary)
      if routine.noAgent == true && (routine.script ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        Text("Script-only routines require a profile script.").foregroundStyle(Palette.danger)
      }
      agentFields.disabled(routine.noAgent == true)
    }
    .task(id: expanded) { if expanded && !loaded { await load() } }
  }
  @ViewBuilder private var agentFields: some View {
    if routine.noAgent == true {
      Text("Model settings are kept and are used when this option is turned off.").font(.caption).foregroundStyle(.secondary)
    }
    Picker("Provider", selection: Binding(
      get: { routine.provider ?? "" },
      set: { routine.provider = $0.isEmpty ? nil : $0; routine.model = nil })) {
      Text("Use assistant provider").tag("")
      if let provider = routine.provider, selectedProvider == nil || selectedProvider?.id != provider {
        Text("\(provider) (saved)").tag(provider)
      }
      ForEach(providers) { provider in
        Text(provider.name + (provider.authenticated == false ? " (disconnected)" : ""))
          .tag(provider.id).disabled(provider.authenticated == false)
      }
    }
    Picker("Model", selection: Binding(
      get: { routine.model ?? "" }, set: { routine.model = $0.isEmpty ? nil : $0 })) {
      Text("Use assistant model").tag("")
      if let model = routine.model, selectedProvider?.models.contains(where: { $0.id == model }) != true {
        Text("\(model) (saved)").tag(model)
      }
      ForEach(selectedProvider?.models ?? []) { model in
        Text(model.name + (model.available ? "" : " (unavailable)"))
          .tag(model.id).disabled(!model.available)
      }
    }.disabled(selectedProvider == nil)
    Button("Use assistant model and provider") { routine.model = nil; routine.provider = nil }
    if loaded && providers.isEmpty { Text("No providers reported. Existing pins are preserved.").font(.caption) }
    Text("Skills to load").font(.headline)
    if loaded && skills.isEmpty { Text("No skills reported for this assistant.").font(.caption) }
    ForEach(choiceIDs(skills, selected: routine.skills ?? []), id: \.self) { id in
      Toggle(choiceName(skills, id: id), isOn: Binding(
        get: { routine.skills?.contains(id) == true },
        set: { routine.skills = toggled(routine.skills ?? [], id: id, selected: $0) }))
    }
    Text("Toolsets").font(.headline)
    Toggle("Use profile tools", isOn: Binding(
      get: { routine.enabledToolsets == nil },
      set: { routine.enabledToolsets = $0 ? nil : tools.filter(\.enabled).map(\.id) }))
    if let selected = routine.enabledToolsets {
      if loaded && tools.isEmpty { Text("No toolsets reported for this assistant.").font(.caption) }
      ForEach(choiceIDs(tools, selected: selected), id: \.self) { id in
        Toggle(choiceName(tools, id: id), isOn: Binding(
          get: { routine.enabledToolsets?.contains(id) == true },
          set: { routine.enabledToolsets = toggled(routine.enabledToolsets ?? [], id: id, selected: $0) }))
      }
      if selected.isEmpty {
        Text("No tools allowed. Existing zero-tool settings are preserved, but Hermes cannot save a new empty selection here. Select a toolset or use profile tools.")
          .font(.caption)
      }
    }
    Text("Context from previous runs").font(.headline)
    Toggle("Include this routine's previous result", isOn: contextBinding("self"))
    Text("Include the latest result from other routines for this assistant. This does not change when they run.")
      .font(.caption).foregroundStyle(.secondary)
    if loaded && sources.isEmpty { Text("No other routines for this assistant.").font(.caption) }
    ForEach(sources) { source in Toggle(source.name, isOn: contextBinding(source.id)) }
    ForEach((routine.contextFrom ?? []).filter { ref in ref != "self" && !sources.contains { $0.id == ref } }, id: \.self) { ref in
      Toggle("\(ref) (saved, unavailable)", isOn: contextBinding(ref))
    }
  }
  private func contextBinding(_ id: String) -> Binding<Bool> {
    Binding(get: { routine.contextFrom?.contains(id) == true },
      set: { routine.contextFrom = toggled(routine.contextFrom ?? [], id: id, selected: $0) })
  }
  private func toggled(_ values: [String], id: String, selected: Bool) -> [String] {
    selected ? (values.contains(id) ? values : values + [id]) : values.filter { $0 != id }
  }
  private func choiceIDs(_ choices: [CapabilityItem], selected: [String]) -> [String] {
    choices.map(\.id) + selected.filter { id in !choices.contains { $0.id == id } }
  }
  private func choiceName(_ choices: [CapabilityItem], id: String) -> String {
    choices.first { $0.id == id }?.name ?? "\(id) (saved, unavailable)"
  }
  @MainActor private func load() async {
    guard let api = store.api, !loading else { return }
    loading = true
    errors = []
    defer { loading = false; loaded = true }
    let path = "/bots/\(APIClient.component(routine.botId))"
    do { skills = try await api.get("\(path)/skills") }
    catch { errors.append("Could not load skills. \(error.localizedDescription)") }
    do { tools = try await api.get("\(path)/tools") }
    catch { errors.append("Could not load toolsets. \(error.localizedDescription)") }
    do {
      let catalog: ModelCatalog = try await api.get("/models?botId=\(APIClient.component(routine.botId))")
      providers = catalog.providers
    } catch { errors.append("Could not load models. \(error.localizedDescription)") }
    do {
      let all: [Routine] = try await api.get("/routines")
      sources = all.filter { $0.botId == routine.botId && $0.id != routine.id }
    } catch { errors.append("Could not load context sources. \(error.localizedDescription)") }
  }
}

/// The editor's preview: the avatar large, with chips to try each live state.
private enum SettingsConfirmation: Identifiable {
  case model(warning: String), personal(name: String), delete(name: String), discard, leaveMemory
  var id: String {
    switch self {
    case .model: "model"
    case .personal: "personal"
    case .delete: "delete"
    case .discard: "discard"
    case .leaveMemory: "leave-memory"
    }
  }
  var title: String {
    switch self {
    case .model: "Use this model?"
    case .personal(let name): "Make \(name) your personal assistant?"
    case .delete(let name): "Delete \(name)?"
    case .discard: "Discard your unsaved changes?"
    case .leaveMemory: "Leave memory without saving?"
    }
  }
  var message: String {
    switch self {
    case .model(let warning): warning
    case .personal: "It will disappear for the rest of the household, along with its conversation, routines and group chats."
    case .delete: "This deletes the assistant in Hermes and removes its settings from WildBots."
    case .discard: "Your unsaved changes will be lost."
    case .leaveMemory: "Your unsaved memory edits will be lost. Save them before leaving if you want to keep them."
    }
  }
  var acceptLabel: String {
    switch self {
    case .model: "Confirm this model"
    case .personal: "Make it personal"
    case .delete: "Yes, delete"
    case .discard: "Discard changes"
    case .leaveMemory: "Discard edits and leave"
    }
  }
  var keepLabel: String { if case .delete = self { "Keep assistant" } else { "Keep editing" } }
  var destructive: Bool { if case .model = self { false } else { true } }
}

/// A native modal sheet with explicit colors. System alert glass cannot style warning text.
struct AssistantConfirmationSheet: View {
  let title: String
  let message: String
  let acceptLabel: String
  let keepLabel: String
  let destructive: Bool
  let accept: () -> Void
  let keep: () -> Void
  @Environment(\.colorScheme) private var scheme
  @Environment(\.horizontalSizeClass) private var horizontalSizeClass
  @State private var height: CGFloat = 340
  @AccessibilityFocusState private var titleFocused: Bool
  private var content: some View {
    VStack(alignment: .leading, spacing: 20) {
      Text(title).font(.title3.weight(.semibold)).foregroundStyle(Color.primary)
        .fixedSize(horizontal: false, vertical: true).accessibilityAddTraits(.isHeader)
        .accessibilityFocused($titleFocused)
      Text(message).font(.body).foregroundStyle(Palette.messageMetadata)
        .fixedSize(horizontal: false, vertical: true)
      VStack(spacing: 12) {
        Button(role: destructive ? .destructive : nil, action: accept) {
          Text(acceptLabel).font(.body.weight(.semibold))
            .frame(maxWidth: .infinity, minHeight: 44).padding(.vertical, 6).contentShape(Capsule())
        }.buttonStyle(.plain).foregroundStyle(destructive ? Palette.danger : Palette.accent)
          .background(Palette.raised(scheme), in: Capsule())
          .overlay(Capsule().strokeBorder(Palette.line))
          .accessibilityIdentifier("confirmationAccept")
        Button(role: .cancel, action: keep) {
          Text(keepLabel).font(.body.weight(.semibold))
            .frame(maxWidth: .infinity, minHeight: 44)
        }.buttonStyle(.accentProminent).keyboardShortcut(.cancelAction)
          .accessibilityIdentifier("confirmationKeep")
      }
    }.padding(24).padding(.top, 8).frame(maxWidth: .infinity, alignment: .leading)
      .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height = $0 }
  }
  private var sheet: some View {
    ScrollView { content }.scrollBounceBehavior(.basedOnSize).frame(idealHeight: height)
      .background(Palette.raised(scheme)).presentationBackground(Palette.raised(scheme))
      .presentationDragIndicator(.visible).interactiveDismissDisabled(false)
      .accessibilityIdentifier("settingsConfirmation")
      .accessibilityAction(.escape, keep).onAppear { titleFocused = true }
  }
  @ViewBuilder var body: some View {
    if horizontalSizeClass == .compact {
      sheet.presentationDetents([.height((height + 20).rounded(.up))])
    } else if #available(iOS 18, *) {
      sheet.presentationSizing(.form.fitted(horizontal: false, vertical: true))
    } else { sheet }
  }
}

/// Preserve native disabled styling instead of forcing the enabled label color through it.
private struct EnabledPrimaryMenuLabel: ViewModifier {
  @Environment(\.isEnabled) private var enabled
  @ViewBuilder func body(content: Content) -> some View {
    if enabled { content.foregroundStyle(.primary) } else { content }
  }
}

private struct AvatarStage: View {
  var avatar: AvatarConfig
  @Binding var state: ActivityState
  var name: String
  /// The name as it is being typed, shown under the avatar while creating.
  var caption: String? = nil
  @Environment(\.colorScheme) private var scheme
  private let states: [ActivityState] = [.idle, .thinking, .working, .waiting, .blocked, .done]
  var body: some View {
    VStack(spacing: 18) {
      AvatarView(avatar: avatar, state: state, size: 124, name: name).padding(.top, 12)
      if let caption {
        Text(caption.trimmingCharacters(in: .whitespaces).isEmpty ? "Your new assistant" : caption)
          .font(.title3.weight(.semibold)).lineLimit(1).foregroundStyle(caption.isEmpty ? Palette.muted : Color.primary)
          .accessibilityHidden(true)
      }
      ChipFlow(spacing: 6) {
        ForEach(states, id: \.self) { option in
          let selected = option == state
          Button { state = option } label: {
            Text(option.label).font(.caption).padding(.horizontal, 11).padding(.vertical, 6)
              .frame(minHeight: 44).contentShape(Capsule())
          }.buttonStyle(.plain)
            .foregroundStyle(selected ? Palette.surface(scheme) : Color.primary)
            .background(selected ? Palette.accent : Palette.raised(scheme), in: Capsule())
            .overlay(Capsule().strokeBorder(selected ? Palette.accent : Palette.line))
            .accessibilityAddTraits(selected ? .isSelected : [])
            .accessibilityIdentifier("previewState.\(option.rawValue)")
        }
      }
      Text("Preview only. The real state always comes from Hermes.").font(.footnote)
        .foregroundStyle(Palette.messageMetadata)
    }
    .frame(maxWidth: .infinity).padding(.horizontal, 16).padding(.top, 16).padding(.bottom, 14)
    .background(
      RadialGradient(
        stops: [
          .init(color: Palette.raised(scheme), location: 0.28),
          .init(color: Palette.rail(scheme), location: 0.62),
        ], center: UnitPoint(x: 0.5, y: 0.38), startRadius: 0, endRadius: 260),
      in: RoundedRectangle(cornerRadius: 18))
  }
}

/// A grid of mini static avatars, one per choice, like the web editor's tile pickers.
private struct AvatarTiles<Value: OpenVocabulary>: View {
  var group: String
  var options: [(Value, String)]
  var selected: Value
  var preview: (Value) -> AvatarConfig
  var select: (Value) -> Void
  @Environment(\.colorScheme) private var scheme
  @ScaledMetric(relativeTo: .caption) private var tileWidth: CGFloat = 64
  var body: some View {
    LazyVGrid(columns: [GridItem(.adaptive(minimum: tileWidth), spacing: 8)], spacing: 10) {
      ForEach(options, id: \.0.rawValue) { value, label in
        let on = value == selected
        Button {
          select(value)
        } label: {
          VStack(spacing: 6) {
            AvatarView(avatar: preview(value), size: 40, name: label, forceReducedMotion: true)
              .frame(maxWidth: .infinity).frame(height: 56)
              .background(
                on ? Palette.accentSoft : Palette.raised(scheme),
                in: RoundedRectangle(cornerRadius: 14)
              )
              .overlay(
                RoundedRectangle(cornerRadius: 14).strokeBorder(
                  on ? Palette.accent : Palette.line, lineWidth: on ? 2 : 1))
            Text(label).font(.caption).fontWeight(on ? .semibold : .regular)
              .foregroundStyle(on ? Color.primary : Palette.muted).lineLimit(2)
              .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
          }.contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityElement(children: .ignore).accessibilityLabel(label)
          .accessibilityAddTraits(on ? [.isButton, .isSelected] : .isButton)
          .accessibilityIdentifier("avatarTile.\(group).\(value.rawValue)")
      }
    }.padding(.vertical, 4)
  }
}

/// Wraps chips onto centered rows.
private struct ChipFlow: Layout {
  var spacing: CGFloat
  private func rows(_ width: CGFloat, _ subviews: Subviews) -> [[(Int, CGSize)]] {
    var rows: [[(Int, CGSize)]] = [[]]
    var x: CGFloat = 0
    for (index, view) in subviews.enumerated() {
      let size = view.sizeThatFits(.unspecified)
      if x > 0 && x + size.width > width {
        rows.append([])
        x = 0
      }
      rows[rows.count - 1].append((index, size))
      x += size.width + spacing
    }
    return rows
  }
  // Small typed steps keep older Swift type checkers within their time limit.
  private func width(of row: [(Int, CGSize)]) -> CGFloat {
    let content: CGFloat = row.map(\.1.width).reduce(0, +)
    return content + spacing * CGFloat(max(row.count - 1, 0))
  }
  private func height(of row: [(Int, CGSize)]) -> CGFloat {
    row.map(\.1.height).max() ?? 0
  }
  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let rows = rows(proposal.width ?? .infinity, subviews)
    let content: CGFloat = rows.map(height(of:)).reduce(0, +)
    let height = content + spacing * CGFloat(max(rows.count - 1, 0))
    let widest: CGFloat = rows.map(width(of:)).max() ?? 0
    return CGSize(width: proposal.width ?? widest, height: height)
  }
  func placeSubviews(
    in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()
  ) {
    var y = bounds.minY
    for row in rows(bounds.width, subviews) {
      let rowWidth = width(of: row)
      let rowHeight = height(of: row)
      var x = bounds.midX - rowWidth / 2
      for (index, size) in row {
        subviews[index].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
        x += size.width + spacing
      }
      y += rowHeight + spacing
    }
  }
}

/// Which save button is working or just finished, like the web's per-button Saving… and Saved.
struct SaveProgress: Equatable {
  enum Phase { case saving, saved }
  private var key: String?
  private var phase: Phase?
  mutating func begin(_ key: String) { self.key = key; phase = .saving }
  mutating func succeed(_ key: String) { if self.key == key { phase = .saved } }
  /// A failed save returns the button to its normal label so the error can speak.
  mutating func fail(_ key: String) { if self.key == key { self.key = nil; phase = nil } }
  /// The Saved confirmation fades on its own, unless a newer save has already replaced it.
  mutating func expire(_ key: String) { if self.key == key && phase == .saved { self.key = nil; phase = nil } }
  func label(_ key: String, idle: String) -> String {
    guard self.key == key else { return idle }
    switch phase {
    case .saving: return "Saving…"
    case .saved: return "Saved"
    case nil: return idle
    }
  }
}

enum SettingsLimits {
  static let name = 100
  static let instructions = 50_000
  static let portraitPrompt = 2_000
  /// Quiet until a field nears its limit, then a counter, then a plain instruction once it is over.
  static func message(_ subject: String, count: Int, limit: Int, action: String = "save") -> String? {
    if count > limit { return "\(subject) \((count - limit).formatted()) character\(count - limit == 1 ? "" : "s") over the \(limit.formatted()) limit. Shorten the text to \(action)." }
    if count * 10 >= limit * 9 { return "\(count.formatted()) of \(limit.formatted()) characters" }
    return nil
  }
}

// MARK: - Always-allowed commands (Workstream B)

/// The reverse of "Always allow" (src/components/ApprovalSettingsPanel.tsx): the command patterns
/// Hermes runs for this assistant without asking, each with Remove, and Hermes's own review of
/// routine commands. An older add-on reports it can't, and the page says so.
struct ApprovalSettingsView: View {
  var botId: String
  var botName: String
  @Environment(AppStore.self) private var store
  @State private var settings: ApprovalSettings?
  @State private var busy = false
  @State private var error: String?
  @State private var notice: String?
  @State private var confirmingAutoReview = false
  private var path: String { "/bots/\(APIClient.component(botId))/approval-settings" }
  var body: some View {
    Form {
      if let error { Section { ErrorBanner(message: error, dismiss: { self.error = nil }) } }
      if let notice { Section { Text(notice).foregroundStyle(Palette.accent).accessibilityIdentifier("approvalSettingsNotice") } }
      if let settings, !settings.supported {
        Section { Text(settings.reason ?? "This Hermes integration can't list always-allowed commands.").foregroundStyle(.secondary) }
      } else if let settings {
        Section {
          if settings.allowlist.isEmpty {
            Text("Nothing yet. Choose Always allow on an approval to add one.").foregroundStyle(.secondary)
          }
          ForEach(settings.allowlist, id: \.self) { pattern in
            HStack {
              Text(pattern).font(.body.monospaced()).textSelection(.enabled)
              Spacer()
              Button("Remove", role: .destructive) { remove(pattern) }.buttonStyle(.borderless)
                .accessibilityLabel("Remove \(pattern)").accessibilityIdentifier("approvalRemove.\(pattern)")
            }
          }
        } header: { Text("Always-allowed commands") } footer: {
          Text("\(botName) runs these kinds of commands without asking, in every conversation. Each one is a kind Hermes flags, so it covers more than the command you first allowed."
            + (settings.allowlist.isEmpty ? "" : " Removing one takes effect at \(botName)'s next command in this app. A chat already running in another Hermes app, such as Discord, keeps it until that chat ends."))
        }
        Section {
          Toggle("Auto-review routine commands", isOn: Binding(
            get: { settings.mode == "smart" },
            set: { on in if on { confirmingAutoReview = true } else { review(false) } }))
            .disabled(!settings.canManageAutoReview || settings.mode == "off")
            .accessibilityIdentifier("approvalAutoReview")
        } footer: {
          Text("Hermes checks each flagged command first and runs the ones it judges safe without asking. Anything it doubts still comes to you, and only for once."
            + (settings.mode == "off" ? " Hermes doesn't ask before commands for this assistant. Change that in Hermes."
              : settings.canManageAutoReview ? "" : " Only an integration administrator can change auto-review."))
        }
      } else { Section { ProgressView() } }
    }.disabled(busy).householdListBackground().accessibilityIdentifier("settings.approvals")
      .navigationTitle("Always-allowed commands")
      .task { await load() }
      .alert("Let Hermes approve routine commands?", isPresented: $confirmingAutoReview) {
        Button("Keep asking me", role: .cancel) {}
        Button("Turn on auto-review") { review(true) }
      } message: { Text("Hermes will run commands it judges safe for \(botName) without asking you. You'll still be asked about anything it doubts.") }
  }
  private func load() async {
    guard let api = store.api else { return }
    do { settings = try await api.get(path) } catch { self.error = error.localizedDescription }
  }
  private func remove(_ pattern: String) {
    change(success: "Removed “\(pattern)”. Hermes will ask again next time.") { api in
      try await api.write(path + "/allowlist", ["pattern": pattern], method: "DELETE")
    }
  }
  private func review(_ on: Bool) {
    change(success: on ? "Hermes now reviews routine commands itself." : "Hermes now asks before every flagged command.") { api in
      try await api.write(path, ["autoReview": on], method: "PUT")
    }
  }
  private func change(success: String, _ work: @escaping (APIClient) async throws -> ApprovalSettings) {
    guard let api = store.api, !busy else { return }
    busy = true; error = nil; notice = nil
    let scope = store.scope
    Task {
      defer { busy = false }
      do {
        let value = try await work(api)
        guard scope == store.scope else { return }
        settings = value; notice = success
      } catch { if scope == store.scope { self.error = error.localizedDescription } }
    }
  }
}
