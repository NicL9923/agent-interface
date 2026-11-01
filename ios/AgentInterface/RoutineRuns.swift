import SwiftUI

/// A routine run's normalized status. Older servers omit it, and a newer word reads as unknown.
enum RoutineRunStatus: String, Equatable, Hashable {
  case succeeded, failed, running, unknown
}

/// One run of an assistant's routine, as `GET /bots/:botId/routine-runs` lists it.
struct RoutineRun: Decodable, Identifiable, Equatable, Hashable {
  var id: String
  var routineId: String
  var routineName: String
  var startedAt: String?
  var finishedAt: String?
  var status: RoutineRunStatus
  var deliveryFailed: Bool
  var error: String?
  var preview: String?
  var previewOnly: Bool
  /// Result IDs are unique within a routine, so the card's identity names both.
  var key: String { "run:\(routineId):\(id)" }
  private enum CodingKeys: String, CodingKey { case id, routineId, routineName, startedAt, finishedAt, status, deliveryFailed, error, preview, previewOnly }
  init(id: String, routineId: String, routineName: String, startedAt: String? = nil, finishedAt: String? = nil, status: RoutineRunStatus = .unknown,
    deliveryFailed: Bool = false, error: String? = nil, preview: String? = nil, previewOnly: Bool = false) {
    self.id = id; self.routineId = routineId; self.routineName = routineName; self.startedAt = startedAt; self.finishedAt = finishedAt
    self.status = status; self.deliveryFailed = deliveryFailed; self.error = error; self.preview = preview; self.previewOnly = previewOnly
  }
  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    id = try container.decode(String.self, forKey: .id)
    routineId = try container.decode(String.self, forKey: .routineId)
    routineName = try container.decode(String.self, forKey: .routineName)
    startedAt = try container.decodeIfPresent(String.self, forKey: .startedAt)
    finishedAt = try container.decodeIfPresent(String.self, forKey: .finishedAt)
    status = RoutineRunStatus(rawValue: (try? container.decodeIfPresent(String.self, forKey: .status)) ?? "") ?? .unknown
    deliveryFailed = (try? container.decodeIfPresent(Bool.self, forKey: .deliveryFailed)) ?? false
    error = try container.decodeIfPresent(String.self, forKey: .error)
    preview = try container.decodeIfPresent(String.self, forKey: .preview)
    previewOnly = try container.decodeIfPresent(Bool.self, forKey: .previewOnly) ?? false
  }
}
struct RoutineRunPage: Decodable { var runs: [RoutineRun]; var unavailable: [String]? }
/// A routine whose runs this person keeps out of its assistant's chat.
struct HiddenRoutineRun: Codable, Equatable, Hashable { var botId: String; var routineId: String }

