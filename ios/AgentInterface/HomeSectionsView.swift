import SwiftUI

/// Settings' summaries and lists for followed assistants and home sections. Each list is one
/// multi-select instead of a toggle per assistant per section. Edits go to the Settings draft,
/// which saves them as you make them.

/// One assistant with a checkmark when chosen, and an optional note such as its current section.
struct AssistantCheckRow: View {
  var bot: Bot
  var selected: Bool
  var note: String? = nil
  var toggle: () -> Void
  var body: some View {
    Button(action: toggle) {
      HStack(spacing: 12) {
        AvatarView(avatar: bot.avatar ?? AvatarConfig(), size: 32, name: bot.name, forceReducedMotion: true)
        VStack(alignment: .leading, spacing: 2) {
          Text(bot.name).foregroundStyle(Color.primary)
          if let note { Text(note).font(.caption).foregroundStyle(.secondary) }
        }
        Spacer(minLength: 8)
        Image(systemName: selected ? "checkmark.circle.fill" : "circle")
          .font(.title3).foregroundStyle(selected ? Palette.accent : Color.secondary.opacity(0.5))
          .accessibilityHidden(true)
      }.contentShape(Rectangle())
    }.buttonStyle(.plain)
      .accessibilityElement(children: .combine)
      .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
      .accessibilityIdentifier("assistantCheck.\(bot.id)")
  }
}

enum HomeSummary {
  static func assistants(_ count: Int) -> String {
    count == 0 ? "No assistants" : count == 1 ? "1 assistant" : "\(count) assistants"
  }
  static func following(_ count: Int) -> String {
    count == 0 ? "Not following any assistants" : count == 1 ? "Following 1 assistant" : "Following \(count) assistants"
  }
}

struct FollowedAssistantsView: View {
  @Binding var preferences: Preferences
  var bots: [Bot]
  @Environment(AppStore.self) private var store
  var body: some View {
    Form {
      Section {
        ForEach(bots) { bot in
          AssistantCheckRow(bot: bot, selected: preferences.isFollowing(bot.id)) {
            preferences = preferences.settingFollow(bot.id, !preferences.isFollowing(bot.id))
          }
        }
      } footer: {
        Text("Shared-task notifications already go to participants. Follow an assistant to receive all their activity.")
      }.disabled(store.sessionExpired)
    }.householdListBackground().navigationTitle("Follow all activity").navigationBarTitleDisplayMode(.inline)
  }
}

/// The rows Settings shows under Home sections: each section with its count, then the add row.
struct HomeSectionRows: View {
  @Binding var preferences: Preferences
  var bots: [Bot]
  @State private var newName = ""
  private var trimmed: String { newName.trimmingCharacters(in: .whitespacesAndNewlines) }
  var body: some View {
    ForEach(preferences.sections) { section in
      NavigationLink {
        HomeSectionView(preferences: $preferences, sectionId: section.id, bots: bots)
      } label: {
        LabeledContent(section.displayName, value: sectionSummary(section))
      }.accessibilityIdentifier("homeSection.\(section.id)")
    }.onDelete { offsets in
      for id in offsets.map({ preferences.sections[$0].id }) { preferences = preferences.removingSection(id) }
    }
    if preferences.sections.count > 1 {
      NavigationLink("Reorder sections") { ReorderSectionsView(preferences: $preferences) }
        .accessibilityIdentifier("reorderSections")
    }
    if preferences.canAddSection { addRow } else {
      Text("You have the most sections home can show (\(Preferences.sectionLimit)).").font(.footnote).foregroundStyle(.secondary)
    }
  }
  private func sectionSummary(_ section: BotSection) -> String {
    let members = bots.filter { section.botIds.contains($0.id) }
    let pinned = members.filter { preferences.favorites.contains($0.id) }.count
    return "\(HomeSummary.assistants(members.count - pinned)) in section" + (pinned > 0 ? " · \(pinned) pinned" : "")
  }
  /// Reads as an action, not a dimmed field: an accent plus and prompt, and Add appears once
  /// there is a name to add. An always-visible but disabled Add made the row look switched off.
  private var addRow: some View {
    HStack(spacing: 10) {
      Image(systemName: "plus.circle.fill").foregroundStyle(Palette.accent).accessibilityHidden(true)
      TextField("New section name", text: $newName, prompt: Text("New section").foregroundStyle(Palette.accent))
        .submitLabel(.done).onSubmit(add).accessibilityIdentifier("newSectionName")
      if !trimmed.isEmpty {
        Button("Add", action: add).buttonStyle(.accentProminent).controlSize(.small).tint(Palette.accent)
          .accessibilityIdentifier("addSection")
      }
    }
  }
  private func add() {
    guard let next = preferences.addingSection(named: newName) else { return }
    preferences = next
    newName = ""
  }
}

