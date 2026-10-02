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
  @State private var selected = ""
  @State private var output: RoutineOutput?
  @State private var error: String?
  @State private var busy = false
  private var path: String { "/bots/\(APIClient.component(botId))/routines/\(APIClient.component(routineId))/results" }
  var body: some View {
    List {
      Section {
        Text("Recent scheduled runs and trials saved by Hermes.").foregroundStyle(.secondary)
        Button("Refresh results") { Task { await load() } }.disabled(busy)
        if busy { ProgressView("Loading routine history…") }
        if let error { ErrorBanner(message: error) }
        if !busy && rows.isEmpty && error == nil { Text("No saved runs yet. Run the routine or return after its next scheduled run.") }
        if !rows.isEmpty {
          Picker("Run", selection: $selected) {
            ForEach(rows) { row in Text(row.startedAt.flatMap(ServerDate.parse)?.formatted(date: .abbreviated, time: .shortened) ?? row.title).tag(row.id) }
          }
        }
      }
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
      .task(id: "\(store.scope ?? ""):\(botId):\(routineId)") { rows = []; selected = resultId ?? ""; await load() }
      .task(id: selected) { await loadOutput() }
  }
  private func load() async {
    guard let api = store.api else { return }; let scope = store.scope
    busy = true; error = nil; defer { busy = false }
    do {
      let result: [RoutineResultRow] = try await api.get(path)
      guard !Task.isCancelled, store.scope == scope, store.api === api else { return }
      rows = result
      if !rows.contains(where: { $0.id == selected }) { selected = rows.first?.id ?? "" }
      else { await loadOutput() }
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

struct GroupMember: Codable { var member_id: String; var profile: String; var handle: String; var display_name: String? }
struct GroupRoom: Decodable, Identifiable { var room_id: String; var name: String; var members: [GroupMember]; var id: String { room_id } }
struct GroupCatalog: Decodable { var supported: Bool; var canSend: Bool; var reason: String?; var rooms: [GroupRoom] }
struct GroupCreated: Decodable { var room: GroupRoom }
struct GroupCreate: Codable { var requestId: String; var name: String; var botIds: [String] }
struct GroupSend: Codable { var requestId: String; var threadId: String; var text: String }
struct GroupAccepted: Decodable { var accepted: Bool }
struct GroupApproved: Decodable { var approved: Bool }
struct GroupEventPayload: Decodable { var text: String?; var thread_id: String?; var member_id: String? }
struct GroupEvent: Decodable, Identifiable {
  var event_id: String; var seq: Int; var kind: String; var created_at: Double; var payload: GroupEventPayload
  var id: String { event_id }
}
struct GroupPage: Decodable { var events: [GroupEvent]; var cursor: Int; var has_more: Bool }
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
  var body: some View {
    List {
      if let reason = catalog?.reason { Section { Text(reason).font(.footnote).foregroundStyle(.secondary) } }
      if let error { Section { ErrorBanner(message: error); Button("Retry") { Task { await load() } } } }
      if catalog == nil && error == nil { Section { ProgressView("Checking Hermes group chats…") } }
      if let catalog, catalog.supported && catalog.rooms.isEmpty {
        Section { Text("No group chats yet. Tap + to let two to six assistants discuss a task together.").foregroundStyle(.secondary) }
      }
      if let rooms = catalog?.rooms, !rooms.isEmpty {
        Section {
          ForEach(rooms) { room in
            NavigationLink { GroupConversationView(room: room, canSend: catalog?.canSend == true) } label: {
              VStack(alignment: .leading, spacing: 3) { Text(room.name); Text("\(room.members.count) assistants").font(.caption).foregroundStyle(.secondary) }
            }
          }
        } footer: { Text("Two to six assistants in one conversation.") }
      }
    }.householdListBackground().navigationTitle("Group chats").refreshable { await load() }
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button { creating = true } label: { Image(systemName: "plus") }
            .accessibilityLabel("New group").disabled(catalog?.canSend != true || !store.connected)
        }
      }
      .onAppear { Task { await load() } }
      .onChange(of: store.scope) { _, _ in catalog = nil; Task { await load() } }
      .sheet(isPresented: $creating, onDismiss: { Task { await load() } }) { NavigationStack { GroupCreateView() }.environmentObject(store) }
  }
  private func load() async {
    guard let api = store.api else { return }; let scope = store.scope
    let id = UUID(); loadId = id
    do { let value: GroupCatalog = try await api.get("/groups"); guard !Task.isCancelled, loadId == id, store.scope == scope, store.api === api else { return }; catalog = value; error = nil }
    catch { if !Task.isCancelled, loadId == id, store.scope == scope { self.error = error.localizedDescription } }
  }
}
struct GroupCreateView: View {
  @EnvironmentObject private var store: AppStore
  @Environment(\.dismiss) private var dismiss
  @State private var name = ""
  @State private var botIds: Set<String> = []
  @State private var pending: GroupCreate?
  @State private var error: String?
  @State private var busy = false
  private var key: String { "group.create.\(store.scope ?? "")" }
  var body: some View {
    Form {
      if let error { ErrorBanner(message: error) }
      if let pending { Text("Check the saved request for \(pending.name). Hermes may already have created the room.") }
      else {
        TextField("Group name", text: $name)
        Section("Choose 2–6 assistants") {
          ForEach((store.bootstrap?.bots ?? []).filter { !["all", "everyone"].contains($0.id.lowercased()) }) { bot in
            Toggle(bot.name, isOn: Binding(get: { botIds.contains(bot.id) }, set: { if $0 { botIds.insert(bot.id) } else { botIds.remove(bot.id) } }))
              .disabled(botIds.count >= 6 && !botIds.contains(bot.id))
          }
        }
      }
      Button(pending == nil ? "Create group" : "Retry saved group request") { Task { await create() } }.disabled(busy || !store.connected || pending == nil && (botIds.count < 2 || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
    }.navigationTitle("New group").toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
      .task { if let data = UserDefaults.standard.data(forKey: key) { pending = try? JSONDecoder().decode(GroupCreate.self, from: data) } }
  }
  private func create() async {
    guard let api = store.api else { return }; let scope = store.scope
    let input = pending ?? GroupCreate(requestId: UUID().uuidString.lowercased(), name: String(name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(100)), botIds: botIds.sorted())
    busy = true; defer { busy = false }; error = nil
    do {
      UserDefaults.standard.set(try JSONEncoder().encode(input), forKey: key); pending = input
      let _: GroupCreated = try await api.write("/groups", input)
      guard store.scope == scope, store.api === api else { return }
      UserDefaults.standard.removeObject(forKey: key); pending = nil; dismiss()
    } catch { if store.scope == scope { self.error = error.localizedDescription } }
  }
}
struct GroupConversationView: View {
  var room: GroupRoom; var canSend: Bool
  @EnvironmentObject private var store: AppStore
  @Environment(\.colorScheme) private var scheme
  @State private var state: GroupState?
  @State private var events: [GroupEvent] = []
  @State private var cursor = 0
  @State private var draft = ""
  @State private var threadId = ""
  @State private var pending: GroupSend?
  @State private var error: String?
  @State private var busy = false
  private var path: String { "/groups/\(APIClient.component(room.id))" }
  private var key: String { "group.send.\(store.scope ?? ""):\(room.id)" }
  private var status: String {
    state?.driver_status?.blocked == true ? "Discussion needs attention." : state?.driver_status?.working == true ? "Assistants are discussing…" : "Ready for a topic."
  }
  var body: some View {
    List {
      Section { Text(room.members.map { "\($0.display_name ?? $0.profile) (@\($0.handle))" }.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary)
        if let error { ErrorBanner(message: error) }
        if state == nil && error == nil { ProgressView("Opening group…") }
      }
      ForEach(events.filter { ["message.user", "message.member"].contains($0.kind) }) { event in
        VStack(alignment: .leading, spacing: 6) {
          HStack(alignment: .firstTextBaseline) {
            Text(event.kind == "message.user" ? "Household member" : room.members.first { $0.member_id == event.payload.member_id }?.display_name ?? event.payload.member_id ?? "Assistant").font(.caption.bold())
            Spacer()
            Text(Date(timeIntervalSince1970: event.created_at).formatted(date: .abbreviated, time: .shortened)).font(.caption2).foregroundStyle(.secondary)
          }
          MarkdownView(text: event.payload.text ?? "")
          if let thread = event.payload.thread_id {
            Button("Reply in thread") { threadId = thread }.font(.caption).buttonStyle(.borderless).disabled(pending != nil || !canSend)
          }
        }
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
    .navigationTitle(room.name).refreshable { await load() }.task(id: "\(store.scope ?? ""):\(room.id)") {
      state = nil; events = []; cursor = 0
      draft = UserDefaults.standard.string(forKey: key + ":draft") ?? ""
      if let data = UserDefaults.standard.data(forKey: key) { pending = try? JSONDecoder().decode(GroupSend.self, from: data) }
      while !Task.isCancelled { await load(); do { try await Task.sleep(for: .seconds(3)) } catch { return } }
    }
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
          TextField("Message the group… use @handle for one assistant", text: $draft, axis: .vertical).lineLimit(1...6)
            .padding(12).background(Palette.raised(scheme), in: RoundedRectangle(cornerRadius: 14))
            .accessibilityIdentifier("groupComposer").onChange(of: draft) { _, value in UserDefaults.standard.set(value, forKey: key + ":draft") }
          let ready = !busy && canSend && store.connected && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
          Button { Task { await send() } } label: {
            Image(systemName: busy ? "hourglass" : "arrow.up").font(.headline).frame(width: 44, height: 44)
              .foregroundStyle(ready ? Palette.surface(scheme) : Palette.muted)
              .background(ready ? Palette.accent : Palette.line, in: Circle()).contentShape(Circle())
          }.buttonStyle(.plain).disabled(!ready).accessibilityLabel("Send to group")
        }
      }
      Text(status).font(.caption).foregroundStyle(.secondary)
    }.padding(12).background(.regularMaterial)
  }
  private func load() async {
    guard let api = store.api else { return }; let scope = store.scope
    do {
      let value: GroupState = try await api.get(path)
      let page: GroupPage = try await api.get("\(path)/log?since=\(cursor)")
      guard !Task.isCancelled, store.scope == scope, store.api === api else { return }
      state = value; error = nil; let known = Set(events.map(\.id)); events += page.events.filter { !known.contains($0.id) }; events.sort { $0.seq < $1.seq }; cursor = page.cursor
    } catch { if !Task.isCancelled, store.scope == scope { self.error = error.localizedDescription } }
  }
  private func send() async {
    guard let api = store.api else { return }; let scope = store.scope
    let input = pending ?? GroupSend(requestId: UUID().uuidString.lowercased(), threadId: threadId.isEmpty ? UUID().uuidString.lowercased() : threadId, text: String(draft.trimmingCharacters(in: .whitespacesAndNewlines).prefix(16000)))
    busy = true; error = nil; defer { busy = false }
    do {
      UserDefaults.standard.set(try JSONEncoder().encode(input), forKey: key); pending = input
      let receipt: GroupAccepted = try await api.write(path + "/messages", input)
      guard store.scope == scope, store.api === api else { return }
      guard receipt.accepted else { throw NSError(domain: "Group chat", code: 1, userInfo: [NSLocalizedDescriptionKey: "Hermes did not confirm this message."]) }
      UserDefaults.standard.removeObject(forKey: key); UserDefaults.standard.removeObject(forKey: key + ":draft"); pending = nil; draft = ""; threadId = ""; await load()
    } catch { if store.scope == scope { self.error = error.localizedDescription } }
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
