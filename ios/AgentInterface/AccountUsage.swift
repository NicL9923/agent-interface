import Foundation

/// Subscription limits and credits for the provider accounts the household's assistants run on.
/// Mirrors `src/shared/account-usage.ts`; the wording and the cutoffs must stay the same as the web's.

/// One allowance, such as a 5-hour session or a weekly limit.
struct UsageWindow: Decodable, Equatable {
  /// `model`: the limit stops one model family (Opus week), never the whole account.
  enum Scope: String, Decodable { case account, model }
  var label: String
  /// 0 to 100, or nil when the provider did not say.
  var usedPercent: Double?
  var resetsAt: String?
  var detail: String?
  var scope: Scope
  init(label: String, usedPercent: Double?, resetsAt: String? = nil, detail: String? = nil, scope: Scope) {
    self.label = label; self.usedPercent = usedPercent; self.resetsAt = resetsAt; self.detail = detail; self.scope = scope
  }
  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    label = try values.decode(String.self, forKey: .label)
    usedPercent = try values.decodeIfPresent(Double.self, forKey: .usedPercent)
    resetsAt = try values.decodeIfPresent(String.self, forKey: .resetsAt)
    detail = try values.decodeIfPresent(String.self, forKey: .detail)
    // A scope this app does not know stops at most part of the account, so it is never an alarm for all of it.
    scope = (try? values.decode(Scope.self, forKey: .scope)) ?? .model
  }
  private enum CodingKeys: String, CodingKey { case label, usedPercent, resetsAt, detail, scope }
}

/// An account as the app shows it: what Hermes reports, and the visible assistants that use it.
struct UsageAccount: Decodable, Equatable, Identifiable {
  var key: String
  var provider: String
  var plan: String?
  var title: String
  var fetchedAt: String
  var windows: [UsageWindow]
  var details: [String]
  var unavailableReason: String?
  /// ChatGPT resets the person can spend to restore the session and weekly limits now.
  var bankedResets: Int
  var botIds: [String]
  /// Every assistant listed uses it only after its main provider fails.
  var fallbackOnly: Bool
  var id: String { key }
}

struct UsageOverview: Decodable, Equatable {
  var accounts: [UsageAccount]
  /// Assistants whose accounts Hermes could not list.
  var unavailableBots: [String]
}

/// `requestId` names one reset the person asked for. Reuse it to retry: Hermes never spends twice for one ID.
struct ResetRequest: Encodable { var confirmed: Bool; var requestId: String; var force: Bool }

/// What a reset attempt reports. A status this app does not know decodes as `.unknown`, because the
/// reset may have been spent already and the person should read Hermes's own words, not a decoding error.
enum ResetStatus: String, Decodable, Equatable {
  case reset, nothingToReset = "nothing_to_reset", noCredit = "no_credit", alreadyRedeemed = "already_redeemed"
  case notExhausted = "not_exhausted", noCreditsBanked = "no_credits_banked", unavailable, uncertain, unknown
  init(from decoder: Decoder) throws {
    self = ResetStatus(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .unknown
  }
}

struct ResetResult: Decodable, Equatable {
  var status: ResetStatus
  /// The add-on's fixed sentence for the status, never the provider's words. Shown only for a status this app does not know.
  var message: String
  var availableCount: Int
  var windowsReset: Int
  /// The account after the attempt, when Hermes could read it again.
  var account: UsageAccount?
}

enum AccountUsage {
  /// The most-used limit that stops the whole account, else any limit; nil when none reports a percentage.
  static func tightestWindow(_ account: UsageAccount) -> UsageWindow? {
    let known = account.windows.filter { $0.usedPercent != nil }
    let pool = known.contains { $0.scope == .account } ? known.filter { $0.scope == .account } : known
    // On a tie the earlier window stays, as on the web.
    var worst: UsageWindow?
    for window in pool where window.usedPercent! > (worst?.usedPercent ?? -.infinity) { worst = window }
    return worst
  }

  enum Level: Equatable { case ok, warn, alarm }
  /// Bars warn at half used and alarm at 80% used, the cutoffs Hermes's own pickers use.
  static func level(_ usedPercent: Double) -> Level { usedPercent >= 80 ? .alarm : usedPercent >= 50 ? .warn : .ok }

