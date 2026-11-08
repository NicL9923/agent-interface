import SwiftUI

struct RoutineResultDestination: Identifiable {
  var botId: String; var routineId: String; var resultId: String?
  var id: String { "\(botId):\(routineId)" }
}
struct RoutineResultRow: Decodable, Identifiable {
  var id: String; var title: String; var startedAt: String?; var preview: String?; var previewOnly: Bool
}
struct RoutineOutput: Decodable { var messages: [Message]; var previewOnly: Bool }
struct RoutineResultsView: View {
  var botId: String; var routineId: String; var resultId: String?
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State private var rows: [RoutineResultRow] = []
  @State private var selected: String
  @State private var output: RoutineOutput?
  @State private var error: String?
  @State private var busy = false
  /// Bumped by Refresh, so both reads run again together, as the web's revision does.
  @State private var revision = 0
  init(botId: String, routineId: String, resultId: String? = nil) {
    self.botId = botId; self.routineId = routineId; self.resultId = resultId
    _selected = State(initialValue: resultId ?? "")
  }
  private var path: String { "/bots/\(APIClient.component(botId))/routines/\(APIClient.component(routineId))/results" }
  var body: some View {
    List {
      Section {
        Text("Recent runs saved by Hermes, including scheduled runs and trials.").foregroundStyle(.secondary)
        Button("Refresh results") { revision += 1 }.disabled(busy)
        if busy { ProgressView("Loading routine history…") }
        if let error { ErrorBanner(message: error) }
        if !busy && rows.isEmpty && error == nil { Text("No saved runs yet. Run the routine or return after its next scheduled run.") }
        if !rows.isEmpty {
          Picker("Run", selection: $selected) {
            ForEach(rows) { row in Text(row.startedAt.map { When.format($0) }.flatMap { $0.isEmpty ? nil : $0 } ?? row.title).tag(row.id) }
          }
        }
      }
      if !selected.isEmpty && output == nil && error == nil { Section { ProgressView("Loading output…") } }
      if let output {
        Section("Output") {
          Button("Save output") { Task { await saveOutput() } }
          if output.previewOnly { Text("Hermes exposes a preview for this script run. Full output is available in the native cron output files.").font(.footnote).foregroundStyle(.secondary) }
          if output.messages.isEmpty { Text("No assistant output was saved for this run.") }
          ForEach(output.messages) { message in
            MarkdownView(text: message.text)
            ForEach(message.files ?? []) { FileAttachmentView(file: $0) }
          }
        }
      }
    }.navigationTitle("Routine results").toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
      // The output read starts with the opened result and does not wait for the list.
      .task(id: "\(store.scope ?? ""):\(botId):\(routineId):\(revision)") { await load() }
      .task(id: "\(store.scope ?? ""):\(selected):\(revision)") { await loadOutput() }
  }
  private func saveOutput() async {
    let pointer = SavedPointer(botId: botId, kind: "routine", routineId: routineId, resultId: selected, title: String((rows.first { $0.id == selected }?.title ?? "Routine output").prefix(120)))
    let saved: SavedItem? = await store.run(error: $error) { try await $0.api.write("/saved", pointer) }
    if saved != nil { error = "Saved to your saved items." }
  }
  private func load() async {
    error = nil
    let result: [RoutineResultRow]? = await store.run(busy: $busy, error: $error) { try await $0.api.get(path) }
    guard let result else { return }
    rows = result
    if !rows.contains(where: { $0.id == selected }) { selected = rows.first?.id ?? "" }
  }
  private func loadOutput() async {
    output = nil
    guard !selected.isEmpty else { return }
    let id = selected
    let result: RoutineOutput? = await store.run(error: $error, current: { selected == id }) {
      try await $0.api.get("\(path)/\(APIClient.component(id))")
    }
    if let result { output = result; error = nil }
  }
}

