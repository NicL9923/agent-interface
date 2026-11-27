import SwiftUI
import UniformTypeIdentifiers

/// Identifiers and payloads for secondary iPadOS windows (`openWindow`).
enum WindowID {
  static let computer = "computer"
  static let conversation = "conversation"
}

struct ComputerWindowRequest: Codable, Hashable {
  var take = false
}

/// Secondary window hosting the household Computer screen side-by-side with a chat on iPadOS.
struct ComputerWindowView: View {
  var request: ComputerWindowRequest
  @Environment(AppStore.self) private var store
  @Environment(\.colorScheme) private var scheme
  var body: some View {
    NavigationStack {
      if store.bootstrap != nil && !store.sessionExpired {
        ComputerView(take: request.take)
      } else {
        ContentUnavailableView(
          "Sign in to view Computer",
          systemImage: "desktopcomputer",
          description: Text("Sign in to your household in the main WildBots window to access the shared computer.")
        )
        .navigationTitle("Computer")
        .navigationBarTitleDisplayMode(.inline)
      }
    }
    .background(Palette.surface(scheme))
  }
}

/// Lightweight, independent state for a secondary iPad conversation window so it can show and
/// reply to another assistant side-by-side without clobbering the main window's selected chat.
@MainActor @Observable final class SecondaryChatModel {
  let botId: String
  var conversation: Conversation?
  var draft = ""
  var loading = false
  var sending = false
  var error: String?

  init(botId: String) { self.botId = botId }

  func load(using store: AppStore) async {
    guard let api = store.api, store.scope != nil, !store.sessionExpired else {
      conversation = nil
      return
    }
    let scope = store.scope
    loading = conversation == nil
    defer { loading = false }
    do {
      let fetched: Conversation = try await api.get("/bots/\(APIClient.component(botId))/conversation?limit=20")
      guard store.scope == scope, store.api === api else { return }
      conversation = fetched
      error = nil
    } catch {
      guard store.scope == scope, !(error is CancellationError) else { return }
      self.error = error.localizedDescription
    }
  }

  func send(using store: AppStore) async {
    let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, !sending, let api = store.api, store.householdReachable, !store.sessionExpired else { return }
    let scope = store.scope
    let submission = PendingSubmission(
      requestId: UUID().uuidString.lowercased(),
      botId: botId,
      text: trimmed,
      attachments: [],
      reviewedInterruption: false,
      draftBaseRevision: 0
    )
    sending = true
    error = nil
    defer { sending = false }
    do {
      let receipt: Receipt = try await api.write("/bots/\(APIClient.component(botId))/messages", submission)
      guard store.scope == scope, store.api === api else { return }
      if receipt.admitted { draft = "" } else if let msg = receipt.message { error = msg }
      await load(using: store)
    } catch {
      guard store.scope == scope else { return }
      self.error = error.localizedDescription
    }
  }
}

/// Secondary iPadOS window showing an assistant's conversation side-by-side in Stage Manager / Split View.
struct SecondaryConversationWindow: View {
  var botId: String
  @Environment(AppStore.self) private var store
  @Environment(\.colorScheme) private var scheme
  @State private var model: SecondaryChatModel

  init(botId: String) {
    self.botId = botId
    _model = State(initialValue: SecondaryChatModel(botId: botId))
  }

  private var bot: Bot? { store.knownBot(botId) }

