import SwiftUI

/// Per-assistant home organization: which home section an assistant sits in and whether its
/// owner follows all of its activity. The preferences shape is the web's; these keep an assistant
/// in at most one section, so moving it can never leave a copy behind.
extension Preferences {
  static let maxSections = 30
  static let maxSectionName = 100
  /// The section an assistant appears under on home, if any.
  func homeSectionId(of botId: String) -> String? { sections.first { $0.botIds.contains(botId) }?.id }
  /// Moves an assistant into one section, or out of every section with nil.
  func moving(_ botId: String, toSection sectionId: String?) -> Preferences {
    var next = self
    for index in next.sections.indices where next.sections[index].id != sectionId {
      next.sections[index].botIds.removeAll { $0 == botId }
    }
    if let sectionId, let index = next.sections.firstIndex(where: { $0.id == sectionId }),
      !next.sections[index].botIds.contains(botId)
    {
      next.sections[index].botIds.append(botId)
    }
    return next
  }
  /// Moves an assistant into a section by name. An existing section with that name is reused
  /// rather than duplicated. Nil when the name is blank or no more sections fit.
  func moving(_ botId: String, toNewSection name: String, id: String = UUID().uuidString) -> Preferences? {
    let trimmed = String(name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(Self.maxSectionName))
    guard !trimmed.isEmpty else { return nil }
    if let existing = sections.first(where: { $0.name.compare(trimmed, options: [.caseInsensitive, .diacriticInsensitive]) == .orderedSame }) {
      return moving(botId, toSection: existing.id)
    }
    guard sections.count < Self.maxSections else { return nil }
    var next = self
    next.sections.append(BotSection(id: id, name: trimmed, botIds: []))
    return next.moving(botId, toSection: id)
  }
  func following(_ botId: String, _ on: Bool) -> Preferences {
    var next = self
    next.followBots.removeAll { $0 == botId }
    if on { next.followBots.append(botId) }
    return next
  }
}

extension AppStore {
  /// The preferences as the person last set them, including a save still on its way.
  var homePreferences: Preferences? { preferencesDraft ?? bootstrap?.preferences }
  /// Saving preferences needs a live, signed-in connection, like pinning.
  var homeCanOrganize: Bool { connected && !sessionExpired }
  func homeSectionId(of botId: String) -> String? { homePreferences?.homeSectionId(of: botId) }
  func homeFollows(_ botId: String) -> Bool { homePreferences?.followBots.contains(botId) == true }
  func homeMove(_ botId: String, toSection sectionId: String?) {
    guard let preferences = homePreferences else { return }
    let next = preferences.moving(botId, toSection: sectionId)
    if next != preferences { queuePreferences(next) }
  }
  /// False when the name is blank or there is no room for another section, so nothing was saved.
  @discardableResult func homeMove(_ botId: String, toNewSection name: String) -> Bool {
    guard let next = homePreferences?.moving(botId, toNewSection: name) else { return false }
    queuePreferences(next)
    return true
  }
  func homeFollow(_ botId: String, _ on: Bool) {
    guard let preferences = homePreferences, preferences.followBots.contains(botId) != on else { return }
    queuePreferences(preferences.following(botId, on))
  }
}

/// The home sections an assistant can move to: none, each saved section, or a new one.
struct HomeSectionPicker: View {
  var botId: String
  /// Asks for a name; the new section is created from the alert.
  var newSection: () -> Void
  @Environment(AppStore.self) private var store
  private static let new = "new-section"
  var body: some View {
    let selection = Binding<String>(
      get: { store.homeSectionId(of: botId) ?? "" },
      set: { value in if value == Self.new { newSection() } else { store.homeMove(botId, toSection: value.isEmpty ? nil : value) } })
    Picker("Home section", selection: selection) {
      Text("None").tag("")
      ForEach(store.homePreferences?.sections ?? []) { section in
        Text(section.name.isEmpty ? "Untitled section" : section.name).tag(section.id)
      }
      if (store.homePreferences?.sections.count ?? 0) < Preferences.maxSections {
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