struct GroupMember: Codable, Hashable { var member_id: String; var profile: String; var handle: String; var display_name: String? }
struct GroupRoom: Decodable, Identifiable, Hashable {
  var room_id: String; var name: String; var members: [GroupMember]
  /// The newest message, which the catalog adds for home. Older servers and room reads omit it.
  var latest: GroupLatest? = nil
  var id: String { room_id }
}
struct GroupCatalog: Decodable, Equatable {
  var supported: Bool; var canSend: Bool; var reason: String?; var rooms: [GroupRoom]
  /// Hermes saves a room's purpose, shared notes and lead. Older servers omit it.
  var settings: Bool? = nil
  /// Routines can post their results in a group chat. Older servers omit it.
  var routineDelivery: Bool? = nil
}
struct GroupCreated: Decodable { var room: GroupRoom }
struct GroupCreate: Codable { var requestId: String; var name: String; var botIds: [String] }
struct GroupSend: Codable { var requestId: String; var threadId: String; var text: String }
struct GroupAccepted: Decodable { var accepted: Bool }
struct GroupApproved: Decodable { var approved: Bool }
struct GroupEventPayload: Decodable {
  var text: String?; var thread_id: String?; var member_id: String?
  /// A lead's hand-off (`room.assignment`). Read leniently, so an unexpected shape never fails the page.
  var lead_member_id: String? = nil; var member_ids: [String]? = nil
  private enum CodingKeys: String, CodingKey { case text, thread_id, member_id, lead_member_id, member_ids }
  init(text: String? = nil, thread_id: String? = nil, member_id: String? = nil) { self.text = text; self.thread_id = thread_id; self.member_id = member_id }
  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    text = try container.decodeIfPresent(String.self, forKey: .text)
    thread_id = try container.decodeIfPresent(String.self, forKey: .thread_id)
    member_id = try container.decodeIfPresent(String.self, forKey: .member_id)
    lead_member_id = try? container.decodeIfPresent(String.self, forKey: .lead_member_id)
    member_ids = try? container.decodeIfPresent([String].self, forKey: .member_ids)
  }
}
/// `display_name` names a member or, on a routine's post, the routine. Read leniently, so it never fails the page.
struct GroupActor: Decodable {
  var kind: String?; var id: String?; var display_name: String? = nil
  private enum CodingKeys: String, CodingKey { case kind, id, display_name }
  init(kind: String? = nil, id: String? = nil, display_name: String? = nil) { self.kind = kind; self.id = id; self.display_name = display_name }
  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    kind = try container.decodeIfPresent(String.self, forKey: .kind)
    id = try container.decodeIfPresent(String.self, forKey: .id)
    display_name = try? container.decodeIfPresent(String.self, forKey: .display_name)
  }
}
/// The household member who sent a `message.user` event through this app. Older servers omit it.
struct GroupSender: Decodable, Equatable { var id: String; var name: String }
struct GroupEvent: Decodable, Identifiable {
  var event_id: String; var seq: Int; var kind: String; var created_at: Double; var actor: GroupActor?; var payload: GroupEventPayload
  var sender: GroupSender? = nil
  var id: String { event_id }
  private enum CodingKeys: String, CodingKey { case event_id, seq, kind, created_at, actor, payload, sender }
  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    event_id = try container.decode(String.self, forKey: .event_id)
    seq = try container.decode(Int.self, forKey: .seq)
    kind = try container.decode(String.self, forKey: .kind)
    created_at = try container.decode(Double.self, forKey: .created_at)
    actor = try container.decodeIfPresent(GroupActor.self, forKey: .actor)
    payload = try container.decode(GroupEventPayload.self, forKey: .payload)
    // A sender this version cannot read is left out rather than failing the page.
    sender = try? container.decodeIfPresent(GroupSender.self, forKey: .sender)
  }
}
/// The limits the web enforces as input `maxLength`, so what is sent is what was typed.
enum GroupLimits {
  static let name = 100
  static let message = 16000
  /// Counted in UTF-16 units, as the browser's `maxLength` and the server's validation count.
  static func clip(_ value: String, to limit: Int) -> String {
    guard value.utf16.count > limit else { return value }
    var used = 0
    var end = value.startIndex
    // Whole characters only, so an emoji is never split.
    for index in value.indices {
      let size = value[index].utf16.count
      if used + size > limit { break }
      used += size
      end = value.index(after: index)
    }
    return String(value[..<end])
  }
  static func fits(_ value: String, _ limit: Int) -> Bool { value.utf16.count <= limit }
}
/// A group creation that may have reached Hermes. Its request ID is kept until Hermes answers, so a retry cannot make a second room.
enum GroupCreation {
  static func key(_ scope: String?) -> String { "group.create.\(scope ?? "")" }
  static func pending(scope: String?) -> GroupCreate? {
    UserDefaults.standard.data(forKey: key(scope)).flatMap { try? JSONDecoder().decode(GroupCreate.self, from: $0) }
  }
  static func clear(scope: String?) { UserDefaults.standard.removeObject(forKey: key(scope)) }
  /// Saves the request, sends it, and forgets it once Hermes confirms the room.
  static func submit(_ input: GroupCreate, api: APIClient, scope: String?) async throws -> GroupRoom {
    UserDefaults.standard.set(try JSONEncoder().encode(input), forKey: key(scope))
    let created: GroupCreated = try await api.write("/groups", input)
    clear(scope: scope)
    return created.room
  }
  static func failure(_ error: Error) -> String { error.localizedDescription + " Retry the saved request to check this room's creation." }
}
/// `state` comes with a log read that asks for it, from servers that support `state=1`.
struct GroupPage: Decodable { var events: [GroupEvent]; var cursor: Int; var has_more: Bool; var state: GroupState? }
struct GroupApproval: Decodable { var request_id: String?; var description: String?; var command: String? }
struct GroupAction: Decodable, Identifiable {
  var kind: String; var task_id: String; var member_id: String?; var execution_generation: Int?; var request_id: String?; var approval: GroupApproval?
  var id: String { task_id }
}
struct GroupDriver: Decodable {
  var working: Bool; var blocked: Bool; var pending_actions: [GroupAction]
  /// Who is working, from Hermes versions that report it.
  var member_activity: [GroupMemberActivity]? = nil
  var max_rounds: Int? = nil
  private enum CodingKeys: String, CodingKey { case working, blocked, pending_actions, member_activity, max_rounds }
  init(working: Bool, blocked: Bool, pending_actions: [GroupAction], member_activity: [GroupMemberActivity]? = nil, max_rounds: Int? = nil) {
    self.working = working; self.blocked = blocked; self.pending_actions = pending_actions; self.member_activity = member_activity; self.max_rounds = max_rounds
  }
  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    working = try container.decode(Bool.self, forKey: .working)
    blocked = try container.decode(Bool.self, forKey: .blocked)
    pending_actions = try container.decode([GroupAction].self, forKey: .pending_actions)
    // Live detail this version cannot read is left out rather than failing the room.
    member_activity = try? container.decodeIfPresent([GroupMemberActivity].self, forKey: .member_activity)
    max_rounds = try? container.decodeIfPresent(Int.self, forKey: .max_rounds)
  }
}
struct GroupState: Decodable {
  var room: GroupRoom; var driver_status: GroupDriver?
  /// Absent from Hermes versions without room settings, and for a disbanded room.
  var context: GroupContext? = nil
  private enum CodingKeys: String, CodingKey { case room, driver_status, context }
  init(room: GroupRoom, driver_status: GroupDriver?, context: GroupContext? = nil) { self.room = room; self.driver_status = driver_status; self.context = context }
  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    room = try container.decode(GroupRoom.self, forKey: .room)
    driver_status = try container.decodeIfPresent(GroupDriver.self, forKey: .driver_status)
    context = try? container.decodeIfPresent(GroupContext.self, forKey: .context)
  }
}
struct GroupDecision: Encodable { var taskId: String; var memberId: String; var generation: Int; var choice: String; var requestId: String }