  var body: some View {
    NavigationStack {
      if let bot, store.bootstrap != nil, !store.sessionExpired {
        VStack(spacing: 0) {
          if let error = model.error {
            ErrorBanner(message: error, dismiss: { model.error = nil })
              .padding(.horizontal).padding(.top, 8)
          }
          ScrollViewReader { proxy in
            ScrollView {
              VStack(alignment: .leading, spacing: 14) {
                if model.loading && model.conversation == nil {
                  ProgressView("Opening \(bot.name)…").frame(maxWidth: .infinity).padding(32)
                } else {
                  let messages = (model.conversation?.messages ?? []).filter(\.isConversationVisible)
                  if messages.isEmpty {
                    Text("No messages yet.").font(.footnote).foregroundStyle(Palette.muted).frame(maxWidth: .infinity).padding(24)
                  }
                  ForEach(messages) { message in
                    VStack(alignment: message.role == "user" ? .trailing : .leading, spacing: 4) {
                      if message.isReply {
                        MarkdownView(text: message.text)
                          .padding(12)
                          .background(Palette.raised(scheme), in: RoundedRectangle(cornerRadius: 14))
                          .draggable(message.text)
                      } else {
                        Text(message.text)
                          .padding(.horizontal, 14).padding(.vertical, 10)
                          .background(Palette.accentSoft, in: RoundedRectangle(cornerRadius: 16))
                      }
                      ForEach(message.files ?? []) { FileAttachmentView(file: $0) }
                    }
                    .frame(maxWidth: .infinity, alignment: message.role == "user" ? .trailing : .leading)
                    .id(message.id)
                  }
                }
                Color.clear.frame(height: 1).id("secondary-end")
              }
              .padding(16)
              .frame(maxWidth: 752).frame(maxWidth: .infinity)
            }
            .onChange(of: model.conversation?.messages.last?.id) { _, _ in
              proxy.scrollTo("secondary-end", anchor: .bottom)
            }
          }
          composer(bot: bot)
        }
        .background(Palette.surface(scheme))
        .navigationTitle(bot.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .topBarTrailing) {
            Button { Task { await model.load(using: store) } } label: { Image(systemName: "arrow.clockwise") }
              .accessibilityLabel("Refresh")
          }
        }
        .task(id: "\(store.scope ?? ""):\(botId)") {
          await model.load(using: store)
          while !Task.isCancelled {
            // Timer: secondary window refresh interval while active.
            try? await Task.sleep(for: .seconds(5))
            if !Task.isCancelled { await model.load(using: store) }
          }
        }
      } else {
        ContentUnavailableView(
          store.bootstrap == nil ? "Sign in to WildBots" : "Assistant unavailable",
          systemImage: "bubble.left.and.bubble.right",
          description: Text(store.bootstrap == nil
            ? "Sign in in the main WildBots window to view this conversation."
            : "This assistant is no longer available in your household.")
        )
        .navigationTitle("Assistant")
        .navigationBarTitleDisplayMode(.inline)
      }
    }
    .onChange(of: store.scope) { _, _ in model.conversation = nil; model.draft = "" }
  }

  private func composer(bot: Bot) -> some View {
    HStack(alignment: .bottom, spacing: 8) {
      TextField("Message \(bot.name)…", text: $model.draft, axis: .vertical)
        .lineLimit(1...4)
        .padding(.horizontal, 12).padding(.vertical, 10)
        .onSubmit { Task { await model.send(using: store) } }
      let canSend = !model.sending && store.householdReachable && !model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      Button { Task { await model.send(using: store) } } label: {
        Group {
          if model.sending { ProgressView().tint(Palette.muted) }
          else { Image(systemName: "arrow.up").font(.body.weight(.semibold)) }
        }
        .frame(width: 40, height: 40)
        .foregroundStyle(canSend ? Palette.raised(scheme) : Palette.muted)
        .background(canSend ? Palette.accent : Palette.line, in: Circle())
      }
      .buttonStyle(.plain)
      .disabled(!canSend)
      .accessibilityLabel("Send message")
    }
    .padding(6)
    .glassSurface(RoundedRectangle(cornerRadius: 24, style: .continuous), interactive: true)
    .padding(.horizontal, 12).padding(.vertical, 8)
    .frame(maxWidth: 752).frame(maxWidth: .infinity)
  }
}

/// Transferable wrapper enabling iPadOS Drag-Out (`.draggable`) for authenticated managed files.
/// Fetches the file bytes on demand through the signed-in `APIClient` only while the owning account
/// scope matches, writing a temporary file for the destination app.
struct DraggableManagedFile: Transferable, Sendable {
  let fileId: String
  let name: String
  let contentType: UTType
  let fetch: @Sendable () async throws -> Data

  @MainActor static func make(file: FileRef, store: AppStore?) -> DraggableManagedFile? {
    guard let store, store.api != nil, let scope = store.scope else { return nil }
    let type = UTType(mimeType: file.mime) ?? UTType(filenameExtension: URL(fileURLWithPath: file.name).pathExtension) ?? .data
    let fileId = file.id
    return DraggableManagedFile(fileId: fileId, name: file.name, contentType: type) {
      try await Task { @MainActor in
        guard store.scope == scope, let api = store.api, !store.sessionExpired else {
          throw APIError(message: "Sign in to drag this file.", status: 401)
        }
        return try await api.data(path: "/api/files/\(APIClient.component(fileId))")
      }.value
    }
  }

  static var transferRepresentation: some TransferRepresentation {
    FileRepresentation(exportedContentType: .item) { item in
      let data = try await item.fetch()
      let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("drag-\(UUID().uuidString)", isDirectory: true)
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      let safeName = URL(fileURLWithPath: item.name).lastPathComponent
      let url = directory.appendingPathComponent(safeName.isEmpty ? "Attachment" : safeName)
      try data.write(to: url, options: [.atomic, .completeFileProtection])
      return SentTransferredFile(url)
    }
  }
}