/// The web's src/shared/routine-runs.ts rules: window, delivered runs, placement among turns, words.
enum RoutineRunRules {
  static func time(_ run: RoutineRun) -> Date? { (run.startedAt ?? run.finishedAt).flatMap(ServerDate.parse) }
  static func label(_ run: RoutineRun) -> String {
    if run.status == .succeeded && run.deliveryFailed { return "Finished, not delivered" }
    switch run.status {
    case .succeeded: return "Succeeded"
    case .failed: return "Failed"
    case .running: return "Running"
    case .unknown: return "Status unknown"
    }
  }
  /// Whether the status word shows beside the name, because the run needs a look.
  static func flagged(_ run: RoutineRun) -> Bool {
    run.status == .failed || run.status == .running || run.status == .succeeded && run.deliveryFailed
  }
  /// The app's status colors, each 3:1 or better against the card in both themes.
  static func color(_ run: RoutineRun) -> Color {
    if run.status == .succeeded && run.deliveryFailed { return Palette.attention }
    switch run.status {
    case .succeeded: return Palette.accent
    case .failed: return Palette.danger
    case .running: return Palette.attention
    case .unknown: return Palette.muted
    }
  }
  static func hidden(_ preferences: Preferences?, botId: String, routineId: String) -> Bool {
    preferences?.hiddenRoutineRuns?.contains(HiddenRoutineRun(botId: botId, routineId: routineId)) == true
  }
  static func withShown(_ preferences: Preferences, botId: String, routineId: String, shown: Bool) -> Preferences {
    var value = preferences
    var rest = (value.hiddenRoutineRuns ?? []).filter { $0.botId != botId || $0.routineId != routineId }
    if !shown { rest.append(HiddenRoutineRun(botId: botId, routineId: routineId)) }
    value.hiddenRoutineRuns = rest
    return value
  }
  /// Dated, not hidden, and no older than the oldest loaded message unless history reaches the start.
  static func inWindow(_ runs: [RoutineRun], oldest: String?, complete: Bool, hidden: Set<String>) -> [RoutineRun] {
    let start = oldest.flatMap(ServerDate.parse)
    if !complete && start == nil { return [] }
    return runs.filter { run in
      guard let at = time(run), !hidden.contains(run.routineId) else { return false }
      return complete || at >= start!
    }.sorted { time($0)! < time($1)! }
  }
  /// The routine name a scheduled delivery names, lowercased without a "[bot:profile] " prefix.
  static func deliveredName(_ text: String) -> String? {
    for pattern in [#"^\[Cronjob "([^\n]+)" output [—-] scheduled job"#, #"^\[Cron delivery: ([^\n\]]+)\]"#] {
      if let match = text.range(of: pattern, options: .regularExpression) {
        let head = String(text[match])
        let name = pattern.hasPrefix(#"^\[Cronjob"#)
          ? head.dropFirst("[Cronjob \"".count).split(separator: "\"", maxSplits: 1).first.map(String.init) ?? ""
          : String(head.dropFirst("[Cron delivery: ".count).dropLast())
        return plain(name)
      }
    }
    return nil
  }
  private static func plain(_ name: String) -> String {
    name.replacingOccurrences(of: #"^\[bot:[^\]]+\]\s*"#, with: "", options: .regularExpression)
      .trimmingCharacters(in: .whitespaces).lowercased()
  }
  static let deliveryBefore: TimeInterval = 60
  static let deliveryAfter: TimeInterval = 30 * 60
  /// Each delivery claims the closest finished run of the routine it names, inside the delivery window.
  static func delivered(_ runs: [RoutineRun], messages: [Message]) -> Set<String> {
    var claimed = Set<String>()
    for message in messages {
      guard let name = deliveredName(message.text), let at = message.createdAt.flatMap(ServerDate.parse) else { continue }
      var best: (key: String, gap: TimeInterval)?
      for run in runs where !claimed.contains(run.key) && (plain(run.routineName) == name || run.routineId.lowercased() == name) {
        guard let start = time(run) else { continue }
        let end = run.finishedAt.flatMap(ServerDate.parse) ?? start
        guard at >= start - deliveryBefore, at <= end + deliveryAfter else { continue }
        let gap = abs(at.timeIntervalSince(end))
        if best == nil || gap < best!.gap { best = (run.key, gap) }
      }
      if let best { claimed.insert(best.key) }
    }
    return claimed
  }
  /// `slots[i]` precede turn `i`; the last slot follows the last turn. An undated turn keeps the previous time.
  static func place(turnTimes: [String?], runs: [RoutineRun]) -> [[RoutineRun]] {
    var slots = Array(repeating: [RoutineRun](), count: turnTimes.count + 1)
    var previous = Date.distantPast
    let times = turnTimes.map { value -> Date in
      if let at = value.flatMap(ServerDate.parse) { previous = max(previous, at) }
      return previous
    }
    for run in runs.sorted(by: { (time($0) ?? .distantPast) < (time($1) ?? .distantPast) }) {
      let at = time(run) ?? .distantPast
      slots[times.firstIndex { $0 > at } ?? turnTimes.count].append(run)
    }
    return slots
  }
  /// The runs shown in a conversation: in its window and not already shown by a delivery.
  static func shown(_ runs: [RoutineRun], conversation: Conversation, hidden: Set<String>) -> [RoutineRun] {
    let window = inWindow(runs, oldest: conversation.messages.first { $0.createdAt != nil }?.createdAt,
      complete: (conversation.earlier ?? 0) == 0, hidden: hidden)
    let delivered = delivered(window, messages: conversation.messages)
    return window.filter { !delivered.contains($0.key) }
  }
  static let poll: Duration = .seconds(60)
  static let runningPoll: Duration = .seconds(15)
}

extension ConversationTurn {
  /// When the turn started, for placing routine runs: its first dated message.
  var startedAt: String? { messages.first { $0.createdAt != nil }?.createdAt }
}

extension AppStore {
  /// Shows or hides a routine's runs in its assistant's chat for this person, with the same save queue as Settings.
  func setRunsShown(botId: String, routineId: String, shown: Bool) {
    guard let preferences = preferencesDraft ?? bootstrap?.preferences else { return }
    queuePreferences(RoutineRunRules.withShown(preferences, botId: botId, routineId: routineId, shown: shown))
  }
  var currentPreferences: Preferences? { preferencesDraft ?? bootstrap?.preferences }
}

/// Hides a routine's runs from the chat on screen; the conversation offers Undo.
private struct HideRoutineRunsKey: EnvironmentKey { static let defaultValue: @MainActor (RoutineRun) -> Void = { _ in } }
extension EnvironmentValues {
  var hideRoutineRuns: @MainActor (RoutineRun) -> Void {
    get { self[HideRoutineRunsKey.self] }
    set { self[HideRoutineRunsKey.self] = newValue }
  }
}

/// One routine run in the transcript, collapsed by default, as the web's RoutineRunCard.
struct RoutineRunCard: View, Equatable {
  var run: RoutineRun
  var botId: String
  @Environment(AppStore.self) private var store
  @Environment(\.colorScheme) private var scheme
  @Environment(\.hideRoutineRuns) private var hide
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var open = false
  @State private var output: RoutineOutput?
  @State private var error: String?
  @State private var notice: String?
  nonisolated static func == (a: Self, b: Self) -> Bool { a.run == b.run && a.botId == b.botId }
  private var status: String { RoutineRunRules.label(run) }
  private var preview: String? {
    let text = (run.status == .failed ? run.error ?? run.preview : run.preview)?.trimmingCharacters(in: .whitespacesAndNewlines)
    return text?.isEmpty == false ? text : nil
  }
  private var path: String {
    "/bots/\(APIClient.component(botId))/routines/\(APIClient.component(run.routineId))/results/\(APIClient.component(run.id))"
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Button {
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) { open.toggle() }
      } label: { summary }
        .buttonStyle(.plain)
        .accessibilityLabel("\(run.routineName), \(status), \((run.startedAt ?? run.finishedAt).map { When.format($0) } ?? "")")
        .accessibilityValue(open ? "Expanded" : "Collapsed")
        .accessibilityHint(open ? "Hides the run's output" : "Shows the run's output")
        .accessibilityIdentifier("routineRun-\(run.id)")
      if open { details.padding(.horizontal, 14).padding(.bottom, 14).transition(.opacity) }
    }
    .background(Palette.raised(scheme), in: RoundedRectangle(cornerRadius: 14))
    .overlay(RoundedRectangle(cornerRadius: 14).stroke(Palette.line, lineWidth: 1))
    .contextMenu {
      Button("All results", systemImage: "list.bullet.rectangle") { openResults() }
      Button("Hide this routine in chat", systemImage: "eye.slash") { hide(run) }
    }
    .task(id: open ? "\(store.scope ?? ""):\(run.key):\(run.status.rawValue):\(run.finishedAt ?? "")" : nil) { if open { await load() } }
  }
  private var summary: some View {
    HStack(alignment: .firstTextBaseline, spacing: 12) {
      RunDot(run: run).alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 5 }
      VStack(alignment: .leading, spacing: 2) {
        Text(run.routineName).font(.subheadline.weight(.semibold)).foregroundStyle(.primary)
        HStack(spacing: 8) {
          if RoutineRunRules.flagged(run) && !open { Text(status).fontWeight(.semibold).foregroundStyle(RoutineRunRules.color(run)) }
          if let at = run.startedAt ?? run.finishedAt { WhenText(value: at) }
        }.font(.caption).foregroundStyle(Palette.messageMetadata)
        if !open, let preview { Text(preview).font(.footnote).foregroundStyle(Palette.muted).lineLimit(1) }
      }.frame(maxWidth: .infinity, alignment: .leading)
      Image(systemName: "chevron.right").font(.caption2.weight(.bold)).foregroundStyle(.secondary)
        .rotationEffect(.degrees(open ? 90 : 0)).accessibilityHidden(true)
    }.padding(.horizontal, 14).padding(.vertical, 11).frame(minHeight: 44).contentShape(Rectangle())
  }
  @ViewBuilder private var details: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 16) {
        HStack(spacing: 6) { RunDot(run: run, size: 8); Text(status) }
        if let started = run.startedAt { Text("Started \(When.format(started, inline: true))") }
      }.font(.caption).foregroundStyle(Palette.messageMetadata)
        .accessibilityElement(children: .combine).accessibilityIdentifier("routineRunStatus")
      if run.status == .failed, let failure = run.error { Text(failure).font(.footnote).foregroundStyle(Palette.danger) }
      if run.deliveryFailed { Text("Hermes couldn't deliver this output where the routine sends it.").font(.footnote).foregroundStyle(Palette.muted) }
      if let error { Text(error).font(.footnote).foregroundStyle(Palette.danger) }
      else if let output {
        if output.previewOnly { Text("Hermes saved a preview of this script run. The full output stays in its cron output files.").font(.footnote).foregroundStyle(Palette.muted) }
        if output.messages.isEmpty { Text("No output was saved for this run.").font(.footnote).foregroundStyle(Palette.muted) }
        ForEach(output.messages) { message in
          MarkdownView(text: message.text)
          ForEach(message.files ?? []) { FileAttachmentView(file: $0) }
        }.accessibilityIdentifier("routineRunOutput")
      } else {
        HStack(spacing: 8) { ProgressView(); Text("Loading output…") }.font(.footnote).foregroundStyle(Palette.muted)
      }
      if let notice { Text(notice).font(.footnote).foregroundStyle(Palette.muted) }
      ViewThatFits(in: .horizontal) {
        HStack(spacing: 8) { actions }
        VStack(alignment: .leading, spacing: 8) { actions }
      }
    }
  }
  @ViewBuilder private var actions: some View {
    Button { Task { await save() } } label: { action("Save output", "bookmark") }
      .disabled(output == nil).accessibilityIdentifier("routineRunSave")
    Button { openResults() } label: { action("All results", "list.bullet.rectangle") }
      .accessibilityIdentifier("routineRunResults")
    Button { hide(run) } label: { action("Hide this routine in chat", "eye.slash") }
      .accessibilityIdentifier("routineRunHide")
  }
  /// A 44-point target, as every phone control.
  private func action(_ title: String, _ symbol: String) -> some View {
    Label(title, systemImage: symbol).font(.subheadline).frame(minHeight: 44).contentShape(Rectangle())
  }
  private func openResults() { store.routineResult = RoutineResultDestination(botId: botId, routineId: run.routineId, resultId: run.id) }
  private func load() async {
    error = nil
    let key = run.key
    let value: RoutineOutput? = await store.run(error: $error, current: { open && run.key == key }) { try await $0.api.get(path) }
    if let value { output = value }
  }
  private func save() async {
    let pointer = SavedPointer(botId: botId, kind: "routine", routineId: run.routineId, resultId: run.id, title: String(run.routineName.prefix(120)))
    let saved: SavedItem? = await store.run(error: $error) { try await $0.api.write("/saved", pointer) }
    if saved != nil { notice = "Saved to your saved items." }
  }
}

/// The status dot. Shape backs up color: unknown and running are outlines.
private struct RunDot: View {
  var run: RoutineRun
  var size: CGFloat = 10
  var body: some View {
    let color = RoutineRunRules.color(run)
    Group {
      if run.status == .unknown || run.status == .running { Circle().strokeBorder(color, lineWidth: 2) }
      else { Circle().fill(color) }
    }.frame(width: size, height: size).accessibilityHidden(true)
  }
}

/// Reads the open assistant's routine runs while its chat is on screen: every minute, every 15
/// seconds while one is running, and again when a new saved message arrives.
@MainActor @Observable final class RoutineRunsFeed {
  private(set) var runs: [RoutineRun] = []
  private(set) var botId: String?
  var running: Bool { runs.contains { $0.status == .running } }
  func load(_ store: AppStore, botId: String) async {
    let page: RoutineRunPage? = try? await store.api?.get("/bots/\(APIClient.component(botId))/routine-runs")
    guard let page, !Task.isCancelled else { return }
    self.botId = botId
    runs = page.runs
  }
  func reset(_ botId: String) { if self.botId != botId { runs = []; self.botId = botId } }
}
