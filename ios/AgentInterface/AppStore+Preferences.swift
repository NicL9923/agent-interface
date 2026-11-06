import SwiftUI

// Saving preferences, one queued save at a time.
extension AppStore {
  @discardableResult func setPreferences(_ value: Preferences) async -> Bool {
    guard let api else { return false }
    let currentGeneration = generation
    do {
      var update = value
      update.modelFavorites = nil
      let saved: Preferences = try await api.write("/preferences", update, method: "PATCH")
      guard currentGeneration == generation else { return false }
      bootstrap?.preferences = saved
      return true
    } catch { if currentGeneration == generation { report(error) }; return false }
  }
  /// Account-owned queue survives closing Settings. A slow earlier save cannot win over a later edit.
  func queuePreferences(_ value: Preferences) {
    if preferencesSaveFailed && error == preferencesFailureMessage { error = nil }
    preferencesFailureMessage = nil
    preferencesDraft = value; queuedPreferences = value; preferencesSaveFailed = false
    guard !preferencesSaving else { return }
    preferencesSaving = true
    let currentGeneration = generation
    Task {
      defer { if currentGeneration == generation { preferencesSaving = false } }
      while let next = queuedPreferences, currentGeneration == generation {
        queuedPreferences = nil
        let saved = await setPreferences(next)
        guard currentGeneration == generation else { return }
        if !saved { preferencesSaveFailed = true; preferencesFailureMessage = error; return }
      }
      if currentGeneration == generation { preferencesDraft = nil }
    }
  }
  func discardPreferenceChanges() {
    if error == preferencesFailureMessage { error = nil }
    queuedPreferences = nil; preferencesDraft = nil; preferencesSaveFailed = false; preferencesFailureMessage = nil
  }
  func resetPreferenceSaves() {
    queuedPreferences = nil; preferencesDraft = nil; preferencesSaveFailed = false; preferencesFailureMessage = nil; preferencesSaving = false
  }
  func togglePin(_ id: String) async {
    guard var preferences = preferencesDraft ?? bootstrap?.preferences else { return }
    if preferences.favorites.contains(id) { preferences.favorites.removeAll { $0 == id } }
    else { preferences.favorites.append(id) }
    queuePreferences(preferences)
  }
}
