import SwiftUI

/// One message waiting for the next turn, mirroring `QueuedMessage` in src/shared/queue.ts. Once the
/// runtime claims it for a turn it leaves the queue, and a change aimed at it is refused with 409.
struct QueuedMessage: Codable, Identifiable, Equatable {
  var id: String
  var text: String
  var attachments: [FileRef]?
  var senderId: String?
  var createdAt: String?
}
/// A bot's queued messages, in the order they will run.
struct BotQueue: Codable, Equatable {
  var items: [QueuedMessage]
}
/// `beforeItemId` is always sent: null moves the message to the end.
struct QueueReorder: Encodable {
  var beforeItemId: String?
  private enum CodingKeys: String, CodingKey { case beforeItemId }
  func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(beforeItemId, forKey: .beforeItemId)
  }
}

/// The queue routes. Each change answers with the queue as it now stands.
extension APIClient {
  private func queuePath(_ botId: String, _ itemId: String? = nil) -> String {
    "/bots/\(Self.component(botId))/queue" + (itemId.map { "/\(Self.component($0))" } ?? "")
  }
  func queue(_ botId: String) async throws -> BotQueue { try await get(queuePath(botId)) }
  func editQueued(_ botId: String, _ itemId: String, text: String) async throws -> BotQueue {
    try await write(queuePath(botId, itemId), ["text": text], method: "PATCH")
  }
  /// Moves the message in front of `before`, or to the end for nil.
  func reorderQueued(_ botId: String, _ itemId: String, before: String?) async throws -> BotQueue {
    try await write(queuePath(botId, itemId) + "/reorder", QueueReorder(beforeItemId: before))
  }
  func sendQueuedNow(_ botId: String, _ itemId: String) async throws -> BotQueue {
    try await write(queuePath(botId, itemId) + "/send-now", [String: String]())
  }
  func cancelQueued(_ botId: String, _ itemId: String) async throws -> BotQueue {
    let path = "/api" + queuePath(botId, itemId)
    return try await Self.decoded(await data(path: path, method: "DELETE"), from: path)
  }
}

@MainActor @Observable final class MessageQueueController {
  static let pollInterval = Duration.seconds(3)
  static let started = "That message already started, so it can't be changed. The queue now shows what is still waiting."
  var items: [QueuedMessage] = []
  var busy = false
  var error: String?
  /// Reads the queue quietly. A failed read keeps what is shown until the next one.
  func load(_ api: APIClient, botId: String) async {
    guard let queue = try? await api.queue(botId) else { return }
    items = queue.items
  }
  /// Runs one change at a time. A 409 means the message already started, so the queue is read again.
  @discardableResult func change(_ api: APIClient, botId: String, done: String, _ work: () async throws -> BotQueue) async -> Bool {
    guard !busy else { return false }
    busy = true; error = nil
    defer { busy = false }
    do {
      items = try await work().items
      AccessibilityNotification.Announcement(done).post()
      return true
    } catch let failure as APIError where failure.status == 409 {
      error = Self.started
      await load(api, botId: botId)
    } catch {
      self.error = error.localizedDescription
    }
    return false
  }
  /// The message to move in front of, or nil for the end, when `index` moves one place.
  func before(moving index: Int, up: Bool) -> String? {
    up ? items[index - 1].id : (index + 2 < items.count ? items[index + 2].id : nil)
  }
}

