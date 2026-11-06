import AppIntents
import Foundation

/// The assistants a Focus lets through, as chosen in iOS Settings > Focus > Add Filter > WildBots.
/// Their notifications arrive as usual and the rest wait silently in Notification Center; home shows
/// only them until Show all. Approval requests from every assistant can still come through, so a Focus never
/// strands work that is waiting on a decision.
struct FocusChoice: Codable, Equatable {
  /// Empty when no Focus filter is on, or it chose nobody, which filters nothing.
  var assistantIds: [String] = []
  var allApprovals = true
  var active: Bool { !assistantIds.isEmpty }

  /// Matched against each notification's `filter-criteria`: the assistant's ID, `approval:` and the
  /// ID for an approval request, or `household` for digests and host alerts, which always arrive.
  var predicate: NSPredicate {
    guard active else { return NSPredicate(value: true) }
    let allowed = assistantIds + assistantIds.map { "approval:" + $0 } + ["household"]
    return allApprovals
      ? NSPredicate(format: "SELF IN %@ OR SELF BEGINSWITH %@", allowed, "approval:")
      : NSPredicate(format: "SELF IN %@", allowed)
  }
  /// Home's assistants under this Focus. A choice naming none of them, as after signing in to another
  /// account, shows everyone rather than an empty home.
  func shown(_ bots: [Bot]) -> [Bot] {
    guard active else { return bots }
    let chosen = bots.filter { assistantIds.contains($0.id) }
    return chosen.isEmpty ? bots : chosen
  }

  private static let key = "focus.choice"
  static func saved(_ defaults: UserDefaults = .standard) -> FocusChoice {
    defaults.data(forKey: key).flatMap { try? JSONDecoder().decode(FocusChoice.self, from: $0) } ?? FocusChoice()
  }
  func save(_ defaults: UserDefaults = .standard) {
    if active, let data = try? JSONEncoder().encode(self) { defaults.set(data, forKey: Self.key) } else { defaults.removeObject(forKey: Self.key) }
  }
}

/// WildBots' Focus filter. iOS calls `perform` when the Focus turns on with the chosen values, and
/// again with the defaults when it turns off.
struct WildBotsFocusFilter: SetFocusFilterIntent {
  static var title: LocalizedStringResource { "Choose assistants" }
  static var description: IntentDescription? {
    IntentDescription("Only the assistants you choose notify you and show on home during this Focus.")
  }
  @Parameter(title: "Assistants") var assistants: [AssistantEntity]?
  @Parameter(title: "Approval requests from every assistant", default: true) var allApprovals: Bool
  init() {}
  var displayRepresentation: DisplayRepresentation {
    let names = assistants?.map(\.name) ?? []
    return DisplayRepresentation(title: names.isEmpty ? "All assistants" : "\(names.joined(separator: ", "))",
      subtitle: allApprovals ? "Approval requests from everyone" : nil)
  }
  var choice: FocusChoice { FocusChoice(assistantIds: assistants?.map(\.id) ?? [], allApprovals: allApprovals) }
  var appContext: FocusFilterAppContext { FocusFilterAppContext(notificationFilterPredicate: choice.predicate) }
  @MainActor func perform() async throws -> some IntentResult {
    choice.save()
    NotificationController.shared.store?.focus = choice
    return .result()
  }
}
