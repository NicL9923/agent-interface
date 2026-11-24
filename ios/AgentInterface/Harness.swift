import Foundation

/// A harness the server can run bots on. An unavailable one carries the reason.
struct HarnessOption: Codable, Equatable {
  var id: String
  var available: Bool
  var reason: String?
}

/// The agent harnesses a bot can run on, mirroring `harnessIds` and `src/app/harness.ts` on the web.
enum Harness {
  static let hermes = "hermes"
  static let native = ["antigravity", "codex", "claude-code", "grok", "pi"]
  private static let labels = ["antigravity": "Antigravity", "codex": "Codex", "claude-code": "Claude Code", "grok": "Grok", "pi": "Pi", "hermes": "Hermes"]
  struct Choice: Equatable, Identifiable {
    var id: String
    var label: String
    var available: Bool
    var reason: String?
  }
  /// A readable name. An id this client does not know shows as sent.
  static func label(_ id: String) -> String { labels[id] ?? id }
  /// Every bot from a server before harnesses runs on Hermes.
  static func of(_ bot: Bot) -> String { bot.harness.flatMap { $0.isEmpty ? nil : $0 } ?? hermes }
  /// The four native harnesses, with any the server cannot run marked unavailable, then any other harness
  /// the server advertises. Hermes is offered only to a bot already on it, or while no native harness is
  /// available, so nobody moves a bot onto the runtime being retired.
  static func choices(_ advertised: [HarnessOption]?, saved: String?) -> [Choice] {
    let offered = advertised ?? []
    var ids = native
    for option in offered where option.id != hermes && !ids.contains(option.id) { ids.append(option.id) }
    var result = ids.map { id -> Choice in
      let option = offered.first { $0.id == id }
      return Choice(id: id, label: label(id), available: option?.available == true,
        reason: option == nil ? "Not set up on this server yet." : option?.reason)
    }
    if saved == hermes || !result.contains(where: \.available) {
      result.append(Choice(id: hermes, label: label(hermes), available: true))
    }
    return result
  }
  /// The harness a new bot starts on: the first native one available, else Hermes.
  static func defaultChoice(_ advertised: [HarnessOption]?) -> String {
    choices(advertised, saved: nil).first(where: \.available)?.id ?? hermes
  }
}

extension Bot {
  var runsOnHermes: Bool { Harness.of(self) == Harness.hermes }
}

extension Bootstrap {
  /// Whether `bot`'s runtime keeps an editable queue of messages sent during a turn. A bot's own value
  /// wins over the bootstrap's. Read by raw name: `CapabilityKey` lists only what every server reports.
  func supportsQueue(_ bot: Bot) -> Bool {
    (bot.capabilities?["queueManagement"] ?? capabilities["queueManagement"])?.supported == true && !bot.runsOnHermes
  }
  /// Whether Hermes updates still matter. Only a server that runs harnesses, with a roster it knows, can
  /// show that no assistant runs on Hermes; during a Hermes outage the roster can be empty, and the
  /// update screen holds the restart that recovers it.
  var showsHermesUpdates: Bool {
    harnesses == nil || rosterUnknown == true || bots.contains(where: \.runsOnHermes)
  }
}
