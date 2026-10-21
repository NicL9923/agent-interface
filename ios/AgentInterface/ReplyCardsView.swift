import EventKit
import EventKitUI
import SwiftUI

struct ReplyCardItem: Decodable, Identifiable {
  var id: String
  var text: String?
  var title: String?
  var time: String?
  var detail: String?
  var url: String?
}
struct ReplyCard: Decodable, Identifiable {
  var id: String
  var type: String
  var title: String
  var items: [ReplyCardItem]?
  var start: String?
  var end: String?
  var location: String?
  var description: String?
}
struct ReplyCardDocument: Decodable { var version: Int; var cards: [ReplyCard] }
struct ReplyCardState: Codable, Equatable { var checkedIds: [String] = []; var notes: [String: String] = [:] }
struct ReplyContentPart: Identifiable {
  var id: Int
  var markdown: String?
  var cards: [ReplyCard]?
  var inline: InlineDocument?
}
enum ReplyCards {
  static func spokenText(_ text: String) -> String {
    parse(text).map { part in
      if let prose = part.markdown { return prose }
      if let inline = part.inline { return inline.title }
      return (part.cards ?? []).map { card in
        ([card.title] + (card.items ?? []).map { $0.text ?? $0.title ?? "" }).joined(separator: ". ")
      }.joined(separator: "\n")
    }.joined(separator: "\n")
  }
  /// Splits a reply into prose, cards and, when `inlineUi` allows it, inline UI. Without it a
  /// wildbots-html fence stays a code block, as the web shows it outside assistant replies.
  /// Messages render on every update, so results are reused like MarkdownCache's blocks.
  static func parse(_ text: String, inlineUi: Bool = true) -> [ReplyContentPart] {
    let key = ((inlineUi ? "1" : "0") + text) as NSString
    if let cached = parsed.object(forKey: key) { return cached.parts }
    let parts = parseFresh(text, inlineUi: inlineUi)
    // A large reply still renders, but cannot evict every ordinary answer from the cache.
    if text.utf16.count <= 100_000 { parsed.setObject(Parsed(parts), forKey: key, cost: text.utf16.count * 2) }
    return parts
  }
  private final class Parsed: NSObject {
    let parts: [ReplyContentPart]
    init(_ parts: [ReplyContentPart]) { self.parts = parts }
  }
  /// NSCache is thread-safe, and its entries are immutable.
  nonisolated(unsafe) private static let parsed: NSCache<NSString, Parsed> = {
    let cache = NSCache<NSString, Parsed>()
    cache.countLimit = 128
    cache.totalCostLimit = 4 * 1024 * 1024
    return cache
  }()
  static func clearCache() { parsed.removeAllObjects() }
  static func parseFresh(_ text: String, inlineUi: Bool = true) -> [ReplyContentPart] {
    guard text.utf16.count <= 200_000 else { return [.init(id: 0, markdown: text)] }
    var parts: [ReplyContentPart] = []
    var cursor = text.startIndex
    for block in fencedBlocks(text) {
      let whole = block.whole, payload = block.payload
      if block.language == "wildbots-html" {
        guard inlineUi, let doc = InlineDocument.parse(String(text[payload])) else { continue }
        if cursor < whole.lowerBound { parts.append(.init(id: parts.count, markdown: String(text[cursor..<whole.lowerBound]))) }
        parts.append(.init(id: parts.count, inline: doc)); cursor = whole.upperBound
        continue
      }
      guard block.language == "agent-ui" else { continue }
      guard
        let data = String(text[payload]).data(using: .utf8), strictJSON(data),
        let doc = try? JSONDecoder().decode(ReplyCardDocument.self, from: data), valid(doc) else { continue }
      if cursor < whole.lowerBound { parts.append(.init(id: parts.count, markdown: String(text[cursor..<whole.lowerBound]))) }
      parts.append(.init(id: parts.count, cards: doc.cards)); cursor = whole.upperBound
    }
    if cursor < text.endIndex || parts.isEmpty { parts.append(.init(id: parts.count, markdown: String(text[cursor...]))) }
    let cards = parts.flatMap { $0.cards ?? [] }
    guard cards.count <= 8, Set(cards.map(\.id)).count == cards.count else { return [.init(id: 0, markdown: text)] }
    return parts
  }
  struct Fence { var whole: Range<String.Index>; var payload: Range<String.Index>; var language: String }
  // Scan all code fences so an example nested inside a longer fence stays code.
  static func fencedBlocks(_ text: String) -> [Fence] {
    // Most replies have no fence at all, and every opening needs three of a kind.
    guard text.contains("```") || text.contains("~~~") else { return [] }
    var result: [Fence] = []
    var active: (start: String.Index, payload: String.Index, language: String, closing: NSRegularExpression)?
    var cursor = text.startIndex
    while cursor < text.endIndex {
      let end = text[cursor...].firstIndex(of: "\n") ?? text.endIndex
      let next = end < text.endIndex ? text.index(after: end) : end
      let line = String(text[cursor..<end]).trimmingCharacters(in: .newlines)
      let range = NSRange(line.startIndex..., in: line)
      if let current = active {
        if current.closing.firstMatch(in: line, range: range) != nil {
          result.append(Fence(whole: current.start..<next, payload: current.payload..<cursor, language: current.language))
          active = nil
        }
      } else if let match = opening.firstMatch(in: line, range: range), let delimiterRange = Range(match.range(at: 1), in: line), let languageRange = Range(match.range(at: 2), in: line) {
        let delimiter = String(line[delimiterRange])
        active = (cursor, next, String(line[languageRange]).trimmingCharacters(in: .whitespaces), closing(delimiter))
      }
      cursor = next
    }
    return result
  }
  private static let opening = try! NSRegularExpression(pattern: "^ {0,3}(`{3,}|~{3,})(.*)$")
  /// Closing patterns by opening fence, compiled once each. NSRegularExpression is thread-safe.
  nonisolated(unsafe) private static let closings = NSCache<NSString, NSRegularExpression>()
  private static func closing(_ delimiter: String) -> NSRegularExpression {
    if let cached = closings.object(forKey: delimiter as NSString) { return cached }
    let pattern = "^ {0,3}" + String(delimiter.first!) + "{" + String(delimiter.count) + ",}[ \t]*$"
    let compiled = try! NSRegularExpression(pattern: pattern)
    closings.setObject(compiled, forKey: delimiter as NSString)
    return compiled
  }
  static func strictJSON(_ data: Data) -> Bool {
    guard data.count <= 100_000, let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], Set(object.keys) == ["version", "cards"], let cards = object["cards"] as? [[String: Any]] else { return false }
    return cards.allSatisfy { card in
      let type = card["type"] as? String ?? ""
      let allowed: Set<String> = type == "event" ? ["id", "type", "title", "start", "end", "location", "description"] : ["id", "type", "title", "items"]
      guard Set(card.keys).isSubset(of: allowed) else { return false }
      if type == "event" { return true }
      guard let items = card["items"] as? [[String: Any]] else { return false }
      let itemKeys: Set<String> = type == "checklist" ? ["id", "text"] : ["id", "title", "time", "detail", "url"]
      return items.allSatisfy { Set($0.keys).isSubset(of: itemKeys) }
    }
  }
  static func validId(_ id: String) -> Bool { !id.isEmpty && id.count <= 80 && id.range(of: "^[a-zA-Z0-9_-]+$", options: .regularExpression) != nil }
  static func valid(_ doc: ReplyCardDocument) -> Bool {
    guard doc.version == 1, !doc.cards.isEmpty, doc.cards.count <= 8, Set(doc.cards.map(\.id)).count == doc.cards.count else { return false }
    return doc.cards.allSatisfy { card in
      guard validId(card.id), !card.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, card.title.count <= 200 else { return false }
      switch card.type {
      case "checklist", "itinerary":
        guard let items = card.items, !items.isEmpty, items.count <= 60, Set(items.map(\.id)).count == items.count else { return false }
        return items.allSatisfy { item in
          guard validId(item.id) else { return false }
          if let url = item.url, url.count > 2000 || !safeLink(url) { return false }
          if card.type == "checklist" { return !(item.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && (item.text?.count ?? 0) <= 500 }
          return !(item.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && (item.title?.count ?? 0) <= 200 && (item.time?.count ?? 0) <= 100 && (item.detail?.count ?? 0) <= 2000
        }
      case "event":
        guard (card.location?.count ?? 0) <= 500, (card.description?.count ?? 0) <= 4000 else { return false }
        guard let raw = card.start, absoluteDate(raw), let start = ServerDate.parse(raw) else { return false }
        if let end = card.end { guard absoluteDate(end), let date = ServerDate.parse(end), date > start else { return false } }
        return true
      default: return false
      }
    }
  }
  static func absoluteDate(_ value: String) -> Bool {
    value.range(of: "(?:Z|[+-][0-9]{2}:[0-9]{2})$", options: .regularExpression) != nil && ServerDate.parse(value) != nil
  }
  static func safeLink(_ value: String) -> Bool { guard let url = URL(string: value), let host = url.host, !host.isEmpty else { return false }; return ["http", "https"].contains(url.scheme?.lowercased() ?? "") }
}

/// A message's text as the web's conversation shows it: replies, meaning the assistant's and
/// scheduled deliveries, are Markdown with reply cards, and only the assistant's may carry inline
/// UI. Everything else, such as a person's message, is plain text.
struct ReplyContentView: View {
  var message: Message
  var body: some View {
    if message.isReply {
      ForEach(ReplyCards.parse(message.text, inlineUi: message.role == "assistant")) { part in
        if let markdown = part.markdown { MarkdownView(text: markdown) }
        if let inline = part.inline { InlineUiView(document: inline) }
        if let cards = part.cards { ForEach(cards) { card in InteractiveReplyCard(card: card, messageId: message.id) } }
      }
    } else {
      Text(message.text).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
    }
  }
}

struct InteractiveReplyCard: View {
  var card: ReplyCard
  var messageId: String
  @Environment(AppStore.self) private var store: AppStore?
  @Environment(\.transcriptConnected) private var connected
  @Environment(\.colorScheme) private var scheme
  @State private var saved = ReplyCardState()
  @State private var draft = ReplyCardState()
  @State private var status = Status.loading
  @State private var error: String?
  @State private var editing: String?
  @State private var eventOpen = false
  enum Status { case loading, ready, saving, failed }
  private var busy: Bool { status == .loading || status == .saving || !connected }
  private var typeLabel: String { card.type == "event" ? "Calendar proposal" : card.type == "itinerary" ? "Itinerary" : "Checklist" }
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack {
        Text(typeLabel).font(.caption2.weight(.semibold)).textCase(.uppercase).foregroundStyle(.secondary)
        Spacer()
        if card.type == "checklist" { Text("\(saved.checkedIds.count) / \(card.items?.count ?? 0)").font(.caption).foregroundStyle(.secondary).monospacedDigit() }
      }
      Text(card.title).font(.headline)
      if card.type == "event" {
        if let start = card.start.flatMap(ServerDate.parse) {
          Text(When.format(start, relative: false) + (card.end.flatMap(ServerDate.parse).map { " to " + When.format($0, relative: false, from: start) } ?? ""))
        }
        if let location = card.location { Label(location, systemImage: "mappin") }
        if let description = card.description { Text(description).font(.footnote) }
        Button("Review calendar event", systemImage: "calendar.badge.plus") { eventOpen = true }.buttonStyle(.bordered)
        Text("Review and choose Save in Apple's event editor to add it to your calendar.").font(.caption).foregroundStyle(.secondary)
      } else {
        ForEach(card.items ?? []) { item in
          if card.type == "checklist" {
            Button {
              var next = draft
              if next.checkedIds.contains(item.id) { next.checkedIds.removeAll { $0 == item.id } } else { next.checkedIds.append(item.id) }
              save(next)
            } label: {
              Label(item.text ?? "", systemImage: draft.checkedIds.contains(item.id) ? "checkmark.circle.fill" : "circle").frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 8)
            }.buttonStyle(.plain).accessibilityIdentifier("checklist.\(card.id).\(item.id)").accessibilityValue(draft.checkedIds.contains(item.id) ? "Checked" : "Unchecked").disabled(busy || status == .failed)
          } else { itineraryItem(item) }
        }
        Text("Checks and notes are saved for your account. The assistant's proposal stays in the conversation.").font(.caption).foregroundStyle(.secondary)
        if status == .loading && error == nil { ProgressView("Loading saved choices…") }
      }
      if let error {
        ErrorBanner(message: error)
        if status == .failed && saved != draft { Button("Retry saving") { save(draft) }.buttonStyle(.bordered).disabled(!connected) }
        else { Button("Reload saved state") { Task { await load() } }.buttonStyle(.bordered).disabled(!connected) }
      }
    }.padding(14).background(Palette.raised(scheme), in: RoundedRectangle(cornerRadius: 14))
      .task(id: "\(store?.scope ?? ""):\(messageId):\(card.id)") { await load() }
      .sheet(isPresented: $eventOpen) { CalendarProposalEditor(card: card) }
  }
  private func itineraryItem(_ item: ReplyCardItem) -> some View {
    let note = draft.notes[item.id] ?? ""
    return VStack(alignment: .leading, spacing: 5) {
      if let time = item.time { Text(time).font(.caption.weight(.semibold)).textCase(.uppercase).foregroundStyle(.secondary) }
      Text(item.title ?? "").font(.subheadline.bold())
      if let detail = item.detail { Text(detail).font(.footnote) }
      if !note.isEmpty && editing != item.id { Text("Your note: \(note)").font(.footnote) }
      if let url = item.url.flatMap(URL.init(string:)) { Link("Open details", destination: url).font(.caption) }
      if editing == item.id {
        TextField("Your itinerary note", text: Binding(get: { draft.notes[item.id] ?? "" }, set: { draft.notes[item.id] = String($0.prefix(2000)) }), axis: .vertical)
          .lineLimit(3...8).textFieldStyle(.roundedBorder).disabled(busy)
        HStack {
          Button("Save note") { save(draft) }.disabled(busy)
          Button("Cancel") { draft = saved; editing = nil }.disabled(busy)
        }.buttonStyle(.bordered)
      } else {
        Button(note.isEmpty ? "Add note" : "Edit note") { editing = item.id }.buttonStyle(.bordered).disabled(busy || status == .failed)
      }
    }
  }
  private var path: String { "/bots/\(APIClient.component(store?.selectedBotId ?? ""))/messages/\(APIClient.component(messageId))/cards/\(APIClient.component(card.id))/state" }
  private func load() async {
    guard card.type != "event", let api = store?.api else { return }
    let scope = store?.scope; status = .loading; error = nil
    do { let value: ReplyCardState = try await api.get(path); guard store?.scope == scope, store?.api === api else { return }; saved = value; draft = value; status = .ready }
    catch { if store?.scope == scope { self.error = error.localizedDescription; status = .failed } }
  }
  private func save(_ value: ReplyCardState) {
    guard let api = store?.api, !busy else { return }
    let scope = store?.scope; let route = path; draft = value; status = .saving; error = nil
    Task {
      do { let result: ReplyCardState = try await api.write(route, value, method: "PUT"); guard store?.scope == scope, store?.api === api else { return }; saved = result; draft = result; status = .ready; editing = nil }
      catch { if store?.scope == scope { self.error = error.localizedDescription; status = .failed } }
    }
  }
}

