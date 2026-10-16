import SwiftUI

struct TodayMessage: Decodable { var id: String; var text: String; var createdAt: String?; var files: [FileRef]? }
struct TodayItem: Decodable, Identifiable {
  var botId: String; var botName: String; var activity: Activity
  var approvals: [Approval]; var attention: [Attention]; var latestMessage: TodayMessage?
  var files: [FileRef]; var error: String?
  var id: String { botId }
}
struct TodayEvent: Decodable, Identifiable { var id: String; var botId: String; var kind: String; var title: String; var body: String?; var occurredAt: String; var routineId: String? }
/// Mirrors src/shared/event-copy.ts. Approval details stay in their conversation.
enum EventCopy {
  static func excerpt(_ source: String?, limit: Int = 180) -> String {
    var text = source ?? ""
    for (pattern, replacement) in [
      (#"(?s)```.*?(```|$)"#, " "),
      (#"!?\[([^\]]*)\]\([^)]*\)"#, "$1"),
      (#"(?m)^\s{0,3}(#{1,6}|[-*+]|\d+[.)]|>)\s+"#, ""),
      (#"(\*\*|__|`|~~)"#, ""), (#"\s+"#, " "),
    ] { text = text.replacingOccurrences(of: pattern, with: replacement, options: .regularExpression) }
    text = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard text.count > limit else { return text }
    let cut = String(text.prefix(limit))
    let lastSpace = cut.lastIndex(of: " ").map { cut.distance(from: cut.startIndex, to: $0) } ?? 0
    return String(cut.prefix(max(lastSpace, Int(Double(limit) * 0.6))))
      .trimmingCharacters(in: .whitespacesAndNewlines.union(CharacterSet(charactersIn: ",;:.–-"))) + "…"
  }
  static func headline(_ event: TodayEvent) -> String {
    // Avoid exposing commands or credentials in the overview, including custom approval titles.
    if event.kind == "approval" { return "Needs your approval to continue." }
    let body = excerpt(event.body)
    let generic = event.title.range(of: #"^(Hermes (completed|failed|interrupted)|Approval requested)$"#, options: .regularExpression) != nil
    if !generic { return body.isEmpty ? excerpt(event.title) : excerpt(event.title, limit: 80) + ": " + body }
    switch event.kind {
    case "failed": return body.isEmpty ? "Couldn't finish. Open the chat to see what happened." : "Couldn't finish: " + body
    case "interrupted": return body.isEmpty ? "Stopped before finishing. Review it before retrying." : body
    default: return body.isEmpty ? "Finished. Open the chat for the reply." : body
    }
  }
}
struct TodayOverview: Decodable {
  var generatedAt: String; var since: String; var items: [TodayItem]; var events: [TodayEvent]; var unavailableBots: [String]; var frontier: String; var hasMore: Bool; var upcoming: [Routine]?
  func recentMessage(_ item: TodayItem) -> TodayMessage? {
    guard let message = item.latestMessage, let date = message.createdAt.flatMap(ServerDate.parse), let since = ServerDate.parse(since), date > since else { return nil }
    return message
  }
}
struct TodayView: View {
  var openBot: () -> Void
  @EnvironmentObject private var store: AppStore
  @Environment(\.colorScheme) private var scheme
  @State private var value: TodayOverview?
  @State private var error: String?
  @State private var busy = false
  @State private var loadId = UUID()
  var body: some View {
    List {
      Group {
      if let error { Section { ErrorBanner(message: error); Button("Retry overview") { Task { await load() } } } }
      if value == nil && error == nil { Section { ProgressView("Checking your assistants…") } }
      if let value {
        Section {
          ViewThatFits(in: .horizontal) {
            HStack(spacing: 20) { counts(value) }
            VStack(alignment: .leading, spacing: 10) { counts(value) }
          }.accessibilityElement(children: .combine).accessibilityLabel("Household activity")
        }
        Section("Needs your attention") {
          if attention(value).isEmpty { Text("No pending requests in the assistants we could check.").foregroundStyle(.secondary) }
          ForEach(attention(value)) { item in
            assistantRow(item, detail: item.approvals.first { $0.status == "pending" }?.title ?? item.attention.first?.title ?? item.activity.detail ?? item.activity.state.label)
          }
        }
        Section {
          if let since = ServerDate.parse(value.since) { Text("Since \(since.formatted(date: .abbreviated, time: .shortened))").font(.caption).foregroundStyle(.secondary) }
          if value.events.isEmpty { Text("No new recorded results yet.").foregroundStyle(.secondary) }
          ForEach(value.events) { event in
            Button { open(event.botId, routine: event.routineId) } label: {
              VStack(alignment: .leading, spacing: 4) {
                Text(store.bootstrap?.bots.first { $0.id == event.botId }?.name ?? "Assistant").font(.headline).foregroundStyle(Color.primary)
                Text(EventCopy.headline(event)).font(.subheadline).foregroundStyle(.secondary).lineLimit(3)
                if let date = ServerDate.parse(event.occurredAt) { Text(date.formatted(date: .abbreviated, time: .shortened)).font(.caption).foregroundStyle(.secondary) }
              }
            }.accessibilityIdentifier("today.event." + event.id)
          }
          if value.hasMore { Text("More results are waiting. Mark this page caught up to see the next page.").font(.footnote).foregroundStyle(.secondary) }
          Button(value.hasMore ? "Mark page caught up" : "Mark caught up") { markCaughtUp(value) }
            .disabled(busy || !store.connected).accessibilityIdentifier("markTodaySeen")
        } header: { Text("Since you were away") }
        if let upcoming = value.upcoming, !upcoming.isEmpty {
          Section("Scheduled next") {
            ForEach(upcoming) { row in
              Button { open(row.botId, routine: row.id) } label: {
                VStack(alignment: .leading, spacing: 4) {
                  Text(row.name).font(.headline).foregroundStyle(Color.primary)
                  Text(store.bootstrap?.bots.first { $0.id == row.botId }?.name ?? "Assistant").font(.caption).foregroundStyle(.secondary)
                  if let date = row.nextRunAt.flatMap(ServerDate.parse) { Text(date.formatted()).font(.caption).foregroundStyle(.secondary) }
                }
              }
            }
          }
        }
        if !active(value).isEmpty {
          Section("At work") { ForEach(active(value)) { item in assistantRow(item, detail: item.activity.detail ?? item.activity.state.label) } }
        }
        if value.items.contains(where: { !$0.files.isEmpty }) {
          Section("Recent files") {
            ForEach(value.items.filter { !$0.files.isEmpty }) { item in
              Button { open(item.botId) } label: {
                VStack(alignment: .leading, spacing: 4) {
                  Text(item.botName).font(.headline).foregroundStyle(Color.primary)
                  Text(item.files.suffix(3).map(\.name).joined(separator: " · ")).font(.subheadline).foregroundStyle(.secondary)
                }
              }
            }
          }
        }
        ForEach(value.items.filter { $0.error != nil }) { item in
          Section(item.botName) { ErrorBanner(message: item.error!) }
        }
        if !value.unavailableBots.isEmpty {
          Section { Text("Couldn't check \(value.unavailableBots.count) assistant(s). Their current activity is unknown.").foregroundStyle(.secondary) }
        }
        Section {
          Text("Checked \(ServerDate.parse(value.generatedAt)?.formatted(date: .omitted, time: .shortened) ?? value.generatedAt) · updates every 30 seconds").font(.caption).foregroundStyle(.secondary)
        }
      }
      }.listRowBackground(Palette.raised(scheme))
    }.listSectionSpacing(18).householdListBackground().accessibilityIdentifier("todayOverview").navigationTitle("Today").navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Refresh") { Task { await load() } }.disabled(busy) } }
      .refreshable { await load() }
      // Split-view reparenting can cancel a view task during a phone push. The initial
      // read belongs to this account/load ID and may finish across that transition.
      .onAppear { Task { await load() } }
      .onChange(of: store.scope) { _, _ in value = nil; Task { await load() } }
      .task(id: store.scope) {
        while !Task.isCancelled {
          do { try await Task.sleep(for: .seconds(30)) } catch { return }
          await load()
        }
      }
  }
  @ViewBuilder private func counts(_ value: TodayOverview) -> some View {
    Text("\(attention(value).count)").bold() + Text(" need you")
    Text("\(active(value).count)").bold() + Text(" at work")
    Text("\(value.events.filter { $0.kind == "completed" }.count)").bold() + Text(value.hasMore ? " finished on this page" : " finished since your last visit")
  }
  private func attention(_ value: TodayOverview) -> [TodayItem] {
    value.items.filter { $0.error == nil && ($0.approvals.contains { $0.status == "pending" } || !$0.attention.isEmpty || [.blocked, .interrupted, .failed].contains($0.activity.state)) }
  }
  private func active(_ value: TodayOverview) -> [TodayItem] {
    value.items.filter { $0.error == nil && [.thinking, .working, .waiting].contains($0.activity.state) }
  }
  private func assistantRow(_ item: TodayItem, detail: String) -> some View {
    Button { open(item.botId) } label: {
      HStack(spacing: 12) {
        AvatarView(avatar: store.bootstrap?.bots.first { $0.id == item.botId }?.avatar ?? AvatarConfig(), state: item.activity.state, size: 42, name: item.botName, forceReducedMotion: true)
        VStack(alignment: .leading, spacing: 4) {
          Text(item.botName).font(.headline).foregroundStyle(Color.primary)
          Text(detail).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
        }
        Spacer(minLength: 0); Image(systemName: "chevron.right").font(.caption).foregroundStyle(.secondary)
      }
    }.accessibilityIdentifier("today.bot.\(item.botId)")
  }
  private func open(_ bot: String, routine: String? = nil) {
    openBot()
    Task { await store.select(bot); if let routine { store.routineResult = RoutineResultDestination(botId: bot, routineId: routine) } }
  }
  private func load() async {
    guard let api = store.api, let scope = store.scope else { return }
    let id = UUID(); loadId = id; busy = true; error = nil
    defer { if loadId == id { busy = false } }
    do {
      let overview: TodayOverview = try await api.get("/today")
      guard !Task.isCancelled, loadId == id, store.scope == scope, store.api === api else { return }
      value = overview
    } catch is CancellationError {} catch { if loadId == id, store.scope == scope { self.error = error.localizedDescription } }
  }
  private func markCaughtUp(_ snapshot: TodayOverview) {
    guard let api = store.api else { return }; let scope = store.scope
    busy = true; error = nil
    Task { do { try await api.markTodaySeen(snapshot); guard store.scope == scope, store.api === api else { return }; busy = false; await load() } catch { busy = false; if store.scope == scope { self.error = error.localizedDescription } } }
  }
}

extension APIClient {
  func markTodaySeen(_ snapshot: TodayOverview) async throws {
    let _: [String: Bool] = try await write("/today/seen", ["seenAt": snapshot.generatedAt, "frontier": snapshot.frontier], method: "PUT")
  }
}

struct MemoryEntry: Codable, Identifiable { var id: String; var text: String }
struct MemoryDocument: Decodable, Identifiable {
  var target: String; var label: String; var revision: String; var enabled: Bool
  var entries: [MemoryEntry]; var charLimit: Int; var charCount: Int
  var id: String { target }
}
struct ProfileMemory: Decodable {
  var botId: String; var profile: String; var scope: String; var owner: String; var documents: [MemoryDocument]; var notice: String
  mutating func acceptSavedDocument(_ target: String, from refreshed: ProfileMemory) {
    guard let index = documents.firstIndex(where: { $0.target == target }), let updated = refreshed.documents.first(where: { $0.target == target }) else { return }
    // Unsaved documents retain their original revision so concurrent edits still conflict.
    documents[index] = updated
  }
}
struct MemorySave: Encodable { var revision: String; var entries: [MemoryEntry] }
struct MemoryDrawer: View {
  var botId: String
  @EnvironmentObject private var store: AppStore
  @State private var value: ProfileMemory?
  @State private var drafts: [String: [MemoryEntry]] = [:]
  @State private var busy = false
  @State private var error: String?
  @State private var notice: String?
  var body: some View {
    Form {
      Section {
        Text("What I remember").font(.headline)
        if let value {
          Text("Hermes profile: \(value.profile)")
          Text("These facts apply to assistants using this Hermes profile. Household members can inspect and edit them.").font(.footnote).foregroundStyle(.secondary)
          Text(value.notice).font(.footnote).foregroundStyle(.secondary)
        }
      }
      if let error { Section { ErrorBanner(message: error); Button("Reload memory") { Task { await load() } } } }
      if let notice { Section { Text(notice).foregroundStyle(Palette.accent) } }
      if value == nil && busy { Section { ProgressView("Reading Hermes memory…") } }
      ForEach(value?.documents ?? []) { document in
        Section(document.label) {
          Text("\(document.charCount) / \(document.charLimit) characters").font(.caption).foregroundStyle(.secondary)
          if !document.enabled { Text("This memory document is disabled in Hermes.").foregroundStyle(.secondary) }
          ForEach(drafts[document.target] ?? []) { entry in
            VStack(alignment: .leading) {
              TextField("Remembered fact", text: Binding(get: { drafts[document.target]?.first { $0.id == entry.id }?.text ?? "" }, set: { text in
                guard let index = drafts[document.target]?.firstIndex(where: { $0.id == entry.id }) else { return }; drafts[document.target]?[index].text = text
              }), axis: .vertical)
              Button("Forget this fact", role: .destructive) { drafts[document.target]?.removeAll { $0.id == entry.id } }.font(.caption)
            }
          }
          if document.entries.isEmpty { Text("No facts saved here.").foregroundStyle(.secondary) }
          Button("Save \(document.label)") { save(document) }.disabled(!document.enabled || busy || !store.connected)
          Text("Forgetting takes effect when you save this document.").font(.caption).foregroundStyle(.secondary)
        }
      }
    }.disabled(busy).task(id: "\(store.scope ?? ""):\(botId)") { value = nil; drafts = [:]; await load() }
  }
  private func accept(_ result: ProfileMemory) { value = result; drafts = Dictionary(uniqueKeysWithValues: result.documents.map { ($0.target, $0.entries) }) }
  private func load() async {
    guard let api = store.api else { return }; let scope = store.scope
    busy = true; error = nil; defer { busy = false }
    do { let result: ProfileMemory = try await api.get("/bots/\(APIClient.component(botId))/memory"); guard store.scope == scope, store.api === api else { return }; accept(result) }
    catch { if store.scope == scope { self.error = error.localizedDescription } }
  }
  private func save(_ document: MemoryDocument) {
    guard let api = store.api else { return }; let scope = store.scope
    busy = true; error = nil; notice = nil
    let payload = MemorySave(revision: document.revision, entries: drafts[document.target] ?? [])
    Task { defer { busy = false }; do {
      let result: ProfileMemory = try await api.write("/bots/\(APIClient.component(botId))/memory/\(APIClient.component(document.target))", payload, method: "PATCH")
      guard store.scope == scope, store.api === api else { return }; value?.acceptSavedDocument(document.target, from: result); drafts[document.target] = result.documents.first { $0.target == document.target }?.entries ?? []; notice = "Memory saved in Hermes."
    } catch { if store.scope == scope { self.error = error.localizedDescription } } }
  }
}

struct RoutineTemplate: Decodable, Identifiable { var id: String; var name: String; var prompt: String; var schedule: String; var description: String }
struct SchedulePreview: Decodable { var botId: String; var schedule: String; var timezone: String; var nextRuns: [String]; var kind: String }
struct RoutineRunReceipt: Codable { var requestId: String; var routineId: String; var botId: String; var status: String; var message: String?; var startedAt: String; var finishedAt: String? }
struct RoutinePreviewControls: View {
  @Binding var routine: Routine
  @Binding var previewValid: Bool
  @EnvironmentObject private var store: AppStore
  @State private var templates: [RoutineTemplate] = []
  @State private var preview: SchedulePreview?
  @State private var receipt: RoutineRunReceipt?
  @State private var busy = false
  @State private var error: String?
  @State private var runConfirm = false
  @State private var retrySameRun = false
  private var receiptKey: String { "routine.run.\(store.scope ?? "").\(routine.id)" }
  var body: some View {
    Section("Routine recipes") {
      ForEach(templates) { template in
        Button { routine.name = template.name; routine.prompt = template.prompt; routine.schedule = template.schedule; routine.enabled = false; preview = nil; previewValid = false } label: { VStack(alignment: .leading) { Text(template.name); Text(template.description).font(.caption).foregroundStyle(.secondary) } }.accessibilityIdentifier("routineTemplate.\(template.id)")
      }
      Text("Recipes start paused. Review the schedule and recipients before enabling.").font(.caption).foregroundStyle(.secondary)
    }.task(id: "\(store.scope ?? ""):\(routine.id)") {
      if let data = UserDefaults.standard.data(forKey: receiptKey) { receipt = try? JSONDecoder().decode(RoutineRunReceipt.self, from: data) }
      guard let api = store.api else { return }; let scope = store.scope
      do { let values: [RoutineTemplate] = try await api.get("/routines/templates"); guard store.scope == scope, store.api === api else { return }; templates = values } catch { if store.scope == scope { self.error = error.localizedDescription } }
    }
    Section("Schedule preview") {
      Button(busy ? "Checking…" : "Show next run times") { checkSchedule() }.disabled(busy || routine.schedule.isEmpty || !store.connected)
      if let preview {
        LabeledContent("Timezone", value: preview.timezone)
        ForEach(preview.nextRuns, id: \.self) { date in Text(ServerDate.parse(date)?.formatted(date: .abbreviated, time: .shortened) ?? date) }
      }
      if let error { ErrorBanner(message: error) }
    }.onChange(of: routine.schedule) { _, _ in preview = nil; previewValid = false }
    if !routine.id.isEmpty {
      Section("Try once") {
        NavigationLink("View results") { RoutineResultsView(botId: routine.botId, routineId: routine.id) }
        Text("Runs this saved routine immediately with its saved instructions and recipients. It can use the assistant's enabled tools.").font(.footnote).foregroundStyle(.secondary)
        Text("Hermes may move the next run or finish a one-time routine. Paused recurring routines stay paused.").font(.footnote).foregroundStyle(.secondary)
        if let receipt {
          Text(receipt.message ?? "Run status: \(receipt.status)")
          if ["accepted", "uncertain"].contains(receipt.status) {
            Button("Check this run") { checkRun(receipt.requestId) }.disabled(busy || !store.connected)
            if retrySameRun { Button("Review and retry same run request") { runConfirm = true }.disabled(busy || !store.connected) }
          }
          else { Button("Try once again") { runConfirm = true }.disabled(busy || !store.connected) }
        } else { Button("Try once") { runConfirm = true }.disabled(busy || !store.connected) }
      }.confirmationDialog(retrySameRun ? "The original request may still arrive. Retry using the same saved request ID?" : "Run this saved routine now?", isPresented: $runConfirm, titleVisibility: .visible) { Button(retrySameRun ? "Retry same request" : "Run once now") { startRun() } }
    }

  }
  private func checkSchedule() {
    guard let api = store.api else { return }; let scope = store.scope; let schedule = routine.schedule
    busy = true; error = nil
    Task { defer { busy = false }; do { let value: SchedulePreview = try await api.write("/routines/preview", ["botId": routine.botId, "schedule": schedule]); guard store.scope == scope, store.api === api, routine.schedule == schedule else { return }; preview = value; previewValid = true } catch { if store.scope == scope { self.error = error.localizedDescription } } }
  }
  private func saveReceipt(_ value: RoutineRunReceipt, key: String) { receipt = value; if let data = try? JSONEncoder().encode(value) { UserDefaults.standard.set(data, forKey: key) } }
  private func startRun() {
    guard let api = store.api else { return }; let scope = store.scope; let key = receiptKey
    let requestId = retrySameRun ? (receipt?.requestId ?? UUID().uuidString) : UUID().uuidString
    retrySameRun = false
    let pending = RoutineRunReceipt(requestId: requestId, routineId: routine.id, botId: routine.botId, status: "uncertain", message: "Checking admission. This run will not be automatically retried.", startedAt: ISO8601DateFormatter().string(from: Date()))
    saveReceipt(pending, key: key); busy = true; error = nil
    Task { defer { busy = false }; do { let value: RoutineRunReceipt = try await api.write("/routines/\(APIClient.component(routine.id))/run", ["requestId": requestId]); guard store.scope == scope, store.api === api else { return }; saveReceipt(value, key: key) } catch { if store.scope == scope {
      self.error = error.localizedDescription
      if let failure = error as? APIError, (400..<500).contains(failure.status) {
        var rejected = pending; rejected.status = "failed"; rejected.message = failure.message; saveReceipt(rejected, key: key)
      }
    } } }
  }
  private func checkRun(_ id: String) {
    guard let api = store.api else { return }; let scope = store.scope; let key = receiptKey
    busy = true; error = nil
    Task { defer { busy = false }; do { let value: RoutineRunReceipt = try await api.get("/routines/\(APIClient.component(routine.id))/runs/\(APIClient.component(id))"); guard store.scope == scope, store.api === api else { return }; saveReceipt(value, key: key); retrySameRun = false } catch { if store.scope == scope {
      self.error = error.localizedDescription
      if (error as? APIError)?.status == 404 { retrySameRun = true }
    } } }
  }
}
