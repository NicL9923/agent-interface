import SwiftUI

struct TodayMessage: Decodable { var id: String; var text: String; var createdAt: String?; var files: [FileRef]? }
struct TodayItem: Decodable, Identifiable {
  var botId: String; var botName: String; var activity: Activity
  var approvals: [Approval]; var attention: [Attention]; var latestMessage: TodayMessage?
  var files: [FileRef]; var error: String?
  var id: String { botId }
}
struct TodayEvent: Decodable, Identifiable { var id: String; var botId: String; var kind: String; var title: String; var body: String?; var occurredAt: String; var routineId: String? }
enum TodayCopy {
  /// An error beside results that may no longer be current, as on the web.
  static func failure(_ message: String) -> String { message + " Loaded results may be out of date." }
}
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
/// Repeats a read while the app is in use, like the web's `pollWhileVisible`: paused while the app
/// is inactive or in the background, and run once on return.
struct ActivePoll: ViewModifier {
  var id: String
  var interval: Duration
  var action: () async -> Void
  @Environment(\.scenePhase) private var scenePhase
  func body(content: Content) -> some View {
    content
      .task(id: "\(id)|\(scenePhase == .active)") {
        guard scenePhase == .active else { return }
        while !Task.isCancelled {
          do { try await Task.sleep(for: interval) } catch { return }
          await action()
        }
      }
      .onChange(of: scenePhase) { old, new in if new == .active && old != .active { Task { await action() } } }
  }
}
extension View {
  func pollWhileActive(id: String, every interval: Duration, _ action: @escaping () async -> Void) -> some View {
    modifier(ActivePoll(id: id, interval: interval, action: action))
  }
}
struct TodayView: View {
  var openBot: () -> Void
  @Environment(AppStore.self) private var store
  @Environment(\.colorScheme) private var scheme
  @State private var value: TodayOverview?
  @State private var error: String?
  @State private var busy = false
  @State private var loadId = UUID()
  /// The ETag of the overview shown, so an unchanged poll skips decoding it again.
  @State private var applied: String?
  /// When this device last confirmed the overview. A 304 keeps the overview's own generatedAt.
  @State private var checkedAt: Date?
  @Environment(\.dynamicTypeSize) private var typeSize
  var body: some View {
    List {
      if let error {
        Section {
          ErrorBanner(message: TodayCopy.failure(error))
          if value == nil {
            Text("Today is unavailable right now.").foregroundStyle(.secondary)
            Button("Retry overview") { Task { await load(manual: true) } }
          }
        }.listRowBackground(Color.clear)
      }
      if value == nil && error == nil {
        Section { ProgressView("Checking your assistants…") }.listRowBackground(Color.clear)
      }
      if let value {
        Section {
          ViewThatFits(in: .horizontal) {
            HStack(spacing: 16) { counts(value) }
            VStack(alignment: .leading, spacing: 8) { counts(value) }
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        } footer: {
          Text("Checked \(checkedAt.map { When.format($0, inline: true) } ?? When.format(value.generatedAt, inline: true))")
            .font(.caption).foregroundStyle(Palette.muted)
        }.listRowBackground(Color.clear)
        if !attention(value).isEmpty {
          Section {
            ForEach(attention(value)) { item in attentionRow(item) }
          } header: { sectionTitle("Needs your attention") }
            .listRowBackground(Palette.raised(scheme))
        }
        Section {
          if value.events.isEmpty { Text("You're caught up. New results will appear here.").font(.subheadline).foregroundStyle(Palette.muted) }
          ForEach(value.events) { event in
            let name = botName(event.botId)
            Button { open(event.botId, routine: event.routineId) } label: {
              recapRow(event.botId, name: name, title: EventCopy.headline(event), detail: name + " · " + When.format(event.occurredAt))
            }.accessibilityIdentifier("today.event." + event.id)
          }
          if value.hasMore {
            Text("More results are waiting. Mark this page caught up to see them.").font(.caption).foregroundStyle(Palette.muted)
          }
          Button(value.hasMore ? "Mark this page caught up" : "Mark caught up") { markCaughtUp(value) }
            .font(.subheadline.weight(.medium)).tint(Palette.accent)
            .disabled(busy || !store.connected).accessibilityIdentifier("markTodaySeen")
        } header: {
          VStack(alignment: .leading, spacing: 4) {
            sectionTitle("Since you were away")
            Text("Since \(When.format(value.since, inline: true))").font(.caption).textCase(nil).foregroundStyle(Palette.muted)
          }
        }.listRowBackground(Color.clear)
        let working = active(value).filter { item in !attention(value).contains { $0.botId == item.botId } }
        if !working.isEmpty || !(value.upcoming ?? []).isEmpty {
          Section {
            ForEach(working) { item in
              Button { open(item.botId) } label: {
                recapRow(item.botId, name: item.botName, title: item.activity.detail ?? item.botName, detail: item.activity.detail == nil ? item.activity.state.label : item.botName + " · " + item.activity.state.label)
              }.accessibilityIdentifier("today.bot." + item.botId)
            }
            ForEach(value.upcoming ?? []) { row in
              Button { open(row.botId, routine: row.id) } label: {
                recapRow(row.botId, name: botName(row.botId), title: row.name,
                  detail: [botName(row.botId), "Scheduled", row.nextRunAt.map { When.format($0) }].compactMap { $0 }.joined(separator: " · "))
              }
            }
          } header: { sectionTitle("Up next") }.listRowBackground(Color.clear)
        }
        if value.items.contains(where: { !$0.files.isEmpty }) {
          Section {
            ForEach(value.items.filter { !$0.files.isEmpty }) { item in
              Button { open(item.botId) } label: {
                recapRow(item.botId, name: item.botName, title: item.files.suffix(3).map(\.name).joined(separator: " · "), detail: item.botName)
              }
            }
          } header: { sectionTitle("Recent files") }.listRowBackground(Color.clear)
        }
        let unchecked = value.unavailableBots.filter { id in !value.items.contains { $0.botId == id && $0.error != nil } }
        if !unchecked.isEmpty {
          Section {
            Text("Couldn't check \(unchecked.count) assistant\(unchecked.count == 1 ? "" : "s"). Their current activity is unknown.")
              .font(.subheadline).foregroundStyle(Palette.muted)
          }.listRowBackground(Color.clear)
        }
      }
    }
    .listSectionSpacing(24).householdListBackground().accessibilityIdentifier("todayOverview")
    .viewHeader("Today", "Your assistants, at a glance")
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        Button("Refresh", systemImage: "arrow.clockwise") { Task { await load(manual: true) } }
          .labelStyle(.iconOnly).disabled(busy).accessibilityIdentifier("refreshToday")
      }
    }
    .refreshable { await load(manual: true) }
    // A split-view transition can cancel the view task while its first read is pending.
    .onAppear { Task { await load() } }
    .onChange(of: store.scope) { _, _ in value = nil; applied = nil; checkedAt = nil; Task { await load() } }
    .pollWhileActive(id: store.scope ?? "", every: .seconds(30)) { await load() }
  }
  private func sectionTitle(_ title: String) -> some View {
    Text(title).font(.caption.weight(.semibold)).tracking(1.1).textCase(.uppercase).foregroundStyle(Palette.muted)
  }
  @ViewBuilder private func counts(_ value: TodayOverview) -> some View {
    if attention(value).isEmpty {
      Label(value.unavailableBots.isEmpty ? "All clear" : "No requests in checked assistants", systemImage: "checkmark")
        .font(.subheadline.weight(.medium)).foregroundStyle(Palette.accent)
    } else { count(attention(value).count, "need you") }
    count(active(value).filter { item in !attention(value).contains { $0.botId == item.botId } }.count, "at work")
    count(value.events.filter { $0.kind == "completed" }.count, "finished")
  }
  private func count(_ number: Int, _ label: String) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 4) {
      Text("\(number)").fontWeight(.semibold).monospacedDigit().foregroundStyle(Color.primary)
      Text(label).foregroundStyle(Palette.muted)
    }.font(.subheadline).accessibilityElement(children: .combine)
  }
  private func botName(_ id: String) -> String { store.bootstrap?.bots.first { $0.id == id }?.name ?? "Assistant" }
  private func avatar(_ id: String, name: String) -> some View {
    AvatarView(avatar: store.bootstrap?.bots.first { $0.id == id }?.avatar ?? AvatarConfig(), state: .idle, size: 36, name: name, forceReducedMotion: true)
      .accessibilityHidden(true)
  }
  private func recapRow(_ id: String, name: String, title: String, detail: String) -> some View {
    HStack(spacing: 12) {
      avatar(id, name: name)
      VStack(alignment: .leading, spacing: 4) {
        Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(Color.primary)
          .lineLimit(typeSize.isAccessibilitySize ? nil : 3)
        Text(detail).font(.footnote).foregroundStyle(Palette.muted)
      }.frame(maxWidth: .infinity, alignment: .leading)
      Image(systemName: "chevron.right").font(.caption).foregroundStyle(Palette.muted)
    }.padding(.vertical, 4).accessibilityElement(children: .combine)
  }
  private func attention(_ value: TodayOverview) -> [TodayItem] {
    value.items.filter { $0.error != nil || ($0.approvals.contains { $0.status == "pending" } || !$0.attention.isEmpty || [.blocked, .interrupted, .failed].contains($0.activity.state)) }
  }
  private func active(_ value: TodayOverview) -> [TodayItem] {
    value.items.filter { $0.error == nil && [.thinking, .working, .waiting].contains($0.activity.state) }
  }
  private func attentionRow(_ item: TodayItem) -> some View {
    let approval = item.approvals.first { $0.status == "pending" }
    let question = item.attention.first
    let failed = item.error != nil || [.failed, .interrupted].contains(item.activity.state)
    let title = item.error ?? approval?.title ?? question?.title ?? item.activity.detail ?? item.activity.state.label
    let reason = item.error != nil ? "Disconnected" : approval != nil ? "Approval" : question != nil ? (question?.kind == "clarify" ? "Question" : question?.kind == "secure" ? "Secure request" : "Needs your help") : item.activity.state.label
    let verb = item.error != nil ? "Reconnect" : approval != nil ? "Review" : question != nil ? (question?.kind == "clarify" ? "Answer" : "Review") : failed ? "View error" : "Review"
    return Button { open(item.botId) } label: {
      HStack(spacing: 12) {
        avatar(item.botId, name: item.botName)
        VStack(alignment: .leading, spacing: 4) {
          Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(Color.primary)
            .lineLimit(typeSize.isAccessibilitySize ? nil : 3)
          (Text(item.botName + " · ").foregroundStyle(Palette.muted) + Text(reason).foregroundStyle(failed ? Palette.danger : Palette.attention))
            .font(.footnote)
          if typeSize.isAccessibilitySize { Text(verb).font(.footnote.weight(.semibold)).foregroundStyle(Palette.accent) }
        }.frame(maxWidth: .infinity, alignment: .leading)
        if !typeSize.isAccessibilitySize {
          Text(verb).font(.caption.weight(.semibold)).foregroundStyle(Palette.accent)
            .padding(.horizontal, 9).padding(.vertical, 6).background(Palette.accentSoft, in: Capsule())
        }
      }.padding(.vertical, 4)
    }.accessibilityIdentifier("today.bot.\(item.botId)").accessibilityElement(children: .combine)
  }
  private func open(_ bot: String, routine: String? = nil) {
    openBot()
    Task { await store.select(bot); if let routine { store.routineResult = RoutineResultDestination(botId: bot, routineId: routine) } }
  }
  /// A background poll leaves the controls alone and keeps an earlier error until a read succeeds, like the web.
  private func load(manual: Bool = false) async {
    guard store.scope != nil else { return }
    let id = UUID(); loadId = id
    let since = value == nil ? nil : applied
    let response: (value: TodayOverview?, etag: String?)? = await store.run(busy: manual ? $busy : nil, error: $error, current: { loadId == id }) {
      try await $0.api.changed("/today", since: since)
    }
    guard let response else { return }
    if let overview = response.value { value = overview; applied = response.etag }
    checkedAt = Date(); if error != nil { error = nil }
  }
  private func markCaughtUp(_ snapshot: TodayOverview) {
    busy = true
    Task {
      let marked: Void? = await store.run(busy: $busy, error: $error) { try await $0.api.markTodaySeen(snapshot) }
      if marked != nil { await load() }
    }
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
  var refresh: MemoryRefreshStatus?
  mutating func acceptSavedDocument(_ target: String, from refreshed: ProfileMemory) {
    guard let index = documents.firstIndex(where: { $0.target == target }), let updated = refreshed.documents.first(where: { $0.target == target }) else { return }
    // Unsaved documents retain their original revision so concurrent edits still conflict.
    documents[index] = updated
    refresh = refreshed.refresh; notice = refreshed.notice
  }
}
struct MemoryRefreshStatus: Decodable {
  var revision: String; var state: String; var busy: Bool; var message: String
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
extension MemoryDocument {
  /// Hermes counts Unicode scalars and its delimiter. Infer only consistent server overhead.
  func draftSize(_ items: [MemoryDraft]) -> Int? {
    let texts = items.map { $0.text.trimmingCharacters(in: .whitespacesAndNewlines) }
    let size = texts.reduce(0) { $0 + $1.unicodeScalars.count }
    guard texts.count > 1 else { return size }
    guard entries.count > 1 else { return nil }
    let raw = entries.reduce(0) { $0 + $1.text.unicodeScalars.count }
    let extra = charCount - raw, gaps = entries.count - 1
    guard extra >= 0, extra % gaps == 0 else { return nil }
    return size + (extra / gaps) * (texts.count - 1)
  }
}

struct MemoryDrawer: View {
  var botId: String
  var onDirtyChange: (Bool) -> Void = { _ in }
  var onSavingChange: (Bool) -> Void = { _ in }
  @Environment(AppStore.self) private var store
  @State private var value: ProfileMemory?
  @State private var drafts: [String: [MemoryDraft]] = [:]
  @State private var busy = false
  @State private var savingTarget: String?
  @State private var error: String?
  @State private var conflicts: Set<String> = []
  @State private var failures: [String: String] = [:]
  @State private var notices: [String: String] = [:]
  @State private var forget: MemoryForgetRequest?
  @State private var pendingForget: MemoryForgetRequest?
  @State private var confirmReload = false
  @State private var reloadAfterDismiss = false
  @State private var pendingEntryFocus: String?
  @FocusState private var focusedEntry: String?
  @AccessibilityFocusState private var focusedFailure: String?
  private var changed: Bool { value?.documents.contains { $0.isChanged(drafts[$0.target] ?? []) } ?? false }
  var body: some View {
    ScrollViewReader { proxy in
      Form {
        Section {
          Text("What Hermes remembers").font(.title3.weight(.semibold)).accessibilityAddTraits(.isHeader)
          Text("Review and correct the facts saved in this Hermes profile.").font(.subheadline).foregroundStyle(Palette.muted)
          if let value {
            VStack(alignment: .leading, spacing: 6) {
              Text("Shared profile: \(value.profile)").font(.subheadline.weight(.semibold))
              Text("Changes apply at the next safe turn boundary. Chat history stays unchanged.")
              Text("Anyone with Hermes dashboard access can reach this memory.")
            }.font(.footnote).foregroundStyle(Palette.muted)
          }
          if !store.connected { Text(value == nil ? "Reconnect to Hermes to load and edit profile memory." : "You are offline. Reconnect to edit these notes.").font(.footnote).foregroundStyle(Palette.muted) }
          if let refresh = value?.refresh, !refresh.revision.isEmpty, refresh.busy, notices.isEmpty {
            Text(refresh.message).font(.footnote).accessibilityIdentifier("memoryRefreshStatus")
          }
        }
        if busy && savingTarget == nil { Section { ProgressView(value == nil ? "Loading profile memory…" : "Reloading profile memory…") } }
        if let error { Section {
        ErrorBanner(message: error).id("memoryLoadError").accessibilityElement(children: .combine)
          .accessibilityFocused($focusedFailure, equals: "load")
        Button { requestReload() } label: {
          Text("Try loading again").frame(minHeight: 44).contentShape(Rectangle())
        }.buttonStyle(.accentProminent).disabled(busy)
      } }
        ForEach(value?.documents ?? []) { documentSection($0) }
        if error == nil { Section {
          Button("Reload profile memory", action: requestReload).disabled(busy)
        } }
      }.accessibilityIdentifier("memoryForm").householdListBackground()
        .task(id: "\(store.scope ?? ""):\(botId)") { value = nil; drafts = [:]; await load() }
        .onChange(of: changed, initial: true) { _, dirty in onDirtyChange(dirty) }
        .onAppear { onDirtyChange(changed) }
        .onChange(of: savingTarget != nil || pendingForget != nil, initial: true) { _, saving in onSavingChange(saving) }
        .onDisappear { onDirtyChange(false); onSavingChange(false) }
        .onChange(of: pendingEntryFocus) { _, identifier in
          guard let identifier else { return }
          Task { @MainActor in
            await Task.yield()
            proxy.scrollTo(identifier, anchor: .center)
            focusedEntry = identifier; pendingEntryFocus = nil
          }
        }
        .onChange(of: error) { _, message in
          guard message != nil else { return }
          Task { @MainActor in
            await Task.yield()
            proxy.scrollTo("memoryLoadError", anchor: .center)
            focusedFailure = "load"
          }
        }
        .onChange(of: failures) { old, current in
          guard let target = current.keys.first(where: { current[$0] != old[$0] }) else { return }
          Task { @MainActor in
            await Task.yield()
            proxy.scrollTo("memoryError.\(target)", anchor: .center)
            focusedFailure = target
          }
        }
        .sheet(item: $forget, onDismiss: {
          if let request = pendingForget { pendingForget = nil; forgetEntry(request) }
        }) { request in
          let entry = request.document.entries.first { $0.id == request.entryId }?.text ?? ""
          AssistantConfirmationSheet(title: "Forget this entry?",
            message: "This removes the following entry from the shared Hermes profile:\n\n\"\(entry)\"",
            acceptLabel: "Forget entry", keepLabel: "Keep entry", destructive: true,
            accept: { pendingForget = request; forget = nil }, keep: { forget = nil })
        }
        .sheet(isPresented: $confirmReload, onDismiss: {
          if reloadAfterDismiss { reloadAfterDismiss = false; Task { await load() } }
        }) {
          AssistantConfirmationSheet(title: "Reload profile memory?", message: "Your unsaved edits will be discarded when the latest memory loads. Copy anything you want to keep first.",
            acceptLabel: "Reload and discard edits", keepLabel: "Keep editing", destructive: true,
            accept: { reloadAfterDismiss = true; confirmReload = false }, keep: { confirmReload = false })
        }
    }
  }
  private func requestReload() {
    guard pendingForget == nil else { return }
    if changed { confirmReload = true } else { Task { await load() } }
  }
  @ViewBuilder private func documentSection(_ document: MemoryDocument) -> some View {
    let target = document.target, items = drafts[target] ?? []
    let changed = document.isChanged(items)
    let conflict = conflicts.contains(target)
    let locked = busy || reloadAfterDismiss || pendingForget != nil || conflict || !document.enabled || !store.connected
    let canAdd = !locked && items.count < 100
    let size = document.draftSize(items)
    let over = size.map { $0 > document.charLimit } ?? false
    Section {
      Text(size.map { "\($0.formatted()) / \(document.charLimit.formatted()) characters" } ?? "Saved size: \(document.charCount.formatted()) / \(document.charLimit.formatted()) characters")
        .font(.footnote).foregroundStyle(over ? Palette.danger : Palette.muted)
      if !document.enabled {
        Text("Editing is disabled in this Hermes profile. You can still read and copy these notes.").font(.footnote).foregroundStyle(Palette.muted)
      }
      if items.isEmpty {
        Text("Nothing saved here yet. Add a fact you want this profile to remember.").font(.subheadline).foregroundStyle(Palette.muted)
      }
      ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
        VStack(alignment: .leading, spacing: 8) {
          Text("\(target == "user" ? "Profile fact" : "Assistant note") \(index + 1)").font(.footnote).foregroundStyle(Palette.muted).accessibilityHidden(true)
          if conflict || !document.enabled || !store.connected {
            Text(item.text).font(.body).foregroundStyle(Color.primary).textSelection(.enabled)
              .frame(maxWidth: .infinity, alignment: .leading)
              .accessibilityIdentifier("memoryEntry.\(target).\(index + 1)")
              .accessibilityLabel("\(target == "user" ? "Profile fact" : "Assistant note") \(index + 1)")
              .accessibilityValue(item.text)
          } else {
            TextField("Enter a fact to remember", text: text(document, item.id), axis: .vertical)
              .lineLimit(3...8).disabled(busy || reloadAfterDismiss || pendingForget != nil || !store.connected)
              .focused($focusedEntry, equals: item.id)
              .accessibilityLabel("\(target == "user" ? "Profile fact" : "Assistant note") \(index + 1)")
              .accessibilityIdentifier("memoryEntry.\(target).\(index + 1)")
          }
        }.padding(.vertical, 4).id(item.id)
        if item.entryId.isEmpty {
          Button("Remove new entry") { drafts[target]?.removeAll { $0.id == item.id }; notices[target] = nil }.disabled(locked)
        } else {
          Button("Forget…", role: .destructive) { forget = MemoryForgetRequest(document: document, entryId: item.entryId) }
            .disabled(locked || changed).accessibilityIdentifier("memoryForget.\(target).\(index + 1)")
        }
      }
      if let size, over {
        Text("This document is \((size - document.charLimit).formatted()) characters over the limit. Shorten or remove an entry before saving.")
          .font(.footnote).foregroundStyle(Palette.danger)
      }
      Button {
        let entry = MemoryDraft(); drafts[target, default: []].append(entry)
        notices[target] = nil; pendingEntryFocus = entry.id
      } label: {
        Label("Add memory", systemImage: "plus").foregroundStyle(canAdd ? Palette.accent : Palette.muted)
          .frame(minHeight: 44).contentShape(Rectangle())
      }.disabled(!canAdd).accessibilityIdentifier("memoryAdd.\(target)")
      Button { save(document) } label: {
        Text("Save memories").frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
      }.buttonStyle(.accentProminent)
        .disabled(locked || !changed || over || items.contains { $0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty })
        .accessibilityIdentifier("memorySave.\(target)")
      if savingTarget == target { ProgressView("Saving memories in Hermes…").font(.footnote).foregroundStyle(Palette.muted) }
      if changed {
        Button("Discard edits") {
          drafts[target] = document.drafts(); notices[target] = nil
          if !conflict { failures[target] = nil }
        }.disabled(busy || pendingForget != nil).accessibilityIdentifier("memoryDiscard.\(target)")
      }
      if let failure = failures[target] {
        ErrorBanner(message: failure + (conflict ? (changed ? " Your edits are kept. Copy any text you want to keep, then reload profile memory to continue." : " Reload profile memory before editing again.") : ""))
          .id("memoryError.\(target)").accessibilityFocused($focusedFailure, equals: target)
      }
      if let notice = notices[target] {
        Text(notice).font(.footnote).foregroundStyle(Palette.accent).accessibilityIdentifier("memorySaved.\(target)")
      }
    } header: { Text(target == "user" ? "About this profile" : document.label).font(.subheadline.weight(.semibold)).foregroundStyle(Palette.muted) }
  }
  private func text(_ document: MemoryDocument, _ id: String) -> Binding<String> {
    Binding(get: { drafts[document.target]?.first { $0.id == id }?.text ?? "" }, set: { text in
      guard let index = drafts[document.target]?.firstIndex(where: { $0.id == id }) else { return }
      drafts[document.target]?[index].text = text; notices[document.target] = nil
    })
  }
  private func path(_ document: MemoryDocument) -> String { "/bots/\(APIClient.component(botId))/memory/\(APIClient.component(document.target))" }
  private func load() async {
    error = nil
    let result: ProfileMemory? = await store.run(busy: $busy, error: $error) { try await $0.api.get("/bots/\(APIClient.component(botId))/memory") }
    guard let result else { return }
    value = result; conflicts = []; failures = [:]; notices = [:]
    drafts = Dictionary(uniqueKeysWithValues: result.documents.map { ($0.target, $0.drafts()) })
  }
  private func save(_ document: MemoryDocument) {
    mutate(document) { api in try await api.write(path(document), MemorySave(revision: document.revision, drafts: drafts[document.target] ?? []), method: "PATCH") }
  }
  private func forgetEntry(_ request: MemoryForgetRequest) {
    mutate(request.document) { api in try await api.write(path(request.document), MemoryForget(revision: request.document.revision, entryId: request.entryId), method: "DELETE") }
  }
  private func mutate(_ document: MemoryDocument, _ operation: @escaping (APIClient) async throws -> ProfileMemory) {
    let target = document.target
    busy = true; savingTarget = target; failures[target] = nil; notices[target] = nil
    Task {
      defer { savingTarget = nil }
      switch await store.attempt(busy: $busy, { try await operation($0.api) }) {
      case .success(let result)?:
        guard let updated = result.documents.first(where: { $0.target == target }) else { return }
        value?.acceptSavedDocument(target, from: result); drafts[target] = updated.drafts()
        notices[target] = result.refresh?.message ?? "Saved in Hermes."
      case .failure(let failure)?:
        failures[target] = failure.localizedDescription
        if (failure as? APIError)?.status == 409 { conflicts.insert(target) }
      case nil: break
      }
    }
  }
}

