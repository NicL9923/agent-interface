import SwiftUI
import UniformTypeIdentifiers
import PhotosUI

struct ConversationView: View {
  var bot: Bot
  var edit: () -> Void
  @EnvironmentObject private var store: AppStore
  @Environment(\.colorScheme) private var scheme
  @State private var importFiles = false
  @State private var importPhotos = false
  @State private var photos: [PhotosPickerItem] = []
  @State private var voiceOpen = false
  @State private var retryConfirm = false
  @State private var discardConfirm = false
  @State private var actionBusy = false
  @State private var visibleMessage: String?
  @State private var restoredBot: String?
  @State private var readSaveTask: Task<Void, Never>?
  @State private var latestTrigger = 0
  @State private var viewportHeight: CGFloat = 0
  @State private var nearBottom = true
  @State private var earlierEdgeVisible = false
  @State private var unseen = 0
  @State private var starters: [Starter] = []
  @State private var modelOpen = false
  @State private var fileSheetOpen = false
  @FocusState private var composerFocused: Bool
  var body: some View {
    VStack(spacing: 0) {
      if let error = store.error {
        ErrorBanner(message: error, dismiss: { store.error = nil }).padding(.horizontal).padding(
          .bottom, 8)
      }
      if store.sessionExpired {
        Button("Sign in again. Your draft is saved.") { Task { await store.signIn() } }.buttonStyle(
          .bordered
        ).padding(8)
      }
      transcript
      composer
    }.background(Palette.surface(scheme)).navigationTitle(bot.name).navigationBarTitleDisplayMode(
      .inline
    )
    .toolbar {
      // Activity reads in the transcript; the bar keeps only the actions.
      ToolbarItem(placement: .principal) {
        HStack(spacing: 8) {
          AvatarView(avatar: bot.avatar ?? AvatarConfig(), size: 30, name: bot.name, forceReducedMotion: true)
          VStack(alignment: .leading, spacing: 2) {
            Text(bot.name).font(.headline).lineLimit(1)
            Text("\(bot.shared ? "Shared with your household" : bot.ownerId == nil ? "Personal, visible to the household" : "Your personal assistant") · \(bot.provider.map { $0 + " / " } ?? "")\(bot.model)").font(.caption2).foregroundStyle(.secondary).lineLimit(1)
          }
        }.accessibilityElement(children: .combine)
      }
      ToolbarItemGroup(placement: .topBarTrailing) {
        Button { Task { await store.togglePin(bot.id) } } label: {
          Image(systemName: store.bootstrap?.preferences.favorites.contains(bot.id) == true ? "pin.fill" : "pin")
        }.accessibilityLabel(store.bootstrap?.preferences.favorites.contains(bot.id) == true ? "Unpin assistant" : "Pin assistant")
          .disabled(!store.connected || store.sessionExpired)
        Button { fileSheetOpen = true } label: { Image(systemName: "doc.on.doc") }
          .accessibilityLabel("Artifacts (\(store.conversationFiles.count))").accessibilityIdentifier("conversationFiles")
        if !store.connected {
          Button {
            Task { await store.reconnect() }
          } label: {
            Image(systemName: "arrow.clockwise")
          }.accessibilityLabel("Reconnect").disabled(store.sessionExpired)
        }
        Button(action: edit) { Image(systemName: "gearshape") }.accessibilityLabel(
          "Configure \(bot.name)")
      }
    }
    .task(id: bot.id + (store.scope ?? "")) { await loadStarters() }
    .sheet(isPresented: $modelOpen) { ComposerModelSheet(botId: bot.id).environmentObject(store) }
    .sheet(isPresented: $fileSheetOpen) { ConversationFilesView().environmentObject(store) }
    .sheet(isPresented: $voiceOpen) { VoiceMessageSheet(botId: bot.id).environmentObject(store) }
    .photosPicker(isPresented: $importPhotos, selection: $photos, maxSelectionCount: 10, matching: .images)
    .onChange(of: photos) { _, selection in
      guard !selection.isEmpty else { return }
      let scope = store.scope; let botId = bot.id
      Task {
        for item in selection {
          do {
            guard let data = try await item.loadTransferable(type: Data.self), scope == store.scope, store.selectedBotId == botId else { continue }
            let image = try ShareImage.prepare(data)
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("Photo-\(UUID().uuidString).\(image.ext)")
            try image.data.write(to: url, options: .atomic)
            await store.attach(urls: [url]); try? FileManager.default.removeItem(at: url)
          } catch { if scope == store.scope { store.report(error) } }
        }
        photos = []
      }
    }
    .fileImporter(
      isPresented: $importFiles, allowedContentTypes: [.png, .jpeg, .webP, .gif, .pdf, .plainText, .commaSeparatedText, UTType(filenameExtension: "md") ?? .plainText],
      allowsMultipleSelection: true
    ) { result in
      switch result {
      case .success(let urls): Task { await store.attach(urls: urls) }
      case .failure(let error): store.report(error)
      }
    }
    .confirmationDialog(
      "The original message may still arrive. Retry the same message using its saved request ID?",
      isPresented: $retryConfirm, titleVisibility: .visible
    ) {
      Button("Review complete, retry same request") {
        Task { await store.send(reviewedUncertain: true) }
      }
    }
    .confirmationDialog(
      "The message may still arrive. Its text goes back into the draft, so sending it again could deliver it twice.",
      isPresented: $discardConfirm, titleVisibility: .visible
    ) {
      Button("Discard and keep my text in the draft", role: .destructive) {
        store.discardUnconfirmedSubmission()
      }
    }
  }
  private var transcript: some View {
    ScrollViewReader { proxy in
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 18) {
          if (store.conversation?.earlier ?? 0) > 0 {
            Button {
              // Prepending would otherwise move the view; keep the oldest message in place.
              let anchor = store.conversation?.messages.first?.id
              Task {
                await store.loadEarlier()
                if let anchor { proxy.scrollTo(anchor, anchor: .top) }
              }
            } label: {
              if store.loadingEarlier {
                ProgressView()
              } else {
                Text("Show earlier messages")
              }
            }.buttonStyle(.bordered).disabled(store.loadingEarlier || !store.connected).frame(maxWidth: .infinity)
              .onGeometryChange(for: Bool.self) { geometry in geometry.frame(in: .named("transcript")).maxY >= -600 } action: { earlierEdgeVisible = $0 }
              .task(id: "\(store.conversation?.earlier ?? 0):\(earlierEdgeVisible):\(nearBottom)") {
                guard earlierEdgeVisible, !nearBottom, restoredBot == bot.id, store.connected, !store.loadingEarlier else { return }
                let anchor = store.conversation?.messages.first?.id
                await store.loadEarlier()
                if let anchor { proxy.scrollTo(anchor, anchor: .top) }
              }
          }
          if store.conversation != nil && (store.conversation?.earlier ?? 0) == 0 && store.conversation?.messages.isEmpty == false {
            Text("This is the start of your conversation with \(bot.name).").font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity)
          }
          if store.conversation == nil {
            ProgressView("Loading conversation…").frame(maxWidth: .infinity).padding(40)
          } else if store.conversation?.messages.isEmpty == true {
            VStack(spacing: 14) {
              AvatarView(avatar: bot.avatar ?? AvatarConfig(), size: 100, name: bot.name, forceReducedMotion: true)
              Text("Let's discuss your role.").font(.title2.bold())
              Text(bot.description?.isEmpty == false ? bot.description! : "Give this assistant a role, then start with what you need.").foregroundStyle(.secondary)
              Button("Discuss \(bot.name)'s role") {
                var draft = store.draft
                let role = bot.description?.isEmpty == false ? ": \(bot.description!)" : ". Ask me what I need help with and how I like to work"
                draft.text = "Let's talk about your role as \(bot.name)\(role)."
                store.updateDraft(draft); composerFocused = true
              }.buttonStyle(.bordered).disabled(!store.draftReady)
            }.multilineTextAlignment(.center).frame(maxWidth: .infinity).padding(.vertical, 36).id("welcome")
          }
          ForEach(store.conversation?.presentationTurns ?? []) { turn in
            ConversationTurnView(turn: turn, advanced: advanced)
          }
          if ![.idle, .done].contains(store.activity) { liveActivity }
          ForEach(store.conversation?.approvals.filter { $0.status == "pending" } ?? []) {
            approval in approvalCard(approval)
          }
          ForEach(store.conversation?.attention ?? []) { request in
            AttentionView(request: request, botId: bot.id)
          }
          Color.clear.frame(height: 1).id("latest").onGeometryChange(for: CGFloat.self) {
            $0.frame(in: .named("transcript")).maxY
          } action: { bottom in
            nearBottom = bottom <= viewportHeight + 120
            if nearBottom { unseen = 0 }
          }
        }.scrollTargetLayout().padding(16).frame(maxWidth: 850, alignment: .leading).frame(
          maxWidth: .infinity)
      }
      .scrollPosition(id: $visibleMessage, anchor: .top)
      .coordinateSpace(name: "transcript")
      .onGeometryChange(for: CGFloat.self) {
        $0.size.height
      } action: {
        viewportHeight = $0
      }
      .scrollDismissesKeyboard(.interactively)
      .onChange(of: store.conversation?.botId, initial: true) { _, id in
        guard let id, id != restoredBot else { return }
        restoredBot = id
        nearBottom = true
        visibleMessage = nil
        if let message = store.conversation?.restorableReadAnchor(store.readMessageId()) {
          // The lazy bottom sentinel may never load here, so assume the user is away
          // from the latest message until it appears.
          nearBottom = message == store.conversation?.messages.last?.id
          visibleMessage = message
          proxy.scrollTo(message, anchor: .top)
        } else if store.conversation?.messages.isEmpty == true {
          proxy.scrollTo("welcome", anchor: .top)
        } else {
          proxy.scrollTo("latest", anchor: .bottom)
        }
      }
      .overlay(alignment: .bottom) {
        if !nearBottom {
          Button {
            proxy.scrollTo("latest", anchor: .bottom)
            store.markRead(store.conversation?.messages.last?.id)
          } label: {
            Label(unseen == 0 ? "Jump to latest" : "\(unseen) new \(unseen == 1 ? "message" : "messages")", systemImage: "arrow.down").font(.subheadline).padding(.horizontal, 16).padding(.vertical, 10).background(.regularMaterial, in: Capsule())
          }.accessibilityLabel(unseen == 0 ? "Jump to latest" : "\(unseen) new \(unseen == 1 ? "message" : "messages"), jump to latest").padding(12).transition(.opacity)
        }
      }
      .animation(.easeOut(duration: 0.15), value: nearBottom)
      .refreshable {
        await store.refreshConversation()
        await store.reconcilePending()
      }
      .onChange(of: visibleMessage) { _, id in
        readSaveTask?.cancel()
        guard let id, store.conversation?.messages.contains(where: { $0.id == id }) == true else {
          return
        }
        readSaveTask = Task {
          try? await Task.sleep(for: .milliseconds(350))
          guard !Task.isCancelled else { return }
          store.markRead(id)
        }
      }
      .onChange(of: store.conversation?.visibleMessages.last?.id) { old, new in
        if let old, old != new, !nearBottom {
          let messages = store.conversation?.visibleMessages ?? []
          unseen += messages.firstIndex { $0.id == old }.map { messages.count - $0 - 1 } ?? 1
        }
      }
      .onChange(of: latestTrigger) { _, _ in proxy.scrollTo("latest", anchor: .bottom) }
      .onChange(of: store.conversation?.messages.last?.text) { _, _ in
        if nearBottom && store.conversation?.messages.isEmpty == false {
          proxy.scrollTo("latest", anchor: .bottom)
        }
      }
      .onDisappear {
        readSaveTask?.cancel()
        if let id = visibleMessage,
          store.conversation?.messages.contains(where: { $0.id == id }) == true
        {
          store.markRead(id)
        }
      }
    }
  }
  private var activitySentence: String {
    switch store.activity {
    case .blocked: "\(bot.name) needs your help"
    case .failed: "\(bot.name)'s last task failed"
    case .interrupted: "\(bot.name) was interrupted"
    case .disconnected: "Connection lost. Your draft is kept."
    case .unknown: "\(bot.name)'s status is unknown"
    default: "\(bot.name) is \(store.activity.label.lowercased())"
    }
  }
  private var liveActivity: some View {
    HStack(alignment: .center, spacing: 12) {
      AvatarView(avatar: bot.avatar ?? AvatarConfig(), state: store.activity, size: 44, name: bot.name)
      VStack(alignment: .leading, spacing: 4) {
        Text(activitySentence).font(.subheadline.bold())
        if let detail = store.conversation?.activity.detail, !detail.isEmpty {
          Text(detail).font(.caption).foregroundStyle(.secondary).lineLimit(3)
        }
        if store.bootstrap?.preferences.presentation == "advanced",
          let call = store.conversation?.activityMessages.last(where: { $0.toolCall?.status == "running" })?.toolCall
        {
          Label(call.name, systemImage: "wrench.and.screwdriver").font(.caption)
        }
      }
      Spacer(minLength: 0)
    }.padding(.vertical, 8).accessibilityIdentifier("liveActivity")
  }
  private var composer: some View {
    VStack(alignment: .leading, spacing: 10) {
      if store.activity == .interrupted {
        Text("This task was interrupted. Review its last actions before sending another message.")
          .font(.footnote).foregroundStyle(.orange)
        Toggle("I reviewed this interrupted task", isOn: $store.interruptionReviewed).font(
          .footnote)
      }
      if let pending = store.pending {
        VStack(alignment: .leading, spacing: 8) {
          Text(
            pending.botId == bot.id
              ? "Checking admission. Your original message and request ID are saved."
              : "Another assistant's message is awaiting an admission check."
          ).font(.footnote)
          Text(store.receipt?.message ?? "Your message will not be automatically resent.").font(
            .caption
          ).foregroundStyle(.secondary)
          HStack {
            Button("Check again") { Task { await store.reconcilePending() } }
            if pending.botId == bot.id && store.supports("idempotency") {
              Button("Review and retry") { retryConfirm = true }.disabled(
                !store.connected || store.sending)
            }
            if pending.botId != bot.id {
              Button("Open assistant") { Task { await store.select(pending.botId) } }
            }
          }.font(.caption)
          Button("Discard and keep my text in the draft", role: .destructive) {
            discardConfirm = true
          }.font(.caption).disabled(store.sending).accessibilityIdentifier("discardUnconfirmedSend")
        }.padding(10).background(Color.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
      } else if let receipt = store.receipt,
        receipt.status == "rejected" || receipt.status == "interrupted"
      {
        Text(receipt.message ?? "The message was \(receipt.status). Your draft is saved.").font(
          .footnote
        ).foregroundStyle(.orange)
      }
      ForEach(store.attachmentUploads.filter { $0.botId == bot.id }) { upload in
        HStack(spacing: 8) {
          if upload.uploading { ProgressView() } else { Image(systemName: upload.error == nil ? "clock" : "exclamationmark.circle").foregroundStyle(upload.error == nil ? Palette.muted : Palette.danger) }
          VStack(alignment: .leading, spacing: 3) {
            Text(upload.name).lineLimit(1)
            Text(upload.error ?? "Waiting to upload…").font(.caption).foregroundStyle(.secondary).lineLimit(2)
          }
          Spacer(minLength: 0)
          if !upload.uploading { Button("Retry") { Task { await store.retryUpload(upload.id) } }.accessibilityLabel("Retry \(upload.name)").disabled(!store.connected || store.uploading) }
          Button { store.removeUpload(upload.id) } label: { Image(systemName: "xmark.circle") }.accessibilityLabel("Remove \(upload.name)")
        }.font(.subheadline).padding(8).background(Palette.user(scheme), in: RoundedRectangle(cornerRadius: 10))
      }
      if !store.draft.attachments.isEmpty {
        ScrollView(.horizontal) {
          HStack {
            ForEach(store.draft.attachments) { file in
              HStack {
                Button { store.open(file) } label: {
                  if file.mime.hasPrefix("image/") {
                    AuthenticatedImage(path: "/api/files/\(APIClient.component(file.id))").scaledToFill().frame(width: 40, height: 40).clipped().clipShape(RoundedRectangle(cornerRadius: 6))
                  } else { Image(systemName: "doc").frame(width: 32, height: 40) }
                }.accessibilityLabel("Preview \(file.name)")
                Text(file.name).lineLimit(1)
                Button {
                  var next = store.draft
                  next.attachments.removeAll { $0.id == file.id }
                  store.updateDraft(next)
                } label: {
                  Image(systemName: "xmark.circle.fill")
                }.accessibilityLabel("Remove \(file.name)")
              }.font(.caption).padding(8).background(Palette.user(scheme), in: Capsule())
            }
          }
        }
      }
      TextField(
          store.active ? "Guide the current task…" : "Message \(bot.name)…",
          text: Binding(
            get: { store.draft.text },
            set: {
              var value = store.draft
              value.text = $0
              store.updateDraft(value)
            }), axis: .vertical
        ).lineLimit(2...6).focused($composerFocused).padding(12).background(
          Palette.raised(scheme), in: RoundedRectangle(cornerRadius: 16)
        ).disabled(!store.draftReady).accessibilityIdentifier("messageComposer")
      HStack(alignment: .bottom, spacing: 10) {
        Menu {
          Button("Choose photos", systemImage: "photo.on.rectangle") { importPhotos = true }
            .disabled(!store.supports("uploads") || store.draft.attachments.count + store.attachmentUploads.filter { $0.botId == bot.id }.count >= 10)
          Button("Attach image, PDF, or text file", systemImage: "paperclip") { importFiles = true }
            .disabled(
              !store.supports("uploads")
                || store.draft.attachments.count + store.attachmentUploads.filter { $0.botId == bot.id }.count >= 10)
          if !starters.isEmpty {
            Section("Starters") {
              ForEach(starters) { item in Button(item.title) { addStarter(item) } }
            }
          }
        } label: {
          Image(systemName: "plus").font(.title3).frame(width: 40, height: 44)
        }.accessibilityLabel("Add to message").accessibilityIdentifier("composerAdd")
          .disabled(!store.draftReady)
        if advanced { modelButton }
        Button { voiceOpen = true } label: { Image(systemName: "mic").frame(width: 36, height: 44) }
          .accessibilityLabel("Record voice message").disabled(!store.draftReady || !store.connected || store.sending)
        Spacer(minLength: 0)
        Button {
          if stopVisible {
            run { try await store.perform("/bots/\(APIClient.component(bot.id))/stop", [String: String]()) }
          } else {
            Task { await store.send(); composerFocused = false; latestTrigger += 1 }
          }
        } label: {
          Image(
            systemName: stopVisible ? "stop.fill" : store.sending
              ? "hourglass" : store.active ? "arrow.turn.up.right" : "arrow.up"
          ).font(.headline).frame(width: 44, height: 44)
            .foregroundStyle(store.canSend || stopVisible ? Palette.raised(scheme) : Palette.muted)
            .background(store.canSend || stopVisible ? Palette.accent : Palette.line, in: Circle())
            .contentShape(Circle())
        }.buttonStyle(.plain).disabled(stopVisible ? actionBusy || !store.connected : !store.canSend)
          .accessibilityLabel(stopVisible ? "Stop task" : store.active ? "Send guidance" : "Send message")
          .accessibilityIdentifier("sendMessage")
      }
      if store.uploading {
        ProgressView("Uploading…").font(.caption)
      } else if store.draft.text.count > 50000 {
        Text("Messages can contain up to 50,000 characters.").font(.caption).foregroundStyle(.red)
      } else if store.active {
        Text("Messages guide this task at Hermes's next supported boundary.").font(.caption)
          .foregroundStyle(.secondary)
      } else if !store.connected {
        Text(
          store.sessionExpired
            ? "Sign in again to send. Your draft is kept."
            : "Your draft is saved on this device. Reconnect to send."
        ).font(.caption).foregroundStyle(.secondary)
      }
      if !store.supports("chat") {
        Text(store.reason("chat")).font(.caption).foregroundStyle(.secondary)
      }
    }.padding(12).background(Palette.raised(scheme), in: RoundedRectangle(cornerRadius: 20))
      .overlay(RoundedRectangle(cornerRadius: 20).stroke(Palette.line, lineWidth: 1))
      .padding(12).frame(maxWidth: 850).frame(maxWidth: .infinity).background(Palette.surface(scheme))
      .overlay(alignment: .top) { Rectangle().fill(Palette.line).frame(height: 1) }
  }
  private var stopVisible: Bool { store.active && !store.sending && store.draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && store.draft.attachments.isEmpty && store.supports("stop") }
  private var advanced: Bool { store.bootstrap?.preferences.presentation == "advanced" }
  private var modelButton: some View {
    Button { modelOpen = true } label: {
      HStack(spacing: 6) {
        Image(systemName: "cpu")
        Text(bot.model).font(.caption).lineLimit(1).truncationMode(.middle)
      }.frame(maxWidth: 180, minHeight: 44, alignment: .leading)
    }.accessibilityLabel("Model: \(bot.model)").accessibilityIdentifier("composerModel")
      .disabled(bot.instructions == nil || !store.supports("botConfiguration") || !store.connected)
  }
  private func addStarter(_ item: Starter) {
    var next = store.draft
    next.text += (next.text.isEmpty ? "" : "\n\n") + item.prompt
    store.updateDraft(next)
    composerFocused = true
  }
  private func loadStarters() async {
    starters = []
    let scope = store.scope
    let rows: [Starter] = (try? await store.api?.get("/bots/\(APIClient.component(bot.id))/starters")) ?? []
    if scope == store.scope && !Task.isCancelled { starters = rows }
  }
  private func approvalCard(_ approval: Approval) -> some View {
    ApprovalDecisionView(approval: approval, botId: bot.id)
  }
  private func run(_ action: @escaping () async throws -> Void) {
    guard !actionBusy else { return }
    actionBusy = true
    Task {
      defer { actionBusy = false }
      do {
        try await action()
        await store.refreshConversation()
      } catch { store.report(error) }
    }
  }
}
struct MessageView: View {
  var message: Message
  var advanced: Bool
  var continued = false
  var groupedReasoning = false
  var groupedActivity = false
  @EnvironmentObject private var store: AppStore
  @Environment(\.colorScheme) private var scheme
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      if !continued { HStack {
        Text(
          message.presentationOrigin?.kind == "scheduled" && !message.isInternalActivity ? "Scheduled" : message.sender?.name
            ?? (message.isInternalActivity ? message.presentationOrigin?.title ?? message.activityGroup : message.role == "assistant"
              ? ""
              : message.role == "tool" ? message.toolName ?? "Tool" : message.role.capitalized)
        ).font(.caption.bold())
        Spacer()
        if let date = message.createdAt, let value = ServerDate.parse(date) {
          Text(value, style: .time).font(.caption2).foregroundStyle(.secondary)
        }
      } }
      if let envelope = message.agentEnvelope {
        Label("\(envelope.name) → \(store.bot?.name ?? "Assistant")", systemImage: "arrow.left.arrow.right").font(.caption.bold()).foregroundStyle(Palette.accent)
        Text("Agent message").font(.caption).foregroundStyle(.secondary)
        Text(envelope.body).textSelection(.enabled)
      } else if message.isAgentExchange {
        Label("Agent handoff", systemImage: "arrow.left.arrow.right").font(.caption.bold()).foregroundStyle(Palette.accent)
        ToolActivityView(message: message)
      } else if message.isToolActivity {
        if !groupedActivity {
          if !advanced,let call=message.toolCall { ActionReceiptView(call:call) } else { ToolActivityView(message:message) }
        }
      } else {
        ReplyContentView(message: message)
        if message.role == "assistant" && !message.isInternalActivity && !message.text.isEmpty { SpokenReplyButton(text: ReplyCards.spokenText(message.text)) }
        if !groupedActivity && advanced && message.toolCall != nil { ToolActivityView(message: message) }
        if !groupedActivity && !advanced,let call=message.toolCall { ActionReceiptView(call:call) }
      }
      if advanced && !groupedReasoning, let reasoning = message.reasoning, !reasoning.isEmpty {
        DisclosureGroup("Reasoning") {
          MarkdownView(text: reasoning).font(.footnote).foregroundStyle(.secondary)
        }
      }
      ForEach(message.files ?? []) { FileAttachmentView(file: $0) }
    }.padding(message.role == "user" || message.isAgentExchange ? 14 : 0).background(
      message.isAgentExchange ? Palette.raised(scheme) : message.role == "user" ? Palette.user(scheme) : Color.clear,
      in: RoundedRectangle(cornerRadius: 14)
    ).padding(.leading, message.role == "user" && !message.isInternalActivity ? 32 : 0)
      .accessibilityElement(children: .contain)
  }
}
struct ToolActivityView: View {
  var message: Message
  @EnvironmentObject private var store: AppStore
  var body: some View {
    DisclosureGroup {
      VStack(alignment: .leading, spacing: 8) {
        if let call = message.toolCall {
          LabeledContent("Call", value: call.id).font(.caption).textSelection(.enabled)
          if let date = call.startedAt.flatMap(ServerDate.parse) { LabeledContent("Started", value: date.formatted()).font(.caption) }
          if let date = call.completedAt.flatMap(ServerDate.parse) { LabeledContent("Finished", value: date.formatted()).font(.caption) }
        }
        if let arguments = message.toolCall?.arguments, !arguments.isEmpty {
          Text("Arguments").font(.caption.bold())
          Text(arguments).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
        }
        if let error = message.toolCall?.error, !error.isEmpty {
          Label(error, systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(.red)
        }
        let result = message.toolResult
        if !result.isEmpty { MarkdownView(text: result).font(.footnote) }
      }.padding(.vertical, 4)
    } label: {
      HStack {
        Label(message.displayToolName, systemImage: "wrench.and.screwdriver").font(.caption.bold())
        Spacer()
        if let status = message.toolCall?.status {
          Text(status == "running" && !store.connected ? "Last seen running" : status.capitalized).font(.caption).foregroundStyle(.secondary)
        }
      }
    }
  }
}
struct AttentionView: View {
  var request: Attention
  var botId: String
  @EnvironmentObject private var store: AppStore
  @State private var answers: [String: String] = [:]
  @State private var busy = false
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Label(request.title, systemImage: "questionmark.bubble").font(.headline)
      MarkdownView(text: request.detail)
      if request.kind == "clarify" {
        ForEach(request.questions ?? []) { question in
          Text(question.prompt).font(.subheadline.bold())
          if let options = question.options, !options.isEmpty {
            ForEach(options, id: \.self) { option in
              Button {
                answers[question.id] = option
              } label: {
                HStack {
                  Image(
                    systemName: answers[question.id] == option ? "checkmark.circle.fill" : "circle")
                  Text(option)
                }
              }.buttonStyle(.plain)
            }
          }
          TextField(
            "Your answer",
            text: Binding(get: { answers[question.id] ?? "" }, set: { answers[question.id] = $0 }),
            axis: .vertical
          ).textFieldStyle(.roundedBorder)
        }
        Button("Send answers") {
          busy = true
          Task {
            defer { busy = false }
            do {
              try await store.perform(
                "/bots/\(APIClient.component(botId))/requests/\(APIClient.component(request.id))",
                ["answers": answers])
              await store.refreshConversation()
            } catch { store.report(error) }
          }
        }.buttonStyle(.borderedProminent).disabled(
          busy || !store.connected
            || (request.questions ?? []).contains {
              (answers[$0.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            })
      } else if request.kind == "secure", let secure = request.secure, secure.supported {
        SecureAttentionView(request: request, botId: botId)
          .id(request.id + secure.binding)
      } else {
        Text("Complete this request in the official Hermes interface.").font(.footnote)
          .foregroundStyle(.secondary)
      }
    }.padding(16).background(Color.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 14))
  }
}