struct ReorderSectionsView: View {
  @Binding var preferences: Preferences
  var body: some View {
    List {
      ForEach(preferences.sections) { section in Text(section.displayName) }
        .onMove { preferences = preferences.movingSections(fromOffsets: $0, toOffset: $1) }
    }.environment(\.editMode, .constant(.active))
      .householdListBackground().navigationTitle("Reorder sections").navigationBarTitleDisplayMode(.inline)
  }
}

/// One section: its name, one multi-select of its assistants, and delete.
struct HomeSectionView: View {
  @Binding var preferences: Preferences
  var sectionId: String
  var bots: [Bot]
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State private var deleteConfirm = false
  @State private var name = ""
  @State private var nameError: String?
  private var section: BotSection? { preferences.sections.first { $0.id == sectionId } }
  var body: some View {
    Form {
      if let section {
        Section("Name") {
          TextField("Section name", text: $name)
            .onChange(of: name) { _, value in
              let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
              if trimmed.isEmpty { nameError = "Enter a section name. The previous name is still saved." }
              else if trimmed.count > Preferences.sectionNameLimit { nameError = "Use 100 characters or fewer. The previous name is still saved." }
              else if preferences.sections.contains(where: { $0.id != sectionId && $0.name.localizedCaseInsensitiveCompare(trimmed) == .orderedSame }) { nameError = "A section with that name already exists. The previous name is still saved." }
              else { nameError = nil; preferences = preferences.renamingSection(sectionId, to: trimmed) }
            }
            .accessibilityIdentifier("sectionName")
          if let nameError { Text(nameError).foregroundStyle(Palette.danger).font(.footnote).accessibilityAddTraits(.updatesFrequently) }
        }
        Section {
          ForEach(bots) { bot in
            let other = preferences.section(of: bot.id).flatMap { $0.id == sectionId ? nil : $0 }
            AssistantCheckRow(bot: bot, selected: section.botIds.contains(bot.id), note: other.map { "In \($0.displayName)" }) {
              preferences = preferences.moving(bot: bot.id, toSection: section.botIds.contains(bot.id) ? nil : sectionId)
            }
          }
        } header: { Text("Assistants") } footer: {
          Text("An assistant appears in one section. Choosing one that is already in another section moves it here.")
        }
        Section {
          Button("Delete section", role: .destructive) { deleteConfirm = true }.accessibilityIdentifier("deleteSection")
        } footer: { Text("Its assistants move back to More assistants on home.") }
      }
    }.onAppear { name = section?.name ?? "" }.disabled(store.sessionExpired).householdListBackground()
      .navigationTitle(section?.displayName ?? "Section").navigationBarTitleDisplayMode(.inline)
      .confirmationDialog("Delete \(section?.displayName ?? "this section")?", isPresented: $deleteConfirm, titleVisibility: .visible) {
        Button("Delete section", role: .destructive) {
          preferences = preferences.removingSection(sectionId)
          dismiss()
        }
      }
  }
}
