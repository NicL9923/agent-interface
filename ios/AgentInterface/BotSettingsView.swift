import SwiftUI
import UniformTypeIdentifiers

struct BotSettingsView: View {
  private let initialBot: Bot?
  var close: (() -> Void)?
  init(bot: Bot?, close: (() -> Void)? = nil) {
    initialBot = bot
    self.close = close
  }
  /// Set when creation succeeded but the avatar did not save, turning the sheet into that
  /// assistant's settings so the chosen look can be retried instead of lost.
  @State private var createdBot: Bot?
  /// The assistant being edited: the one opened, or the one this sheet just created.
  private var bot: Bot? { initialBot ?? createdBot }
  @State private var creationStep = CreationStep.look
  @State private var avatarFailure: String?
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State private var form = BotInput()
  @State private var savedForm = BotInput()
  @State private var savedAvatar = AvatarConfig()
  @State private var savedCapabilities: [String: Set<String>] = [:]
  @State private var discardConfirm = false
  @State private var initialized = false
  @State private var detailLoaded = false
  @State private var avatar = AvatarConfig()
  @State private var lastDrawn = AvatarConfig()
  @State private var lastPortrait: AvatarConfig?
  @State private var previewState: ActivityState = .idle
  @State private var tab = "Details"
  @State private var tools: [CapabilityItem] = []
  @State private var skills: [CapabilityItem] = []
  @State private var routines: [Routine] = []
  @State private var busy = false
  @State private var error: String?
  @State private var notice: String?
  @State private var confirmModel = false
  @State private var confirmPersonal = false
  @State private var personalConfirmed = false
  @State private var deleteConfirm = false
  @State private var portraitImport = false
  @State private var portraitPrompt = ""
  @State private var editingRoutine: Routine?
  @State private var addingRoutine = false
  @State private var mcpText = ""
  @State private var templates: [RoutineTemplate] = []
  @State private var deletingRoutine: Routine?
  @State private var catalogReady: Set<String> = []
  @State private var catalogLoading: Set<String> = []
  @State private var loadId = UUID()
  @State private var progress = SaveProgress()
  let tabs = ["Details", "Avatar", "Connections", "Tools", "Skills", "Routines", "Memory", "Logins"]
  // Split out of body so the type checker stays fast on slower CI machines.
  private var tabBar: some View {
    HStack(spacing: 8) {
      ForEach(tabs.prefix(2), id: \.self) { title in
        Button(title) { selectTab(title) }.buttonStyle(.bordered).tint(
          tab == title ? Palette.accent : .secondary).frame(minHeight: 44)
      }
      Spacer(minLength: 0)
      Menu {
        ForEach(tabs.dropFirst(2), id: \.self) { title in
          Button {
            selectTab(title)
          } label: {
            if tab == title { Label(title, systemImage: "checkmark") }
            else { Text(title) }
          }
        }
      } label: {
        Label(tabs.prefix(2).contains(tab) ? "More" : tab, systemImage: "chevron.down")
          .font(.subheadline).lineLimit(1).padding(.horizontal, 10).frame(minHeight: 44)
      }.tint(tabs.prefix(2).contains(tab) ? .secondary : Palette.accent)
        .accessibilityLabel("More settings")
        .accessibilityValue(tabs.prefix(2).contains(tab) ? "" : tab)
        .accessibilityIdentifier("settingsMore")
    }.font(.subheadline).padding(.horizontal).padding(.vertical, 6)
  }
  @ViewBuilder private var tabContent: some View {
    if let error {
      ErrorBanner(message: error, dismiss: { self.error = nil }).padding(.horizontal)
    }
    if let notice { Text(notice).font(.footnote).foregroundStyle(Palette.accent).padding(10) }
    if tab == "Connections" {
      if let bot { IntegrationsView(botId: bot.id) }
    } else if tab == "Logins" {
      if let bot { VaultView(botId: bot.id) }
    } else if tab == "Memory" {
      if let bot { MemoryDrawer(botId: bot.id) }
    } else { Form {
      switch tab {
      case "Details": details
      case "Avatar": avatarEditor
      case "Tools": capabilities("tools")
      case "Skills": capabilities("skills")
      default: routineList
      }
    }.householdListBackground().disabled(busy || (bot != nil && !detailLoaded)) }
  }
  var body: some View {
    NavigationStack { routinePresentations(editor) }
  }
  enum CreationStep { case look, role }
  /// Creation is two short steps in one sheet: name and look, then role and model. Tabs that need
  /// an existing assistant stay hidden until it exists.
  @ViewBuilder private var creationContent: some View {
    if let error { ErrorBanner(message: error, dismiss: { self.error = nil }).padding(.horizontal) }
    Form {
      creationHeader
      Section { unavailable("botConfiguration") }
      if creationStep == .look {
        avatarPreview
        nameSection
        avatarControls
        Section {
          Button("Next: role and model") { creationStep = .role }.disabled(!nameReady)
            .accessibilityIdentifier("creationNextBottom")
        } footer: { if !nameReady { Text("Name the assistant to continue.") } }
      } else {
        roleSections
        saveSection
      }
    }.id(creationStep) // Each step opens at its top, not at the last step's scroll position.
      .householdListBackground().disabled(busy)
  }
  private var creationHeader: some View {
    Section {
      VStack(alignment: .leading, spacing: 2) {
        Text(creationStep == .look ? "Step 1 of 2" : "Step 2 of 2").font(.caption).foregroundStyle(.secondary)
        Text(creationStep == .look ? "Name and look" : "Role and model").font(.title3.bold())
          .accessibilityAddTraits(.isHeader)
      }.accessibilityElement(children: .combine).accessibilityIdentifier("creationStep")
    }.listRowBackground(Color.clear).listRowInsets(EdgeInsets(top: 0, leading: 4, bottom: 0, trailing: 4))
  }
  @ToolbarContentBuilder private var editorToolbar: some ToolbarContent {
    ToolbarItem(placement: .cancellationAction) {
      if bot == nil && creationStep == .role {
        Button { creationStep = .look } label: { Label("Back", systemImage: "chevron.backward").labelStyle(.titleAndIcon) }
          .disabled(busy).accessibilityIdentifier("creationBack")
      } else {
        Button("Close") { if dirty { discardConfirm = true } else { closeSheet() } }.disabled(busy)
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
    }
  }
  /// A message belongs to the screen that produced it, so it does not follow you to another tab.
  private func selectTab(_ title: String) {
    tab = title
    error = nil
    notice = nil
  }
  private var editor: some View {
    VStack(spacing: 0) {
      if bot == nil {
        creationContent
      } else {
        tabBar
        if !detailLoaded {
          if let error { ErrorBanner(message: error); Button("Retry settings") { Task { await loadTab() } } }
          else { ProgressView("Loading assistant settings…") }
        }
        tabContent
      }
    }.navigationTitle(bot?.name ?? "New assistant").navigationBarTitleDisplayMode(.inline)
      .toolbar { editorToolbar }
      .onAppear {
        guard !initialized else { return }
        initialized = true
        form = BotInput(bot: bot, fallback: store.bootstrap?.bots.first)
        savedForm = form
        mcpText = form.enabledMcpServers.joined(separator: ", ")
        avatar = bot?.avatar ?? AvatarConfig()
        savedAvatar = avatar
        if avatar.mode != "portrait" { lastDrawn = avatar } else { lastPortrait = avatar }
      }
      .task(id: tab) { await loadTab() }
      .interactiveDismissDisabled(dirty || busy)
      .confirmationDialog("Discard your unsaved changes?", isPresented: $discardConfirm, titleVisibility: .visible) {
        Button("Discard changes", role: .destructive) { closeSheet() }
      }
      .onChange(of: avatar) { _, value in
        if value.mode != "portrait" {
          lastDrawn = value
        } else if !(value.src ?? "").isEmpty {
          lastPortrait = value
        }
      }
      .confirmationDialog(
        "Hermes asks for confirmation before using this model.", isPresented: $confirmModel,
        titleVisibility: .visible
      ) { Button("Confirm this model") { saveBot(confirmed: true) } }
      .confirmationDialog(
        "Make \(bot?.name ?? "this assistant") your personal assistant?", isPresented: $confirmPersonal,
        titleVisibility: .visible
      ) {
        Button("Make it personal", role: .destructive) { saveBot(personal: true) }
      } message: {
        Text("It will disappear for the rest of the household, along with its conversation, routines and group chats.")
      }
      .confirmationDialog(
        "Delete \(bot?.name ?? "this assistant")?", isPresented: $deleteConfirm,
        titleVisibility: .visible
      ) {
        Button("Delete assistant", role: .destructive) {
          action {
            guard let id = bot?.id, let api = store.api else { return }
            store.deletedBotId = id
            try await api.delete("/bots/\(APIClient.component(id))")
            await store.refreshBootstrap()
            closeSheet()
          }
        }
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
            await loadTab()
          }
        }
      }
      .sheet(item: $editingRoutine) { routine in
        RoutineEditor(routine: routine, onSaved: { Task { await loadTab() } }).appStore(
          store)
      }
      .sheet(isPresented: $addingRoutine) {
        if let bot {
          RoutineEditor(routine: .empty(botId: bot.id), onSaved: { Task { await loadTab() } })
            .appStore(store)
        }
      }
  }
  @ViewBuilder private var details: some View {
    Section {
      unavailable("botConfiguration")
    }
    nameSection
    roleSections
    saveSection
  }
  @ViewBuilder private var roleSections: some View {
    descriptionAndInstructions
    Section {
      Button(interactiveEnabled ? "Interactive replies enabled" : "Enable interactive replies") {
        form.instructions = (form.instructions.trimmingCharacters(in: .whitespacesAndNewlines) + "\n\n" + NativeInteractiveReplyInstructions)
          .trimmingCharacters(in: .whitespacesAndNewlines)
      }.disabled(busy || interactiveEnabled)
    } footer: {
      Text("Adds instructions for checklists, itineraries and calendar proposals. Save changes to apply them.")
    }
    Section {
      ModelSelectionRow(botId: bot?.id, selection: ModelChoice(provider: form.provider ?? "", model: form.model), disabled: busy || !store.supports("botConfiguration")) {
        form.model = $0.model
        form.provider = $0.provider
      }
    } header: { Text("Model") } footer: {
      Text("Model choices come from your connected Hermes providers. Star models to keep them handy.")
    }
    Section {
      Toggle("Shared with your household", isOn: $form.shared)
    } footer: {
      Text(
        form.shared
          ? "This assistant has one shared model. Provider and model changes are visible to both people."
          : "Only you see a personal assistant in WildBots. Anyone with Hermes dashboard access can still reach its memory and logins.")
    }
    Section {
      TextField("Existing server ids, separated by commas", text: $mcpText, axis: .vertical)
        .textInputAutocapitalization(.never).autocorrectionDisabled()
        .onChange(of: mcpText) { _, value in form.enabledMcpServers = BotInput.serverIds(value) }
    } header: { Text("Enabled existing MCP servers") } footer: {
      Text("Only existing Hermes connections can be configured here.")
    }
  }
  private var nameReady: Bool { !form.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
  private var canSave: Bool {
    store.supports("botConfiguration") && store.connected && nameReady
      && !form.model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      && form.instructions.count <= SettingsLimits.instructions
  }
  @ViewBuilder private var saveSection: some View {
    Section {
      Button(progress.label("details", idle: bot == nil ? "Create assistant" : "Save changes")) { saveBot() }.disabled(!canSave)
      if bot != nil {
        Button("Delete assistant", role: .destructive) { deleteConfirm = true }.disabled(
          !store.supports("botConfiguration") || !store.connected)
      }
    }
  }
  /// Split out of `details` so the type checker stays fast on slower CI machines.
  private var nameSection: some View {
    Section("Name") {
      TextField("Name", text: $form.name)
        .onChange(of: form.name) { _, value in
          if value.count > SettingsLimits.name { form.name = String(value.prefix(SettingsLimits.name)) }
        }
    }
  }
  @ViewBuilder private var descriptionAndInstructions: some View {
    Section("Description") { TextField("Description", text: $form.description, axis: .vertical).lineLimit(1...4) }
    Section {
      TextEditor(text: $form.instructions).frame(minHeight: 180).accessibilityLabel("Assistant instructions")
        .overlay(alignment: .topLeading) {
          if form.instructions.isEmpty {
            Text("How should this assistant help?").foregroundStyle(.tertiary).padding(.top, 8).padding(.leading, 5).allowsHitTesting(false)
          }
        }
    } header: { Text("Instructions") } footer: {
      if let limit = SettingsLimits.message("Instructions are", count: form.instructions.count, limit: SettingsLimits.instructions) {
        Text(limit).foregroundStyle(form.instructions.count > SettingsLimits.instructions ? Color.red : Color.secondary)
          .accessibilityIdentifier("instructionsLimit")
      }
    }
  }
  private var interactiveEnabled: Bool { form.instructions.contains(NativeInteractiveReplyInstructions) }
  @ViewBuilder private var avatarEditor: some View {
    if let avatarFailure { avatarFailureSection(avatarFailure) }
    avatarPreview
    avatarControls
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
          Text("Geometric").tag("geometric")
          Text("Mascot").tag("mascot")
          if bot != nil { Text("Portrait").tag("portrait") }
        }.pickerStyle(.segmented).accessibilityIdentifier("avatarStyle")
      } header: { Text("Style") } footer: {
        // A portrait is stored with the assistant, so it can only be added once it exists.
        if bot == nil { Text("Want a portrait? Upload or generate one in Avatar settings after you create the assistant.") }
      }
      if avatar.mode == "portrait" {
        Section("Portrait") {
          Text("Portraits stay still. Activity appears in a separate state indicator.")
            .font(.caption).foregroundStyle(.secondary)
          Button("Upload portrait") { portraitImport = true }.disabled(
            bot == nil || !store.supports("uploads") || !store.connected)
          unavailable("uploads")
          TextField("Describe a portrait", text: $portraitPrompt, axis: .vertical).lineLimit(2...5)
          if let limit = SettingsLimits.message("The description is", count: portraitPrompt.count, limit: SettingsLimits.portraitPrompt) {
            Text(limit).font(.caption).foregroundStyle(portraitPrompt.count > SettingsLimits.portraitPrompt ? Color.red : Color.secondary)
              .accessibilityIdentifier("portraitPromptLimit")
          }
          Button("Generate portrait") { generatePortrait() }.disabled(
            bot == nil || !store.supports("portraitGeneration") || !store.connected
              || portraitPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
              || portraitPrompt.count > SettingsLimits.portraitPrompt)
          unavailable("portraitGeneration")
          Text("Use a PNG, JPEG, or WebP image up to 2 MB.").font(.caption).foregroundStyle(
            .secondary)
        }
      } else {
        if avatar.mode == "geometric" {
          Section("Shape") {
            AvatarTiles(
              group: "shape", options: AvatarConfig.shapes.map { ($0, $0.capitalized) },
              selected: avatar.shape ?? "blob",
              preview: { var a = avatar; a.shape = $0; a.accessory = "none"; return a },
              select: { avatar.shape = $0 })
          }
        } else {
          Section("Character") { characterTiles(AvatarConfig.everydayFamilies) }
          Section("Seasonal") { characterTiles(AvatarConfig.seasonalFamilies) }
        }
        Section("Color") { colorSwatches }
        Section("Eyes") {
          AvatarTiles(
            group: "eyes", options: ["oval", "round", "visor", "spark"].map { ($0, $0.capitalized) },
            selected: avatar.eyes ?? "oval",
            preview: { var a = avatar; a.eyes = $0; a.accessory = "none"; return a },
            select: { avatar.eyes = $0 })
        }
        Section("Accessory") {
          AvatarTiles(
            group: "accessory",
            options: [("none", "None"), ("hat", "Cowboy hat"), ("glasses", "Glasses")],
            selected: avatar.accessory ?? "none",
            preview: { var a = avatar; a.accessory = $0; return a },
            select: { avatar.accessory = $0 })
        }
        Section("Fine-tune eyes") {
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
        }
      }
      if bot != nil {
        Section {
          Button(progress.label("avatar", idle: "Save avatar")) { saveAvatar() }.disabled(
            !store.connected || avatar.mode == "portrait" && (avatar.src ?? "").isEmpty)
        }
      }
    }
  }
  /// Creation went through but the look did not save: say so plainly and offer the retry here.
  private func avatarFailureSection(_ message: String) -> some View {
    Section {
      Label(message, systemImage: "exclamationmark.triangle").foregroundStyle(Palette.danger)
        .accessibilityIdentifier("avatarFailure")
      Button(progress.label("avatar", idle: "Retry saving avatar")) { saveAvatar() }
        .disabled(busy || !store.connected).accessibilityIdentifier("retryAvatar")
    }
  }
  private func characterTiles(_ families: [(id: String, label: String)]) -> some View {
    AvatarTiles(
      group: "family", options: families.map { ($0.id, $0.label) },
      selected: avatar.family ?? "sprout",
      preview: { var a = avatar.selectingFamily($0); a.accessory = "none"; return a },
      select: { avatar = avatar.selectingFamily($0) })
  }
  private var colorSwatches: some View {
    LazyVGrid(columns: [GridItem(.adaptive(minimum: 40), spacing: 6)], spacing: 8) {
      ForEach(AvatarConfig.colors, id: \.self) { hex in
        let selected = avatar.color?.lowercased() == hex.lowercased()
        Button {
          avatar.color = hex
        } label: {
          Circle().fill(Color(hex: hex)).overlay(Circle().strokeBorder(.black.opacity(0.1)))
            .frame(width: 32, height: 32).padding(4)
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
      ).labelsHidden().frame(width: 40, height: 40)
    }.padding(.vertical, 4)
  }
  /// Switching styles keeps the drawn character's color, eyes, accessory, and eye tuning,
  /// returning from Portrait restores the last drawn character, and returning to Portrait
  /// restores the last portrait.
  private func switchAvatarMode(_ mode: String) {
    guard mode != avatar.mode else { return }
    if mode == "portrait" {
      // Restore the last uploaded, generated, or saved portrait from this session.
      if let lastPortrait {
        avatar = lastPortrait
        return
      }
      var next = avatar
      next.mode = "portrait"
      next.src = nil
      next.origin = "uploaded"
      avatar = next
      return
    }
    var next = lastDrawn
    next.mode = mode
    if mode == "geometric" { next.shape = lastDrawn.shape ?? "blob" }
    if mode == "mascot" { next.family = lastDrawn.family ?? "bear" }
    avatar = next
  }
  @ViewBuilder private func capabilities(_ kind: String) -> some View {
    Section {
      unavailable(kind)
      if bot != nil {
        let items = kind == "tools" ? tools : skills
        ForEach(items) { item in
          Toggle(
            isOn: Binding(
              get: {
                (kind == "tools" ? tools : skills).first { $0.id == item.id }?.enabled == true
                  || item.required == true
              },
              set: { selected in
                if kind == "tools", let i = tools.firstIndex(where: { $0.id == item.id }) {
                  tools[i].enabled = selected
                }
                if kind == "skills", let i = skills.firstIndex(where: { $0.id == item.id }) {
                  skills[i].enabled = selected
                }
              })
          ) {
            VStack(alignment: .leading, spacing: 4) {
              Text(item.name).font(.headline)
              Text(item.description).font(.caption).foregroundStyle(.secondary)
              if item.required == true {
                Text("Required by Hermes").font(.caption).foregroundStyle(.secondary)
              }
            }
          }.disabled(item.required == true || !store.supports(kind) || !catalogReady.contains(kind))
        }
        if catalogLoading.contains(kind) {
          ProgressView("Loading \(kind)…")
        } else if !catalogReady.contains(kind) && store.supports(kind) {
          Button("Retry loading \(kind)") { Task { await loadTab() } }
        }
        if items.isEmpty && catalogReady.contains(kind) {
          Text("No \(kind) were reported by Hermes.").foregroundStyle(.secondary)
        }
        Button(progress.label(kind, idle: "Save \(kind)")) {
          action(progressKey: kind) {
            guard let bot, catalogReady.contains(kind) else { return }
            let ids = (kind == "tools" ? tools : skills).filter {
              $0.enabled || $0.required == true
            }.map(\.id)
            try await store.perform(
              "/bots/\(APIClient.component(bot.id))/\(kind)", ["ids": ids], method: "PUT")
            savedCapabilities[kind] = Set(ids)
            notice = "Saved"
          }
        }.disabled(!store.supports(kind) || !store.connected || !catalogReady.contains(kind))
      }
    }
  }
  @ViewBuilder private var routineList: some View {
    Section {
      unavailable("routines")
      Text("Routines keep working when you are away. Choose notification recipients explicitly.")
        .font(.footnote).foregroundStyle(.secondary)
    }
    if let bot {
      if !templates.isEmpty {
        Section("Routine recipes") {
          ForEach(templates) { template in
            Button {
              editingRoutine = Routine(id: "", botId: bot.id, name: template.name, prompt: template.prompt, schedule: template.schedule, enabled: false, recipientIds: [store.bootstrap?.user.id].compactMap { $0 })
            } label: {
              VStack(alignment: .leading, spacing: 2) {
                Text(template.name).font(.headline).foregroundStyle(.primary)
                Text(template.description).font(.caption).foregroundStyle(.secondary)
              }
            }.disabled(!store.supports("routines") || !store.connected).accessibilityIdentifier("routineTemplate.\(template.id)")
          }
        }
      }
      ForEach(routines) { routine in
        Section(routine.name) {
          Text(routine.schedule).font(.subheadline)
          Text(routine.enabled ? "Active" : "Paused").font(.caption).foregroundStyle(.secondary)
          Text(routine.prompt).font(.footnote).lineLimit(6)
          RoutineEnhancements(routine: routine, disabled: !store.supports("routines"))
          Button(routine.enabled ? "Pause" : "Resume") {
            action {
              guard let api = store.api else { return }
              var next = routine
              next.enabled.toggle()
              let _: Routine = try await api.write(
                "/routines/\(APIClient.component(routine.id))", next, method: "PUT")
              await loadTab()
            }
          }
          Button("Edit") { editingRoutine = routine }
          Button("Delete", role: .destructive) { deletingRoutine = routine }
        }
      }
      Section {
        Button("Add routine") { addingRoutine = true }.disabled(
          !store.supports("routines") || !store.connected)
      }
      if routines.isEmpty && store.supports("routines") {
        Section { Text("No routines for \(bot.name).") }
      }
    }
  }
  @ViewBuilder private func unavailable(_ key: String) -> some View {
    if !store.supports(key) { Text(store.reason(key)).font(.footnote).foregroundStyle(.secondary) }
  }
  private func slider(_ title: String, _ key: WritableKeyPath<AvatarConfig, Double?>) -> some View {
    let value = avatar[keyPath: key] ?? 1
    return VStack(alignment: .leading, spacing: 2) {
      HStack {
        Text(title)
        Spacer()
        Text("\(Int((value * 100).rounded()))%").monospacedDigit().foregroundStyle(.secondary)
      }.font(.subheadline)
      Slider(
        value: Binding(get: { value }, set: { avatar[keyPath: key] = ($0 * 20).rounded() / 20 }),
        in: 0.6...1.5, step: 0.05
      ).accessibilityLabel(title)
    }
  }
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
        if let e = error as? APIError, e.confirmRequired { confirmModel = true }
        if let e = error as? APIError, e.code == "private_confirmation_required" {
          self.error = nil
          confirmPersonal = true
        }
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
  private func saveBot(confirmed: Bool = false, personal: Bool? = nil) {
    let personal = personal ?? personalConfirmed
    if form.hidesFromHousehold(bot) && !personal {
      confirmPersonal = true
      return
    }
    personalConfirmed = personal
    if bot == nil { createBot(confirmed: confirmed); return }
    action(progressKey: "details") {
      guard let api = store.api else { return }
      var value = form
      value.confirmModel = confirmed
      if bot != nil && personal { value.confirmPrivate = true }
      let _: Bot = try await api.write(
        bot.map { "/bots/\(APIClient.component($0.id))" } ?? "/bots", value,
        method: bot == nil ? "POST" : "PATCH")
      await store.refreshBootstrap()
      savedForm = form
      notice = bot?.shared == true ? "Changes saved for both household members." : "Assistant saved."
    }
  }
  /// Creates the assistant, then saves the look chosen on the first step. The server takes the
  /// avatar separately, so a failed avatar save keeps this sheet open on the new assistant's
  /// Avatar settings with the choice intact and a retry.
  private func createBot(confirmed: Bool) {
    action(progressKey: "details") {
      guard let api = store.api else { return }
      var value = form
      value.confirmModel = confirmed
      let created: Bot = try await api.write("/bots", value, method: "POST")
      savedForm = form
      do {
        try await putAvatar(created.id, api)
      } catch {
        await store.refreshBootstrap()
        detailLoaded = true
        createdBot = created
        tab = "Avatar"
        avatarFailure = "\(created.name) was created, but its avatar wasn't saved yet."
        self.error = error.localizedDescription
        return
      }
      savedAvatar = avatar
      await store.refreshBootstrap()
      closeSheet()
    }
  }
  private func putAvatar(_ id: String, _ api: APIClient) async throws {
    var value = avatar
    if value.mode == "mascot" { value.family = value.family ?? "sprout" }
    let _: AvatarConfig = try await api.write("/bots/\(APIClient.component(id))/avatar", value, method: "PUT")
  }
  private func saveAvatar() {
    action(progressKey: "avatar") {
      guard let bot, let api = store.api else { return }
      try await putAvatar(bot.id, api)
      await store.refreshBootstrap()
      savedAvatar = avatar
      notice = "Avatar saved"
      // A retried avatar from creation finishes the job the Create button started.
      if avatarFailure != nil {
        avatarFailure = nil
        closeSheet()
      }
    }
  }
  private func generatePortrait() {
    action {
      guard let bot, let api = store.api else { return }
      let file: FileRef = try await api.write(
        "/bots/\(APIClient.component(bot.id))/portrait", ["prompt": portraitPrompt])
      avatar.src = file.url ?? "/api/files/\(APIClient.component(file.id))"
      avatar.origin = "generated"
      notice = "Portrait generated. Save avatar to apply it."
    }
  }
  private func uploadPortrait(_ url: URL) {
    action {
      guard let bot, let api = store.api else { return }
      let accessed = url.startAccessingSecurityScopedResource()
      defer { if accessed { url.stopAccessingSecurityScopedResource() } }
      let values = try url.resourceValues(forKeys: [.fileSizeKey, .contentTypeKey])
      guard (values.fileSize ?? 0) <= 2_000_000 else {
        throw APIError(message: "Choose a portrait no larger than 2 MB.", status: 400)
      }
      let mime = values.contentType?.preferredMIMEType ?? "application/octet-stream"
      guard ["image/png", "image/jpeg", "image/webp"].contains(mime) else {
        throw APIError(message: "Choose a PNG, JPEG, or WebP portrait.", status: 400)
      }
      let file = try await api.upload(
        botId: bot.id, name: url.lastPathComponent, mime: mime, data: Data(contentsOf: url))
      avatar.src = file.url ?? "/api/files/\(APIClient.component(file.id))"
      avatar.origin = "uploaded"
      notice = "Portrait uploaded. Save avatar to apply it."
    }
  }
  private func closeSheet() { if let close { close() } else { dismiss() } }
  private var dirty: Bool {
    guard initialized else { return false }
    return form != savedForm || avatar != savedAvatar || ["tools", "skills"].contains { kind in
      guard let saved = savedCapabilities[kind] else { return false }
      return Set((kind == "tools" ? tools : skills).filter { $0.enabled || $0.required == true }.map(\.id)) != saved
    }
  }
  private func loadTab() async {
    guard let bot, let api = store.api else { return }
    let kind = tab.lowercased()
    let currentId = UUID()
    loadId = currentId
    if ["tools", "skills"].contains(kind), catalogReady.contains(kind) { return }
    if ["tools", "skills"].contains(kind) {
      catalogReady.remove(kind)
      catalogLoading.insert(kind)
    }
    defer { if loadId == currentId { catalogLoading.remove(kind) } }
    do {
      if !detailLoaded {
        let detail: Bot = try await api.get("/bots/\(APIClient.component(bot.id))")
        guard !Task.isCancelled, loadId == currentId else { return }
        form = BotInput(bot: detail, fallback: store.bootstrap?.bots.first)
        savedForm = form
        mcpText = form.enabledMcpServers.joined(separator: ", ")
        detailLoaded = true
      }
      if ["tools", "skills"].contains(kind), store.supports(kind) {
        let values: [CapabilityItem] = try await api.get(
          "/bots/\(APIClient.component(bot.id))/\(kind)")
        guard !Task.isCancelled, loadId == currentId else { return }
        if kind == "tools" { tools = values } else { skills = values }
        savedCapabilities[kind] = Set(values.filter { $0.enabled || $0.required == true }.map(\.id))
        catalogReady.insert(kind)
      }
      if tab == "Routines", store.supports("routines") {
        let all: [Routine] = try await api.get("/routines")
        routines = all.filter { $0.botId == bot.id }
        templates = try await api.get("/routines/templates")
      }
    } catch is CancellationError {} catch {
      if loadId == currentId { self.error = error.localizedDescription }
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
        if !routine.id.isEmpty {
          Section { Button("Delete routine", role: .destructive) { deleteConfirm = true } }
        }
      }.accessibilityIdentifier("routineEditorForm").disabled(busy).navigationTitle(routine.id.isEmpty ? "New routine" : "Edit routine")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
          ToolbarItem(placement: .confirmationAction) {
            Button(busy ? "Saving…" : routine.id.isEmpty ? "Add routine" : "Save routine") { save() }.disabled(
              busy || !store.connected
                || routine.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                || routine.prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
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
  private func save() {
    busy = true
    error = nil
    var value = routine
    value.recipientIds = value.recipientIds?.filter { id in recipients.contains { $0.id == id } }
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

/// The editor's preview: the avatar large, with chips to try each live state.
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
          .font(.title3.weight(.semibold)).lineLimit(1).foregroundStyle(caption.isEmpty ? .secondary : .primary)
          .accessibilityHidden(true)
      }
      ChipFlow(spacing: 6) {
        ForEach(states, id: \.self) { option in
          let selected = option == state
          Button(option.label) { state = option }.buttonStyle(.plain).font(.caption)
            .padding(.horizontal, 11).padding(.vertical, 6)
            .foregroundStyle(selected ? Palette.surface(scheme) : Color.primary)
            .background(selected ? Palette.accent : Palette.raised(scheme), in: Capsule())
            .overlay(Capsule().strokeBorder(selected ? Palette.accent : Palette.line))
            .accessibilityAddTraits(selected ? .isSelected : [])
            .accessibilityIdentifier("previewState.\(option.rawValue)")
        }
      }
      Text("Preview only. The real state always comes from Hermes.").font(.caption2)
        .foregroundStyle(.secondary)
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
private struct AvatarTiles: View {
  var group: String
  var options: [(String, String)]
  var selected: String
  var preview: (String) -> AvatarConfig
  var select: (String) -> Void
  @Environment(\.colorScheme) private var scheme
  @ScaledMetric(relativeTo: .caption) private var tileWidth: CGFloat = 64
  var body: some View {
    LazyVGrid(columns: [GridItem(.adaptive(minimum: tileWidth), spacing: 8)], spacing: 10) {
      ForEach(options, id: \.0) { value, label in
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
              .foregroundStyle(on ? Color.primary : Color.secondary).lineLimit(2)
              .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
          }.contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityElement(children: .ignore).accessibilityLabel(label)
          .accessibilityAddTraits(on ? [.isButton, .isSelected] : .isButton)
          .accessibilityIdentifier("avatarTile.\(group).\(value)")
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

extension BotInput {
  /// The web field's comma-separated list of existing MCP server ids.
  static func serverIds(_ text: String) -> [String] {
    text.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
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
  static func message(_ subject: String, count: Int, limit: Int) -> String? {
    if count > limit { return "\(subject) \((count - limit).formatted()) character\(count - limit == 1 ? "" : "s") over the \(limit.formatted()) limit. Shorten the text to save." }
    if count * 10 >= limit * 9 { return "\(count.formatted()) of \(limit.formatted()) characters" }
    return nil
  }
}
