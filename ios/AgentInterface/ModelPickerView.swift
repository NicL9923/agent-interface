import SwiftUI

/// Shared searchable catalog for assistant settings and the Advanced composer.
struct ModelCatalogSections: View {
  var botId: String?
  var selection: ModelChoice
  var disabled = false
  var choose: (ModelChoice) -> Void
  @EnvironmentObject private var store: AppStore
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
        Button { Task { await load() } } label: { Image(systemName: "arrow.clockwise") }
          .accessibilityLabel("Refresh models").disabled(loading || disabled)
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
          row(item.provider, item.model)
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
          if provider.models.isEmpty { Text("No models reported. Connect this provider in Hermes, then refresh.").font(.caption).foregroundStyle(.secondary) }
          ForEach(filtered(provider)) { model in row(provider, model) }
        } label: {
          HStack {
            Text(provider.name).foregroundStyle(.primary)
            Spacer()
            Text("\(provider.models.count)").font(.caption).foregroundStyle(.secondary)
          }
        }
      }
    }
    if !loading && error == nil && (providers.isEmpty || !query.isEmpty && providers.allSatisfy({ filtered($0).isEmpty })) {
      Section { Text(query.isEmpty ? "No models were reported by Hermes." : "No models match your search.").foregroundStyle(.secondary) }
    }
    Section {
      LabeledContent("Selected model", value: selection.model.isEmpty ? "None" : selection.model)
      if !selection.provider.isEmpty { LabeledContent("Provider", value: selection.provider) }
      if !selection.model.isEmpty && !providers.contains(where: { $0.matches(selection.provider) && $0.models.contains(where: { $0.id == selection.model }) }) {
        Text("This saved selection is not in the current catalog. It stays selected until you choose another model.").font(.caption).foregroundStyle(.secondary)
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
  private func row(_ provider: ModelProviderInfo, _ model: ModelInfo) -> some View {
    let choice = ModelChoice(provider: provider.id, model: model.id)
    let selected = selection.model == model.id && provider.matches(selection.provider)
    let favorite = favorites.first { $0.model == model.id && provider.matches($0.provider) }
    return HStack(spacing: 8) {
      Button { choose(choice) } label: {
        HStack {
          VStack(alignment: .leading, spacing: 4) {
            Text(model.name).foregroundStyle(.primary)
            if !model.available { Text("Reconnect in Hermes to use this model").font(.caption).foregroundStyle(.secondary) }
          }.frame(maxWidth: .infinity, alignment: .leading)
          if selected { Image(systemName: "checkmark").foregroundStyle(Palette.accent) }
        }.frame(minHeight: 44).contentShape(Rectangle())
      }.buttonStyle(.plain).disabled(disabled || !model.available)
        .accessibilityAddTraits(selected ? .isSelected : [])
      Button { Task { await toggleFavorite(favorite ?? choice) } } label: {
        Image(systemName: favorite == nil ? "star" : "star.fill").frame(width: 44, height: 44)
      }.buttonStyle(.borderless).disabled(disabled || savingFavorite || favorites.count >= 100 && favorite == nil)
        .accessibilityLabel("\(favorite == nil ? "Add" : "Remove") \(model.name) \(favorite == nil ? "to" : "from") favorites")
    }
  }
  private func load() async {
    guard let api = store.api else { return }
    let scope = store.scope
    loading = true; error = nil
    do {
      let catalog: ModelCatalog = try await api.get("/models" + (botId.map { "?botId=\(APIClient.component($0))" } ?? ""))
      guard scope == store.scope, !Task.isCancelled else { return }
      providers = catalog.providers
      if let selected = providers.first(where: { $0.matches(selection.provider) }) { expanded.insert(selected.id) }
      loading = false
    } catch {
      guard scope == store.scope, !Task.isCancelled else { return }
      self.error = error.localizedDescription; loading = false
    }
  }
  private func toggleFavorite(_ choice: ModelChoice) async {
    guard let api = store.api, !savingFavorite else { return }
    let scope = store.scope
    let next = favorites.contains(choice) ? favorites.filter { $0 != choice } : favorites + [choice]
    savingFavorite = true; favoriteError = nil
    defer { savingFavorite = false }
    do {
      let saved: ModelFavorites = try await api.write("/preferences/models", ModelFavorites(modelFavorites: next), method: "PUT")
      guard scope == store.scope else { return }
      store.bootstrap?.preferences.modelFavorites = saved.modelFavorites
    } catch { if scope == store.scope { favoriteError = error.localizedDescription } }
  }
}

/// The assistant settings model row, like the web selector's collapsed summary:
/// the model and provider with a chevron that opens the full catalog.
struct ModelSelectionRow: View {
  var botId: String?
  var selection: ModelChoice
  var disabled = false
  var choose: (ModelChoice) -> Void
  @EnvironmentObject private var store: AppStore
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
  @EnvironmentObject private var store: AppStore
  @Environment(\.dismiss) private var dismiss
  @Environment(\.colorScheme) private var scheme
  @State private var busy = false
  @State private var settings: InferenceSettings?
  @State private var settingsError: String?
  @State private var error: String?
  @State private var confirmation: ModelChoice?
  private var bot: Bot? { store.bootstrap?.bots.first { $0.id == botId } }
  private var blocked: Bool { !store.connected || store.sessionExpired || !store.supports("botConfiguration") || bot?.instructions == nil }
  var body: some View {
    NavigationStack {
      Form {
        Group {
        if let bot {
          if bot.shared { Section { Text("Shared assistant: the model changes for your household.").font(.footnote).foregroundStyle(.secondary) } }
          if let error { Section { ErrorBanner(message: error) } }
          Section("This conversation") {
            if let settings {
              Picker("Reasoning", selection: Binding(get: { settings.reasoning }, set: { changeSettings(["reasoning": $0]) })) {
                ForEach(InferenceSettings.reasoningLevels, id: \.self) { Text($0 == "none" ? "Off" : $0.capitalized).tag($0) }
              }.accessibilityIdentifier("inferenceReasoning")
              Picker("Speed", selection: Binding(get: { settings.speed }, set: { changeSettings(["speed": $0]) })) {
                ForEach(InferenceSettings.speeds, id: \.self) { Text($0.capitalized).tag($0) }
              }.accessibilityIdentifier("inferenceSpeed")
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
    guard let api = store.api else { return }
    let scope = store.scope
    settingsError = nil
    do {
      let value: InferenceSettings = try await api.get("/bots/\(APIClient.component(botId))/inference")
      if scope == store.scope, !Task.isCancelled { settings = value }
    } catch { if scope == store.scope, !Task.isCancelled { settingsError = error.localizedDescription } }
  }
  private func changeSettings(_ update: [String: String]) {
    guard let api = store.api, !busy, !blocked else { return }
    let scope = store.scope
    busy = true; settingsError = nil
    Task {
      defer { busy = false }
      do {
        let value: InferenceSettings = try await api.write("/bots/\(APIClient.component(botId))/inference", update, method: "PATCH")
        if scope == store.scope { settings = value }
      } catch { if scope == store.scope { settingsError = error.localizedDescription } }
    }
  }
  private func save(_ choice: ModelChoice, confirmed: Bool = false) {
    guard let api = store.api, let bot, !busy, !blocked else { return }
    let scope = store.scope
    var input = BotInput(bot: bot)
    input.model = choice.model; input.provider = choice.provider; input.confirmModel = confirmed
    busy = true; error = nil
    Task {
      defer { busy = false }
      do {
        let _: Bot = try await api.write("/bots/\(APIClient.component(bot.id))", input, method: "PATCH")
        guard scope == store.scope else { return }
        await store.refreshBootstrap()
        if scope == store.scope { dismiss() }
      } catch let failure as APIError where failure.confirmRequired {
        if scope == store.scope { confirmation = choice; error = failure.localizedDescription }
      } catch { if scope == store.scope { self.error = error.localizedDescription } }
    }
  }
}