struct CalendarProposalEditor: UIViewControllerRepresentable {
  var card: ReplyCard
  @Environment(\.dismiss) private var dismiss
  func makeCoordinator() -> Coordinator { Coordinator { dismiss() } }
  func makeUIViewController(context: Context) -> EKEventEditViewController {
    let controller = EKEventEditViewController()
    let store = EKEventStore()
    let event = EKEvent(eventStore: store)
    event.title = card.title; event.startDate = card.start.flatMap(ServerDate.parse)
    event.endDate = card.end.flatMap(ServerDate.parse) ?? event.startDate?.addingTimeInterval(3600)
    event.location = card.location; event.notes = card.description
    controller.eventStore = store; controller.event = event; controller.editViewDelegate = context.coordinator
    return controller
  }
  func updateUIViewController(_ uiViewController: EKEventEditViewController, context: Context) {}
  final class Coordinator: NSObject, EKEventEditViewDelegate {
    var close: () -> Void
    init(close: @escaping () -> Void) { self.close = close }
    func eventEditViewController(_ controller: EKEventEditViewController, didCompleteWith action: EKEventEditViewAction) { close() }
  }
}

let NativeInteractiveReplyInstructions = #"When a checklist, itinerary, or calendar proposal would help, include a fenced agent-ui JSON block alongside a short explanation. Use {"version":1,"cards":[...]}. Each card needs a unique stable id and title. A checklist is {"id":"groceries","type":"checklist","title":"Groceries","items":[{"id":"milk","text":"Milk"}]}. An itinerary is {"id":"trip","type":"itinerary","title":"Our trip","items":[{"id":"stop1","title":"First stop","time":"Saturday, 10 AM","detail":"Details","url":"https://example.com"}]}. An event is {"id":"dinner","type":"event","title":"Dinner","start":"2026-10-03T18:00:00-05:00","end":"2026-10-03T19:00:00-05:00","location":"Home","description":"Details"}. IDs use letters, digits, underscores or hyphens. Include only useful fields, at most 8 cards and 60 items per card. Event timestamps require a confirmed date and timezone offset; ask when those are unknown. Cards are proposals, never evidence that a calendar event or other external action was created."#