struct GroupCreateView: View {
  var onCreated: (GroupRoom) -> Void = { _ in }
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State private var name = ""
  /// In the order they were chosen, which is the order Hermes receives.
  @State private var botIds: [String] = []
  @State private var pending: GroupCreate?
  @State private var error: String?
  @State private var busy = false
  var body: some View {
    Form {
      if let error { ErrorBanner(message: error) }
      if let pending { Text("\(pending.name) · \(pending.botIds.count) assistants. The saved request will be checked with Hermes.") }
      else {
        TextField("Group name", text: Binding(get: { name }, set: { name = GroupLimits.clip($0, to: GroupLimits.name) }))
        Section {
          ForEach((store.bootstrap?.bots ?? []).filter { !["all", "everyone"].contains($0.id.lowercased()) }) { bot in
            Toggle(isOn: Binding(get: { botIds.contains(bot.id) }, set: { if $0 { if !botIds.contains(bot.id) { botIds.append(bot.id) } } else { botIds.removeAll { $0 == bot.id } } })) {
              HStack(spacing: 8) {
                AvatarView(avatar: bot.avatar ?? AvatarConfig(), size: 24, name: bot.name, botId: bot.id, forceReducedMotion: true).accessibilityHidden(true)
                Text(bot.name)
              }
            }
              // The hidden avatar's own label still joins a toggle's label on iOS 27, so name the bot alone.
              .accessibilityLabel(bot.name)
              .disabled(busy || botIds.count >= 6 && !botIds.contains(bot.id))
          }
        } header: { Text("Choose 2–6 assistants · \(botIds.count) chosen") } footer: {
          if botIds.count == 6 { Text("Six assistants selected. Deselect one to choose another.") }
          if (store.bootstrap?.bots ?? []).contains(where: { botIds.contains($0.id) && !$0.shared && $0.ownerId != nil }) {
            Text("Only you will see this group, because it includes your personal assistant.")
          }
        }
      }
      Button(pending == nil ? "Create group" : "Retry saved group request") { Task { await create() } }.accessibilityIdentifier(pending == nil ? "createGroup" : "retryGroupRequest").disabled(busy || !store.connected || pending == nil && (botIds.count < 2 || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
    }.navigationTitle(pending == nil ? "New group" : "Finish creating group").toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
      .task { pending = GroupCreation.pending(scope: store.scope) }
  }
  private func create() async {
    let input = pending ?? GroupCreate(requestId: UUID().uuidString.lowercased(), name: name.trimmingCharacters(in: .whitespacesAndNewlines), botIds: botIds)
    error = nil
    pending = input
    let room = await store.run(busy: $busy, error: $error, failure: GroupCreation.failure) {
      try await GroupCreation.submit(input, api: $0.api, scope: $0.scope)
    }
    guard let room else { return }
    pending = nil; onCreated(room); dismiss()
  }
}
struct GroupConversationView: View {
  var room: GroupRoom; var canSend: Bool
  @Environment(AppStore.self) private var store
  @Environment(\.colorScheme) private var scheme
  @State private var state: GroupState?
  @State private var events: [GroupEvent] = []
  @State private var cursor = 0
  @State private var more = false
  @State private var draft = ""
  @State private var threadId = ""
  @State private var replyToId = ""
  @State private var sentScrollRequest: UUID?
  @State private var followingLatest = false
  @State private var suppressPageFollow = false
  @FocusState private var composerFocused: Bool
  @State private var pending: GroupSend?
  @State private var error: String?
  @State private var busy = false
  /// Another member made one of its assistants personal, so this group is gone for this person.
  @State private var missing = false
  /// The ETag of the log page applied last, so an unchanged poll skips decoding it again.
  @State private var applied: String?
  /// Cleared once an older server refuses a log read that asks for the room state too.
  @State private var combined = true
  /// Loads run one at a time; a reset for another account or room makes one still running stale.
  @State private var loads = SerialRefresh()
  @State private var loadGeneration = 0
  private var path: String { "/groups/\(APIClient.component(room.id))" }
  private var key: String { "group.send.\(store.scope ?? ""):\(room.id)" }
  /// The room's members as Hermes last reported them, or as home listed them before the first read.
  private var members: [GroupMember] { state?.room.members ?? room.members }
  private var advanced: Bool { store.bootstrap?.preferences.presentation == "advanced" }
  private var status: String { GroupActivity.status(state?.driver_status, context: state?.context, members: members) }
  /// Who is working right now. Advanced adds each one's tool and round.
  private var working: [GroupActivity.Line] { GroupActivity.lines(state?.driver_status, members: members, advanced: advanced) }
  @State private var settingsOpen = false
  /// A group that disappeared keeps none of its name, members or messages on screen.
  static func identity(_ room: GroupRoom, missing: Bool) -> (title: String, members: String?) {
    missing ? ("Group chat", nil) : (room.name, room.members.map { "\($0.display_name ?? $0.profile) (@\($0.handle))" }.joined(separator: " · "))
  }
  var body: some View {
    let identity = Self.identity(room, missing: missing)
    let roots = threadRoots
    ScrollViewReader { proxy in
    List {
      if missing || error != nil || state == nil {
        Section {
          if missing { Text("That group chat is no longer available to you.").font(.footnote) }
          else if let error { ErrorBanner(message: error) }
          if state == nil && error == nil && !missing { ProgressView("Opening group…") }
        }
      }
      Section {
        ForEach(transcript) { entry in
          if let handoff = GroupActivity.assignment(entry.event, members: members) {
            Text(handoff).font(.footnote).foregroundStyle(Palette.muted).listRowBackground(Color.clear).id(entry.id)
          } else {
            let startsThreadRun = entry.event.payload.thread_id != entry.previousThread
            messageRow(entry.event, root: startsThreadRun ? entry.event.payload.thread_id.flatMap { roots[$0] } : nil).id(entry.id)
          }
        }
        if more { Button("Load more messages") { Task { await load() } }.listRowBackground(Color.clear) }
        if state != nil && !missing && messages.isEmpty {
          Text("Start a discussion. Use @handle to address an assistant.").font(.footnote).foregroundStyle(Palette.muted).listRowBackground(Color.clear)
        }
      } header: {
        if let members = identity.members {
          VStack(alignment: .leading, spacing: 4) {
            Text(members).font(.footnote).foregroundStyle(Palette.muted)
            if let purpose = state?.context?.purpose, !purpose.isEmpty { Text(purpose).font(.footnote).foregroundStyle(.primary) }
          }.textCase(nil)
        }
      }
      if state?.driver_status?.working == true || !(state?.driver_status?.pending_actions.isEmpty ?? true) {
        Section {
          if state?.driver_status?.working == true { Button("Stop discussion", role: .destructive) { Task { await stop() } }.disabled(busy || !canSend || !store.connected) }
          ForEach(state?.driver_status?.pending_actions ?? []) { action in
            if action.kind == "approval" {
              HStack(spacing: 8) { assistantAvatar(action.member_id); Text("\(requester(action)) requests approval").font(.subheadline.bold()) }
              Text(action.approval?.description ?? action.approval?.command ?? "An assistant needs approval")
              HStack { Button("Allow once") { Task { await decide(action, "once") } }; Button("Deny") { Task { await decide(action, "deny") } } }.buttonStyle(.bordered).disabled(busy || !canSend || !store.connected)
            } else { Text("The last turn from \(requester(action)) is unconfirmed. Open this group in Hermes to review it before retrying.").font(.footnote) }
          }
        }
      }
      if !working.isEmpty && !missing {
        Section {
          ForEach(working) { line in
            HStack(spacing: 8) {
              assistantAvatar(line.memberId)
              VStack(alignment: .leading, spacing: 2) {
                Text(line.sentence).font(.subheadline).foregroundStyle(Palette.muted)
                if let round = line.round { Text(round).font(.caption).foregroundStyle(Palette.muted) }
              }
            }.accessibilityElement(children: .combine).accessibilityIdentifier("groupActivity.\(line.memberId)")
          }
        }
      }
      if state != nil {
        Color.clear.frame(height: 1).id("group-end").listRowInsets(EdgeInsets()).listRowSeparator(.hidden).listRowBackground(Color.clear)
          .onAppear { followingLatest = true }.onDisappear { followingLatest = false }
      }
    }
    .householdListBackground()
    .safeAreaInset(edge: .bottom) { composer }
    .navigationTitle(identity.title).refreshable { await load() }
    .toolbar {
      if state?.context != nil && !missing {
        ToolbarItem(placement: .primaryAction) {
          Button { settingsOpen = true } label: { Label("Group settings", systemImage: "gearshape") }.accessibilityIdentifier("groupSettings")
        }
      }
    }
    .sheet(isPresented: $settingsOpen) {
      if let state, let context = state.context {
        NavigationStack { GroupSettingsView(roomId: room.id, name: state.room.name, members: state.room.members, context: context) { Task { await load() } } }
      }
    }
    .task(id: "\(store.scope ?? ""):\(room.id)") {
      loadGeneration += 1
      settingsOpen = false
      state = nil; events = []; cursor = 0; more = false; applied = nil; threadId = ""; replyToId = ""; sentScrollRequest = nil; followingLatest = false; suppressPageFollow = false
      draft = UserDefaults.standard.string(forKey: key + ":draft") ?? ""
      if let data = UserDefaults.standard.data(forKey: key) { pending = try? JSONDecoder().decode(GroupSend.self, from: data) }
      await load()
      if !Task.isCancelled && !more { scrollToLatest(proxy) }
    }
    // The server announces new events on the app event stream; this slow poll only covers a
    // stream that failed unnoticed, and the room's state.
    .watchingGroup(room.id) { if !missing { await load() } }
    .pollWhileActive(id: "\(store.scope ?? ""):\(room.id)", every: Self.fallbackInterval) { if !missing { await load() } }
    .onChange(of: messages.last?.id) { _, _ in if followingLatest && !suppressPageFollow { scrollToLatest(proxy) } }
    .onChange(of: sentScrollRequest) { _, request in if request != nil { scrollToLatest(proxy) } }
    }
  }
  private func scrollToLatest(_ proxy: ScrollViewProxy) {
    Task { @MainActor in proxy.scrollTo("group-end", anchor: .bottom) }
  }
  private var composer: some View {
    VStack(alignment: .leading, spacing: 8) {
      if !threadId.isEmpty {
        HStack(alignment: .top, spacing: 12) {
          VStack(alignment: .leading, spacing: 4) {
            Text("Replying in thread").font(.subheadline.bold())
            Text(replyingTo.map(context) ?? "Earlier messages in this thread").font(.footnote).foregroundStyle(Palette.muted).lineLimit(2)
          }.frame(maxWidth: .infinity, alignment: .leading)
          Button("New topic") { threadId = ""; replyToId = ""; composerFocused = true }.font(.subheadline)
        }

      }
      if let pending {
        Text(pending.text).font(.footnote).textSelection(.enabled)
        Text("This message may have arrived. Retry the same saved message to check without sending a duplicate.").font(.caption).foregroundStyle(.secondary)
        Button("Retry same saved message") { Task { await send() } }.buttonStyle(.accentProminent).disabled(busy || !canSend || !store.connected)
      } else {
        if let query = GroupMentions.query(in: draft), canSend {
          let members = GroupMentions.suggestions(for: query, members: room.members)
          if !members.isEmpty {
            MentionSuggestions(members: members) { member in
              draft = GroupLimits.clip(GroupMentions.insert(member, into: draft), to: GroupLimits.message)
              AccessibilityNotification.Announcement("Mentioned \(member.display_name ?? member.profile)").post()
            }
          }
        }
        HStack(alignment: .bottom, spacing: 10) {
          TextField("Message the group", text: Binding(get: { draft }, set: { draft = GroupLimits.clip($0, to: GroupLimits.message) }), axis: .vertical).lineLimit(1...6)
            .padding(12).background(Palette.raised(scheme), in: RoundedRectangle(cornerRadius: 14))
            .accessibilityLabel("Message the group").focused($composerFocused).accessibilityIdentifier("groupComposer").onChange(of: draft) { _, value in UserDefaults.standard.set(value, forKey: key + ":draft") }
          // A draft saved before the input limit existed can be longer; it stays editable but cannot send.
          let ready = !busy && canSend && store.connected && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && GroupLimits.fits(draft, GroupLimits.message)
          Button { Task { await send() } } label: {
            Image(systemName: busy ? "hourglass" : "arrow.up").font(.headline).frame(width: 44, height: 44)
              .foregroundStyle(ready ? Palette.surface(scheme) : Palette.muted)
              .background(ready ? Palette.accent : Palette.line, in: Circle()).contentShape(Circle())
          }.buttonStyle(.plain).disabled(!ready).accessibilityLabel("Send to group")
        }
      }
      if !GroupLimits.fits(draft, GroupLimits.message) { Text("Messages can contain up to 16,000 characters.").font(.caption).foregroundStyle(Palette.danger) }
      Text(status).font(.footnote).foregroundStyle(Palette.muted)
    }.padding(12).background(.regularMaterial)
  }
  private var messages: [GroupEvent] { events.filter { ["message.user", "message.member"].contains($0.kind) } }
  /// One row of the room: a message, knowing the thread of the message before it, or the lead's hand-off.
  struct TranscriptEntry: Identifiable { var event: GroupEvent; var previousThread: String?; var id: String { event.id } }
  /// Messages, with the lead's hand-offs between them.
  private var transcript: [TranscriptEntry] { Self.transcript(events) }
  static func transcript(_ events: [GroupEvent]) -> [TranscriptEntry] {
    var previous: String?
    var entries: [TranscriptEntry] = []
    for event in events {
      if event.kind == "room.assignment" { entries.append(TranscriptEntry(event: event, previousThread: nil)) }
      else if ["message.user", "message.member"].contains(event.kind) {
        entries.append(TranscriptEntry(event: event, previousThread: previous)); previous = event.payload.thread_id
      }
    }
    return entries
  }
  private var threadRoots: [String: GroupEvent] {
    var roots: [String: GroupEvent] = [:]
    for event in messages { if let thread = event.payload.thread_id, roots[thread] == nil { roots[thread] = event } }
    return roots
  }
  private var replyingTo: GroupEvent? { messages.first { $0.id == replyToId } ?? threadRoots[threadId] }
  private func context(_ event: GroupEvent) -> String {
    "\(author(event)): " + String((event.payload.text ?? "Message").replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).prefix(100))
  }
  @ViewBuilder private func assistantAvatar(_ id: String?) -> some View {
    if let bot = store.bootstrap?.bots.first(where: { $0.id == id }) {
      AvatarView(avatar: bot.avatar ?? AvatarConfig(), size: 24, name: bot.name, botId: bot.id, forceReducedMotion: true).accessibilityHidden(true)
    }
  }
  private func requester(_ action: GroupAction) -> String {
    let member = room.members.first { $0.member_id == action.member_id }
    return member?.display_name ?? member?.profile ?? "Assistant"
  }
  private func messageRow(_ event: GroupEvent, root: GroupEvent?) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .center, spacing: 8) {
        if event.kind == "message.member" { assistantAvatar(event.payload.member_id ?? event.actor?.id) }
        Text(author(event)).font(.subheadline.bold())
        if let routine = GroupActivity.scheduledPost(event) {
          Text(routine.failed ? "Routine failed" : "Routine").font(.caption.weight(.semibold)).foregroundStyle(Palette.muted)
            .padding(.horizontal, 8).padding(.vertical, 2).overlay(Capsule().strokeBorder(Palette.line))
        }
        Spacer()
        Text(When.format(Date(timeIntervalSince1970: event.created_at))).font(.caption).foregroundStyle(Palette.muted)
      }
      if let root, root.id != event.id {
        Text("In thread with \(context(root))").font(.footnote).foregroundStyle(Palette.muted)
          .padding(.leading, 8).overlay(alignment: .leading) { Rectangle().fill(Palette.accent).frame(width: 2) }
      }
      MarkdownView(text: event.payload.text ?? "")
      if let thread = event.payload.thread_id {
        Button("Reply in thread") { threadId = thread; replyToId = event.id; composerFocused = true }
          .font(.subheadline).buttonStyle(.borderless).frame(minHeight: 44).disabled(busy || pending != nil || !canSend)
          .accessibilityLabel("Reply in thread to \(context(event))")
      }
    }.overlay(alignment: .leading) {
      if replyToId == event.id { Rectangle().fill(Palette.accent).frame(width: 3).padding(.vertical, 6).offset(x: -8) }
    }.listRowBackground(replyToId == event.id ? Palette.accentSoft : event.kind == "message.user" && author(event) == "You" ? Palette.rail(scheme) : Palette.raised(scheme))
  }
  private func author(_ event: GroupEvent) -> String {
    if let routine = GroupActivity.scheduledPost(event) { return routine.name }
    if event.kind == "message.user" { return (event.sender?.id ?? event.actor?.id) == store.bootstrap?.user.id ? "You" : Self.memberName(event) }
    return Self.assistantName(event, in: room)
  }
  /// While the room is watched, new events arrive by notice; this poll is the fallback.
  static let fallbackInterval: Duration = .seconds(30)
  /// The household member who wrote a message, when the server recorded it.
  static func memberName(_ event: GroupEvent) -> String {
    let name = event.sender?.name.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return name.isEmpty ? "Household member" : name
  }
  /// Matches the author by the event's actor as well as its payload, like the web.
  static func assistantName(_ event: GroupEvent, in room: GroupRoom) -> String {
    let member = room.members.first { $0.member_id == event.actor?.id || $0.member_id == event.payload.member_id }
    return member?.display_name ?? member?.profile ?? event.actor?.id ?? event.payload.member_id ?? "Assistant"
  }
  private enum Fetched {
    case unchanged
    case gone
    case combined(GroupState, GroupPage, etag: String?)
    /// `downgraded` when this server cannot send the room state with the log.
    case separate(GroupState, GroupPage, downgraded: Bool)
  }
  /// Reloads the room. The stream, the fallback poll and actions all ask; their loads run one at a
  /// time, so a slow response never lands over a newer snapshot.
  private func load() async { await loads.run { await loadOnce() } }
  /// One request a poll: the log brings the room state along, so the server reads it from Hermes once.
  private func loadOnce() async {
    let since = cursor, tag = applied, wantsCombined = combined, generation = loadGeneration
    let fetched: Fetched? = await store.run(error: $error, current: { generation == loadGeneration }) { context in
      var downgraded = false
      do {
        if wantsCombined {
          do {
            let response: (value: GroupPage?, etag: String?) = try await context.api.changed("\(path)/log?since=\(since)&state=1", since: tag)
            // The page applied last time, unchanged: nothing to decode or redraw.
            guard let page = response.value else { return .unchanged }
            if let value = page.state { return .combined(value, page, etag: response.etag) }
            downgraded = true
          } catch let failure as APIError where failure.status == 400 { downgraded = true }
        }
        let value: GroupState = try await context.api.get(path)
        let page: GroupPage = try await context.api.get("\(path)/log?since=\(since)")
        return .separate(value, page, downgraded: downgraded)
      } catch let failure as APIError where failure.status == 404 { return .gone }
    }
    // The room was reset for another account or room meanwhile: this snapshot is for the old one.
    guard generation == loadGeneration else { return }
    switch fetched {
    case nil: return
    case .unchanged?: if error != nil { error = nil }
    case .gone?: missing = true; state = nil; events = []; error = nil
    case .combined(let value, let page, let etag)?: apply(value, page); applied = etag
    case .separate(let value, let page, let downgraded)?:
      if downgraded { combined = false }
      apply(value, page)
    }
  }
  private func apply(_ value: GroupState, _ page: GroupPage) {
    suppressPageFollow = more || page.has_more
    state = value; error = nil; let known = Set(events.map(\.id)); events += page.events.filter { !known.contains($0.id) }; events.sort { $0.seq < $1.seq }; cursor = page.cursor; more = page.has_more
  }
  private func send() async {
    let input = pending ?? GroupSend(requestId: UUID().uuidString.lowercased(), threadId: threadId.isEmpty ? UUID().uuidString.lowercased() : threadId, text: draft.trimmingCharacters(in: .whitespacesAndNewlines))
    error = nil
    let receipt: GroupAccepted? = await store.run(busy: $busy, error: $error, failure: { $0.localizedDescription + " The message may have arrived. Retry the same saved message to check, without sending a duplicate." }) {
      UserDefaults.standard.set(try JSONEncoder().encode(input), forKey: key); pending = input
      let receipt: GroupAccepted = try await $0.api.write(path + "/messages", input)
      guard receipt.accepted else { throw NSError(domain: "Group chat", code: 1, userInfo: [NSLocalizedDescriptionKey: "Hermes did not confirm this message."]) }
      return receipt
    }
    guard receipt != nil else { return }
    UserDefaults.standard.removeObject(forKey: key); UserDefaults.standard.removeObject(forKey: key + ":draft"); pending = nil; draft = ""; threadId = ""; replyToId = ""; await load(); sentScrollRequest = UUID()
  }
  private func stop() async {
    let stopped: [String: Int]? = await store.run(busy: $busy, error: $error) { try await $0.api.write(path + "/stop", ["requestId": UUID().uuidString.lowercased()]) }
    if stopped != nil { await load() }
  }
  private func decide(_ action: GroupAction, _ choice: String) async {
    guard let member = action.member_id, let generation = action.execution_generation, let request = action.request_id ?? action.approval?.request_id else { return }
    let decision = GroupDecision(taskId: action.task_id, memberId: member, generation: generation, choice: choice, requestId: request)
    switch await store.attempt(busy: $busy, { (context) -> GroupApproved in try await context.api.write(path + "/approve", decision) }) {
    case .success?: store.buzz(.decided); await load()
    case .failure(let failure)?: store.buzz(.failed); error = failure.localizedDescription
    case nil: break
    }
  }
}

