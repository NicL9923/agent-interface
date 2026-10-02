import SwiftUI

struct TodayMessage: Decodable { var id: String; var text: String; var createdAt: String?; var files: [FileRef]? }
struct TodayItem: Decodable, Identifiable {
  var botId: String; var botName: String; var activity: Activity
  var approvals: [Approval]; var attention: [Attention]; var latestMessage: TodayMessage?
  var files: [FileRef]; var error: String?
  var id: String { botId }
}
struct TodayEvent: Decodable, Identifiable { var id: String; var botId: String; var kind: String; var title: String; var body: String?; var occurredAt: String; var routineId: String? }
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
  @State private var value: TodayOverview?
  @State private var error: String?
  @State private var busy = false
  @State private var loadId = UUID()
  var body: some View {
    List {
      if let error { Section { ErrorBanner(message: error); Button("Retry overview") { Task { await load() } } } }
      if value == nil && error == nil { Section { ProgressView("Checking your assistants…") } }
      if let value, !value.events.isEmpty {
        Section("Since you were away") {
          ForEach(value.events) { event in
            Button { openBot(); Task { await store.select(event.botId); if let routineId = event.routineId { store.routineResult = RoutineResultDestination(botId: event.botId, routineId: routineId) } } } label: {
              VStack(alignment: .leading, spacing: 4) {
                Text(event.title).font(.headline)
                if let body = event.body { Text(body).font(.footnote).foregroundStyle(.secondary) }
                if let date = ServerDate.parse(event.occurredAt) { Text(date.formatted(date: .abbreviated, time: .shortened)).font(.caption).foregroundStyle(.secondary) }
              }
            }
          }
        }
      }
      if let upcoming = value?.upcoming, !upcoming.isEmpty { Section("Scheduled next") {
        ForEach(upcoming) { row in Button { openBot();Task { await store.select(row.botId);store.routineResult=RoutineResultDestination(botId:row.botId,routineId:row.id) } } label: { VStack(alignment:.leading) { Text(row.name);if let date=row.nextRunAt.flatMap(ServerDate.parse) { Text(date.formatted()).font(.caption).foregroundStyle(.secondary) } } } }
      } }
      ForEach(value?.items ?? []) { item in
        Section {
          Button {
            openBot(); Task { await store.select(item.botId) }
          } label: {
            HStack {
              VStack(alignment: .leading, spacing: 6) {
                Text(item.botName).font(.headline)
                ActivityLabel(state: item.activity.state)
                if let detail = item.activity.detail { Text(detail).font(.caption).foregroundStyle(.secondary) }
              }
              Spacer(); Image(systemName: "chevron.right")
            }
          }.accessibilityIdentifier("today.bot.\(item.botId)")
          if !item.approvals.isEmpty { Label("\(item.approvals.count) decision(s) waiting", systemImage: "hand.raised").foregroundStyle(Palette.attention) }
          ForEach(item.attention) { attention in Text(attention.title).font(.subheadline) }
          if let message = value?.recentMessage(item) { MarkdownView(text: String(message.text.prefix(800))).font(.footnote) }
          ForEach(item.files) { file in FileAttachmentView(file: file) }
          if let error = item.error { ErrorBanner(message: error) }
        }
      }
      if let value, value.items.isEmpty { Section { Text("No assistant work to show yet.").foregroundStyle(.secondary) } }
      if let value, !value.unavailableBots.isEmpty { Section { Text("Some assistants could not be checked. Pull to refresh for current status.").foregroundStyle(.secondary) } }
      if let value {
        Section {
          if value.hasMore { Text("More results are waiting. Mark this page caught up to see the next page.").font(.footnote).foregroundStyle(.secondary) }
          Button(value.hasMore ? "Mark page caught up" : "Mark caught up") { markCaughtUp(value) }.disabled(busy || !store.connected).accessibilityIdentifier("markTodaySeen")
        } footer: { Text("Checked \(ServerDate.parse(value.generatedAt)?.formatted(date: .omitted, time: .shortened) ?? value.generatedAt)") }
      }
    }.householdListBackground().accessibilityIdentifier("todayOverview").navigationTitle("Today").refreshable { await load() }.onAppear { Task { await load() } }
      .onChange(of: store.scope) { _, _ in value = nil; Task { await load() } }
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
