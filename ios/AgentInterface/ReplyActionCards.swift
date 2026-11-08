import CryptoKit
import SwiftUI
import UIKit

// Email drafts, forms and T3 Code threads, as the web's src/shared/reply-cards.ts,
// src/shared/t3-code.ts, EmailDraftCard.tsx, FormReplyCard.tsx and T3ThreadCard.tsx show them.

/// A form field's starting value or a person's answer: text for most kinds, a list for multi and a
/// switch for toggle. A JSON number reads as the text JavaScript's `String(number)` gives it; only a
/// number field may start with one, which `ReplyCards.strictJSON` checks on the raw JSON.
enum FormValue: Codable, Equatable {
  case text(String), list([String]), toggle(Bool)
  init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    if let value = try? container.decode(String.self) { self = .text(value) }
    else if let value = try? container.decode([String].self) { self = .list(value) }
    else if let value = try? container.decode(Bool.self) { self = .toggle(value) }
    else if let value = try? container.decode(Double.self) { self = .text(JS.number(value)) }
    else { throw DecodingError.dataCorruptedError(in: container, debugDescription: "Not a form value") }
  }
  func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .text(let value): try container.encode(value)
    case .list(let value): try container.encode(value)
    case .toggle(let value): try container.encode(value)
    }
  }
  var text: String? { if case .text(let value) = self { value } else { nil } }
  var list: [String]? { if case .list(let value) = self { value } else { nil } }
  var toggle: Bool? { if case .toggle(let value) = self { value } else { nil } }
  /// Equal as JavaScript compares them, code unit by code unit. Swift's own `==` on strings would
  /// call "Café" written two ways the same answer, where the web sees two options.
  static func == (a: FormValue, b: FormValue) -> Bool {
    switch (a, b) {
    case (.text(let x), .text(let y)): JS.same(x, y)
    case (.list(let x), .list(let y)): x.count == y.count && zip(x, y).allSatisfy(JS.same)
    case (.toggle(let x), .toggle(let y)): x == y
    default: false
    }
  }
}

/// JavaScript's string rules, so a card is accepted, measured and written exactly as on the web.
enum JS {
  /// `String.prototype.length`: UTF-16 code units, not Swift's characters.
  static func length(_ value: String) -> Int { value.utf16.count }
  /// `String.prototype.trim`: JavaScript's white space and line terminators. Foundation's set also
  /// holds U+0085 and lacks U+FEFF, so it would trim differently.
  private static let space: Set<Unicode.Scalar> = Set("\t\n\u{0B}\u{0C}\r \u{A0}\u{1680}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}".unicodeScalars)
    .union((0x2000...0x200A).compactMap(Unicode.Scalar.init))
  static func trim(_ value: String) -> String {
    let scalars = value.unicodeScalars
    guard let first = scalars.firstIndex(where: { !space.contains($0) }), let last = scalars.lastIndex(where: { !space.contains($0) }) else { return "" }
    return String(scalars[first...last])
  }
  /// `===` on strings: the same code units. Swift's `==` also matches canonically equivalent text.
  static func same(_ a: String, _ b: String) -> Bool { a.utf16.elementsEqual(b.utf16) }
  static func distinct(_ values: [String]) -> Bool { Set(values.map { Array($0.utf16) }).count == values.count }
  static func contains(_ values: [String], _ value: String) -> Bool { values.contains { same($0, value) } }
  /// `String(number)`: the shortest digits that round-trip, written with an exponent only below
  /// 1e-6 or from 1e21. Swift's description agrees on the digits but not on where exponents start.
  static func number(_ value: Double) -> String {
    if value == 0 { return "0" }
    var text = "\(abs(value))", exponent = 0
    if let mark = text.firstIndex(where: { $0 == "e" || $0 == "E" }) { exponent = Int(text[text.index(after: mark)...]) ?? 0; text = String(text[..<mark]) }
    let halves = text.split(separator: ".", omittingEmptySubsequences: false)
    var digits = String(halves[0]) + (halves.count > 1 ? String(halves[1]) : "")
    var point = halves[0].count + exponent
    while digits.count > 1 && digits.hasPrefix("0") { digits.removeFirst(); point -= 1 }
    while digits.count > 1 && digits.hasSuffix("0") { digits.removeLast() }
    let count = digits.count
    let written: String
    if count <= point && point <= 21 { written = digits + String(repeating: "0", count: point - count) }
    else if 0 < point && point <= 21 { written = String(digits.prefix(point)) + "." + String(digits.dropFirst(point)) }
    else if -6 < point && point <= 0 { written = "0." + String(repeating: "0", count: -point) + digits }
    else {
      let power = point - 1
      written = (count == 1 ? digits : String(digits.prefix(1)) + "." + String(digits.dropFirst())) + "e" + (power >= 0 ? "+" : "-") + String(abs(power))
    }
    return (value < 0 ? "-" : "") + written
  }
}

struct FormField: Codable, Identifiable, Equatable {
  var id: String
  var label: String
  var kind: String
  var required: Bool?
  var help: String?
  var placeholder: String?
  var options: [String]?
  var value: FormValue?
  var isRequired: Bool { required == true }
}

