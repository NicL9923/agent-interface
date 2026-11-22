import SwiftUI

/// A chat style choice, which a settings save sends only when the person changed it here.
enum PreferenceChoice: Hashable { case chatStyle, ownBubble }

extension Preferences {
  /// The chat style choices that differ from `earlier`.
  func choices(changedFrom earlier: Preferences?) -> Set<PreferenceChoice> {
    var changed: Set<PreferenceChoice> = []
    if chatStyle != earlier?.chatStyle { changed.insert(.chatStyle) }
    if ownBubble != earlier?.ownBubble { changed.insert(.ownBubble) }
    return changed
  }
}

/// Counts one account's preference saves starting and settling, so a bootstrap read can tell whether one
/// overlapped it, as the web's `preferenceQueue` does with `mark` and `fresh`. A read that did may hold
/// preferences from before the save, so it keeps the saved ones. Each account gets a new one, and a save
/// settles on the one it started on, so an old account's save never makes the next account's reads stale.
@MainActor final class PreferenceSaveOrder {
  private var generation = 0
  private var saving = 0
  func start() { generation += 1; saving += 1 }
  func settle() { saving -= 1; generation += 1 }
  /// Taken when a read starts.
  var mark: Int { generation }
  /// Whether no save was running when the read started, or started or settled since.
  func fresh(_ mark: Int) -> Bool { mark == generation && saving == 0 }
}

// Saving preferences, one queued save at a time.
extension AppStore {
  /// Every request that saves preferences goes through here, so bootstrap reads are ordered against it.
  func savingPreferences<T>(_ save: () async throws -> T) async throws -> T {
    let order = preferenceSaves
    order.start()
    defer { order.settle() }
    return try await save()
  }
  static let unsavedChoiceNotice = "This server cannot save that setting yet. Update WildBots on the server to use it."
  /// Saves `value`. Of the chat style choices, only those in `choices` go out, and only as a value this app
  /// knows: the server keeps one left out, so neither a stale copy nor a newer client's value overwrites
  /// another device's pick. Without `choices`, the ones that differ from the last copy read are sent.
  @discardableResult func setPreferences(_ value: Preferences, choices: Set<PreferenceChoice>? = nil) async -> Bool {
    guard let api else { return false }
    let currentGeneration = generation
    let choices = choices ?? value.choices(changedFrom: bootstrap?.preferences)
    do {
      var update = value
      update.modelFavorites = nil
      update.chatStyle = choices.contains(.chatStyle) ? value.chatStyle.flatMap(ChatStyle.init(rawValue:))?.rawValue : nil
      update.ownBubble = choices.contains(.ownBubble) ? value.ownBubble.flatMap(OwnBubble.init(rawValue:))?.rawValue : nil
      let saved: Preferences = try await savingPreferences { try await api.write("/preferences", update, method: "PATCH") }
      guard currentGeneration == generation else { return false }
      bootstrap?.preferences = saved
      // A server from before chat styles saves the rest and answers without the choice.
      let sent = [(update.chatStyle, saved.chatStyle), (update.ownBubble, saved.ownBubble)].filter { $0.0 != nil }
      if sent.contains(where: { $0.0 != $0.1 }) { preferencesNotice = Self.unsavedChoiceNotice }
      else if !sent.isEmpty { preferencesNotice = nil }
      return true
    } catch { if currentGeneration == generation { report(error) }; return false }
  }
  /// Account-owned queue survives closing Settings. A slow earlier save cannot win over a later edit.
  /// `changed` names the chat style choices this edit made, as Settings knows them from the control. Without
  /// it, the choices that differ from what the person was shown go out: the draft while saves are out.
  func queuePreferences(_ value: Preferences, changed: Set<PreferenceChoice>? = nil) {
    if preferencesSaveFailed && error == preferencesFailureMessage { error = nil }
    preferencesFailureMessage = nil
    queuedChoices.formUnion(changed ?? value.choices(changedFrom: preferencesDraft ?? bootstrap?.preferences))
    preferencesDraft = value; queuedPreferences = value; preferencesSaveFailed = false
    guard !preferencesSaving else { return }
    preferencesSaving = true
    let currentGeneration = generation
    Task {
      defer { if currentGeneration == generation { preferencesSaving = false } }
      while let next = queuedPreferences, currentGeneration == generation {
        queuedPreferences = nil
        // Taken now, so a choice changed again during this save goes out with the next one.
        let choices = queuedChoices
        queuedChoices = []
        let saved = await setPreferences(next, choices: choices)
        guard currentGeneration == generation else { return }
        if !saved {
          queuedChoices.formUnion(choices)
          preferencesSaveFailed = true; preferencesFailureMessage = error; return
        }
      }
      if currentGeneration == generation { preferencesDraft = nil }
    }
  }
  func discardPreferenceChanges() {
    if error == preferencesFailureMessage { error = nil }
    queuedPreferences = nil; queuedChoices = []; preferencesDraft = nil; preferencesSaveFailed = false; preferencesFailureMessage = nil
  }
  func resetPreferenceSaves() {
    queuedPreferences = nil; queuedChoices = []; preferencesDraft = nil; preferencesSaveFailed = false; preferencesFailureMessage = nil
    preferencesSaving = false; preferencesNotice = nil
  }
  /// Saves the starred models. Like every preferences save, it is ordered against bootstrap reads, so a
  /// read that overlaps it keeps the saved stars instead of putting the older list back.
  func saveModelFavorites(_ favorites: [ModelChoice], busy: Binding<Bool>? = nil, error: Binding<String?>) async {
    let saved: ModelFavorites? = await run(busy: busy, error: error) { context in
      try await self.savingPreferences {
        try await context.api.write("/preferences/models", ModelFavorites(modelFavorites: favorites), method: "PUT")
      }
    }
    if let saved { bootstrap?.preferences.modelFavorites = saved.modelFavorites }
  }
  func togglePin(_ id: String) async {
    guard var preferences = preferencesDraft ?? bootstrap?.preferences else { return }
    if preferences.favorites.contains(id) { preferences.favorites.removeAll { $0 == id } }
    else { preferences.favorites.append(id) }
    queuePreferences(preferences)
  }
}
