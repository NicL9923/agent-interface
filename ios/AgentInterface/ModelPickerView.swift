import SwiftUI

/// Shared searchable catalog for assistant settings and the Advanced composer.
struct ModelCatalogSections: View {
  var botId: String?
  var selection: ModelChoice
  var disabled = false
  var choose: (ModelChoice) -> Void
  @Environment(AppStore.self) private var store
  @State private var providers: [ModelProviderInfo] = []
  @State private var expanded: Set<String> = []
  @State private var search = ""
  @State private var loading = true
  @State private var savingFavorite = false
  @State private var error: String?
  @State private var favoriteError: String?
  private var favorites: [ModelChoice] { store.bootstrap?.preferences.modelFavorites ?? [] }
  private var query: String { search.trimmingCharacters(in: .whitespacesAndNewlines) }
  var body: some View {
    Section {
      HStack {
        Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
        TextField("Find a model or provider", text: $search).autocorrectionDisabled()
          .textInputAutocapitalization(.never).accessibilityIdentifier("modelSearch")
        if ModelPickerRules.refreshVisible(error: error, providerCount: providers.count) {
          Button { Task { await load() } } label: { Image(systemName: "arrow.clockwise") }
            .accessibilityLabel("Refresh models").disabled(loading)
        }
      }
      if loading { ProgressView("Loading models from Hermes…") }
      if let error {
        ErrorBanner(message: error)
        Button("Retry loading models") { Task { await load() } }
      }
      if let favoriteError { ErrorBanner(message: favoriteError) }
    }
    .task(id: "\(botId ?? "default"):\(store.scope ?? "")") { await load() }
    if !favoriteRows.isEmpty {
      Section("Favorites") {
        ForEach(favoriteRows, id: \.choice) { item in
          row(item.provider, item.model, showProvider: true)
        }
      }
    }
    ForEach(providers.filter { query.isEmpty || !filtered($0).isEmpty }) { provider in
      Section {
        DisclosureGroup(isExpanded: Binding(
          get: { !query.isEmpty || expanded.contains(provider.id) },
          set: { if $0 { expanded.insert(provider.id) } else { expanded.remove(provider.id) } }
        )) {
          if let warning = provider.warning { Text(warning).font(.caption).foregroundStyle(.secondary) }
          if provider.models.isEmpty { Text(ModelPickerRules.noModelsForProvider).font(.caption).foregroundStyle(.secondary) }
          ForEach(filtered(provider)) { model in row(provider, model) }
        } label: {
          HStack {
            Text(provider.name).foregroundStyle(.primary)
            Spacer()
            Text("\(filtered(provider).count)").font(.caption).foregroundStyle(.secondary)
          }
        }
      }
    }
    if !loading && error == nil && (providers.isEmpty || !query.isEmpty && providers.allSatisfy({ filtered($0).isEmpty })) {
      Section {
        Text(query.isEmpty ? ModelPickerRules.noModelsReported : "No models match your search.").foregroundStyle(.secondary)
        if providers.isEmpty { Button("Retry loading models") { Task { await load() } } }
      }
    }
    Section {
      LabeledContent("Selected model", value: selection.model.isEmpty ? "None" : selection.model)
      if !selection.provider.isEmpty { LabeledContent("Provider", value: selection.provider) }
      if !loading && error == nil && !selection.model.isEmpty && !providers.contains(where: { $0.matches(selection.provider) && $0.models.contains(where: { $0.id == selection.model }) }) {
        Text(ModelPickerRules.savedModelKept).font(.caption).foregroundStyle(.secondary)
      }
    }

  }
  private func filtered(_ provider: ModelProviderInfo) -> [ModelInfo] {
    provider.models.filter { query.isEmpty || "\(provider.name) \($0.name) \($0.id)".localizedCaseInsensitiveContains(query) }
  }
  private var favoriteRows: [(choice: ModelChoice, provider: ModelProviderInfo, model: ModelInfo)] {
    favorites.compactMap { choice in
      guard let provider = providers.first(where: { $0.matches(choice.provider) }),
        let model = filtered(provider).first(where: { $0.id == choice.model }) else { return nil }
      return (choice, provider, model)
    }
  }
  private func row(_ provider: ModelProviderInfo, _ model: ModelInfo, showProvider: Bool = false) -> some View {
    let choice = ModelChoice(provider: provider.id, model: model.id)
    let selected = selection.model == model.id && provider.matches(selection.provider)
    let favorite = favorites.first { $0.model == model.id && provider.matches($0.provider) }
    return HStack(spacing: 8) {
      Button { choose(choice) } label: {
        HStack {
          VStack(alignment: .leading, spacing: 4) {
            Text(model.name).foregroundStyle(.primary)
            if showProvider { Text(provider.name).font(.caption).foregroundStyle(.secondary) }
            if !model.available { Text("Reconnect in Hermes to use this model").font(.caption).foregroundStyle(.secondary) }
          }.frame(maxWidth: .infinity, alignment: .leading)
          if selected { Image(systemName: "checkmark").foregroundStyle(Palette.accent) }
        }.frame(minHeight: 44).contentShape(Rectangle())
      }.buttonStyle(.plain).disabled(disabled || !model.available)
        .accessibilityAddTraits(selected ? .isSelected : [])
      Button { Task { await toggleFavorite(favorite ?? choice) } } label: {
        Image(systemName: favorite == nil ? "star" : "star.fill").frame(width: 44, height: 44)
      }.buttonStyle(.borderless).disabled(ModelPickerRules.starDisabled(saving: savingFavorite, favoriteCount: favorites.count, isFavorite: favorite != nil))
        .accessibilityLabel("\(favorite == nil ? "Add" : "Remove") \(model.name) \(favorite == nil ? "to" : "from") favorites")
    }
  }
  private func load() async {
    guard store.api != nil else { return }
    loading = true; error = nil
    // A stale answer leaves `loading` on for the load that replaced it.
    switch await store.attempt({ (context) -> ModelCatalog in
      try await context.api.get("/models" + (botId.map { "?botId=\(APIClient.component($0))" } ?? ""))
    }) {
    case .success(let catalog)?:
      providers = catalog.providers
      if let selected = providers.first(where: { $0.matches(selection.provider) }) { expanded.insert(selected.id) }
      loading = false
    case .failure(let failure)?: error = failure.localizedDescription; loading = false
    case nil: break
    }
  }
  private func toggleFavorite(_ choice: ModelChoice) async {
    guard !savingFavorite else { return }
    let next = favorites.contains(choice) ? favorites.filter { $0 != choice } : favorites + [choice]
    favoriteError = nil
    let saved: ModelFavorites? = await store.run(busy: $savingFavorite, error: $favoriteError) {
      try await $0.api.write("/preferences/models", ModelFavorites(modelFavorites: next), method: "PUT")
    }
    if let saved { store.bootstrap?.preferences.modelFavorites = saved.modelFavorites }
  }
}