/// Messages sent during a turn on a harness without native steering wait here for the next turn. It
/// shows above the message box only while at least one waits, and never for a Hermes bot.
struct MessageQueuePanel: View {
  var bot: Bot
  @Environment(AppStore.self) private var store
  @Environment(\.colorScheme) private var scheme
  @State private var control = MessageQueueController()
  @State private var editingId: String?
  @State private var draft = ""
  @FocusState private var editorFocused: Bool
  private var supported: Bool { store.bootstrap?.supportsQueue(bot) == true }
  var body: some View {
    Group {
      if supported && !control.items.isEmpty { panel }
    }
    // A turn that starts or ends changes the queue, so the read starts over then.
    .task(id: "\(bot.id)|\(store.active)|\(store.scope ?? "")|\(supported)") { await poll() }
  }
  private func poll() async {
    guard supported, let api = store.api else { control.items = []; return }
    while !Task.isCancelled {
      await control.load(api, botId: bot.id)
      guard store.active || !control.items.isEmpty else { return }
      try? await Task.sleep(for: MessageQueueController.pollInterval)
    }
  }
  private var panel: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 6) {
        Image(systemName: "text.line.first.and.arrowtriangle.forward").foregroundStyle(Palette.accent).accessibilityHidden(true)
        Text(control.items.count == 1 ? "1 message queued" : "\(control.items.count) messages queued").font(.footnote.weight(.semibold))
        Text("· sends after the current reply").font(.footnote).foregroundStyle(Palette.muted).lineLimit(1)
      }.accessibilityElement(children: .combine).accessibilityAddTraits(.isHeader)
      ForEach(Array(control.items.enumerated()), id: \.element.id) { index, item in
        if index > 0 { Divider() }
        if editingId == item.id { editor(item) } else { row(item, index) }
      }
      if let error = control.error {
        Text(error).font(.footnote).foregroundStyle(Palette.danger).accessibilityIdentifier("queueError")
      }
    }.padding(.horizontal, 12).padding(.vertical, 8)
      .background(Palette.raised(scheme), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
      .accessibilityElement(children: .contain).accessibilityIdentifier("messageQueue")
  }
  private func row(_ item: QueuedMessage, _ index: Int) -> some View {
    let number = index + 1
    let preview = item.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && item.attachments?.isEmpty == false
      ? "Attachments only" : item.text
    return HStack(spacing: 8) {
      Text(preview).font(.subheadline).lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
      Button { run("Sending it now.") { try await $0.sendQueuedNow(bot.id, item.id) } } label: {
        Label("Send now", systemImage: "arrow.up").font(.footnote.weight(.semibold)).labelStyle(.titleAndIcon)
          .frame(minHeight: 44).contentShape(Rectangle())
      }.buttonStyle(.borderless).accessibilityLabel("Send queued message \(number) now")
        .accessibilityIdentifier("queue.sendNow.\(item.id)")
      Menu {
        Button { draft = item.text; editingId = item.id; editorFocused = true } label: { Label("Edit", systemImage: "pencil") }
        Button { move(index, up: true) } label: { Label("Move up", systemImage: "arrow.up.to.line") }.disabled(index == 0)
        Button { move(index, up: false) } label: { Label("Move down", systemImage: "arrow.down.to.line") }
          .disabled(index == control.items.count - 1)
        Button(role: .destructive) { run("Cancelled the message.") { try await $0.cancelQueued(bot.id, item.id) } } label: {
          Label("Cancel message", systemImage: "xmark")
        }
      } label: {
        Image(systemName: "ellipsis.circle").font(.body).frame(width: 44, height: 44).contentShape(Rectangle())
      }.accessibilityLabel("More for queued message \(number)").accessibilityIdentifier("queue.more.\(item.id)")
    }.disabled(control.busy || editingId != nil)
  }
  private func editor(_ item: QueuedMessage) -> some View {
    let unchanged = draft == item.text || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    return VStack(alignment: .trailing, spacing: 6) {
      TextField("Queued message", text: $draft, axis: .vertical).lineLimit(1...6).focused($editorFocused)
        .textFieldStyle(.roundedBorder).accessibilityIdentifier("queue.editor")
      HStack(spacing: 12) {
        Button("Keep original") { editingId = nil }.disabled(control.busy)
        Button("Save") {
          let text = draft
          Task {
            let api = store.api
            guard let api else { return }
            if await control.change(api, botId: bot.id, done: "Saved the queued message.", { try await api.editQueued(bot.id, item.id, text: text) }) {
              editingId = nil
            }
          }
        }.buttonStyle(.accentProminent).disabled(control.busy || unchanged).accessibilityIdentifier("queue.save")
      }
    }.onChange(of: control.items) { _, items in
      // A message that started or was removed elsewhere ends its edit.
      if !items.contains(where: { $0.id == item.id }) { editingId = nil }
    }
  }
  private func move(_ index: Int, up: Bool) {
    let item = control.items[index], before = control.before(moving: index, up: up)
    run(up ? "Moved up." : "Moved down.") { try await $0.reorderQueued(bot.id, item.id, before: before) }
  }
  private func run(_ done: String, _ work: @escaping (APIClient) async throws -> BotQueue) {
    guard let api = store.api else { return }
    Task { await control.change(api, botId: bot.id, done: done) { try await work(api) } }
  }
}
