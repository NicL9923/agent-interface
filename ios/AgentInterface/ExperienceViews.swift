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
          HStack(alignment: .top, spacing: 14) {
            WrapLayout(spacing: 14, lineSpacing: 6) { counts(value) }.frame(maxWidth: .infinity, alignment: .leading)
            Button("Refresh") { Task { await load() } }.buttonStyle(.bordered).controlSize(.small)
              .disabled(busy).accessibilityIdentifier("refreshToday")
          }
        }
        Section("Needs your attention") {
          if attention(value).isEmpty { Text("No pending requests in the assistants we could check.").foregroundStyle(.secondary) }
          ForEach(attention(value)) { item in
            assistantRow(item, detail: item.approvals.first { $0.status == "pending" }?.title ?? item.attention.first?.title ?? item.activity.detail ?? item.activity.state.label)
          }
        }
        Section {
          if let since = ServerDate.parse(value.since) { Text("Since \(When.format(since, inline: true))").font(.footnote).foregroundStyle(Palette.muted) }
          if value.events.isEmpty { Text("No new recorded results yet.").foregroundStyle(.secondary) }
          ForEach(value.events) { event in
            Button { open(event.botId, routine: event.routineId) } label: {
              chevronRow {
                Text(store.bootstrap?.bots.first { $0.id == event.botId }?.name ?? "Assistant").font(.headline).foregroundStyle(Color.primary)
                Text(EventCopy.headline(event)).font(.subheadline).foregroundStyle(Palette.muted).lineLimit(3)
                Text(When.format(event.occurredAt)).font(.caption).foregroundStyle(Palette.muted)
              }
            }.accessibilityIdentifier("today.event." + event.id)
          }
          if value.hasMore { Text("More recorded results are waiting. Mark this page caught up to load the next page.").font(.footnote).foregroundStyle(Palette.muted) }
          Button(value.hasMore ? "Mark this page caught up" : "Mark caught up") { markCaughtUp(value) }
            .disabled(busy || !store.connected).accessibilityIdentifier("markTodaySeen")
        } header: { Text("Since you were away") }
        if let upcoming = value.upcoming, !upcoming.isEmpty {
          Section("Scheduled next") {
            ForEach(upcoming) { row in
              Button { open(row.botId, routine: row.id) } label: {
                chevronRow {
                  Text(row.name).font(.headline).foregroundStyle(Color.primary)
                  Text([store.bootstrap?.bots.first { $0.id == row.botId }?.name, row.nextRunAt.map { When.format($0) }].compactMap { $0 }.joined(separator: " · "))
                    .font(.subheadline).foregroundStyle(Palette.muted)
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
                chevronRow {
                  Text(item.botName).font(.headline).foregroundStyle(Color.primary)
                  Text(item.files.suffix(3).map(\.name).joined(separator: " · ")).font(.subheadline).foregroundStyle(Palette.muted)
                }
              }
            }
          }
        }
        ForEach(value.items.filter { $0.error != nil }) { item in
          Section(item.botName) { ErrorBanner(message: item.error!) }
        }
        if !value.unavailableBots.isEmpty {
          Section { Text("Couldn't check \(value.unavailableBots.count) assistant\(value.unavailableBots.count == 1 ? "" : "s"). Their current activity is unknown.").foregroundStyle(.secondary) }
        }
        Section {
          Text("Checked \(When.format(value.generatedAt, inline: true)) · updates every 30 seconds").font(.caption).foregroundStyle(.secondary)
        }
      }
      }.listRowBackground(Palette.raised(scheme))
    }.listSectionSpacing(18).householdListBackground().accessibilityIdentifier("todayOverview").viewHeader("Today", "Your assistants, at a glance")
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
    count(attention(value).count, "need you")
    count(active(value).count, "at work")
    count(value.events.filter { $0.kind == "completed" }.count, value.hasMore ? "finished on this page" : "finished since your last visit")
  }
  private func count(_ number: Int, _ label: String) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 6) {
      Text("\(number)").font(.title2.bold())
      Text(label).font(.footnote).foregroundStyle(Palette.muted)
    }.accessibilityElement(children: .combine)
  }
  private func chevronRow<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
    HStack(spacing: 12) {
      VStack(alignment: .leading, spacing: 4) { content() }.frame(maxWidth: .infinity, alignment: .leading)
      Image(systemName: "chevron.right").font(.caption).foregroundStyle(Palette.muted)
    }
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

