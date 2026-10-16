import ActivityKit
import Foundation

/// The one aggregate Live Activity per device. The server owns `ContentState`: it is both the
/// `GET /api/native/live-activity` state and the APNs `content-state`, so its field names and
/// types follow docs/native-api.md exactly.
struct AssistantsActivityAttributes: ActivityAttributes {
  typealias ContentState = AssistantActivityState
  /// The account that started the activity. A different sign-in ends it instead of showing
  /// another person's assistants.
  var scope: String
}

/// A Live Activity row's phase. A phase this version does not know decodes as `unknown`, so a
/// newer server cannot break an activity that is already on the Lock Screen.
enum ActivityPhase: String, Codable, Hashable, CaseIterable {
  case starting, thinking, working, waiting, blocked, done, failed, interrupted, unknown
  init(from decoder: Decoder) throws {
    self = Self(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .unknown
  }
  var needsAttention: Bool { self == .waiting || self == .blocked }
  var isProblem: Bool { self == .failed || self == .interrupted }
  /// Non-terminal: still running or waiting for the person.
  var isActive: Bool { [.starting, .thinking, .working, .waiting, .blocked].contains(self) }
  /// The server's row order: attention, failed and interrupted, active, then done.
  var rank: Int {
    if needsAttention { return 0 }
    if isProblem { return 1 }
    if isActive { return 2 }
    return self == .done ? 3 : 4
  }
  var symbol: String {
    switch self {
    case .waiting: "exclamationmark.circle.fill"
    case .blocked: "questionmark.circle.fill"
    case .failed, .interrupted: "xmark.octagon.fill"
    case .done: "checkmark.circle.fill"
    case .starting: "circle.dotted"
    case .thinking, .working: "arrow.triangle.2.circlepath"
    case .unknown: "circle.dashed"
    }
  }
  /// The minimal Dynamic Island shows the phase itself only when it asks something of the
  /// person or has finished; running work shows the app glyph.
  var showsSymbolWhenMinimal: Bool { needsAttention || isProblem || self == .done }
}

struct AssistantActivityState: Codable, Hashable {
  struct Row: Codable, Hashable, Identifiable {
    var botId: String
    var name: String
    var phase: ActivityPhase
    var status: String
    var detail: String?
    /// Unix epoch seconds. ActivityKit decodes `Date` from the 2001 reference epoch, so the
    /// wire format stays a number and views convert it.
    var since: Double?
    var color: String?
    var id: String { botId }
    var sinceDate: Date? { since.map(Date.init(timeIntervalSince1970:)) }
    /// Out-of-date running rows must not claim to still be working.
    func statusText(stale: Bool) -> String {
      if phase == .unknown { return "Status unknown" }
      return stale && phase.isActive ? "Out of date" : status
    }
    /// A running clock is honest only while updates arrive.
    func showsTimer(stale: Bool) -> Bool { !stale && phase.isActive && since != nil }
  }
  var title: String
  var activeCount: Int
  var attentionCount: Int
  /// Unix epoch seconds.
  var updatedAt: Double
  var rows: [Row]

  /// The first row drives the tint, the minimal symbol and the tap target.
  var hero: Row? { rows.first }
  var updatedDate: Date { Date(timeIntervalSince1970: updatedAt) }
  static func empty(at now: Date) -> Self {
    Self(title: "", activeCount: 0, attentionCount: 0, updatedAt: now.timeIntervalSince1970, rows: [])
  }
  /// The Lock Screen header and its attention suffix, drawn in the attention color.
  func header(stale: Bool) -> (text: String, attention: String?) {
    if stale { return ("Assistant status out of date", nil) }
    guard activeCount > 0 else { return (title.isEmpty ? "Assistants are done" : title, nil) }
    let attention = attentionCount > 0 ? " · \(attentionCount) \(attentionCount == 1 ? "needs" : "need") you" : nil
    return ("\(activeCount) active", attention)
  }
  /// The compact trailing Dynamic Island label.
  func compactLabel(stale: Bool) -> String {
    if stale { return "Out of date" }
    switch hero?.phase {
    case .waiting: return "Approval"
    case .blocked: return "Input"
    default: break
    }
    if activeCount > 0 { return "\(activeCount) active" }
    switch hero?.phase {
    case .failed: return "Failed"
    case .interrupted: return "Stopped"
    default: return "Done"
    }
  }
  /// Shows a just-sent message right away as a `starting` row, the same seed the server
  /// reports during its grace period, so the activity does not wait for the first push.
  func seeded(botId: String, name: String, color: String?, at now: Date) -> Self {
    var next = self
    if let index = rows.firstIndex(where: { $0.botId == botId }) {
      if rows[index].phase.isActive { return self }
      next.rows.remove(at: index)
    }
    if next.activeCount == 0 { next.title = "\(name) is starting" }
    next.rows.append(Row(botId: botId, name: name, phase: .starting, status: "Starting", since: now.timeIntervalSince1970, color: color))
    next.rows = Array(Self.ordered(next.rows).prefix(4))
    next.activeCount += 1
    next.updatedAt = now.timeIntervalSince1970
    return next
  }
  /// Stable server order, so rows of the same rank keep the server's sequence.
  static func ordered(_ rows: [Row]) -> [Row] {
    rows.enumerated().sorted { ($0.element.phase.rank, $0.offset) < ($1.element.phase.rank, $1.offset) }.map(\.element)
  }
}

/// Links that widgets and the Live Activity open. The app maps them to the same relative
/// links notifications carry, so one path handles both.
enum DeepLink {
  static let today = URL(string: "agentinterface://open?view=today")!
  static func bot(_ id: String) -> URL {
    var components = URLComponents()
    components.scheme = "agentinterface"
    components.host = "open"
    components.queryItems = [URLQueryItem(name: "bot", value: id)]
    return components.url ?? today
  }
  /// `agentinterface://open?bot=ID` becomes `/?bot=ID`. Anything else, including the sign-in
  /// callback `agentinterface://auth/callback`, is not a navigation link.
  static func relativePath(for url: URL) -> String? {
    guard url.scheme?.lowercased() == "agentinterface", url.host?.lowercased() == "open",
      url.path.isEmpty || url.path == "/",
      let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems
    else { return nil }
    var components = URLComponents()
    components.path = "/"
    if let bot = items.first(where: { $0.name == "bot" })?.value, !bot.isEmpty {
      components.queryItems = [URLQueryItem(name: "bot", value: bot)]
    } else if items.first(where: { $0.name == "view" })?.value == "today" {
      components.queryItems = [URLQueryItem(name: "view", value: "today")]
    } else {
      return nil
    }
    return components.string
  }
}