struct RoutineTemplate: Decodable, Identifiable { var id: String; var name: String; var prompt: String; var schedule: String; var description: String }
struct SchedulePreview: Decodable {
  var botId: String; var schedule: String; var timezone: String; var nextRuns: [String]; var kind: String
  /// Full run date and time in the Hermes profile's timezone, which decides when the schedule fires, like the web.
  func label(_ run: String, locale: Locale = .current) -> String {
    guard let date = ServerDate.parse(run) else { return run }
    let formatter = DateFormatter()
    formatter.locale = locale
    formatter.setLocalizedDateFormatFromTemplate("yMdjmmss")
    if let zone = TimeZone(identifier: timezone) { formatter.timeZone = zone; return formatter.string(from: date) }
    formatter.timeZone = .gmt
    return formatter.string(from: date) + " UTC"
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
  @Environment(AppStore.self) private var store
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
    let asked = schedule
    busy = true; error = nil; preview = nil; requested = asked
    Task {
      let value: SchedulePreview? = await store.run(busy: $busy, error: $error, current: { requested == asked }) {
        try await $0.api.write("/routines/preview", ["botId": botId, "schedule": asked])
      }
      if let value { preview = value; onReady?(asked) }
    }
  }
}
/// A saved routine's preview, results link and one-off trial, like the web card's controls.
struct RoutineEnhancements: View {
  var routine: Routine
  var disabled = false
  @Environment(AppStore.self) private var store
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
      .confirmationDialog("The original request may still arrive. Retry using the same saved request ID?", isPresented: $runConfirm, titleVisibility: .visible) {
        Button("Retry same request") { startRun() }
      }
    if let receipt, !receipt.finished {
      Button(busy ? "Checking…" : "Check run status") { checkRun(receipt.requestId) }.disabled(busy || disabled || !store.connected)
    } else {
      Button(busy ? "Starting…" : "Try once") { startRun() }.disabled(busy || disabled || !store.connected)
    }
    if retrySameRun { Button("Retry the same request") { runConfirm = true }.disabled(busy || disabled || !store.connected) }
    if let receipt { Text(receipt.summary).font(.footnote) }
    if let error { ErrorBanner(message: error) }
  }
  private func saveReceipt(_ value: RoutineRunReceipt, key: String) { receipt = value; if let data = try? JSONEncoder().encode(value) { UserDefaults.standard.set(data, forKey: key) } }
  private func startRun() {
    guard store.api != nil else { return }
    let key = receiptKey
    let requestId = retrySameRun ? (receipt?.requestId ?? UUID().uuidString) : UUID().uuidString
    retrySameRun = false
    let pending = RoutineRunReceipt(requestId: requestId, routineId: routine.id, botId: routine.botId, status: "uncertain", message: "Checking admission. This run will not be automatically retried.", startedAt: ISO8601DateFormatter().string(from: Date()))
    saveReceipt(pending, key: key); busy = true; error = nil
    Task {
      switch await store.attempt(busy: $busy, { (context) -> RoutineRunReceipt in
        try await context.api.write("/routines/\(APIClient.component(routine.id))/run", ["requestId": requestId])
      }) {
      case .success(let value)?: saveReceipt(value, key: key)
      case .failure(let failure)?:
        if let failure = failure as? APIError, (400..<500).contains(failure.status) {
          error = failure.localizedDescription
          var rejected = pending; rejected.status = "failed"; rejected.message = failure.message; saveReceipt(rejected, key: key)
        } else { error = failure.localizedDescription + " Check this run's status before starting another." }
      case nil: break
      }
    }
  }
  private func checkRun(_ id: String) {
    busy = true; error = nil
    Task { defer { busy = false }; await fetchRun(id) }
  }
  private func fetchRun(_ id: String) async {
    let key = receiptKey
    switch await store.attempt({ (context) -> RoutineRunReceipt in
      try await context.api.get("/routines/\(APIClient.component(routine.id))/runs/\(APIClient.component(id))")
    }) {
    case .success(let value)?: saveReceipt(value, key: key); retrySameRun = false
    case .failure(let failure)?:
      error = failure.localizedDescription
      if (failure as? APIError)?.status == 404 { retrySameRun = true }
    case nil: break
    }
  }
}
