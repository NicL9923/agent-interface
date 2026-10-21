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
  @EnvironmentObject private var store: AppStore
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
          Button("Save output") { Task { do { let _:SavedItem = try await store.api!.write("/saved",SavedPointer(botId:botId,kind:"routine",routineId:routineId,resultId:selected,title:String((rows.first { $0.id==selected }?.title ?? "Routine output").prefix(120))));error="Saved to your saved items." } catch { self.error=error.localizedDescription } } }
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
  private func load() async {
    guard let api = store.api else { return }; let scope = store.scope
    busy = true; error = nil; defer { busy = false }
    do {
      let result: [RoutineResultRow] = try await api.get(path)
      guard !Task.isCancelled, store.scope == scope, store.api === api else { return }
      rows = result
      if !rows.contains(where: { $0.id == selected }) { selected = rows.first?.id ?? "" }
    } catch { if !Task.isCancelled, store.scope == scope { self.error = error.localizedDescription } }
  }
  private func loadOutput() async {
    output = nil
    guard !selected.isEmpty, let api = store.api else { return }; let scope = store.scope, id = selected
    do {
      let result: RoutineOutput = try await api.get("\(path)/\(APIClient.component(id))")
      guard !Task.isCancelled, selected == id, store.scope == scope, store.api === api else { return }
      output = result; error = nil
    } catch { if !Task.isCancelled, selected == id, store.scope == scope { self.error = error.localizedDescription } }
  }
}

