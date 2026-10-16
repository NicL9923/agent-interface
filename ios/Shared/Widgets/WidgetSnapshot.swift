import Foundation

/// What the widgets know: the app's last view of the signed-in person's assistants. The widget
/// extension never receives a sign-in token, so it only ever shows this snapshot and its age.
struct WidgetSnapshot: Codable, Equatable {
  struct Assistant: Codable, Equatable, Identifiable {
    var id: String
    var name: String
    /// The bootstrap activity state's raw value.
    var activity: String
    var lastMessage: String?
    var lastMessageAt: Date?
    var color: String?
    var pinned: Bool
    var needsAttention: Bool { activity == "waiting" || activity == "blocked" }
    var isWorking: Bool { activity == "thinking" || activity == "working" }
    /// Idle and disconnected have no phase of their own; the row shows the last message instead.
    var phase: ActivityPhase? {
      activity == "idle" || activity == "disconnected" ? nil : ActivityPhase(rawValue: activity) ?? .unknown
    }
    var status: String? {
      switch activity {
      case "idle": nil
      case "thinking": "Thinking"
      case "working": "Working"
      case "waiting": "Needs approval"
      case "blocked": "Needs your input"
      case "done": "Done"
      case "failed": "Failed"
      case "interrupted": "Interrupted"
      case "disconnected": "Connection lost"
      default: "Status unknown"
      }
    }
  }
  var scope: String
  var generatedAt: Date
  var assistants: [Assistant]

  /// Past this age the widgets ask the person to open the app instead of implying it is current.
  static let freshness: TimeInterval = 30 * 60
  func isStale(at date: Date) -> Bool { date.timeIntervalSince(generatedAt) >= Self.freshness }
  /// Entries for now and for the moment the snapshot goes stale, so widgets degrade on their
  /// own when the app is not opened.
  func timelineDates(now: Date) -> [Date] {
    let stale = generatedAt.addingTimeInterval(Self.freshness)
    return stale > now ? [now, stale] : [now]
  }
  /// Needing the person first, then working, then pinned, then the most recent conversation.
  var ordered: [Assistant] {
    func rank(_ value: Assistant) -> Int { value.needsAttention ? 0 : value.isWorking ? 1 : value.pinned ? 2 : 3 }
    return assistants.enumerated().sorted { a, b in
      let (left, right) = (a.element, b.element)
      if rank(left) != rank(right) { return rank(left) < rank(right) }
      let (leftAt, rightAt) = (left.lastMessageAt ?? .distantPast, right.lastMessageAt ?? .distantPast)
      return leftAt != rightAt ? leftAt > rightAt : a.offset < b.offset
    }.map(\.element)
  }
  var attentionCount: Int { assistants.filter(\.needsAttention).count }
  var workingCount: Int { assistants.filter(\.isWorking).count }
  /// The attention part alone, for headers too narrow for `summary`.
  var shortSummary: String { attentionCount > 0 ? "\(attentionCount) \(attentionCount == 1 ? "needs" : "need") you" : summary }
  /// "1 needs you · 2 working", for widget headers and the Lock Screen.
  var summary: String {
    let working = workingCount > 0 ? "\(workingCount) working" : nil
    guard attentionCount > 0 else { return working ?? "All caught up" }
    return ["\(attentionCount) \(attentionCount == 1 ? "needs" : "need") you", working].compactMap { $0 }.joined(separator: " · ")
  }
}

/// The snapshot file in the App Group the share extension already uses.
enum WidgetSnapshotStore {
  static var defaultURL: URL? {
    FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: ShareInbox.group)?
      .appendingPathComponent("Widgets", isDirectory: true).appendingPathComponent("snapshot.json")
  }
  /// How old the stored time may get before an unchanged snapshot is written again. Rewriting on
  /// every bootstrap would reload timelines every minute; never rewriting would let the widget
  /// say "Open WildBots to refresh" while the app is in use.
  static let rewriteAge: TimeInterval = 10 * 60
  static func read(from url: URL? = defaultURL) -> WidgetSnapshot? {
    guard let url, let data = try? Data(contentsOf: url) else { return nil }
    return try? JSONDecoder().decode(WidgetSnapshot.self, from: data)
  }
  /// Writes or, for `nil`, removes the snapshot. Returns whether widgets should reload.
  @discardableResult static func write(_ value: WidgetSnapshot?, to url: URL? = defaultURL) -> Bool {
    guard let url else { return false }
    guard let value else {
      guard FileManager.default.fileExists(atPath: url.path) else { return false }
      try? FileManager.default.removeItem(at: url)
      return true
    }
    if var stored = read(from: url), value.generatedAt.timeIntervalSince(stored.generatedAt) < rewriteAge {
      stored.generatedAt = value.generatedAt
      if stored == value { return false }
    }
    guard let data = try? JSONEncoder().encode(value) else { return false }
    try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    // Readable while the device is locked after its first unlock, for Lock Screen widgets.
    try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    return true
  }
}