struct MemoryEntry: Codable, Identifiable, Equatable { var id: String; var text: String }
struct MemoryDocument: Decodable, Identifiable {
  var target: String; var label: String; var revision: String; var enabled: Bool
  var entries: [MemoryEntry]; var charLimit: Int; var charCount: Int
  var id: String { target }
  func drafts() -> [MemoryDraft] { entries.map(MemoryDraft.init) }
  func isChanged(_ drafts: [MemoryDraft]) -> Bool { drafts.map { MemoryEntry(id: $0.entryId, text: $0.text) } != entries }
}
/// A memory entry being edited. A new entry has no Hermes id until it is saved.
struct MemoryDraft: Identifiable, Equatable {
  var id = UUID().uuidString
  var entryId = ""
  var text = ""
  init() {}
  init(_ entry: MemoryEntry) { entryId = entry.id; text = entry.text }
}
struct ProfileMemory: Decodable {
  var botId: String; var profile: String; var scope: String; var owner: String; var documents: [MemoryDocument]; var notice: String
  mutating func acceptSavedDocument(_ target: String, from refreshed: ProfileMemory) {
    guard let index = documents.firstIndex(where: { $0.target == target }), let updated = refreshed.documents.first(where: { $0.target == target }) else { return }
    // Unsaved documents retain their original revision so concurrent edits still conflict.
    documents[index] = updated
  }
}
struct MemorySaveEntry: Encodable { var id: String?; var text: String }
struct MemorySave: Encodable {
  var revision: String; var entries: [MemorySaveEntry]
  init(revision: String, drafts: [MemoryDraft]) {
    self.revision = revision
    entries = drafts.map { MemorySaveEntry(id: $0.entryId.isEmpty ? nil : $0.entryId, text: $0.text) }
  }
}
struct MemoryForget: Encodable { var revision: String; var entryId: String }
struct MemoryForgetRequest: Identifiable { var document: MemoryDocument; var entryId: String; var id: String { document.target + entryId } }
struct MemoryDrawer: View {
  var botId: String
  @EnvironmentObject private var store: AppStore
  @State private var value: ProfileMemory?
  @State private var drafts: [String: [MemoryDraft]] = [:]
  @State private var busy = false
  @State private var error: String?
  @State private var conflicts: Set<String> = []
  @State private var failures: [String: String] = [:]
  @State private var notices: [String: String] = [:]
  @State private var forget: MemoryForgetRequest?
  var body: some View {
    Form {
      Section {
        Text("What Hermes remembers").font(.headline)
        Text("Inspect and correct the facts saved in the assistant's Hermes profile.").font(.footnote).foregroundStyle(.secondary)
        if let value { (Text("Profile: \(value.profile). ").bold() + Text(value.notice)).font(.footnote) }
      }
      if busy && value == nil { Section { ProgressView("Loading profile memory…") } }
      if let error { Section { ErrorBanner(message: error) } }
      ForEach(value?.documents ?? []) { documentSection($0) }
      Section { Button(error != nil ? "Try loading again" : "Reload profile memory") { Task { await load() } }.disabled(busy) }
    }.disabled(busy).task(id: "\(store.scope ?? ""):\(botId)") { value = nil; drafts = [:]; await load() }
      .confirmationDialog("Forget this entry in the profile?", isPresented: Binding(get: { forget != nil }, set: { if !$0 { forget = nil } }), titleVisibility: .visible, presenting: forget) { request in
        Button("Forget entry", role: .destructive) { forgetEntry(request) }
      }
  }
  @ViewBuilder private func documentSection(_ document: MemoryDocument) -> some View {
    let items = drafts[document.target] ?? []
    let changed = document.isChanged(items)
    let locked = busy || conflicts.contains(document.target) || !document.enabled || !store.connected
    Section {
      Text("\(document.charCount) / \(document.charLimit) characters").font(.caption).foregroundStyle(.secondary)
      if !document.enabled { Text("This memory is disabled in the Hermes profile.").foregroundStyle(.secondary) }
      if items.isEmpty { Text("Nothing saved here yet.").foregroundStyle(.secondary) }
      ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
        TextField("Memory \(index + 1)", text: text(document, item.id), axis: .vertical).lineLimit(3...8).disabled(locked).accessibilityIdentifier("memoryEntry.\(index + 1)")
        if item.entryId.isEmpty {
          Button("Remove new entry") { drafts[document.target]?.removeAll { $0.id == item.id } }.disabled(locked)
        } else {
          Button("Forget…", role: .destructive) { forget = MemoryForgetRequest(document: document, entryId: item.entryId) }.disabled(locked || changed)
        }
      }
      Button("Add memory") { drafts[document.target, default: []].append(MemoryDraft()) }.disabled(locked || items.count >= 100)
      Button(busy ? "Saving…" : "Save memories") { save(document) }.disabled(locked || !changed || items.contains { $0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty })
      if changed { Button("Discard edits") { drafts[document.target] = document.drafts(); failures[document.target] = nil }.disabled(busy) }
      if let failure = failures[document.target] {
        ErrorBanner(message: failure + (conflicts.contains(document.target) ? " Your edits are kept. Copy them before reloading the newer profile memory." : ""))
      }
      if let notice = notices[document.target] { Text(notice).foregroundStyle(Palette.accent) }
    } header: { Text(document.label) }
  }
  private func text(_ document: MemoryDocument, _ id: String) -> Binding<String> {
    Binding(
      get: { drafts[document.target]?.first { $0.id == id }?.text ?? "" },
      set: { text in
        guard let index = drafts[document.target]?.firstIndex(where: { $0.id == id }) else { return }
        drafts[document.target]?[index].text = String(text.prefix(document.charLimit))
      })
  }
  private func path(_ document: MemoryDocument) -> String { "/bots/\(APIClient.component(botId))/memory/\(APIClient.component(document.target))" }
  private func load() async {
    guard let api = store.api else { return }; let scope = store.scope
    busy = true; error = nil; defer { busy = false }
    do {
      let result: ProfileMemory = try await api.get("/bots/\(APIClient.component(botId))/memory")
      guard store.scope == scope, store.api === api else { return }
      value = result; conflicts = []; failures = [:]; notices = [:]
      drafts = Dictionary(uniqueKeysWithValues: result.documents.map { ($0.target, $0.drafts()) })
    } catch { if store.scope == scope { self.error = error.localizedDescription } }
  }
  private func save(_ document: MemoryDocument) {
    mutate(document) { api in try await api.write(path(document), MemorySave(revision: document.revision, drafts: drafts[document.target] ?? []), method: "PATCH") }
  }
  private func forgetEntry(_ request: MemoryForgetRequest) {
    let document = request.document
    mutate(document) { api in try await api.write(path(document), MemoryForget(revision: document.revision, entryId: request.entryId), method: "DELETE") }
  }
  private func mutate(_ document: MemoryDocument, _ operation: @escaping (APIClient) async throws -> ProfileMemory) {
    guard let api = store.api else { return }; let scope = store.scope; let target = document.target
    busy = true; failures[target] = nil; notices[target] = nil
    Task {
      defer { busy = false }
      do {
        let result = try await operation(api)
        guard store.scope == scope, store.api === api, let updated = result.documents.first(where: { $0.target == target }) else { return }
        value?.acceptSavedDocument(target, from: result); drafts[target] = updated.drafts(); notices[target] = "Saved in Hermes."
      } catch {
        guard store.scope == scope else { return }
        failures[target] = error.localizedDescription
        if (error as? APIError)?.status == 409 { conflicts.insert(target) }
      }
    }
  }
}

