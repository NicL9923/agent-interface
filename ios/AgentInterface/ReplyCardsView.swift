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
struct ReplyCardState: Codable { var checkedIds: [String] = []; var notes: [String: String] = [:] }
struct ReplyContentPart: Identifiable {
  var id: Int
  var markdown: String?
  var cards: [ReplyCard]?
}
enum ReplyCards {
  static func spokenText(_ text: String) -> String {
    parse(text).map { part in
      if let prose = part.markdown { return prose }
      return (part.cards ?? []).map { card in
        ([card.title] + (card.items ?? []).map { $0.text ?? $0.title ?? "" }).joined(separator: ". ")
      }.joined(separator: "\n")
    }.joined(separator: "\n")
  }
  static func parse(_ text: String) -> [ReplyContentPart] {
    guard text.utf8.count <= 200_000,
      let pattern = try? NSRegularExpression(pattern: "(?m)^```agent-ui[ \\t]*\\r?\\n([\\s\\S]*?)^```[ \\t]*(?:\\r?\\n|$)") else { return [.init(id: 0, markdown: text)] }
    let range = NSRange(text.startIndex..., in: text)
    var parts: [ReplyContentPart] = []
    var cursor = text.startIndex
    for match in pattern.matches(in: text, range: range) {
      guard let whole = Range(match.range, in: text), let payload = Range(match.range(at: 1), in: text),
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

struct ReplyContentView: View {
  var message: Message
  var body: some View {
    if message.role == "assistant" {
      ForEach(ReplyCards.parse(message.text)) { part in
        if let markdown = part.markdown { MarkdownView(text: markdown) }
        if let cards = part.cards { ForEach(cards) { card in InteractiveReplyCard(card: card, messageId: message.id) } }
      }
    } else { MarkdownView(text: message.text) }
  }
}

struct InteractiveReplyCard: View {
  var card: ReplyCard
  var messageId: String
  @EnvironmentObject private var store: AppStore
  @Environment(\.colorScheme) private var scheme
  @State private var state = ReplyCardState()
  @State private var loaded = false
  @State private var busy = false
  @State private var error: String?
  @State private var eventOpen = false
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Label(card.title, systemImage: card.type == "checklist" ? "checklist" : card.type == "event" ? "calendar" : "map").font(.headline)
      if card.type == "event" {
        if let start = card.start.flatMap(ServerDate.parse) { Text(start.formatted(date: .abbreviated, time: .shortened)) }
        if let end = card.end.flatMap(ServerDate.parse) { Text("Until \(end.formatted(date: .abbreviated, time: .shortened))").font(.caption) }
        if let location = card.location { Label(location, systemImage: "mappin") }
        if let description = card.description { Text(description).font(.footnote) }
        Button("Review calendar event", systemImage: "calendar.badge.plus") { eventOpen = true }
        Text("Review and choose Save in Apple's event editor to add it to your calendar.").font(.caption).foregroundStyle(.secondary)
      } else {
        ForEach(card.items ?? []) { item in
          if card.type == "checklist" {
            Button {
              var next = state
              if next.checkedIds.contains(item.id) { next.checkedIds.removeAll { $0 == item.id } } else { next.checkedIds.append(item.id) }
              save(next)
            } label: {
              Label(item.text ?? "", systemImage: state.checkedIds.contains(item.id) ? "checkmark.circle.fill" : "circle").frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 8)
            }.buttonStyle(.plain).accessibilityIdentifier("checklist.\(card.id).\(item.id)").accessibilityValue(state.checkedIds.contains(item.id) ? "Checked" : "Unchecked").disabled(!loaded || busy || !store.connected)
          } else {
            VStack(alignment: .leading, spacing: 5) {
              Text(item.title ?? "").font(.subheadline.bold())
              if let time = item.time { Text(time).font(.caption).foregroundStyle(.secondary) }
              if let detail = item.detail { Text(detail).font(.footnote) }
              if let url = item.url.flatMap(URL.init(string:)) { Link("Open details", destination: url).font(.caption) }
              TextField("Your notes", text: Binding(get: { state.notes[item.id] ?? "" }, set: { state.notes[item.id] = $0 }), axis: .vertical).textFieldStyle(.roundedBorder).disabled(!loaded || busy)
            }
          }
        }
        if card.type == "itinerary" { Button("Save itinerary notes") { save(state) }.disabled(!loaded || busy || !store.connected) }
        if !loaded && error == nil { ProgressView("Loading saved choices…") }
        if !loaded && error != nil { Button("Retry saved choices") { Task { await load() } } }
      }
      if let error { ErrorBanner(message: error) }
    }.padding(14).background(Palette.raised(scheme), in: RoundedRectangle(cornerRadius: 14))
      .task(id: "\(store.scope ?? ""):\(messageId):\(card.id)") { await load() }
      .sheet(isPresented: $eventOpen) { CalendarProposalEditor(card: card) }
  }
  private var path: String { "/bots/\(APIClient.component(store.selectedBotId ?? ""))/messages/\(APIClient.component(messageId))/cards/\(APIClient.component(card.id))/state" }
  private func load() async {
    guard card.type != "event", let api = store.api else { return }
    let scope = store.scope; loaded = false; error = nil; state = ReplyCardState()
    do { let value: ReplyCardState = try await api.get(path); guard store.scope == scope, store.api === api else { return }; state = value; loaded = true }
    catch { if store.scope == scope { self.error = error.localizedDescription } }
  }
  private func save(_ value: ReplyCardState) {
    guard let api = store.api, !busy else { return }
    let scope = store.scope; let route = path; busy = true; error = nil
    Task { defer { busy = false }; do { let saved: ReplyCardState = try await api.write(route, value, method: "PUT"); guard store.scope == scope, store.api === api else { return }; state = saved } catch { if store.scope == scope { self.error = error.localizedDescription } } }
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
