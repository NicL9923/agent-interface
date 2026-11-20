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

// Saving preferences, one queued save at a time.
extension AppStore {
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
      let saved: Preferences = try await api.write("/preferences", update, method: "PATCH")
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
  func queuePreferences(_ value: Preferences) {
    if preferencesSaveFailed && error == preferencesFailureMessage { error = nil }
    preferencesFailureMessage = nil
    // What the person changed is measured against what they were shown: the draft while saves are out.
    queuedChoices.formUnion(value.choices(changedFrom: preferencesDraft ?? bootstrap?.preferences))
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
        preferencesLastSent = next
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
  func togglePin(_ id: String) async {
    guard var preferences = preferencesDraft ?? bootstrap?.preferences else { return }
    if preferences.favorites.contains(id) { preferences.favorites.removeAll { $0 == id } }
    else { preferences.favorites.append(id) }
    queuePreferences(preferences)
  }
}