struct RoutineTemplate: Decodable, Identifiable { var id: String; var name: String; var prompt: String; var schedule: String; var description: String }
struct SchedulePreview: Decodable {
  var botId: String; var schedule: String; var timezone: String; var nextRuns: [String]; var kind: String
  /// Run times read in the Hermes profile's timezone, which decides when the schedule fires.
  func label(_ run: String, now: Date = .now) -> String {
    guard let date = ServerDate.parse(run) else { return run }
    var calendar = Calendar.current
    if let zone = TimeZone(identifier: timezone) { calendar.timeZone = zone; return When.format(date, now: now, relative: false, calendar: calendar) }
    calendar.timeZone = .gmt
    return When.format(date, now: now, relative: false, calendar: calendar) + " UTC"
  }
}
struct RoutineRunReceipt: Codable {
  var requestId: String; var routineId: String; var botId: String; var status: String; var message: String?; var startedAt: String; var finishedAt: String?
  /// A finished trial no longer blocks starting another.
  var finished: Bool { status == "completed" || status == "failed" }
  var summary: String {
    let head: String
    switch status {
    case "accepted": head = "Trial run started. Hermes will finish it even if you close this screen."
    case "completed": head = "Trial run completed."
    case "failed": head = "Trial run failed."
    default: head = "The run's outcome is unknown. Review its result before starting another."
    }
    return message.flatMap { $0.isEmpty ? nil : head + " " + $0 } ?? head
  }
}
/// The button and result list under a routine's schedule, shared by the card and the editor.
struct RoutineSchedulePreview: View {
  var botId: String
  var schedule: String
  var onReady: ((String) -> Void)? = nil
  @EnvironmentObject private var store: AppStore
  @State private var preview: SchedulePreview?
  @State private var requested = ""
  @State private var busy = false
  @State private var error: String?
  var body: some View {
    Button(busy ? "Checking schedule…" : "Preview schedule") { load() }
      .disabled(busy || schedule.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !store.connected)
    if let preview, requested == schedule, preview.botId == botId {
      VStack(alignment: .leading, spacing: 4) {
        Text(preview.kind == "once" ? "Scheduled run" : "Next runs").font(.subheadline.bold())
        Text("Hermes timezone: \(preview.timezone)").font(.footnote)
        ForEach(preview.nextRuns, id: \.self) { Text(preview.label($0)).font(.footnote) }
        Text("The assistant's Hermes profile controls this timezone.").font(.caption).foregroundStyle(.secondary)
      }
    }
    if let error, requested == schedule { ErrorBanner(message: error) }
  }
  private func load() {
    guard let api = store.api else { return }; let scope = store.scope; let asked = schedule
    busy = true; error = nil; requested = asked
    Task {
      defer { busy = false }
      do {
        let value: SchedulePreview = try await api.write("/routines/preview", ["botId": botId, "schedule": asked])
        guard store.scope == scope, store.api === api else { return }
        preview = value; onReady?(asked)
      } catch { if store.scope == scope { self.error = error.localizedDescription } }
    }
  }
}
/// A saved routine's preview, results link and one-off trial, like the web card's controls.
struct RoutineEnhancements: View {
  var routine: Routine
  var disabled = false
  @EnvironmentObject private var store: AppStore
  @State private var receipt: RoutineRunReceipt?
  @State private var busy = false
  @State private var error: String?
  @State private var runConfirm = false
  @State private var retrySameRun = false
  private var receiptKey: String { "routine.run.\(store.scope ?? "").\(routine.id)" }
  var body: some View {
    RoutineSchedulePreview(botId: routine.botId, schedule: routine.schedule)
    NavigationLink("View results") { RoutineResultsView(botId: routine.botId, routineId: routine.id) }
    Text("Runs now. Hermes may move the next run or finish a one-time routine. Paused recurring routines stay paused.").font(.caption).foregroundStyle(.secondary)
      .task(id: "\(store.scope ?? ""):\(routine.id)") {
        receipt = UserDefaults.standard.data(forKey: receiptKey).flatMap { try? JSONDecoder().decode(RoutineRunReceipt.self, from: $0) }
      }
      .task(id: receipt?.status) {
        while receipt?.status == "accepted", !Task.isCancelled {
          try? await Task.sleep(for: .seconds(5))
          if !Task.isCancelled, !busy, let id = receipt?.requestId { await fetchRun(id) }
        }
      }
      .confirmationDialog(retrySameRun ? "The original request may still arrive. Retry using the same saved request ID?" : "Run this saved routine now?", isPresented: $runConfirm, titleVisibility: .visible) {
        Button(retrySameRun ? "Retry same request" : "Run once now") { startRun() }
      }
    if let receipt, !receipt.finished {
      Button(busy ? "Checking…" : "Check run status") { checkRun(receipt.requestId) }.disabled(busy || disabled || !store.connected)
    } else {
      Button(busy ? "Starting…" : "Try once") { runConfirm = true }.disabled(busy || disabled || !store.connected)
    }
    if retrySameRun { Button("Retry the same request") { runConfirm = true }.disabled(busy || disabled || !store.connected) }
    if let receipt { Text(receipt.summary).font(.footnote) }
    if let error { ErrorBanner(message: error) }
  }
  private func saveReceipt(_ value: RoutineRunReceipt, key: String) { receipt = value; if let data = try? JSONEncoder().encode(value) { UserDefaults.standard.set(data, forKey: key) } }
  private func startRun() {
    guard let api = store.api else { return }; let scope = store.scope; let key = receiptKey
    let requestId = retrySameRun ? (receipt?.requestId ?? UUID().uuidString) : UUID().uuidString
    retrySameRun = false
    let pending = RoutineRunReceipt(requestId: requestId, routineId: routine.id, botId: routine.botId, status: "uncertain", message: "Checking admission. This run will not be automatically retried.", startedAt: ISO8601DateFormatter().string(from: Date()))
    saveReceipt(pending, key: key); busy = true; error = nil
    Task { defer { busy = false }; do { let value: RoutineRunReceipt = try await api.write("/routines/\(APIClient.component(routine.id))/run", ["requestId": requestId]); guard store.scope == scope, store.api === api else { return }; saveReceipt(value, key: key) } catch { if store.scope == scope {
      if let failure = error as? APIError, (400..<500).contains(failure.status) {
        self.error = failure.localizedDescription
        var rejected = pending; rejected.status = "failed"; rejected.message = failure.message; saveReceipt(rejected, key: key)
      } else { self.error = error.localizedDescription + " Check this run's status before starting another." }
    } } }
  }
  private func checkRun(_ id: String) {
    busy = true; error = nil
    Task { defer { busy = false }; await fetchRun(id) }
  }
  private func fetchRun(_ id: String) async {
    guard let api = store.api else { return }; let scope = store.scope; let key = receiptKey
    do { let value: RoutineRunReceipt = try await api.get("/routines/\(APIClient.component(routine.id))/runs/\(APIClient.component(id))"); guard store.scope == scope, store.api === api else { return }; saveReceipt(value, key: key); retrySameRun = false } catch { if store.scope == scope {
      self.error = error.localizedDescription
      if (error as? APIError)?.status == 404 { retrySameRun = true }
    } }
  }
}