// MARK: Group chats on home

/// The newest message in a room, which the server words for this viewer ("You", an assistant's name).
struct GroupLatest: Decodable, Hashable { var text: String; var at: String; var author: String }

/// One face in a room's cluster on home: a member, with the assistant it stands for when this person can see it.
struct GroupFace: Identifiable {
  var member: GroupMember; var bot: Bot?
  var id: String { member.member_id }
}

/// How group chats appear in the home list. Pure, so ordering and wording are tested without a screen.
enum GroupRows {
  /// Rooms follow the assistants, newest message first. Assistant rows keep the roster's order and
  /// never jump while a reply arrives, so rooms do the same inside their run: a room with no message
  /// yet keeps the catalog's order after those that have one.
  static func ordered(_ rooms: [GroupRoom]) -> [GroupRoom] {
    rooms.enumerated().sorted { a, b in
      let left = a.element.latest.flatMap { ServerDate.parse($0.at) }, right = b.element.latest.flatMap { ServerDate.parse($0.at) }
      switch (left, right) {
      case let (l?, r?): return l != r ? l > r : a.offset < b.offset
      case (_?, nil): return true
      case (nil, _?): return false
      case (nil, nil): return a.offset < b.offset
      }
    }.map(\.element)
  }
  /// The row's second line: who spoke last and what they said, or a plain note.
  static func preview(_ room: GroupRoom) -> String {
    guard let latest = room.latest, !latest.text.isEmpty else { return "No messages yet" }
    return "\(latest.author): \(latest.text)"
  }
  /// At most three members shown as faces, in the room's order.
  static func faces(_ room: GroupRoom, bots: [Bot]) -> [GroupFace] {
    room.members.prefix(3).map { member in GroupFace(member: member, bot: bots.first { $0.id == member.member_id }) }
  }
  /// The members in words, such as "Ranch hand, Planner and Kitchen companion".
  static func memberNames(_ room: GroupRoom) -> String {
    let names = room.members.map { $0.display_name ?? $0.profile }
    guard names.count > 1 else { return names.joined() }
    return names.dropLast().joined(separator: ", ") + " and " + names.last!
  }
  /// Whether home offers to make a group: Hermes hosts them and two assistants exist to put in one,
  /// or a saved request is waiting to be finished.
  static func canCreate(_ catalog: GroupCatalog?, bots: [Bot], pending: Bool) -> Bool {
    if pending { return true }
    guard let catalog, catalog.supported else { return false }
    return bots.filter { !["all", "everyone"].contains($0.id.lowercased()) }.count >= 2
  }
  /// Why a group cannot be made right now, or nil when one can.
  static func creationHint(_ catalog: GroupCatalog?, connected: Bool) -> String? {
    if catalog?.canSend != true { return catalog?.reason ?? "The Hermes group coordinator must be running to make a group chat." }
    return connected ? nil : "Reconnect to Hermes to make a group chat."
  }
}

