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
/// Reuses the original `PendingSubmission.requestId` across retries and preserves edits made while
/// a send is in flight.
@MainActor @Observable final class SecondaryChatModel {
  let botId: String
  var conversation: Conversation?
  var draft = ""
  var pending: PendingSubmission?
  var loading = false
  var sending = false
  var error: String?

  init(botId: String) { self.botId = botId }

  func reset() {
    conversation = nil
    draft = ""
    pending = nil
    error = nil
    sending = false
    loading = false
  }

  func load(using store: AppStore) async {
    guard let api = store.api, store.scope != nil, !store.sessionExpired else {
      conversation = nil
      return
    }
    let scope = store.scope
    loading = conversation == nil
    defer { loading = false }
    do {
      let fetched: Conversation = try await api.get("/bots/\(APIClient.component(botId))/conversation?turns=20")
      guard store.scope == scope, store.api === api else { return }
      conversation = fetched
      error = nil
    } catch {
      guard store.scope == scope, !(error is CancellationError) else { return }
      self.error = error.localizedDescription
    }
  }

  func send(using store: AppStore, retryPending: Bool = false) async {
    guard !sending, let api = store.api, store.householdReachable, !store.sessionExpired else { return }
    let scope = store.scope
    let submission: PendingSubmission
    let submittedText: String
    if retryPending, var existing = pending {
      existing.reviewedUncertain = true
      submission = existing
      submittedText = existing.text
      pending = existing
    } else {
      guard pending == nil else { return }
      let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !trimmed.isEmpty else { return }
      submittedText = draft
      submission = PendingSubmission(
        requestId: UUID().uuidString.lowercased(),
        botId: botId,
        text: trimmed,
        attachments: [],
        reviewedInterruption: false,
        draftBaseRevision: 0
      )
      pending = submission
    }
    sending = true
    error = nil
    defer { sending = false }
    do {
      let receipt: Receipt = try await api.write("/bots/\(APIClient.component(botId))/messages", submission)
      guard store.scope == scope, store.api === api else { return }
      applyReceipt(receipt, submittedText: submittedText)
      await load(using: store)
    } catch {
      guard store.scope == scope, store.api === api else { return }
      if let failure = error as? APIError, (400..<500).contains(failure.status) {
        pending = nil
        if draft.isEmpty { draft = submission.text }
        self.error = failure.message
      } else {
        // Keep `pending` with its original `requestId` so Retry / status check never delivers twice.
        self.error = "Checking whether the assistant accepted this message. The original request ID is preserved."
      }
    }
  }

  /// Checks the server receipt for an uncertain submission without resending.
  func reconcilePending(using store: AppStore) async {
    guard !sending, let existing = pending, let api = store.api, !store.sessionExpired else { return }
    let scope = store.scope
    do {
      let receipt: Receipt = try await api.get("/submissions/\(APIClient.component(existing.requestId))")
      guard store.scope == scope, store.api === api, pending?.requestId == existing.requestId else { return }
      applyReceipt(receipt, submittedText: existing.text)
      if pending == nil { await load(using: store) }
    } catch {
      // Leave `pending` intact so the next poll or explicit Retry keeps the original requestId.
    }
  }

  private func applyReceipt(_ receipt: Receipt, submittedText: String) {
    if receipt.status == "uncertain" {
      // Non-terminal: keep `pending` with its original `requestId` until confirmed or explicitly retried.
      error = receipt.message ?? "Checking whether the assistant accepted this message. The original request ID is preserved."
      return
    }
    pending = nil
    if receipt.admitted {
      if draft == submittedText { draft = "" }
      error = nil
    } else {
      if let msg = receipt.message { error = msg }
      if draft.isEmpty { draft = submittedText }
    }
  }

  func discardPending() {
    if let text = pending?.text, draft.isEmpty { draft = text }
    pending = nil
    error = nil
  }
}