struct GroupMember: Codable, Hashable { var member_id: String; var profile: String; var handle: String; var display_name: String? }
struct GroupRoom: Decodable, Identifiable, Hashable { var room_id: String; var name: String; var members: [GroupMember]; var id: String { room_id } }
struct GroupCatalog: Decodable { var supported: Bool; var canSend: Bool; var reason: String?; var rooms: [GroupRoom] }
struct GroupCreated: Decodable { var room: GroupRoom }
struct GroupCreate: Codable { var requestId: String; var name: String; var botIds: [String] }
struct GroupSend: Codable { var requestId: String; var threadId: String; var text: String }
struct GroupAccepted: Decodable { var accepted: Bool }
struct GroupApproved: Decodable { var approved: Bool }
struct GroupEventPayload: Decodable { var text: String?; var thread_id: String?; var member_id: String? }
struct GroupActor: Decodable { var kind: String?; var id: String? }
struct GroupEvent: Decodable, Identifiable {
  var event_id: String; var seq: Int; var kind: String; var created_at: Double; var actor: GroupActor?; var payload: GroupEventPayload
  var id: String { event_id }
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
struct GroupDriver: Decodable { var working: Bool; var blocked: Bool; var pending_actions: [GroupAction] }
struct GroupState: Decodable { var room: GroupRoom; var driver_status: GroupDriver? }
struct GroupDecision: Encodable { var taskId: String; var memberId: String; var generation: Int; var choice: String; var requestId: String }

struct GroupChatsView: View {
  @EnvironmentObject private var store: AppStore
  @State private var catalog: GroupCatalog?
  @State private var error: String?
  @State private var creating = false
  @State private var loadId = UUID()
  @State private var pendingCreate: GroupCreate?
  @State private var retryingCreate = false
  /// The room just created, opened once the new-group sheet is gone.
  @State private var created: GroupRoom?
  @State private var opened: GroupRoom?
  var body: some View {
    List {
      if let reason = catalog?.reason { Section { Text(reason).font(.footnote).foregroundStyle(.secondary) } }
      if let error { Section { ErrorBanner(message: error); Button("Retry") { Task { await load() } } } }
      if catalog == nil && error == nil { Section { ProgressView("Checking Hermes group chats…") } }
      if let pendingCreate { pendingSection(pendingCreate) }
      if let catalog, catalog.supported { roomsSection(catalog) }
    }.householdListBackground().viewHeader("Group chats", "Two to six assistants in one conversation").refreshable { await load() }
      // Rooms other members create show up without a manual refresh, like the web's 15 second poll.
      // Split-view reparenting can cancel a view task during a phone push, so the first read
      // does not depend on one; the poll below only keeps it fresh.
      .onAppear { pendingCreate = GroupCreation.pending(scope: store.scope); Task { await load() } }
      .pollWhileActive(id: store.scope ?? "", every: .seconds(15)) { await load() }
      .onChange(of: store.scope) { _, scope in
        catalog = nil; opened = nil; pendingCreate = GroupCreation.pending(scope: scope)
        Task { await load() }
      }
      // The split view's detail column honors the legacy link, not a value destination, for a push by code.
      .background { openedLink }
      .sheet(isPresented: $creating, onDismiss: sheetDismissed) {
        NavigationStack { GroupCreateView(onCreated: { created = $0 }) }.appStore(store)
      }
  }
  @ViewBuilder private var openedLink: some View {
    NavigationLink(isActive: Binding(get: { opened != nil }, set: { if !$0 { opened = nil } })) {
      if let room = opened { GroupConversationView(room: room, canSend: catalog?.canSend ?? false) }
    } label: { EmptyView() }.hidden()
  }
  private func roomsSection(_ catalog: GroupCatalog) -> some View {
    Section {
      if catalog.rooms.isEmpty && pendingCreate == nil { Text("No group chats yet. Create one to let your assistants discuss a task together.").foregroundStyle(.secondary) }
      ForEach(catalog.rooms) { room in
        NavigationLink { GroupConversationView(room: room, canSend: catalog.canSend) } label: {
          VStack(alignment: .leading, spacing: 3) { Text(room.name); Text("\(room.members.count) assistants").font(.caption).foregroundStyle(.secondary) }
        }
      }
      Button { creating = true } label: { Label("New group", systemImage: "plus") }
        .disabled(!catalog.canSend || !store.connected)
    }
  }
  /// A saved request stays above the rooms until Hermes answers, so a retry cannot make a second room.
  private func pendingSection(_ request: GroupCreate) -> some View {
    Section {
      Text("Finish creating group").font(.headline)
      Text("\(request.name) · \(request.botIds.count) assistants. The saved request will be checked with Hermes.").font(.footnote).foregroundStyle(.secondary)
      Button(retryingCreate ? "Checking…" : "Retry saved group request") { Task { await retryCreate(request) } }
        .disabled(retryingCreate || !(catalog?.canSend ?? false) || !store.connected).accessibilityIdentifier("retryGroupRequest")
    }
  }
  private func retryCreate(_ request: GroupCreate) async {
    guard let api = store.api else { return }; let scope = store.scope
    retryingCreate = true; defer { retryingCreate = false }
    do {
      let room = try await GroupCreation.submit(request, api: api, scope: scope)
      guard store.scope == scope, store.api === api else { return }
      pendingCreate = nil; error = nil; created = room
      await open(room)
    } catch { if store.scope == scope { self.error = GroupCreation.failure(error) } }
  }
  private func sheetDismissed() {
    pendingCreate = GroupCreation.pending(scope: store.scope)
    guard let room = created else { Task { await load() }; return }
    created = nil
    Task { await open(room) }
  }
  /// Refreshes the list, then opens the room, as the web selects the room it just created.
  private func open(_ room: GroupRoom) async { await load(); opened = room }
  private func load() async {
    guard let api = store.api else { return }; let scope = store.scope
    let id = UUID(); loadId = id
    do { let value: GroupCatalog = try await api.get("/groups"); guard !Task.isCancelled, loadId == id, store.scope == scope, store.api === api else { return }; catalog = value; error = nil }
    catch { if !Task.isCancelled, loadId == id, store.scope == scope { self.error = error.localizedDescription } }
  }
}
struct GroupCreateView: View {
  var onCreated: (GroupRoom) -> Void = { _ in }
  @EnvironmentObject private var store: AppStore
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
            Toggle(bot.name, isOn: Binding(get: { botIds.contains(bot.id) }, set: { if $0 { if !botIds.contains(bot.id) { botIds.append(bot.id) } } else { botIds.removeAll { $0 == bot.id } } }))
              .disabled(busy || botIds.count >= 6 && !botIds.contains(bot.id))
          }
        } header: { Text("Choose 2–6 assistants") } footer: {
          if (store.bootstrap?.bots ?? []).contains(where: { botIds.contains($0.id) && !$0.shared && $0.ownerId != nil }) {
            Text("Only you will see this group, because it includes your personal assistant.")
          }
        }
      }
      Button(pending == nil ? "Create group" : "Retry saved group request") { Task { await create() } }.disabled(busy || !store.connected || pending == nil && (botIds.count < 2 || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
    }.navigationTitle(pending == nil ? "New group" : "Finish creating group").toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
      .task { pending = GroupCreation.pending(scope: store.scope) }
  }
  private func create() async {
    guard let api = store.api else { return }; let scope = store.scope
    let input = pending ?? GroupCreate(requestId: UUID().uuidString.lowercased(), name: name.trimmingCharacters(in: .whitespacesAndNewlines), botIds: botIds)
    busy = true; defer { busy = false }; error = nil
    pending = input
    do {
      let room = try await GroupCreation.submit(input, api: api, scope: scope)
      guard store.scope == scope, store.api === api else { return }
      pending = nil; onCreated(room); dismiss()
    } catch { if store.scope == scope { self.error = GroupCreation.failure(error) } }
  }
}
struct GroupConversationView: View {
  var room: GroupRoom; var canSend: Bool
  @EnvironmentObject private var store: AppStore
  @Environment(\.colorScheme) private var scheme
  @State private var state: GroupState?
  @State private var events: [GroupEvent] = []
  @State private var cursor = 0
  @State private var more = false
  @State private var draft = ""
  @State private var threadId = ""
  @State private var pending: GroupSend?
  @State private var error: String?
  @State private var busy = false
  /// Another member made one of its assistants personal, so this group is gone for this person.
  @State private var missing = false
  /// The ETag of the log page applied last, so an unchanged poll skips decoding it again.
  @State private var applied: String?
  /// Cleared once an older server refuses a log read that asks for the room state too.
  @State private var combined = true
  private var path: String { "/groups/\(APIClient.component(room.id))" }
  private var key: String { "group.send.\(store.scope ?? ""):\(room.id)" }
  private var status: String {
    state?.driver_status?.blocked == true ? "Discussion needs attention." : state?.driver_status?.working == true ? "Assistants are discussing…" : "Ready for a topic."
  }
  /// A group that disappeared keeps none of its name, members or messages on screen.
  static func identity(_ room: GroupRoom, missing: Bool) -> (title: String, members: String?) {
    missing ? ("Group chat", nil) : (room.name, room.members.map { "\($0.display_name ?? $0.profile) (@\($0.handle))" }.joined(separator: " · "))
  }
  var body: some View {
    let identity = Self.identity(room, missing: missing)
    List {
      Section { if let members = identity.members { Text(members).font(.caption).foregroundStyle(.secondary) }
        if missing { Text("That group chat is no longer available to you.").font(.footnote) }
        else if let error { ErrorBanner(message: error) }
        if state == nil && error == nil && !missing { ProgressView("Opening group…") }
      }
      ForEach(events.filter { ["message.user", "message.member"].contains($0.kind) }) { event in
        VStack(alignment: .leading, spacing: 6) {
          HStack(alignment: .firstTextBaseline) {
            Text(author(event)).font(.caption.bold())
            Spacer()
            Text(When.format(Date(timeIntervalSince1970: event.created_at))).font(.caption2).foregroundStyle(.secondary)
          }
          MarkdownView(text: event.payload.text ?? "")
          if let thread = event.payload.thread_id {
            Button("Reply in thread") { threadId = thread }.font(.caption).buttonStyle(.borderless).disabled(pending != nil || !canSend)
          }
        }
      }
      if more { Button("Load more messages") { Task { await load() } }.listRowBackground(Color.clear) }
      if state != nil && !missing && events.allSatisfy({ !["message.user", "message.member"].contains($0.kind) }) {
        Text("Start a discussion. Use @handle to address an assistant.").font(.footnote).foregroundStyle(.secondary).listRowBackground(Color.clear)
      }
      if state?.driver_status?.working == true || !(state?.driver_status?.pending_actions.isEmpty ?? true) {
        Section {
          if state?.driver_status?.working == true { Button("Stop discussion", role: .destructive) { Task { await stop() } }.disabled(busy || !canSend || !store.connected) }
          ForEach(state?.driver_status?.pending_actions ?? []) { action in
            if action.kind == "approval" {
              Text(action.approval?.description ?? action.approval?.command ?? "An assistant needs approval")
              HStack { Button("Allow once") { Task { await decide(action, "once") } }; Button("Deny") { Task { await decide(action, "deny") } } }.buttonStyle(.bordered).disabled(busy || !canSend || !store.connected)
            } else { Text("Hermes cannot confirm a member's last turn. Review it in the native group client before retrying.").font(.footnote) }
          }
        }
      }
    }
    .householdListBackground()
    .safeAreaInset(edge: .bottom) { composer }
    .navigationTitle(identity.title).refreshable { await load() }.task(id: "\(store.scope ?? ""):\(room.id)") {
      state = nil; events = []; cursor = 0; more = false; applied = nil
      draft = UserDefaults.standard.string(forKey: key + ":draft") ?? ""
      if let data = UserDefaults.standard.data(forKey: key) { pending = try? JSONDecoder().decode(GroupSend.self, from: data) }
      await load()
    }
    .pollWhileActive(id: "\(store.scope ?? ""):\(room.id)", every: .seconds(3)) { if !missing { await load() } }
  }
  private var composer: some View {
    VStack(alignment: .leading, spacing: 8) {
      if !threadId.isEmpty {
        HStack { Text("Replying in thread").font(.caption).foregroundStyle(.secondary); Button("New topic") { threadId = "" }.font(.caption) }
      }
      if let pending {
        Text(pending.text).font(.footnote).textSelection(.enabled)
        Text("This message may have arrived. Retry the same saved message to check without sending a duplicate.").font(.caption).foregroundStyle(.secondary)
        Button("Retry same saved message") { Task { await send() } }.buttonStyle(.borderedProminent).disabled(busy || !canSend || !store.connected)
      } else {
        HStack(alignment: .bottom, spacing: 10) {
          TextField("Message the group… use @handle to address one assistant", text: Binding(get: { draft }, set: { draft = GroupLimits.clip($0, to: GroupLimits.message) }), axis: .vertical).lineLimit(1...6)
            .padding(12).background(Palette.raised(scheme), in: RoundedRectangle(cornerRadius: 14))
            .accessibilityIdentifier("groupComposer").onChange(of: draft) { _, value in UserDefaults.standard.set(value, forKey: key + ":draft") }
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
      Text(status).font(.caption).foregroundStyle(.secondary)
    }.padding(12).background(.regularMaterial)
  }
  private func author(_ event: GroupEvent) -> String {
    if event.kind == "message.user" { return "Household member" }
    return Self.assistantName(event, in: room)
  }
  /// Matches the author by the event's actor as well as its payload, like the web.
  static func assistantName(_ event: GroupEvent, in room: GroupRoom) -> String {
    let member = room.members.first { $0.member_id == event.actor?.id || $0.member_id == event.payload.member_id }
    return member?.display_name ?? member?.profile ?? event.actor?.id ?? event.payload.member_id ?? "Assistant"
  }
  /// One request a poll: the log brings the room state along, so the server reads it from Hermes once.
  private func load() async {
    guard let api = store.api else { return }; let scope = store.scope
    do {
      if combined {
        do {
          let response: (value: GroupPage?, etag: String?) = try await api.changed("\(path)/log?since=\(cursor)&state=1", since: applied)
          guard !Task.isCancelled, store.scope == scope, store.api === api else { return }
          // The page applied last time, unchanged: nothing to decode or redraw.
          guard let page = response.value else { if error != nil { error = nil }; return }
          if let value = page.state { apply(value, page); applied = response.etag; return }
          combined = false
        } catch let failure as APIError where failure.status == 400 { combined = false }
      }
      let value: GroupState = try await api.get(path)
      let page: GroupPage = try await api.get("\(path)/log?since=\(cursor)")
      guard !Task.isCancelled, store.scope == scope, store.api === api else { return }
      apply(value, page)
    } catch {
      guard !Task.isCancelled, store.scope == scope else { return }
      if (error as? APIError)?.status == 404 { missing = true; state = nil; events = []; self.error = nil }
      else { self.error = error.localizedDescription }
    }
  }
  private func apply(_ value: GroupState, _ page: GroupPage) {
    state = value; error = nil; let known = Set(events.map(\.id)); events += page.events.filter { !known.contains($0.id) }; events.sort { $0.seq < $1.seq }; cursor = page.cursor; more = page.has_more
  }
  private func send() async {
    guard let api = store.api else { return }; let scope = store.scope
    let input = pending ?? GroupSend(requestId: UUID().uuidString.lowercased(), threadId: threadId.isEmpty ? UUID().uuidString.lowercased() : threadId, text: draft.trimmingCharacters(in: .whitespacesAndNewlines))
    busy = true; error = nil; defer { busy = false }
    do {
      UserDefaults.standard.set(try JSONEncoder().encode(input), forKey: key); pending = input
      let receipt: GroupAccepted = try await api.write(path + "/messages", input)
      guard store.scope == scope, store.api === api else { return }
      guard receipt.accepted else { throw NSError(domain: "Group chat", code: 1, userInfo: [NSLocalizedDescriptionKey: "Hermes did not confirm this message."]) }
      UserDefaults.standard.removeObject(forKey: key); UserDefaults.standard.removeObject(forKey: key + ":draft"); pending = nil; draft = ""; threadId = ""; await load()
    } catch { if store.scope == scope { self.error = error.localizedDescription + " The message may have arrived. Retry the same saved message to check, without sending a duplicate." } }
  }
  private func stop() async {
    guard let api = store.api else { return }; busy = true; defer { busy = false }
    do { let _: [String: Int] = try await api.write(path + "/stop", ["requestId": UUID().uuidString.lowercased()]); await load() } catch { self.error = error.localizedDescription }
  }
  private func decide(_ action: GroupAction, _ choice: String) async {
    guard let api = store.api, let member = action.member_id, let generation = action.execution_generation, let request = action.request_id ?? action.approval?.request_id else { return }
    busy = true; defer { busy = false }
    do { let _: GroupApproved = try await api.write(path + "/approve", GroupDecision(taskId: action.task_id, memberId: member, generation: generation, choice: choice, requestId: request)); await load() } catch { self.error = error.localizedDescription }
  }
}