/// A group's members as overlapping faces in the square one assistant's avatar takes, so rows line up.
/// Two faces sit on a diagonal, three in a triangle; a member this person cannot see shows an initial.
struct RoomFacesView: View {
  var room: GroupRoom; var bots: [Bot]; var cluster: CGFloat; var ring: Color
  var body: some View {
    let faces = GroupRows.faces(room, bots: bots)
    let size = (cluster * (faces.count == 2 ? 0.68 : 0.56)).rounded()
    ZStack {
      ForEach(Array(faces.enumerated()), id: \.element.id) { index, face in
        faceView(face, size: size).offset(offset(index, count: faces.count, size: size))
      }
    }.frame(width: cluster, height: cluster).accessibilityHidden(true)
  }
  private func offset(_ index: Int, count: Int, size: CGFloat) -> CGSize {
    let reach = (cluster - size) / 2
    switch (count, index) {
    case (2, 0): return CGSize(width: -reach, height: -reach)
    case (2, _): return CGSize(width: reach, height: reach)
    case (_, 0): return CGSize(width: 0, height: -reach)
    case (_, 1): return CGSize(width: -reach, height: reach)
    default: return CGSize(width: reach, height: reach)
    }
  }
  @ViewBuilder private func faceView(_ face: GroupFace, size: CGFloat) -> some View {
    Group {
      if let bot = face.bot {
        AvatarView(avatar: bot.avatar ?? AvatarConfig(), size: size, name: bot.name, forceReducedMotion: true)
      } else {
        Text(String((face.member.display_name ?? face.member.profile).prefix(1)).uppercased())
          .font(.system(size: size * 0.42, weight: .semibold)).foregroundStyle(Palette.accent)
          .frame(width: size, height: size).background(Palette.accentSoft, in: Circle())
      }
    }.frame(width: size, height: size).clipShape(Circle()).overlay(Circle().strokeBorder(ring, lineWidth: 2))
  }
}