  /// A reset restores the whole allowance, so one spent before any limit is used up wastes most of it.
  static func resetWouldBeWasted(_ account: UsageAccount) -> Bool {
    !account.windows.contains { $0.scope == .account && ($0.usedPercent ?? 0) >= 100 }
  }

  private static let names: [String: String] = ["openai-codex": "ChatGPT", "openai": "OpenAI", "anthropic": "Claude", "openrouter": "OpenRouter",
    "nous": "Nous Portal", "opencode-zen": "OpenCode Zen", "google": "Gemini", "gemini": "Gemini", "xai": "Grok"]
  /// The account's name as people know it: ChatGPT for Hermes's `openai-codex` sign-in, else the slug in words.
  static func name(_ provider: String) -> String {
    names[provider] ?? provider.split(whereSeparator: { $0 == "-" || $0 == "_" })
      .map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined(separator: " ")
  }

  /// "Resets in 3 hr 20 min" within a day, else the weekday and time it resets.
  static func resetPhrase(_ resetsAt: String, now: Date = Date(), locale: Locale = .current, timeZone: TimeZone = .current) -> String {
    guard let at = ServerDate.parse(resetsAt) else { return "" }
    let minutes = Int((at.timeIntervalSince(now) / 60).rounded(.up))
    if minutes <= 0 { return "Resets any moment" }
    if minutes < 60 { return "Resets in \(minutes) min" }
    if minutes < 24 * 60 { return "Resets in \(minutes / 60) hr" + (minutes % 60 != 0 ? " \(minutes % 60) min" : "") }
    let formatter = DateFormatter()
    formatter.locale = locale; formatter.timeZone = timeZone
    formatter.setLocalizedDateFormatFromTemplate("EEE jmm")
    return "Resets " + formatter.string(from: at)
  }

  /// One line for the profile menu: the account closest to a limit, or nil when nothing reports one.
  static func summary(_ accounts: [UsageAccount]) -> String? {
    var top: (account: UsageAccount, window: UsageWindow)?
    for account in accounts {
      // Strictly greater, so an earlier account wins a tie, as in the web's stable sort.
      if let window = tightestWindow(account), window.usedPercent! > (top?.window.usedPercent ?? -.infinity) { top = (account, window) }
    }
    guard let top else { return nil }
    return "\(name(top.account.provider)) · \(Int(top.window.usedPercent!.rounded()))% of \(top.window.label.lowercased())"
  }

  private static func plural(_ count: Int, _ word: String) -> String { "\(count) \(word)\(count == 1 ? "" : "s")" }
  /// What happened to a reset, in the app's words. Hermes's own words only where the app has none.
  static func resetOutcome(_ result: ResetResult) -> String {
    switch result.status {
    case .reset: "Limits reset. \(plural(result.availableCount, "banked reset")) left."
    case .nothingToReset: "Nothing needed resetting, so no reset was used."
    case .alreadyRedeemed: "That reset was already used. No other reset was spent."
    case .noCredit, .noCreditsBanked: "This account has no banked resets."
    case .notExhausted: "Not reset: no limit is used up yet, so a reset would be wasted."
    case .unavailable: "ChatGPT did not confirm the reset. Refresh to see whether it went through before trying again."
    case .uncertain: "ChatGPT did not answer after the reset was sent. Try again: it goes as the same request, so it cannot spend a second reset."
    case .unknown: result.message.isEmpty ? "The reset finished with a result this app does not know. Refresh to see what is left." : result.message
    }
  }

  /// The assistants that use an account, by name. An id the household no longer lists is skipped.
  static func assistantNames(_ account: UsageAccount, bots: [Bot]) -> [String] {
    account.botIds.compactMap { id in bots.first { $0.id == id }?.name }
  }
  /// When the newest of the accounts was read, which is what "Updated" says.
  static func newestFetch(_ accounts: [UsageAccount]) -> Date? {
    accounts.compactMap { ServerDate.parse($0.fetchedAt) }.max()
  }
  static func countPhrase(_ count: Int, _ word: String) -> String { plural(count, word) }
}
