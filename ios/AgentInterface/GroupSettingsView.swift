import SwiftUI

/// A group chat's purpose, shared notes and lead, as on the web's Group settings. Anyone who can open the
/// room may change them, as anyone may message it. Hermes gives them to every assistant from the next message on.
struct GroupSettingsView: View {
  var roomId: String; var name: String; var members: [GroupMember]; var context: GroupContext
  var onSaved: () -> Void
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State private var purpose: String
  @State private var notes: String
  /// The lead's member ID, or empty for no lead.
  @State private var lead: String
  @State private var busy = false
  @State private var error: String?
  init(roomId: String, name: String, members: [GroupMember], context: GroupContext, onSaved: @escaping () -> Void) {
    self.roomId = roomId; self.name = name; self.members = members; self.context = context; self.onSaved = onSaved
    _purpose = State(initialValue: context.purpose)
    _notes = State(initialValue: context.notes)
    _lead = State(initialValue: Self.initialLead(context, members: members))
  }
  /// A lead who has left the room is no choice at all.
  static func initialLead(_ context: GroupContext, members: [GroupMember]) -> String {
    context.routing == "lead" && members.contains { $0.member_id == context.lead_member_id } ? context.lead_member_id : ""
  }
  /// How far the notes are over Hermes's limit, in bytes, or 0.
  static func notesOver(_ notes: String) -> Int { max(0, GroupActivity.notesBytes(notes) - GroupActivity.notesByteLimit) }
  var body: some View {
    let over = Self.notesOver(notes)
    Form {
      if let error { Section { ErrorBanner(message: error, dismiss: { self.error = nil }) } }
      Section {
        TextField("What this group is for", text: Binding(get: { purpose }, set: { purpose = GroupLimits.clip($0, to: GroupActivity.purposeLimit) }), axis: .vertical)
          .lineLimit(1...4).accessibilityLabel("Purpose").accessibilityIdentifier("groupPurpose")
      } header: { Text("Purpose") } footer: { Text("Every assistant in \(name) reads these settings from the next message on.") }
      Section {
        TextField("Facts every assistant should keep in mind", text: $notes, axis: .vertical)
          .lineLimit(4...12).accessibilityLabel("Shared notes").accessibilityIdentifier("groupNotes")
      } header: { Text("Shared notes") } footer: {
        if over > 0 { Text("These notes are too long. Remove about \(over.formatted()) characters.").foregroundStyle(Palette.danger) }
      }
      Section {
        Picker("Lead assistant", selection: $lead) {
          Text("No lead, every assistant answers").tag("")
          ForEach(members, id: \.member_id) { member in Text(member.display_name ?? member.profile).tag(member.member_id) }
        }.accessibilityIdentifier("groupLead")
      } footer: { Text("A lead picks who answers a message that names no one. Messages with an @mention always reach the assistants named.") }
      if !store.connected { Section { Text("Reconnect to Hermes to change these settings.").font(.footnote) } }
    }
    .disabled(busy)
    .navigationTitle("Group settings").navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
      ToolbarItem(placement: .confirmationAction) {
        Button(busy ? "Saving…" : "Save") { Task { await save() } }.disabled(busy || !store.connected || over > 0).accessibilityIdentifier("saveGroupSettings")
      }
    }
  }
  private func save() async {
    error = nil
    let input = GroupContextSave(requestId: UUID().uuidString.lowercased(), purpose: purpose, notes: notes, leadMemberId: lead.isEmpty ? nil : lead)
    let saved: GroupContextSaved? = await store.run(busy: $busy, error: $error) {
      try await $0.api.write("/groups/\(APIClient.component(roomId))/context", input)
    }
    guard saved != nil else { return }
    onSaved(); dismiss()
  }
}
