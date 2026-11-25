import Foundation

/// A harness the server can run bots on. An unavailable one carries the reason.
struct HarnessOption: Codable, Equatable {
  var id: String
  var available: Bool
  var reason: String?
}

/// The agent harnesses a bot can run on, mirroring `harnessIds` and `src/app/harness.ts` on the web.
enum Harness {
  static let native = ["antigravity", "codex", "claude-code", "grok", "pi"]
  private static let labels = ["antigravity": "Antigravity", "codex": "Codex", "claude-code": "Claude Code", "grok": "Grok", "pi": "Pi"]
  struct Choice: Equatable, Identifiable {
    var id: String
    var label: String
    var available: Bool
    var reason: String?
  }
  /// A readable name. An id this client does not know shows as sent.
  static func label(_ id: String) -> String { labels[id] ?? id }
  /// The harness a bot runs on, defaulting to Antigravity when omitted.
  static func of(_ bot: Bot) -> String { bot.harness.flatMap { $0.isEmpty ? nil : $0 } ?? "antigravity" }
  /// The native harnesses, with any the server cannot run marked unavailable, then any other harness
  /// the server advertises.
  static func choices(_ advertised: [HarnessOption]?, saved: String?) -> [Choice] {
    let offered = advertised ?? []
    var ids = native
    for option in offered where !ids.contains(option.id) { ids.append(option.id) }
    if let saved, !saved.isEmpty, !ids.contains(saved) { ids.append(saved) }
    return ids.map { id -> Choice in
      let option = offered.first { $0.id == id }
      return Choice(id: id, label: label(id), available: option?.available == true,
        reason: option == nil ? "Not set up on this server yet." : option?.reason)
    }
  }
  /// The harness a new bot starts on: the first native one available, else Antigravity.
  static func defaultChoice(_ advertised: [HarnessOption]?) -> String {
    choices(advertised, saved: nil).first(where: \.available)?.id ?? "antigravity"
  }
}

extension Bootstrap {
  /// Whether `bot`'s runtime keeps an editable queue of messages sent during a turn. A bot's own value
  /// wins over the bootstrap's. Read by raw name: `CapabilityKey` lists only what every server reports.
  func supportsQueue(_ bot: Bot) -> Bool {
    (bot.capabilities?["queueManagement"] ?? capabilities["queueManagement"])?.supported == true
  }
}