enum ReplyActionRules {
  static let fieldKinds: Set<String> = ["text", "textarea", "number", "date", "select", "choice", "multi", "toggle"]
  static let choosing: Set<String> = ["select", "choice", "multi"]
  static func trimmed(_ value: String) -> String { JS.trim(value) }
  /// Trimmed text of 1 to `max` UTF-16 units, as the web's `text(value, max, 1, true)` accepts it.
  static func title(_ value: String, _ max: Int) -> Bool { (1...max).contains(JS.length(trimmed(value))) }
  /// A single address, as people write them: no display names, spaces or list separators.
  static func address(_ value: String) -> Bool {
    let value = trimmed(value)
    return (3...254).contains(JS.length(value)) && value.range(of: #"^[^\s@<>()\[\],;:"]+@[^\s@<>()\[\],;:"]+\.[^\s@<>()\[\],;:"]+$"#, options: .regularExpression) != nil
  }
  /// HTML's valid floating-point number, the only text a number field shows, and finite. ASCII digits
  /// only: the pattern's `\d` would also match other scripts' digits, which JavaScript's does not.
  static func decimal(_ value: String) -> Bool {
    value.range(of: #"^-?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$"#, options: .regularExpression) != nil
      && Double(value).map { $0.isFinite } == true
  }
  /// A real calendar day as YYYY-MM-DD, so 2026-02-30 is not one.
  static func day(_ value: String) -> Bool {
    guard value.range(of: #"^[0-9]{4}-[0-9]{2}-[0-9]{2}$"#, options: .regularExpression) != nil else { return false }
    let formatter = DateFormatter()
    formatter.calendar = Calendar(identifier: .gregorian); formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = TimeZone(identifier: "UTC"); formatter.dateFormat = "yyyy-MM-dd"; formatter.isLenient = false
    return formatter.date(from: value).map { formatter.string(from: $0) == value } == true
  }
  /// Whether a value suits its field: one of its options, a real day, a number or a switch.
  static func fits(_ field: FormField, _ value: FormValue) -> Bool {
    switch field.kind {
    case "toggle": return value.toggle != nil
    case "multi":
      guard let list = value.list, let options = field.options else { return false }
      return list.count <= options.count && JS.distinct(list) && list.allSatisfy { JS.contains(options, $0) }
    case "select", "choice": return value.text.map { JS.contains(field.options ?? [], $0) } == true
    case "date": return value.text.map(day) == true
    case "number": return value.text.map(decimal) == true
    default: return value.text.map { JS.length($0) <= 4000 } == true
    }
  }
  static func validField(_ field: FormField) -> Bool {
    guard ReplyCards.validId(field.id), fieldKinds.contains(field.kind), title(field.label, 200),
      JS.length(field.help ?? "") <= 500, JS.length(field.placeholder ?? "") <= 200 else { return false }
    // Options belong to the kinds that choose among them, and those kinds need at least one.
    if choosing.contains(field.kind) {
      guard let options = field.options, (1...20).contains(options.count), options.allSatisfy({ title($0, 200) }),
        JS.distinct(options.map(trimmed)) else { return false }
    } else if field.options != nil { return false }
    return field.value.map { fits(normalized(field), $0) } ?? true
  }
  static func validEmail(_ card: ReplyCard) -> Bool {
    for list in [card.to, card.cc] { if let list { guard (1...20).contains(list.count), list.allSatisfy(address) else { return false } } }
    if let subject = card.subject { guard title(subject, 500) else { return false } }
    guard let body = card.body, !trimmed(body).isEmpty, (1...20_000).contains(JS.length(body)) else { return false }
    return true
  }
  static func validForm(_ card: ReplyCard) -> Bool {
    guard JS.length(card.description ?? "") <= 2000, let fields = card.fields, (1...20).contains(fields.count),
      JS.distinct(fields.map(\.id)), fields.allSatisfy(validField) else { return false }
    if let label = card.submitLabel { guard title(label, 40) else { return false } }
    return true
  }
  /// The field as the web keeps it: label and options trimmed.
  static func normalized(_ field: FormField) -> FormField {
    var field = field
    field.label = trimmed(field.label); field.options = field.options?.map(trimmed)
    return field
  }
  /// The card as the web keeps it: title, headers, labels and options trimmed; the body as written.
  static func normalized(_ card: ReplyCard) -> ReplyCard {
    var card = card
    card.title = trimmed(card.title)
    card.to = card.to?.map(trimmed); card.cc = card.cc?.map(trimmed); card.subject = card.subject.map(trimmed)
    card.submitLabel = card.submitLabel.map(trimmed); card.fields = card.fields?.map(normalized)
    return card
  }
}

/// ASCII letters and digits only: `CharacterSet.alphanumerics` also holds letters such as é,
/// which a URL must escape.
let asciiAlphanumerics = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789")

enum EmailDraft {
  /// What JavaScript's encodeURIComponent leaves alone, so a draft opens the same from every client.
  /// RFC 6068 wants line breaks in a mailto body as CRLF; addresses keep their @ readable.
  private static let allowed = asciiAlphanumerics.union(CharacterSet(charactersIn: "-_.!~*'()"))
  private static func component(_ value: String) -> String { value.addingPercentEncoding(withAllowedCharacters: allowed) ?? "" }
  private static func mailText(_ value: String) -> String {
    component(value.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n").replacingOccurrences(of: "\n", with: "\r\n"))
  }
  static func mailto(_ card: ReplyCard) -> URL? {
    var fields: [String] = []
    if let cc = card.cc { fields.append("cc=" + cc.map(component).joined(separator: ",")) }
    if let subject = card.subject { fields.append("subject=" + mailText(subject)) }
    fields.append("body=" + mailText(card.body ?? ""))
    let query = fields.joined(separator: "&")
    let to = (card.to ?? []).map(component).joined(separator: ",")
    return URL(string: ("mailto:" + to + "?" + query).replacingOccurrences(of: "%40", with: "@"))
  }
  /// Gmail's compose window with the draft filled in. Nothing sends until the person presses Send.
  static func gmail(_ card: ReplyCard) -> URL? {
    var parts = URLComponents(string: "https://mail.google.com/mail/")!
    var items = [URLQueryItem(name: "view", value: "cm"), URLQueryItem(name: "fs", value: "1")]
    if let to = card.to { items.append(URLQueryItem(name: "to", value: to.joined(separator: ","))) }
    if let cc = card.cc { items.append(URLQueryItem(name: "cc", value: cc.joined(separator: ","))) }
    if let subject = card.subject { items.append(URLQueryItem(name: "su", value: subject)) }
    items.append(URLQueryItem(name: "body", value: card.body ?? ""))
    parts.queryItems = items
    // URLComponents leaves "+" alone, which Gmail reads as a space.
    parts.percentEncodedQuery = parts.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
    return parts.url
  }
  static func text(_ card: ReplyCard) -> String {
    var headers: [String] = []
    if let to = card.to { headers.append("To: " + to.joined(separator: ", ")) }
    if let cc = card.cc { headers.append("Cc: " + cc.joined(separator: ", ")) }
    if let subject = card.subject { headers.append("Subject: " + subject) }
    return headers.isEmpty ? card.body ?? "" : headers.joined(separator: "\n") + "\n\n" + (card.body ?? "")
  }
}

enum FormAnswers {
  typealias Answers = [String: FormValue]
  static func start(_ card: ReplyCard) -> Answers {
    Dictionary(uniqueKeysWithValues: (card.fields ?? []).map { field in
      (field.id, field.value ?? (field.kind == "multi" ? .list([]) : field.kind == "toggle" ? .toggle(false) : .text("")))
    })
  }
  /// The answer after tapping `option`: the one choice for `choice`, otherwise `option` added to or
  /// removed from `chosen`, matched by exact code units as the web matches them.
  static func choose(_ option: String, kind: String, from chosen: [String]) -> FormValue {
    if kind == "choice" { return .text(option) }
    return .list(JS.contains(chosen, option) ? chosen.filter { !JS.same($0, option) } : chosen + [option])
  }
  static func answered(_ value: FormValue?) -> Bool {
    switch value {
    case .list(let list)?: !list.isEmpty
    case .text(let text)?: !ReplyActionRules.trimmed(text).isEmpty
    case .toggle?: true
    case nil: false
    }
  }
  private static let reasons = ["text": "Keep this under 4,000 characters.", "textarea": "Keep this under 4,000 characters.", "number": "Enter a number.",
    "date": "Enter a real date.", "select": "Choose one of the options.", "choice": "Choose one of the options.", "multi": "Choose from the options.", "toggle": "Turn this on or off."]
  /// What stops the answers from going, by field ID, and why.
  static func problems(_ card: ReplyCard, _ answers: Answers) -> [String: String] {
    var problems: [String: String] = [:]
    for field in card.fields ?? [] {
      let value = answers[field.id]
      if field.kind != "toggle" && !answered(value) {
        if field.isRequired { problems[field.id] = field.kind == "multi" ? "Choose at least one." : "This one needs an answer." }
      } else if value == nil || !ReplyActionRules.fits(field, value!) { problems[field.id] = reasons[field.kind] }
    }
    return problems
  }
  /// The message that carries the answers, written exactly as the web writes it.
  static func text(_ card: ReplyCard, _ answers: Answers) -> String {
    let lines = (card.fields ?? []).flatMap { field -> [String] in
      let value = answers[field.id]
      if field.kind != "toggle" && !answered(value) { return [] }
      let shown: String
      switch value {
      case .toggle(let on)?: shown = on ? "Yes" : "No"
      case .list(let list)?: shown = list.joined(separator: ", ")
      case .text(let text)?: shown = ReplyActionRules.trimmed(text)
      case nil: shown = "No"
      }
      // As the web: a value holding a line feed starts on its own line, split at CRLF, CR or LF.
      // Foundation's string methods here work on UTF-16, where Swift's own would see CRLF as one character.
      guard shown.utf16.contains(10) else { return ["- \(field.label): \(shown)"] }
      let lines = shown.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n").components(separatedBy: "\n")
      return ["- \(field.label):"] + lines.map { "  " + $0 }
    }
    return (["My answers to \"\(card.title)\":"] + (lines.isEmpty ? ["- (No answers given)"] : lines)).joined(separator: "\n")
  }
  /// The request ID for one person's answers to one form, as `formRequestId` in src/shared/retry-id.ts:
  /// a version 4 UUID from SHA-256 over `wildbots-form`, the person's form key, the assistant, the
  /// message, the card and the attempt, joined with NUL. docs/native-api.md lists test vectors.
  static func requestId(formKey: String, botId: String, messageId: String, cardId: String, attempt: Int) -> String {
    var bytes = Array(SHA256.hash(data: Data(["wildbots-form", formKey, botId, messageId, cardId, String(attempt)].joined(separator: "\u{0}").utf8)).prefix(16))
    bytes[6] = (bytes[6] & 0x0F) | 0x40
    bytes[8] = (bytes[8] & 0x3F) | 0x80
    let hex = bytes.map { String(format: "%02x", $0) }.joined()
    return [hex.prefix(8), hex.dropFirst(8).prefix(4), hex.dropFirst(12).prefix(4), hex.dropFirst(16).prefix(4), hex.dropFirst(20)]
      .map(String.init).joined(separator: "-")
  }
}

// MARK: T3 Code threads

/// A T3 Code thread an assistant started with `t3_thread_launch`, as src/shared/t3-code.ts reads it.
struct T3Thread: Equatable, Identifiable {
  enum State: Equatable { case starting, started, failed }
  var id: String
  var state: State
  var title: String
  var prompt: String?
  var model: String?
  var workspace: String?
  var plan = false
  var url: URL?
  var error: String?

  static let hostedApp = "https://app.t3.codes"
  static func isLaunch(_ name: String) -> Bool { name.range(of: #"(^|_)t3_thread_launch$"#, options: .regularExpression) != nil }
  private static func json(_ text: String?) -> Any? {
    guard let text else { return nil }
    return (try? JSONSerialization.jsonObject(with: Data(text.utf8), options: [.fragmentsAllowed])) ?? text
  }
  private static func words(_ value: Any?, _ max: Int) -> String? {
    guard let value = value as? String else { return nil }
    let single = value.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    guard !single.isEmpty else { return nil }
    return single.count > max ? String(single.prefix(max - 1)).trimmingCharacters(in: .whitespaces) + "…" : single
  }
  /// T3 Code's answer inside Hermes's wrapping: the first object that names a thread, at most three layers down.
  private static func answer(_ text: String?) -> [String: Any]? {
    var value = json(text)
    for _ in 0..<3 {
      guard let object = value as? [String: Any] else { return nil }
      if object["threadId"] is String { return object }
      if let structured = object["structuredContent"] as? [String: Any], structured["threadId"] is String { return structured }
      guard let next = object["result"] else { return nil }
      value = (next as? String).flatMap { json($0) } ?? next
    }
    return nil
  }
  private static func reportedError(_ call: ToolCall) -> String? {
    if let error = call.error { return words(error, 300) }
    var value = json(call.result)
    for _ in 0..<3 {
      guard let object = value as? [String: Any] else { return nil }
      if let error = object["error"] as? String { return words(error, 300) }
      if let error = object["error"] as? [String: Any], let message = error["message"] as? String { return words(message, 300) }
      value = (object["result"] as? String).flatMap { json($0) } ?? object["result"]
    }
    return nil
  }
  private static func segment(_ id: String) -> String {
    // As T3 Code escapes a hosted link: even URL-safe punctuation, so a sentence's period never joins an ID.
    id.addingPercentEncoding(withAllowedCharacters: asciiAlphanumerics.union(CharacterSet(charactersIn: "-_"))) ?? id
  }
  /// T3 Code's hosted link as given, or a `t3-thread://v2/` link rewritten to one. Anything else opens nothing.
  static func url(_ link: Any?) -> URL? {
    guard var written = (link as? String)?.trimmingCharacters(in: .whitespaces) else { return nil }
    if written.hasPrefix("<") && written.hasSuffix(">") { written = String(written.dropFirst().dropLast()) }
    let prefix = "t3-thread://v2/"
    if written.hasPrefix(prefix) {
      let parts = written.dropFirst(prefix.count).split(separator: "/", omittingEmptySubsequences: false)
      guard parts.count == 2, !parts[0].isEmpty, !parts[1].isEmpty, !parts.joined().contains(where: \.isWhitespace) else { return nil }
      let ids = parts.map { String($0).removingPercentEncoding ?? String($0) }
      return URL(string: "\(hostedApp)/threads/\(segment(ids[0]))/\(segment(ids[1]))")
    }
    guard let url = URL(string: written), url.scheme == "https", url.user == nil, url.password == nil,
      // The encoded path, as the web reads it: a hosted link escapes its IDs, and the decoded path
      // would turn %2E back into a dot the pattern refuses.
      url.path(percentEncoded: true).range(of: #"^/threads/[A-Za-z0-9_%-]+/[A-Za-z0-9_%-]+/?$"#, options: .regularExpression) != nil else { return nil }
    return url
  }
  private static func model(_ selection: Any?) -> String? {
    words((selection as? [String: Any])?["model"], 120).map(ModelNames.format)
  }
  private static func workspace(_ args: [String: Any]) -> String? {
    if args["scratch"] as? Bool == true { return "Scratch folder" }
    let strategy = args["workspaceStrategy"] as? [String: Any]
    switch strategy?["type"] as? String {
    case "worktree": return words(strategy?["branch"], 80).map { "New worktree on \($0)" } ?? "New worktree"
    case "existing_worktree": return "Existing worktree"
    case "root": return "Project checkout"
    default: return nil
    }
  }
  /// The thread a launch call started, is starting, or failed to start. Nil for any other tool.
  static func from(_ call: ToolCall) -> T3Thread? {
    guard isLaunch(call.name) else { return nil }
    let args = json(call.arguments) as? [String: Any] ?? [:]
    let result = call.status == "completed" ? answer(call.result) : nil
    let failed = call.status == "failed" || call.status == "completed" && result == nil
    var thread = T3Thread(id: call.id, state: call.status == "running" ? .starting : failed ? .failed : .started,
      title: words(args["title"], 200) ?? "New thread")
    thread.prompt = words(args["message"], 280)
    thread.model = model(result?["modelSelection"]) ?? model(args["modelSelection"])
    thread.workspace = workspace(args)
    thread.plan = args["interactionMode"] as? String == "plan"
    if thread.state == .started { thread.url = url(result?["link"]) }
    if thread.state == .failed { thread.error = reportedError(call) ?? "T3 Code didn't report the new thread." }
    return thread
  }
}

enum ModelNames {
  /// A readable name for a model slug, as src/shared/model-name.ts: `claude-opus-5-5` becomes
  /// "Claude Opus 5.5" and `gpt-6.1-terra` becomes "GPT-6.1-Terra". Other families stay as written.
  static func format(_ slug: String) -> String {
    let separator = slug.lastIndex(of: "/").map { slug.index(after: $0) } ?? slug.startIndex
    let prefix = String(slug[..<separator]), name = String(slug[separator...])
    if name.range(of: #"^gpt-\d"#, options: [.regularExpression, .caseInsensitive]) != nil {
      var result = "GPT" + name.dropFirst(3)
      while let range = result.range(of: #"-[a-z]"#, options: .regularExpression) { result.replaceSubrange(range, with: result[range].uppercased()) }
      return prefix + result
    }
    guard name.range(of: #"^(claude-(opus|sonnet|haiku|fable)|gemini|grok|composer)-\d"#, options: [.regularExpression, .caseInsensitive]) != nil else { return slug }
    var dotted = name
    if let range = dotted.range(of: #"^(claude-[a-zA-Z]+-\d+)-(\d{1,2})(?=-|\[|$)"#, options: .regularExpression) {
      let matched = String(dotted[range]), cut = matched.lastIndex(of: "-")!
      dotted.replaceSubrange(range, with: String(matched[..<cut]) + "." + String(matched[matched.index(after: cut)...]))
    }
    return prefix + dotted.split(separator: "-", omittingEmptySubsequences: false).map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined(separator: " ")
  }
}

extension ConversationTurn {
  /// The T3 Code threads this turn's tools started, shown beside its work rather than inside it.
  var t3Threads: [T3Thread] { messages.compactMap { $0.toolCall.flatMap(T3Thread.from) } }
}

struct T3ThreadCardView: View {
  var thread: T3Thread
  @Environment(\.colorScheme) private var scheme
  private var heading: String {
    switch thread.state { case .starting: "Starting a T3 Code thread"; case .started: "T3 Code thread started"; case .failed: "T3 Code thread didn't start" }
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 6) {
        if thread.state == .starting { ProgressView().controlSize(.mini) }
        else { Image(systemName: thread.state == .failed ? "exclamationmark.triangle" : "terminal") }
        Text(heading)
      }.font(.caption2.weight(.semibold)).textCase(.uppercase)
        .foregroundStyle(thread.state == .started ? Palette.accent : thread.state == .failed ? Palette.danger : Palette.muted)
      Text(thread.title).font(.headline)
      if let prompt = thread.prompt { Text(prompt).font(.subheadline).foregroundStyle(Palette.muted).lineLimit(3) }
      let facts = [thread.model, thread.workspace, thread.plan ? "Plan mode" : nil].compactMap { $0 }
      if !facts.isEmpty { Text(facts.joined(separator: " · ")).font(.caption).foregroundStyle(Palette.muted) }
      if let error = thread.error { Text(error).font(.footnote).foregroundStyle(Palette.danger) }
      if let url = thread.url {
        Link(destination: url) { Label("Open in T3 Code", systemImage: "arrow.up.right.square").frame(maxWidth: .infinity) }
          .buttonStyle(.accentProminent).controlSize(.large).accessibilityIdentifier("t3ThreadOpen.\(thread.id)")
      } else if thread.state == .started {
        Text("Open T3 Code to find this thread.").font(.footnote).foregroundStyle(Palette.muted)
      }
    }.padding(14).frame(maxWidth: .infinity, alignment: .leading)
      .background(Palette.raised(scheme), in: RoundedRectangle(cornerRadius: 14))
      .accessibilityElement(children: .contain).accessibilityLabel("\(heading): \(thread.title)")
  }
}

// MARK: Email drafts

struct EmailDraftCardView: View {
  var card: ReplyCard
  @Environment(\.colorScheme) private var scheme
  @State private var copied = false
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Grid(alignment: .leading, horizontalSpacing: 10, verticalSpacing: 6) {
        if let to = card.to { header("To", to.joined(separator: ", ")) }
        if let cc = card.cc { header("Cc", cc.joined(separator: ", ")) }
        header("Subject", card.subject ?? "No subject")
      }
      Text(card.body ?? "").font(.subheadline).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
        .padding(12).background(Palette.surface(scheme), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Palette.line))
      ViewThatFits(in: .horizontal) {
        HStack(spacing: 10) { actions }
        VStack(alignment: .leading, spacing: 10) { actions }
      }
      Text("Nothing has been sent. Your mail app opens with this draft so you can review it first.").font(.caption).foregroundStyle(Palette.muted)
    }
  }
  @ViewBuilder private var actions: some View {
    if let url = EmailDraft.mailto(card) {
      Link(destination: url) { Label("Open in Mail", systemImage: "envelope") }.buttonStyle(.accentProminent).accessibilityIdentifier("emailMail.\(card.id)")
    }
    if let url = EmailDraft.gmail(card) {
      Link(destination: url) { Label("Open in Gmail", systemImage: "arrow.up.right.square") }.buttonStyle(.bordered)
    }
    Button { UIPasteboard.general.string = EmailDraft.text(card); copied = true } label: {
      Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
    }.buttonStyle(.bordered).accessibilityIdentifier("emailCopy.\(card.id)")
  }
  private func header(_ name: String, _ value: String) -> some View {
    GridRow {
      Text(name).font(.caption).foregroundStyle(Palette.muted)
      Text(value).font(.subheadline).foregroundStyle(card.subject == nil && name == "Subject" ? Palette.muted : Color.primary).textSelection(.enabled)
    }
  }
}

// MARK: Forms

/// When one saved form record may replace another, as the web's `mayReplace` in FormReplyCard.tsx.
/// Several copies of a card share one record, so a stale copy never undoes another's progress: a
/// later attempt's record is never overwritten by what happened to an earlier one (moving on from
/// attempt `from` counts as happening to `from`), and within an attempt a record never goes back,
/// except when the copy that owns the checking request learns the server refused it outright.
enum FormRecords {
  private static let progress = ["editing": 0, "checking": 1, "sent": 2, "interrupted": 2]
  static func mayReplace(_ stored: SavedFormReply?, with next: SavedFormReply, from: Int? = nil, owns: String? = nil) -> Bool {
    guard let stored else { return true }
    if stored.attempt > (from ?? next.attempt) { return false }
    if stored.attempt != next.attempt || progress[next.state, default: 0] >= progress[stored.state, default: 0] { return true }
    return stored.state == "checking" && owns != nil && stored.requestId == owns
  }
}

/// What this device keeps for one form, as the web's FormReplyCard keeps it.
struct SavedFormReply: Codable, Equatable {
  var attempt: Int
  var answers: [String: FormValue]
  var state: String
  var requestId: String?
  var elsewhere: Bool?
}

struct FormReplyCardView: View {
  var card: ReplyCard
  var messageId: String
  @Environment(AppStore.self) private var store: AppStore?
  @Environment(\.transcriptConnected) private var connected
  enum Status: Equatable { case looking, editing, sending, checking, sent, interrupted }
  /// The one request a check follows: its ID, attempt and the answers it carried.
  struct Pending: Equatable { var id: String; var attempt: Int; var answers: FormAnswers.Answers; var elsewhere: Bool }
  @State private var loaded = false
  @State private var status = Status.looking
  @State private var answers: FormAnswers.Answers = [:]
  @State private var attempt = 0
  @State private var elsewhere = false
  @State private var pending: Pending?
  @State private var problems: [String: String] = [:]
  @State private var error: String?
  @FocusState private var focused: String?
  /// The first field with a problem takes VoiceOver focus, whatever its kind.
  @AccessibilityFocusState private var spokenProblem: String?
  /// The assistant this form belongs to, kept from when it opened: a send can finish after the
  /// person has opened another assistant, and must still save under this one.
  @State private var bot: String?
  private static let refused = "Hermes didn't take your answers."
  private static let unconfirmed = "Hermes hasn't confirmed your answers yet. They're being checked and won't be sent twice."
  /// Attempts checked on open; each one past the first exists only because Hermes refused the one before.
  private static let lookupLimit = 100

  private var botId: String { bot ?? store?.selectedBotId ?? "" }
  private var storageKey: String? { store?.key(.formReply, "\(botId).\(messageId).\(card.id)") }
  /// Every client of this server has the key. An older server has none, and the person's ID stands in.
  private var formKey: String { store?.bootstrap?.formKey ?? store?.bootstrap?.user.id ?? "" }
  private func requestId(_ attempt: Int) -> String {
    FormAnswers.requestId(formKey: formKey, botId: botId, messageId: messageId, cardId: card.id, attempt: attempt)
  }
  private func readSaved() -> SavedFormReply? {
    guard let store, let saved: SavedFormReply = store.read(storageKey), saved.attempt >= 0,
      ["editing", "checking", "sent", "interrupted"].contains(saved.state) else { return nil }
    var kept = saved
    if let id = saved.requestId, id.range(of: #"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"#, options: .regularExpression) == nil { kept.requestId = nil }
    return kept
  }
  /// Saves unless that would undo another copy's progress; see `FormRecords.mayReplace`.
  private func save(_ next: SavedFormReply, from: Int? = nil, owns: String? = nil) {
    guard let store, FormRecords.mayReplace(readSaved(), with: next, from: from, owns: owns) else { return }
    store.save(next, storageKey)
  }


  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      if let description = card.description { Text(description).font(.subheadline) }
      switch status {
      case .sent:
        if elsewhere { Text("Your answers were sent from another device or tab.").font(.footnote).foregroundStyle(Palette.muted) }
        else {
          ForEach(card.fields ?? []) { field in
            VStack(alignment: .leading, spacing: 2) {
              Text(field.label).font(.caption).foregroundStyle(Palette.muted)
              Text(Self.shown(answers[field.id])).font(.subheadline).textSelection(.enabled)
            }
          }
        }
        Label("Sent", systemImage: "checkmark").font(.subheadline.weight(.semibold)).foregroundStyle(Palette.accent).accessibilityIdentifier("formSent.\(card.id)")
      case .interrupted:
        Text("Hermes restarted while it had \(elsewhere ? "answers to this form" : "your answers"), so they may or may not have arrived. Check the conversation above.")
          .font(.subheadline)
        Button("They didn't arrive. Edit and send again") { sendAgain() }.buttonStyle(.bordered).disabled(!connected)
      default:
        ForEach(card.fields ?? []) { field in fieldView(field) }
        if let error { ErrorBanner(message: error) }
        Button {
          Task { await send() }
        } label: {
          HStack(spacing: 8) {
            if status != .editing { ProgressView().controlSize(.small) }
            Text(status == .sending ? "Sending…" : status == .checking || status == .looking ? "Checking…" : card.submitLabel ?? "Send answers")
          }.frame(maxWidth: .infinity)
        }.buttonStyle(.accentProminent).controlSize(.large).disabled(status != .editing || !connected)
          .accessibilityIdentifier("formSend.\(card.id)")
        if !connected && status == .editing { Text("Reconnect to send your answers.").font(.caption).foregroundStyle(Palette.muted) }
      }
    }
    .task(id: "\(store?.scope ?? ""):\(messageId):\(card.id)") { await open() }
    .task(id: pending?.id) { await check() }
  }

  // MARK: Fields

  @ViewBuilder private func fieldView(_ field: FormField) -> some View {
    let problem = problems[field.id]
    let locked = status != .editing
    let grouped = field.kind == "choice" || field.kind == "multi"
    VStack(alignment: .leading, spacing: 6) {
      if field.kind != "toggle" {
        HStack(spacing: 2) {
          Text(field.label).font(.subheadline.weight(.semibold))
          if field.isRequired { Text("*").foregroundStyle(Palette.danger).accessibilityHidden(true) }
        }.accessibilityElement(children: .combine).accessibilityLabel(Self.spoken(field))
          // A single control carries the field's name itself; a group of choices keeps it as a heading.
          .accessibilityHidden(!grouped).accessibilityAddTraits(.isHeader)
      }
      // Help and the problem are read with the control, as its hint, so they are not read twice.
      if let help = field.help { Text(help).font(.caption).foregroundStyle(Palette.muted).accessibilityHidden(true) }
      control(field).disabled(locked)
      if let problem {
        Text(problem).font(.caption).foregroundStyle(Palette.danger)
          .accessibilityLabel("\(field.label): \(problem)").accessibilityFocused($spokenProblem, equals: field.id)
      }
    }.accessibilityElement(children: .contain).accessibilityIdentifier("form.\(card.id).\(field.id)")
  }
  /// The field's name as VoiceOver reads it, with "required" where it is.
  private static func spoken(_ field: FormField) -> String { field.isRequired ? "\(field.label), required" : field.label }
  /// What a control's hint reads after its name: the problem first, then the help.
  private func hint(_ field: FormField) -> String { [problems[field.id], field.help].compactMap { $0 }.joined(separator: ". ") }
  @ViewBuilder private func control(_ field: FormField) -> some View {
    switch field.kind {
    case "choice", "multi":
      let chosen = answers[field.id]?.list ?? answers[field.id]?.text.map { [$0] } ?? []
      VStack(spacing: 8) {
        // Options are told apart as the web tells them apart: by position and exact code units,
        // never by Swift's string equality, which merges canonically equivalent spellings.
        ForEach(Array((field.options ?? []).enumerated()), id: \.offset) { index, option in
          let on = JS.contains(chosen, option)
          Button {
            set(field, FormAnswers.choose(option, kind: field.kind, from: chosen))
          } label: {
            HStack(spacing: 10) {
              Image(systemName: field.kind == "choice" ? (on ? "largecircle.fill.circle" : "circle") : (on ? "checkmark.square.fill" : "square"))
                .foregroundStyle(on ? Palette.accent : Palette.muted)
              Text(option).frame(maxWidth: .infinity, alignment: .leading)
            }.padding(12).contentShape(Rectangle())
              .background(RoundedRectangle(cornerRadius: 10).fill(on ? Palette.accentSoft : Color.clear))
              .overlay(RoundedRectangle(cornerRadius: 10).stroke(on ? Palette.accent : Palette.line))
          }.buttonStyle(.plain).accessibilityAddTraits(on ? .isSelected : []).accessibilityHint(hint(field))
            .accessibilityIdentifier("form.\(card.id).\(field.id).\(index)")
        }
      }
    case "toggle":
      Toggle(isOn: Binding(get: { answers[field.id]?.toggle ?? false }, set: { set(field, .toggle($0)) })) {
        Text(field.label).font(.subheadline.weight(.semibold))
      }.tint(Palette.accent).accessibilityHint(hint(field))
    case "select":
      let options = field.options ?? []
      // Tagged by position, so two spellings of the same word stay two choices.
      Picker(field.label, selection: Binding(
        get: { answers[field.id]?.text.flatMap { value in options.firstIndex { JS.same($0, value) } } ?? -1 },
        set: { set(field, .text($0 >= 0 && $0 < options.count ? options[$0] : "")) })) {
        Text("Choose…").tag(-1)
        ForEach(Array(options.enumerated()), id: \.offset) { index, option in Text(option).tag(index) }
      }.pickerStyle(.menu).accessibilityLabel(Self.spoken(field)).accessibilityHint(hint(field))
    case "date":
      let text = answers[field.id]?.text ?? ""
      if let date = Self.dayFormatter.date(from: text) {
        HStack {
          DatePicker(Self.spoken(field), selection: Binding(get: { date }, set: { set(field, .text(Self.dayFormatter.string(from: $0))) }), displayedComponents: .date)
            .labelsHidden().accessibilityHint(hint(field))
          Button("Clear") { set(field, .text("")) }.buttonStyle(.borderless)
        }
      } else {
        Button("Choose a date", systemImage: "calendar") { set(field, .text(Self.dayFormatter.string(from: Date()))) }.buttonStyle(.bordered)
          .accessibilityLabel("\(Self.spoken(field)): choose a date").accessibilityHint(hint(field))
      }
    default:
      let binding = Binding(get: { answers[field.id]?.text ?? "" }, set: { set(field, .text(String($0.prefix(4000)))) })
      Group {
        // The field's name labels the control; the placeholder is only its prompt.
        if field.kind == "textarea" { TextField(Self.spoken(field), text: binding, prompt: Text(field.placeholder ?? ""), axis: .vertical).lineLimit(3...8) }
        else { TextField(Self.spoken(field), text: binding, prompt: Text(field.placeholder ?? "")).keyboardType(field.kind == "number" ? .decimalPad : .default) }
      }.textFieldStyle(.roundedBorder).focused($focused, equals: field.id).accessibilityHint(hint(field))
    }
  }
  private static let dayFormatter: DateFormatter = {
    let formatter = DateFormatter()
    formatter.calendar = Calendar(identifier: .gregorian); formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.dateFormat = "yyyy-MM-dd"
    return formatter
  }()
  private static func shown(_ value: FormValue?) -> String {
    switch value {
    case .toggle(let on)?: on ? "Yes" : "No"
    case .list(let list)?: list.isEmpty ? "No answer" : list.joined(separator: ", ")
    case .text(let text)?: ReplyActionRules.trimmed(text).isEmpty ? "No answer" : ReplyActionRules.trimmed(text)
    case nil: "No answer"
    }
  }
  private func set(_ field: FormField, _ value: FormValue) {
    // A text field writes its unchanged value back when it takes focus; that is not an answer.
    guard answers[field.id] != value else { return }
    answers[field.id] = value
    problems[field.id] = nil
    if status == .editing { save(SavedFormReply(attempt: attempt, answers: answers, state: "editing")) }
  }

  // MARK: Admission

  /// Restores what this device saved, or looks up where the form stands when it saved nothing.
  private func open() async {
    guard !loaded else { return }
    loaded = true
    bot = store?.selectedBotId
    let start = FormAnswers.start(card)
    guard let saved = readSaved() else { answers = start; await lookUp(); return }
    answers = start.merging(saved.answers.filter { start.keys.contains($0.key) }) { $1 }
    attempt = saved.attempt; elsewhere = saved.elsewhere == true
    switch saved.state {
    case "sent": status = .sent
    case "interrupted": status = .interrupted
    case "checking":
      pending = Pending(id: saved.requestId ?? requestId(saved.attempt), attempt: saved.attempt, answers: answers, elsewhere: elsewhere)
      status = .checking
    default: status = .editing
    }
  }
  /// Skips refused attempts until the first that says where the form stands.
  private func lookUp() async {
    guard let store else { status = .editing; return }
    for next in 0... {
      if next == Self.lookupLimit { attempt = next; status = .editing; return }
      let path = "/submissions/\(APIClient.component(requestId(next)))"
      let receipt = await store.attempt { (context) -> Receipt in try await context.api.get(path) }
      if Task.isCancelled { return }
      guard case .success(let value)? = receipt else { attempt = next; status = .editing; return }
      switch value.status {
      case "rejected": continue
      case "accepted", "interrupted":
        attempt = next; elsewhere = true; status = value.status == "accepted" ? .sent : .interrupted
        save(SavedFormReply(attempt: next, answers: FormAnswers.start(card), state: value.status == "accepted" ? "sent" : "interrupted", elsewhere: true))
        return
      default: attempt = next; status = .editing; return
      }
    }
  }
  private func send() async {
    guard status == .editing, connected, let store else { return }
    let found = FormAnswers.problems(card, answers)
    problems = found
    if let first = (card.fields ?? []).first(where: { found[$0.id] != nil }) {
      error = nil; spokenProblem = first.id
      if !["choice", "multi", "toggle", "select", "date"].contains(first.kind) { focused = first.id }
      return
    }
    let text = FormAnswers.text(card, answers)
    if text.utf16.count > AppStore.maxMessageLength {
      error = "Your answers are \((text.utf16.count - AppStore.maxMessageLength).formatted()) characters too long to send. Shorten the longest one."
      return
    }
    status = .sending; error = nil
    let from = Pending(id: requestId(attempt), attempt: attempt, answers: answers, elsewhere: false)
    // Saved first, so leaving while the request is out checks it on return.
    save(SavedFormReply(attempt: attempt, answers: answers, state: "checking", requestId: from.id))
    let body = FormSubmission(requestId: from.id, text: text, attachments: [], reviewedInterruption: store.interruptionReviewed ? true : nil)
    let path = "/bots/\(APIClient.component(botId))/messages"
    switch await store.attempt({ (context) -> Receipt in try await context.api.write(path, body) }) {
    case .success(let receipt)?: settle(from, receipt)
    case .failure(let failure)?:
      if let failure = failure as? APIError, failure.code == "submission_conflict" {
        // Another tab or device sent different answers under this attempt's ID. Follow that one.
        elsewhere = true; pending = Pending(id: from.id, attempt: from.attempt, answers: from.answers, elsewhere: true); status = .checking
        save(SavedFormReply(attempt: from.attempt, answers: from.answers, state: "checking", requestId: from.id, elsewhere: true))
      } else if let failure = failure as? APIError, (400..<500).contains(failure.status) {
        // Refused before Hermes saw it, so this attempt's ID is still free.
        status = .editing; error = failure.message.isEmpty ? Self.refused : failure.message
        save(SavedFormReply(attempt: from.attempt, answers: from.answers, state: "editing"), owns: from.id)
      } else {
        pending = from; status = .checking; error = Self.unconfirmed
      }
    case nil:
      // Left mid-request; the saved record checks it on return.
      pending = from; status = .checking
    }
  }
  private struct FormSubmission: Encodable {
    var requestId: String
    var text: String
    var attachments: [FileRef]
    var reviewedInterruption: Bool?
  }
  /// Settles the one request `from` names, with the attempt and answers it carried.
  private func settle(_ from: Pending, _ receipt: Receipt) {
    switch receipt.status {
    case "accepted":
      pending = nil; status = .sent; error = nil
      save(SavedFormReply(attempt: from.attempt, answers: from.answers, state: "sent", elsewhere: from.elsewhere ? true : nil))
      store?.buzz(.sent)
    case "rejected":
      // A refused ID stays refused, so the person's next Send is a new attempt.
      pending = nil; attempt = from.attempt + 1; status = .editing; elsewhere = false; answers = from.answers
      error = receipt.message.map { $0.isEmpty ? Self.refused : "\(Self.refused) \($0)" } ?? Self.refused
      save(SavedFormReply(attempt: from.attempt + 1, answers: from.answers, state: "editing"), from: from.attempt)
    case "interrupted":
      pending = nil; status = .interrupted; error = nil
      save(SavedFormReply(attempt: from.attempt, answers: from.answers, state: "interrupted", elsewhere: from.elsewhere ? true : nil))
    default:
      pending = from; status = .checking; error = Self.unconfirmed
      save(SavedFormReply(attempt: from.attempt, answers: from.answers, state: "checking", requestId: from.id, elsewhere: from.elsewhere ? true : nil))
    }
  }
  /// Checks the pending request by its ID, every 2 seconds at first and slowing to 30, until a receipt settles it.
  private func check() async {
    guard let from = pending, status == .checking, let store else { return }
    var delay = Duration.seconds(2)
    while !Task.isCancelled, pending == from {
      // The store's own connection, not this view's: a view the transcript no longer redraws would
      // keep the snapshot it started with and never notice reconnecting.
      if store.connected, case .success(let receipt)? = await store.attempt({ (context) -> Receipt in
        try await context.api.get("/submissions/\(APIClient.component(from.id))")
      }), receipt.status != "uncertain" {
        settle(from, receipt); return
      }
      try? await Task.sleep(for: delay)
      delay = min(delay * 2, .seconds(30))
    }
  }
  private func sendAgain() {
    save(SavedFormReply(attempt: attempt + 1, answers: answers, state: "editing"), from: attempt)
    attempt += 1; elsewhere = false; status = .editing; error = nil
  }
}