/// One group chat in the home list, shaped like an assistant row: faces, name, time, and the last message.
struct GroupRoomRow: View {
  var room: GroupRoom; var selected: Bool; var ring: Color; var action: () -> Void
  @Environment(AppStore.self) private var store
  @Environment(\.dynamicTypeSize) private var typeSize
  var body: some View {
    Button(action: action) {
      HStack(spacing: 12) {
        RoomFacesView(room: room, bots: store.bootstrap?.bots ?? [], cluster: 52, ring: ring)
        VStack(alignment: .leading, spacing: 5) {
          if typeSize.isAccessibilitySize {
            Text(room.name).font(.body.weight(.semibold)).foregroundStyle(.primary)
            if let at = room.latest?.at, let date = ServerDate.parse(at) { AssistantListDate(date: date) }
          } else {
            HStack(alignment: .firstTextBaseline) {
              Text(room.name).font(.body.weight(.semibold)).foregroundStyle(.primary).lineLimit(2)
              Spacer(minLength: 8)
              if let at = room.latest?.at, let date = ServerDate.parse(at) { AssistantListDate(date: date) }
            }
          }
          Text(GroupRows.preview(room)).font(.subheadline).foregroundStyle(.secondary).lineLimit(typeSize.isAccessibilitySize ? 3 : 2)
        }.frame(maxWidth: .infinity, alignment: .leading)
      }.padding(.horizontal, 10).padding(.vertical, 12).contentShape(Rectangle())
    }.buttonStyle(.plain)
      .background(selected ? Palette.accentSoft : Color.clear, in: RoundedRectangle(cornerRadius: 16))
      .accessibilityHint("Group chat with \(GroupRows.memberNames(room))")
      .accessibilityAddTraits(selected ? .isSelected : [])
      .accessibilityIdentifier("room.\(room.id)")
  }
}

/// A saved request to make a group, which may already have reached Hermes. Opening it finishes the request.
struct PendingGroupRow: View {
  var request: GroupCreate; var action: () -> Void
  var body: some View {
    Button(action: action) {
      HStack(spacing: 12) {
        Image(systemName: "bubble.left.and.bubble.right").font(.title3).foregroundStyle(Palette.accent)
          .frame(width: 52, height: 52).background(Palette.accentSoft, in: Circle()).accessibilityHidden(true)
        VStack(alignment: .leading, spacing: 5) {
          Text("Finish creating group").font(.body.weight(.semibold)).foregroundStyle(Palette.accent)
          Text("\(request.name) · \(request.botIds.count) assistants. The saved request will be checked with Hermes.")
            .font(.subheadline).foregroundStyle(.secondary).lineLimit(3)
        }.frame(maxWidth: .infinity, alignment: .leading)
      }.padding(.horizontal, 10).padding(.vertical, 12).contentShape(Rectangle())
    }.buttonStyle(.plain).accessibilityIdentifier("finishGroup")
  }
}