/// The assistant settings model row, like the web selector's collapsed summary:
/// the model and provider with a chevron that opens the full catalog.
struct ModelSelectionRow: View {
  var botId: String?
  var selection: ModelChoice
  var disabled = false
  var choose: (ModelChoice) -> Void
  @Environment(AppStore.self) private var store
  @State private var providerName: String?
  var body: some View {
    NavigationLink {
      ModelCatalogPage(botId: botId, selection: selection, disabled: disabled, choose: choose)
    } label: {
      VStack(alignment: .leading, spacing: 2) {
        Text(selection.model.isEmpty ? "Choose a model" : selection.model).font(.headline)
        Text(providerName ?? (selection.provider.isEmpty ? "Connected providers" : selection.provider))
          .font(.caption).foregroundStyle(.secondary)
      }.frame(minHeight: 44, alignment: .leading)
    }.accessibilityIdentifier("assistantModel")
      .task(id: "\(botId ?? "default"):\(store.scope ?? ""):\(selection.provider)") {
        guard let api = store.api, !selection.provider.isEmpty else { providerName = nil; return }
        let catalog: ModelCatalog? = try? await api.get("/models" + (botId.map { "?botId=\(APIClient.component($0))" } ?? ""))
        providerName = catalog?.providers.first { $0.matches(selection.provider) }?.name
      }
  }
}

/// The full searchable catalog, pushed from the settings row. Choosing a model returns to the form.
struct ModelCatalogPage: View {
  var botId: String?
  var selection: ModelChoice
  var disabled = false
  var choose: (ModelChoice) -> Void
  @Environment(\.dismiss) private var dismiss
  var body: some View {
    Form {
      ModelCatalogSections(botId: botId, selection: selection, disabled: disabled) { choice in
        choose(choice)
        dismiss()
      }
    }.householdListBackground().navigationTitle("Model").navigationBarTitleDisplayMode(.inline)
  }
}

