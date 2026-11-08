import SwiftUI

/// Per-assistant home organization from an assistant's card and home's long-press menu. The
/// rules live in PreferencesEditing.swift, shared with Settings.
extension AppStore {
  /// The preferences as the person last set them, including a save still on its way.
  var homePreferences: Preferences? { preferencesDraft ?? bootstrap?.preferences }
  /// Saving preferences needs a live, signed-in connection, like pinning.
  var homeCanOrganize: Bool { householdConnected }
  func homeSectionId(of botId: String) -> String? { homePreferences?.section(of: botId)?.id }
  func homeFollows(_ botId: String) -> Bool { homePreferences?.followBots.contains(botId) == true }
  func homeMove(_ botId: String, toSection sectionId: String?) {
    guard let preferences = homePreferences else { return }
    let next = preferences.moving(bot: botId, toSection: sectionId)
    if next != preferences { queuePreferences(next) }
  }
  /// False when the name is blank or there is no room for another section, so nothing was saved.
  @discardableResult func homeMove(_ botId: String, toNewSection name: String) -> Bool {
    guard let next = homePreferences?.moving(bot: botId, toNewSection: name) else { return false }
    queuePreferences(next)
    return true
  }
  func homeFollow(_ botId: String, _ on: Bool) {
    guard let preferences = homePreferences, preferences.followBots.contains(botId) != on else { return }
    queuePreferences(preferences.settingFollow(botId, on))
  }
}

/// The home sections an assistant can move to: none, each saved section, or a new one.
struct HomeSectionPicker: View {
  var botId: String
  /// Asks for a name; the new section is created from the alert.
  var newSection: () -> Void
  /// Called after a move to an existing section or to none, with the section it left. Home offers Undo.
  var moved: ((_ from: String?, _ to: String?) -> Void)? = nil
  @Environment(AppStore.self) private var store
  private static let new = "new-section"
  var body: some View {
    let selection = Binding<String>(
      get: { store.homeSectionId(of: botId) ?? "" },
      set: { value in
        if value == Self.new { newSection(); return }
        let from = store.homeSectionId(of: botId), to = value.isEmpty ? nil : value
        guard from != to else { return }
        store.homeMove(botId, toSection: to)
        moved?(from, to)
      })
    Picker("Home section", selection: selection) {
      Text("None").tag("")
      ForEach(store.homePreferences?.sections ?? []) { section in
        Text(section.name.isEmpty ? "Untitled section" : section.name).tag(section.id)
      }
      if (store.homePreferences?.sections.count ?? 0) < Preferences.sectionLimit {
        Label("New section…", systemImage: "plus").tag(Self.new)
      }
    }.disabled(!store.homeCanOrganize).accessibilityIdentifier("homeSection")
  }
}

extension View {
  /// Names a new home section and moves the assistant into it.
  func newSectionAlert(for bot: Binding<Bot?>) -> some View { modifier(NewSectionAlert(bot: bot)) }
}
private struct NewSectionAlert: ViewModifier {
  @Binding var bot: Bot?
  @Environment(AppStore.self) private var store
  @State private var name = ""
  func body(content: Content) -> some View {
    content.alert("New section", isPresented: Binding(get: { bot != nil }, set: { if !$0 { bot = nil } })) {
      TextField("Section name", text: $name).accessibilityIdentifier("newSectionName")
      Button("Cancel", role: .cancel) { name = "" }
      Button("Add") {
        if let bot { store.homeMove(bot.id, toNewSection: name) }
        name = ""
      }
    } message: { Text("\(bot?.name ?? "This assistant") moves into it on home, for example Around the house.") }
  }
}