/// Secondary iPadOS window showing an assistant's conversation side-by-side in Stage Manager / Split View.
struct SecondaryConversationWindow: View {
  var botId: String
  @Environment(AppStore.self) private var store
  @Environment(\.colorScheme) private var scheme
  @Environment(\.scenePhase) private var scenePhase
  @State private var model: SecondaryChatModel
  @State private var previewFile: PreviewFile?

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
          if model.pending != nil && !model.sending {
            HStack(spacing: 10) {
              Text("Last message not confirmed yet.")
                .font(.caption).foregroundStyle(Palette.attention)
              Spacer()
              Button("Check") { Task { await model.reconcilePending(using: store) } }
                .font(.caption)
              Button("Retry") { Task { await model.send(using: store, retryPending: true) } }
                .font(.caption.weight(.semibold))
              Button("Discard", role: .destructive) { model.discardPending() }
                .font(.caption)
            }
            .padding(.horizontal, 16).padding(.vertical, 8)
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
                  ForEach(messages) { messageRow($0) }
                }
                Color.clear.frame(height: 1).id("secondary-end")
              }
              .padding(16)
              .frame(maxWidth: 752).frame(maxWidth: .infinity)
            }
            .environment(\.openManagedFile) { file, sourceId in
              openLocalFile(file, sourceId: sourceId)
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
        .sheet(item: $previewFile, onDismiss: { previewFile = nil }) { file in
          FilePreview(file: file).ignoresSafeArea()
        }
        .task(id: "\(store.scope ?? ""):\(botId):\(scenePhase == .active)") {
          guard scenePhase == .active else { return }
          await model.reconcilePending(using: store)
          await model.load(using: store)
          while !Task.isCancelled {
            // Timer: secondary window refresh interval while active.
            try? await Task.sleep(for: .seconds(5))
            if !Task.isCancelled {
              await model.reconcilePending(using: store)
              await model.load(using: store)
            }
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
    .onChange(of: store.scope) { _, _ in
      model.reset()
      previewFile = nil
    }
  }

  private func messageRow(_ message: Message) -> some View {
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

  private func openLocalFile(_ file: FileRef, sourceId: String) {
    guard let api = store.api, let scope = store.scope, !store.sessionExpired else { return }
    Task {
      do {
        let data = try await api.data(path: "/api/files/\(APIClient.component(file.id))")
        guard store.scope == scope, store.api === api, !store.sessionExpired else { return }
        let directory = FileManager.default.temporaryDirectory
          .appendingPathComponent("secondary-preview-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let safeName = URL(fileURLWithPath: file.name).lastPathComponent
        let url = directory.appendingPathComponent(safeName.isEmpty ? "Attachment" : safeName)
        try data.write(to: url, options: [.atomic, .completeFileProtection])
        previewFile = PreviewFile(url: url, sourceId: sourceId)
      } catch {
        if store.scope == scope { model.error = error.localizedDescription }
      }
    }
  }

  private func composer(bot: Bot) -> some View {
    HStack(alignment: .bottom, spacing: 8) {
      TextField("Message \(bot.name)…", text: $model.draft, axis: .vertical)
        .lineLimit(1...4)
        .padding(.horizontal, 12).padding(.vertical, 10)
        .disabled(model.sending || model.pending != nil)
        .onSubmit { Task { await model.send(using: store) } }
      let canSend = !model.sending && model.pending == nil && store.householdReachable
        && !model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
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
/// Fetches file bytes on demand through the signed-in `APIClient` only while the initiating account
/// scope and API client still match, advertises concrete UTTypes, and expires staged temporary copies.
struct DraggableManagedFile: Transferable, Sendable {
  let fileId: String
  let name: String
  let contentType: UTType
  let fetch: @Sendable () async throws -> Data
  let isStillAuthorized: @Sendable () async -> Bool

  @MainActor static func make(file: FileRef, store: AppStore?) -> DraggableManagedFile? {
    guard let store, let api = store.api, let scope = store.scope, !store.sessionExpired else { return nil }
    let type = UTType(mimeType: file.mime)
      ?? UTType(filenameExtension: URL(fileURLWithPath: file.name).pathExtension)
      ?? .data
    let fileId = file.id
    let checkAuthorized: @Sendable () async -> Bool = {
      await MainActor.run { store.scope == scope && store.api === api && !store.sessionExpired }
    }
    return DraggableManagedFile(
      fileId: fileId,
      name: file.name,
      contentType: type,
      fetch: {
        try await Task { @MainActor in
          guard store.scope == scope, store.api === api, !store.sessionExpired else {
            throw APIError(message: "Sign in to drag this file.", status: 401)
          }
          return try await api.data(path: "/api/files/\(APIClient.component(fileId))")
        }.value
      },
      isStillAuthorized: checkAuthorized
    )
  }

  /// Removes staged `drag-*` temporary directories older than `maxAge` seconds (or all when `maxAge == 0`).
  nonisolated static func cleanupTemporaryFiles(maxAge: TimeInterval = 600, now: Date = Date()) {
    let tmp = FileManager.default.temporaryDirectory
    guard let entries = try? FileManager.default.contentsOfDirectory(
      at: tmp,
      includingPropertiesForKeys: [.creationDateKey],
      options: [.skipsHiddenFiles]
    ) else { return }
    for url in entries where url.lastPathComponent.hasPrefix("drag-") {
      if maxAge <= 0 {
        try? FileManager.default.removeItem(at: url)
        continue
      }
      let created = (try? url.resourceValues(forKeys: [.creationDateKey]).creationDate) ?? .distantPast
      if now.timeIntervalSince(created) >= maxAge {
        try? FileManager.default.removeItem(at: url)
      }
    }
  }

  private nonisolated static func stageFile(for item: DraggableManagedFile) async throws -> SentTransferredFile {
    cleanupTemporaryFiles()
    let data = try await item.fetch()
    guard await item.isStillAuthorized() else {
      throw APIError(message: "Account changed before drag completed.", status: 401)
    }
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("drag-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let safeName = URL(fileURLWithPath: item.name).lastPathComponent
    let url = directory.appendingPathComponent(safeName.isEmpty ? "Attachment" : safeName)
    try data.write(to: url, options: [.atomic, .completeFileProtection])
    return SentTransferredFile(url)
  }

  static var transferRepresentation: some TransferRepresentation {
    FileRepresentation(exportedContentType: .pdf) { try await stageFile(for: $0) }
      .exportingCondition { $0.contentType.conforms(to: .pdf) }
    FileRepresentation(exportedContentType: .png) { try await stageFile(for: $0) }
      .exportingCondition { $0.contentType.conforms(to: .png) }
    FileRepresentation(exportedContentType: .jpeg) { try await stageFile(for: $0) }
      .exportingCondition { $0.contentType.conforms(to: .jpeg) }
    FileRepresentation(exportedContentType: .plainText) { try await stageFile(for: $0) }
      .exportingCondition { $0.contentType.conforms(to: .plainText) && !$0.contentType.conforms(to: .json) }
    FileRepresentation(exportedContentType: .json) { try await stageFile(for: $0) }
      .exportingCondition { $0.contentType.conforms(to: .json) }
    FileRepresentation(exportedContentType: .data) { try await stageFile(for: $0) }
  }
}