struct ComposerModelSheet: View {
  var botId: String
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @Environment(\.colorScheme) private var scheme
  @State private var busy = false
  @State private var settings: InferenceSettings?
  @State private var settingsError: String?
  @State private var error: String?
  @State private var confirmation: ModelChoice?
  private var bot: Bot? { store.bootstrap?.bots.first { $0.id == botId } }
  private var blocked: Bool { !store.connected || store.sessionExpired || !store.supports(.botConfiguration) }
  var body: some View {
    NavigationStack {
      Form {
        Group {
        if let bot {
          if bot.shared { Section { Text("Shared assistant: the model changes for your household.").font(.footnote).foregroundStyle(.secondary) } }
          if let error { Section { ErrorBanner(message: error) } }
          Section("This conversation") {
            if let settings {
              InferenceChoice(title: "Reasoning", options: InferenceSettings.reasoningLevels, identifier: "inferenceReasoning",
                label: { $0 == "none" ? "Off" : $0.capitalized },
                selection: Binding(get: { settings.reasoning }, set: { changeSettings(["reasoning": $0]) }))
              InferenceChoice(title: "Speed", options: InferenceSettings.speeds, identifier: "inferenceSpeed",
                label: { $0.capitalized },
                selection: Binding(get: { settings.speed }, set: { changeSettings(["speed": $0]) }))
              Text("Available levels and speeds depend on the model.").font(.caption).foregroundStyle(.secondary)
            } else if settingsError == nil { ProgressView("Loading reasoning and speed…") }
            if let settingsError {
              ErrorBanner(message: settingsError)
              Button("Retry reasoning and speed") { Task { await loadSettings() } }
            }
          }.disabled(busy || blocked)
          ModelCatalogSections(botId: bot.id, selection: ModelChoice(provider: bot.provider ?? "", model: bot.model),
            disabled: busy || blocked, choose: { save($0) })
        }
        }.listRowBackground(Palette.raised(scheme))
      }.listSectionSpacing(18).householdListBackground().navigationTitle("Choose a model").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() }.disabled(busy) } }
        .task(id: store.scope) { await loadSettings() }
        .confirmationDialog("Use this model? Hermes asks for confirmation.", isPresented: Binding(
          get: { confirmation != nil }, set: { if !$0 { confirmation = nil } }), titleVisibility: .visible
        ) { Button("Use this model") { if let choice = confirmation { save(choice, confirmed: true) } } }
        .interactiveDismissDisabled(busy)
        .onChange(of: store.scope) { _, _ in dismiss() }
    }
  }
  private func loadSettings() async {
    settingsError = nil
    let value: InferenceSettings? = await store.run(error: $settingsError) { try await $0.api.get("/bots/\(APIClient.component(botId))/inference") }
    if let value { settings = value }
  }
  private func changeSettings(_ update: [String: String]) {
    guard !busy, !blocked else { return }
    busy = true; settingsError = nil
    Task {
      let value: InferenceSettings? = await store.run(busy: $busy, error: $settingsError) {
        try await $0.api.write("/bots/\(APIClient.component(botId))/inference", update, method: "PATCH")
      }
      if let value { settings = value }
    }
  }
  private func save(_ choice: ModelChoice, confirmed: Bool = false) {
    guard let bot, !busy, !blocked else { return }
    busy = true; error = nil
    Task {
      switch await store.attempt(busy: $busy, { (context) -> Void in
        let detail: Bot = try await context.api.get("/bots/\(APIClient.component(bot.id))")
        try context.checkCurrent()
        var input = BotInput(bot: detail)
        input.model = choice.model; input.provider = choice.provider; input.confirmModel = confirmed
        let _: Bot = try await context.api.write("/bots/\(APIClient.component(bot.id))", input, method: "PATCH")
        try context.checkCurrent()
        await store.refreshBootstrap()
      }) {
      case .success?: dismiss()
      case .failure(let failure)?:
        if (failure as? APIError)?.confirmRequired == true { confirmation = choice }
        error = failure.localizedDescription
      case nil: break
      }
    }
  }
}

/// One inference setting. A few options read best as a segmented control, which shows every
/// choice and takes one tap; a long list, or one too wide for the row, stays a menu.
struct InferenceChoice: View {
  var title: String
  var options: [String]
  var identifier: String
  var label: (String) -> String
  @Binding var selection: String
  static let segmentLimit = 4
  static func segmented(_ count: Int) -> Bool { count > 1 && count <= segmentLimit }
  var body: some View {
    if Self.segmented(options.count) {
      ViewThatFits(in: .horizontal) {
        VStack(alignment: .leading, spacing: 8) {
          Text(title)
          picker.pickerStyle(.segmented).labelsHidden()
        }
        picker.pickerStyle(.menu)
      }
    } else {
      picker.pickerStyle(.menu)
    }
  }
  private var picker: some View {
    Picker(title, selection: $selection) {
      ForEach(options, id: \.self) { Text(label($0)).tag($0) }
    }.accessibilityIdentifier(identifier)
  }
}

/// The catalog rules that mirror the web selector, kept apart from the views so they can be tested.
enum ModelPickerRules {
  static let favoriteLimit = 100
  static let noModelsForProvider = "No models reported. Check this connection in Hermes."
  static let noModelsReported = "No connected models were reported. Connect a provider in Hermes, then retry."
  static let savedModelKept = "Your saved model is kept. Hermes did not include it in the current catalog."
  /// Refresh has nothing to refresh during a load error, where Retry is offered, or with an empty catalog.
  static func refreshVisible(error: String?, providerCount: Int) -> Bool { error == nil && providerCount > 0 }
  /// Starring is its own save, so only a pending save or a full list blocks it, not a blocked model change.
  static func starDisabled(saving: Bool, favoriteCount: Int, isFavorite: Bool) -> Bool {
    saving || favoriteCount >= favoriteLimit && !isFavorite
  }
}
