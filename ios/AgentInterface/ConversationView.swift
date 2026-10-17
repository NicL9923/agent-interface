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
  @State private var discardConfirm = false
  @State private var checkingConnection = false
  @State private var earlierFailed = false
  @State private var actionBusy = false
  @State private var visibleMessage: String?
  @State private var openedBot: String?
  @State private var readSaveTask: Task<Void, Never>?
  @State private var latestTrigger = 0
  @State private var viewportHeight: CGFloat = 0
  @State private var content = TranscriptMetrics()
  /// Following keeps the latest message in view as replies and cards grow, as on the web.
  @State private var following = true
  /// Set once the opened chat sits at its latest message, so history only pages in after that.
  @State private var placed = false
  /// A smooth jump reports positions short of the end until it lands.
  @State private var jumpingUntil = Date.distantPast
  @State private var earlierEdgeVisible = false
  @State private var unseen = 0
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var modelOpen = false
  @State private var fileSheetOpen = false
  @FocusState private var composerFocused: Bool
  var body: some View {
    VStack(spacing: 0) {
      if !store.connected && !store.sessionExpired && store.bootstrap != nil { connectionCard }
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
      // The web header's order: files, settings, pin.
      ToolbarItemGroup(placement: .topBarTrailing) {
        let files = store.conversationFileCount
        Button { fileSheetOpen = true } label: {
          Image(systemName: "doc").overlay(alignment: .topTrailing) {
            if files > 0 {
              Text("\(files)").font(.system(size: 9, weight: .semibold)).monospacedDigit().foregroundStyle(Palette.accent)
                .padding(.horizontal, 3).background(Palette.surface(scheme), in: RoundedRectangle(cornerRadius: 5)).offset(x: 9, y: -7)
            }
          }
        }.accessibilityLabel("Artifacts (\(files))").accessibilityIdentifier("conversationFiles")
        Button(action: edit) { Image(systemName: "gearshape") }.accessibilityLabel(
          "Configure \(bot.name)")
        Button { Task { await store.togglePin(bot.id) } } label: {
          Image(systemName: store.bootstrap?.preferences.favorites.contains(bot.id) == true ? "pin.fill" : "pin")
        }.accessibilityLabel(store.bootstrap?.preferences.favorites.contains(bot.id) == true ? "Unpin assistant" : "Pin assistant")
          .disabled(!store.connected || store.sessionExpired)
      }
    }
    .onChange(of: bot.id) { _, _ in earlierFailed = false }
    .sheet(isPresented: $modelOpen) { ComposerModelSheet(botId: bot.id).appStore(store) }
    .sheet(isPresented: $fileSheetOpen) { ConversationFilesView().appStore(store) }
    .sheet(isPresented: $voiceOpen) { VoiceMessageSheet(botId: bot.id).appStore(store) }
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
        // Not lazy: like the web's page, every loaded turn has a real height, so the latest
        // message and a held place can be scrolled to exactly.
        VStack(alignment: .leading, spacing: 18) {
          if (store.conversation?.earlier ?? 0) > 0 {
            Button { loadEarlier(proxy) } label: {
              HStack(spacing: 7) {
                if store.loadingEarlier { ProgressView() }
                Text(store.loadingEarlier ? "Loading earlier messages…" : earlierFailed ? "Try loading earlier messages again" : "Show earlier messages")
              }
            }.buttonStyle(.bordered).disabled(store.loadingEarlier || !store.connected).frame(maxWidth: .infinity)
              .onGeometryChange(for: Bool.self) { geometry in geometry.frame(in: .named("transcript")).maxY >= -600 } action: { earlierEdgeVisible = $0 }
              .task(id: "\(store.conversation?.earlier ?? 0):\(earlierEdgeVisible):\(placed)") {
                // A failed page waits for the button, as on the web, instead of retrying on every scroll.
                guard earlierEdgeVisible, placed, !earlierFailed, store.connected, !store.loadingEarlier else { return }
                loadEarlier(proxy)
              }
          }
          if store.conversation != nil && (store.conversation?.earlier ?? 0) == 0 && store.conversation?.messages.isEmpty == false {
            Text("This is the start of your conversation with \(bot.name).").font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity)
          }
          if store.conversation == nil {
            ProgressView("Opening your conversation…").frame(maxWidth: .infinity).padding(40)
          } else if store.conversation?.messages.isEmpty == true && [.idle, .done].contains(store.activity) {
            VStack(spacing: 14) {
              AvatarView(avatar: bot.avatar ?? AvatarConfig(), size: 112, name: bot.name, forceReducedMotion: true)
              Text("Let's discuss your role.").font(.title2.bold())
              Text(bot.description?.isEmpty == false ? bot.description! : "Tell \(bot.name) what you need help with.").foregroundStyle(.secondary)
              Button("Discuss \(bot.name)'s role") {
                var draft = store.draft
                draft.text = RoleDiscussion.draft(appendingTo: draft.text, description: bot.description)
                store.updateDraft(draft); composerFocused = true
              }.buttonStyle(.bordered).disabled(!store.draftReady)
              if !store.supports("chat") { Text(store.reason("chat")).font(.footnote).foregroundStyle(.secondary) }
            }.multilineTextAlignment(.center).frame(maxWidth: .infinity).padding(.vertical, 36).id("welcome")
          }
          TranscriptTurns(turns: store.turns, advanced: advanced)
          if ![.idle, .done].contains(store.activity) { liveActivity }
          // Questions and secure requests come before approvals, as on the web.
          ForEach(store.conversation?.attention ?? []) { request in
            AttentionView(request: request, botId: bot.id)
          }
          ForEach(store.conversation?.approvals.filter { $0.status == "pending" } ?? []) {
            approval in approvalCard(approval)
          }
          Color.clear.frame(height: 1).id("latest")
        }.scrollTargetLayout().padding(16).frame(maxWidth: 850, alignment: .leading).frame(
          maxWidth: .infinity)
          .environment(\.transcriptConnected, store.connected)
          .onGeometryChange(for: TranscriptMetrics.self) { geometry in
            let frame = geometry.frame(in: .named("transcript"))
            return TranscriptMetrics(top: frame.minY, height: frame.height)
          } action: { contentMoved(to: $0, proxy) }
      }
      .scrollPosition(id: $visibleMessage, anchor: .top)
      .coordinateSpace(name: "transcript")
      .onGeometryChange(for: CGFloat.self) {
        $0.size.height
      } action: {
        viewportHeight = $0
        // The keyboard or a rotation resizes the view; a follower stays at the end.
        if following { scrollToLatest(proxy) }
      }
      .scrollDismissesKeyboard(.interactively)
      .onChange(of: store.conversation?.botId, initial: true) { _, id in
        guard let id, id != openedBot else { return }
        // Like the web, a chat always opens at its latest message.
        openedBot = id
        following = true
        placed = false
        unseen = 0
        visibleMessage = nil
        earlierFailed = false
        scrollToLatest(proxy)
      }
      .overlay(alignment: .bottom) {
        if !following && store.conversation != nil {
          Button { jumpToLatest(proxy) } label: {
            Label(unseen == 0 ? "Jump to latest" : "\(unseen) new \(unseen == 1 ? "message" : "messages")", systemImage: "arrow.down").font(.subheadline).padding(.horizontal, 16).padding(.vertical, 10).background(.regularMaterial, in: Capsule())
          }.accessibilityLabel(unseen == 0 ? "Jump to latest" : "\(unseen) new \(unseen == 1 ? "message" : "messages"), jump to latest").padding(12).transition(.opacity)
        }
      }
      .animation(.easeOut(duration: 0.15), value: following)
      .refreshable {
        await store.refreshConversation()
        await store.reconcilePending()
      }
      .onChange(of: visibleMessage) { _, _ in saveReadPosition() }
      .onChange(of: store.conversation?.visibleMessages.last?.id) { old, new in
        if let old, old != new, !following {
          let messages = store.conversation?.visibleMessages ?? []
          unseen += messages.firstIndex { $0.id == old }.map { messages.count - $0 - 1 } ?? 1
        }
      }
      .onChange(of: latestTrigger) { _, _ in following = true; scrollToLatest(proxy) }
      .onDisappear {
        readSaveTask?.cancel()
        if let id = readPosition { store.markRead(id) }
      }
    }
  }
  /// Content grew or the reader scrolled. Growth keeps a follower at the end; a scroll decides
  /// whether the reader is following, as the web's scroll handler does.
  private func contentMoved(to next: TranscriptMetrics, _ proxy: ScrollViewProxy) {
    let previous = content
    content = next
    if next.height != previous.height {
      if following { scrollToLatest(proxy) }
      return
    }
    let atLatest = next.top + next.height - viewportHeight < 100
    if atLatest || Date() >= jumpingUntil { following = atLatest }
    if atLatest { unseen = 0; jumpingUntil = .distantPast }
  }
  /// Waits for the layout pass that changed the content, then shows its end.
  private func scrollToLatest(_ proxy: ScrollViewProxy) {
    Task { @MainActor in
      proxy.scrollTo("latest", anchor: .bottom)
      if store.conversation != nil { placed = true }
    }
  }
  private func jumpToLatest(_ proxy: ScrollViewProxy) {
    following = true
    unseen = 0
    // A short trip glides; a long one jumps rather than scrolling through pages of history.
    let distance = content.top + content.height - viewportHeight
    if distance < viewportHeight * 3 && !reduceMotion {
      jumpingUntil = Date().addingTimeInterval(1)
      withAnimation(.easeOut(duration: 0.3)) { proxy.scrollTo("latest", anchor: .bottom) }
    } else {
      proxy.scrollTo("latest", anchor: .bottom)
    }
    saveReadPosition()
  }
  /// The web's reading position: the latest message while following, otherwise the top one in view.
  private var readPosition: String? {
    let messages = store.conversation?.messages ?? []
    if following { return messages.last?.id }
    return visibleMessage.flatMap { id in messages.contains { $0.id == id } ? id : nil }
  }
  private func saveReadPosition() {
    readSaveTask?.cancel()
    guard placed, let id = readPosition else { return }
    readSaveTask = Task {
      try? await Task.sleep(for: .milliseconds(350))
      guard !Task.isCancelled else { return }
      store.markRead(id)
    }
  }
  /// The tool the working avatar can hold, as the web picks it: the latest running call while connected.
  private var liveActivity: some View {
    HStack(alignment: .center, spacing: 12) {
      AvatarView(avatar: bot.avatar ?? AvatarConfig(), state: store.activity, size: 52, name: bot.name,
        prop: store.connected ? AvatarProp.from(toolCalls: store.conversation?.toolCalls) : nil)
      ShimmerText(
        text: ActivitySentence.text(name: bot.name, state: store.activity, detail: store.conversation?.activity.detail, connectionLost: !store.connected),
        moving: [.thinking, .working, .waiting].contains(store.activity))
      Spacer(minLength: 0)
    }.padding(.vertical, 8).accessibilityIdentifier("liveActivity")
  }
  /// The compact connection card the web shows above the transcript while Hermes is unreachable.
  private var connectionCard: some View {
    let connection = store.bootstrap?.connection
    let copy = ConnectionCopy.compact(code: connection?.code, appUnavailable: store.appUnavailable)
    return VStack(alignment: .leading, spacing: 6) {
      Text(copy.title).font(.subheadline.bold())
      Text(copy.detail).font(.caption).foregroundStyle(.secondary)
      Button(checkingConnection ? "Checking connection…" : copy.setup ? "Check connection" : "Reconnect now") {
        checkingConnection = true
        Task { await store.reconnect(); checkingConnection = false }
      }.font(.caption).buttonStyle(.bordered).disabled(checkingConnection).padding(.vertical, 2)
      DisclosureGroup(copy.setup ? "Set up this installation" : "Connection details") {
        VStack(alignment: .leading, spacing: 8) {
          if let address = connection?.address { Text("Hermes address: \(address)").textSelection(.enabled) }
          if let detail = connection?.detail, !detail.isEmpty { Text(detail) }
          if let last = connection?.lastConnectedAt, !When.format(last).isEmpty { Text("Last connected \(When.format(last, inline: true)).") }
          if copy.setup {
            Text("On the computer running WildBots, open its project folder and run `npm run setup`. Setup keeps the connection token on that computer. Restart this app after saving; everyone else can simply sign in.")
          }
          Text("For a read-only connection check on that computer, run `npm run doctor`.")
        }.frame(maxWidth: .infinity, alignment: .leading).padding(.top, 4)
      }.font(.caption).foregroundStyle(.secondary)
    }.padding(.horizontal, 16).padding(.vertical, 12).frame(maxWidth: .infinity, alignment: .leading)
      .background(Palette.raised(scheme)).overlay(alignment: .bottom) { Rectangle().fill(Palette.line).frame(height: 1) }
      .accessibilityElement(children: .contain).accessibilityIdentifier("connectionCard")
  }
  private var composer: some View {
    VStack(alignment: .leading, spacing: 8) {
      composerNotices
      composerCard
    }.padding(12).frame(maxWidth: 850).frame(maxWidth: .infinity).background(Palette.surface(scheme))
      .overlay(alignment: .top) { Rectangle().fill(Palette.line).frame(height: 1) }
  }
  /// The web composer's notices, above the message box.
  @ViewBuilder private var composerNotices: some View {
    if store.activity == .interrupted {
      Toggle("I reviewed the interrupted task and its last actions before continuing.", isOn: $store.interruptionReviewed)
        .toggleStyle(CheckboxStyle()).font(.footnote)
    }
    // A normal send only spins the send button. This appears once the request ended without a receipt.
    if let pending = store.pending, !store.sending {
      VStack(alignment: .leading, spacing: 8) {
        if pending.botId == bot.id {
          Text("Checking whether your last message arrived…").font(.footnote)
          Button("Retry this saved message") { Task { await store.send(reviewedUncertain: true) } }
            .font(.footnote).disabled(store.sending || !store.supports("idempotency") || !store.connected)
        } else {
          // This app holds one unconfirmed send at a time, so another assistant's blocks this one.
          Text("Another assistant's message is awaiting an admission check.").font(.footnote)
          Button("Open assistant") { Task { await store.select(pending.botId) } }.font(.footnote)
        }
        // A send that never resolves would otherwise block every assistant on this device.
        Button("Discard and keep my text in the draft", role: .destructive) {
          discardConfirm = true
        }.font(.caption).accessibilityIdentifier("discardUnconfirmedSend")
      }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
        .background(Palette.raised(scheme), in: RoundedRectangle(cornerRadius: 10))
        .accessibilityElement(children: .contain)
    }
    if let receipt = store.receipt, receipt.status == "rejected" {
      Text(receipt.message?.isEmpty == false ? receipt.message! : "Hermes did not accept this message. Your draft is saved.")
        .font(.footnote).foregroundStyle(Palette.attention)
    }
    if store.receipt?.status == "interrupted" {
      Text("This submission was interrupted. Review its last actions before trying again.")
        .font(.footnote).foregroundStyle(Palette.attention)
    }
  }
  private var composerCard: some View {
    VStack(alignment: .leading, spacing: 10) {
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
          store.active ? "Guide \(bot.name) while they work…" : "Message \(bot.name)…",
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
      HStack(alignment: .center, spacing: 8) {
        Menu {
          Button("Photo Library", systemImage: "photo.on.rectangle") { importPhotos = true }
          Button("Choose Files", systemImage: "folder") { importFiles = true }
        } label: {
          Image(systemName: "paperclip").font(.body).frame(width: 44, height: 44)
        }.accessibilityLabel("Attach images, PDFs, or text").accessibilityIdentifier("composerAttach")
          .disabled(attachUnavailable)
        if advanced { modelButton }
        Button { voiceOpen = true } label: { Image(systemName: "mic").frame(width: 44, height: 44) }
          .accessibilityLabel("Record voice message").disabled(!store.draftReady || !store.connected || store.sending || store.pending != nil)
        // The web offers the latest reply aloud only while the assistant is idle.
        if !store.active, let reply = latestReply {
          SpokenReplyButton(text: ReplyCards.spokenText(reply.text)).id(reply.id)
        }
        Spacer(minLength: 0)
        Button {
          if stopVisible {
            run { try await store.perform("/bots/\(APIClient.component(bot.id))/stop", [String: String]()) }
          } else {
            Task { await store.send(); composerFocused = false; latestTrigger += 1 }
          }
        } label: {
          let enabled = stopVisible ? !stopDisabled : store.canSend
          Group {
            if store.sending || (stopVisible && actionBusy) { ProgressView().tint(Palette.muted) }
            else { Image(systemName: stopVisible ? "stop.fill" : "arrow.up").font(.headline) }
          }.frame(width: 44, height: 44)
            .foregroundStyle(enabled ? Palette.raised(scheme) : Palette.muted)
            .background(enabled ? Palette.accent : Palette.line, in: Circle())
            .contentShape(Circle())
        }.buttonStyle(.plain).disabled(stopVisible ? stopDisabled : !store.canSend)
          .accessibilityLabel(stopVisible ? "Stop response" : store.active ? "Send guidance" : "Send message")
          .accessibilityIdentifier("sendMessage")
      }
      if store.uploading {
        ProgressView("Uploading…").font(.caption)
      } else if store.draft.text.count > 50000 {
        Text("Messages can contain up to 50,000 characters.").font(.caption).foregroundStyle(.red)
      }
      if !store.supports("chat") {
        Text(store.reason("chat")).font(.caption).foregroundStyle(.secondary)
      }
    }.padding(12).background(Palette.raised(scheme), in: RoundedRectangle(cornerRadius: 20))
      .overlay(RoundedRectangle(cornerRadius: 20).stroke(Palette.line, lineWidth: 1))
  }
  // An in-flight send keeps its spinning send button even if the draft is cleared meanwhile.
  private var stopVisible: Bool { store.active && !store.sending && store.draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && store.draft.attachments.isEmpty }
  private var stopDisabled: Bool { actionBusy || !store.connected || !store.supports("stop") }
  private var attachUnavailable: Bool {
    !store.supports("uploads") || !store.draftReady
      || store.draft.attachments.count + store.attachmentUploads.filter { $0.botId == bot.id }.count >= 10
  }
  /// The newest reply in the conversation, the one the web's Listen to reply reads.
  private var latestReply: Message? {
    store.conversation?.messages.last { $0.role == "assistant" && !$0.isInternalActivity && (!$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !($0.files ?? []).isEmpty) }
      .flatMap { $0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 }
  }
  private var advanced: Bool { store.bootstrap?.preferences.presentation == "advanced" }
  /// Icon only, like the web at phone width; the label still names the model.
  private var modelButton: some View {
    Button { modelOpen = true } label: {
      RobotGlyph().frame(width: 20, height: 20).frame(width: 44, height: 44)
    }.accessibilityLabel("Model: \(bot.model)").accessibilityIdentifier("composerModel")
      .disabled(bot.instructions == nil || !store.supports("botConfiguration") || !store.connected || store.sending)
  }
  private func loadEarlier(_ proxy: ScrollViewProxy) {
    let first = store.conversation?.messages.first?.id
    // The scroll position holds the turn in view while history is added above it. Before the
    // reader has scrolled there is none, so the oldest loaded turn is held instead.
    let anchor = visibleMessage == nil ? store.turns.first?.id : nil
    Task {
      await store.loadEarlier()
      // The store reports a failed page as an error and leaves the window as it was.
      earlierFailed = (store.conversation?.earlier ?? 0) > 0 && store.conversation?.messages.first?.id == first
      if let anchor, !following { proxy.scrollTo(anchor, anchor: .top) }
    }
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
/// A conversation row. Tool calls and reasoning render in the turn's groups, not here.
struct MessageView: View {
  var message: Message
  var continued = false
  @Environment(\.unobservedStore) private var store
  @Environment(\.colorScheme) private var scheme
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      if !continued && !message.isAgentExchange && (!label.isEmpty || message.createdAt != nil) {
        HStack(spacing: 12) {
          if !label.isEmpty { Text(label).font(.caption.weight(.semibold)) }
          if let date = message.createdAt { WhenText(value: date).font(.caption2) }
        }.foregroundStyle(.secondary)
      }
      if message.isAgentExchange {
        AgentExchangeView(message: message, recipient: store?.bot?.name ?? "Assistant")
      } else if !message.isToolActivity {
        ReplyContentView(message: message)
      }
      ForEach(message.files ?? []) { FileAttachmentView(file: $0) }
    }.padding(message.role == "user" && !message.isAgentExchange ? 14 : 0).background(
      message.role == "user" && !message.isAgentExchange ? Palette.user(scheme) : Color.clear,
      in: RoundedRectangle(cornerRadius: 14)
    ).padding(.leading, message.role == "user" && !message.isInternalActivity ? 32 : 0)
      .accessibilityElement(children: .contain)
  }
  private var label: String {
    message.presentationOrigin?.kind == "scheduled" && !message.isInternalActivity ? "Scheduled" : message.sender?.name
      ?? (message.isInternalActivity ? message.presentationOrigin?.title ?? message.activityGroup : message.role == "assistant"
        ? "" : message.role == "tool" ? message.toolName ?? "Tool" : message.role.capitalized)
  }
}
/// A message between assistants, as the web's AgentExchange shows it.
struct AgentExchangeView: View {
  var message: Message
  var recipient: String
  var body: some View {
    let handoff = AgentHandoff(message: message)
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 8) {
        Text("↔").accessibilityHidden(true)
        Text(handoff.incoming.map { "\($0.name) → \(recipient)" } ?? "\(recipient) → \(handoff.target)").bold()
        Text("Agent message").foregroundStyle(.secondary)
      }.font(.caption)
      if let incoming = handoff.incoming {
        Text(incoming.body).textSelection(.enabled)
      } else {
        DisclosureGroup(handoff.summary) {
          VStack(alignment: .leading, spacing: 8) {
            if !handoff.body.isEmpty { Text(handoff.body).textSelection(.enabled) }
            Text(handoff.response).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
          }.frame(maxWidth: .infinity, alignment: .leading).padding(.top, 4)
        }.font(.subheadline)
      }
    }.padding(.horizontal, 16).padding(.vertical, 12).frame(maxWidth: .infinity, alignment: .leading)
      .background(Palette.accentSoft, in: UnevenRoundedRectangle(bottomTrailingRadius: 12, topTrailingRadius: 12))
      .overlay(alignment: .leading) { Rectangle().fill(Palette.accent).frame(width: 3) }
  }
}
/// A tool call's detail, as the web's ToolCallDetail: identifiers and times, then the call's
/// arguments, result and error as preformatted text.
struct ToolActivityView: View {
  var message: Message
  @Environment(\.transcriptConnected) private var connected
  var body: some View {
    DisclosureGroup {
      VStack(alignment: .leading, spacing: 8) {
        if let call = message.toolCall { times(call) }
        if let arguments = message.toolCall?.arguments { section("Arguments", arguments) }
        if let result { section("Result", result) }
        if let error = message.toolCall?.error, !error.isEmpty { section("Error", error, danger: true) }
        if let waiting = Self.waiting(message.toolCall, result: result, connected: connected) {
          Text(waiting).font(.footnote).foregroundStyle(.secondary)
        }
      }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 4)
    } label: {
      HStack {
        Label(message.displayToolName, systemImage: "wrench.and.screwdriver").font(.caption.bold())
        Spacer()
        if let call = message.toolCall {
          Text(Self.status(call.status, connected: connected)).font(.caption)
            .foregroundStyle(call.status == "failed" ? Palette.danger : .secondary)
        }
      }
    }
  }
  /// The call's own result, or the text of a tool row that carries it.
  private var result: String? {
    message.toolCall?.result ?? (message.toolResult.isEmpty ? nil : message.toolResult)
  }
  @ViewBuilder private func times(_ call: ToolCall) -> some View {
    LabeledContent("Call") { Text(call.id).font(.system(.caption, design: .monospaced)) }.font(.caption).textSelection(.enabled)
    if let date = call.startedAt, !When.format(date).isEmpty { LabeledContent("Started") { WhenText(value: date) }.font(.caption) }
    if let date = call.completedAt, !When.format(date).isEmpty { LabeledContent("Finished") { WhenText(value: date) }.font(.caption) }
  }
  private func section(_ title: String, _ text: String, danger: Bool = false) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(title).font(.caption.bold()).accessibilityAddTraits(.isHeader)
      Text(text).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    }.foregroundStyle(danger ? Palette.danger : Color.primary)
  }
  static func status(_ status: String, connected: Bool) -> String {
    status == "running" ? connected ? "Running" : "Last seen running" : status == "failed" ? "Failed" : "Completed"
  }
  /// What a running call with no result yet is waiting for.
  static func waiting(_ call: ToolCall?, result: String?, connected: Bool) -> String? {
    guard call?.status == "running", result == nil else { return nil }
    return connected ? "Waiting for the result from Hermes." : "The current tool status will be checked when Hermes reconnects."
  }
}
struct AttentionView: View {
  var request: Attention
  var botId: String
  @EnvironmentObject private var store: AppStore
  @Environment(\.colorScheme) private var scheme
  @State private var answers: [String: String] = [:]
  @State private var busy = false
  private var secure: Bool { request.kind == "secure" && request.secure?.supported == true }
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text(request.kind == "clarify" ? "A question for you" : secure ? "Secure input for Hermes" : "Continue in Hermes")
        .font(.caption.weight(.semibold)).foregroundStyle(Palette.attention)
      Text(request.title).font(.headline)
      Text(request.detail).textSelection(.enabled)
      if request.kind == "clarify" {
        ForEach(request.questions ?? []) { question in
          VStack(alignment: .leading, spacing: 6) {
            Text(question.prompt).font(.subheadline)
            let answer = Binding(get: { answers[question.id] ?? "" }, set: { answers[question.id] = $0 })
            if let options = question.options, !options.isEmpty {
              Picker(question.prompt, selection: answer) {
                Text("Choose an answer").tag("")
                ForEach(options, id: \.self) { Text($0).tag($0) }
              }.pickerStyle(.menu).labelsHidden()
            } else {
              TextField(question.prompt, text: answer, axis: .vertical).textFieldStyle(.roundedBorder).labelsHidden()
            }
          }
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
      } else if secure, let value = request.secure {
        SecureAttentionView(request: request, botId: botId)
          .id(request.id + value.binding)
      } else {
        Text("Open the official Hermes interface to handle this request. Return here when it is complete.").font(.footnote)
          .foregroundStyle(.secondary)
      }
    }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
      .background(Palette.raised(scheme), in: RoundedRectangle(cornerRadius: 14))
      .overlay(alignment: .leading) { UnevenRoundedRectangle(topLeadingRadius: 14, bottomLeadingRadius: 14).fill(Palette.attention).frame(width: 4) }
  }
}

/// The working line's sentence, ported from the web conversation: one sentence that names the
/// current step while working and a plain verb for every other state.
enum ActivitySentence {
  static let actions: [ActivityState: String] = [
    .idle: "ready", .thinking: "thinking", .working: "working", .waiting: "waiting for approval",
    .blocked: "waiting for your input", .done: "done", .failed: "having trouble", .interrupted: "stopped", .disconnected: "reconnecting",
  ]
  static func text(name: String, state: ActivityState, detail: String?, connectionLost: Bool) -> String {
    let step = (detail ?? "").trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: #"[.…]+$"#, with: "", options: .regularExpression)
    if !connectionLost && state == .working && !step.isEmpty { return "\(name) is \(step.prefix(1).lowercased() + step.dropFirst())..." }
    // A state from a newer server has no web verb yet.
    guard let action = actions[connectionLost ? .disconnected : state] else { return "\(name)'s status is unknown" }
    return "\(name) is \(action)..."
  }
}

/// What the "Discuss role" button adds to the draft. It appends, so typed text is kept, as on the web.
enum RoleDiscussion {
  static func draft(appendingTo text: String, description: String?) -> String {
    let role = description.flatMap { $0.isEmpty ? nil : ": \($0)" } ?? ". Ask me what I need help with and how I like to work"
    let line = "Let's discuss your role\(role)."
    return text.isEmpty ? line : "\(text)\n\n\(line)"
  }
}

/// A message between assistants. Incoming ones carry an envelope; outgoing ones are a
/// `message_agent` call whose arguments name the target, as the web's AgentExchange reads them.
struct AgentHandoff {
  var incoming: (name: String, body: String)?
  var target = "another assistant"
  var body = ""
  var summary: String
  var response: String
  init(message: Message) {
    if let envelope = message.agentEnvelope { incoming = envelope }
    else if message.role == "user", let name = message.presentationOrigin?.name { incoming = (name, message.text) }
    if incoming == nil {
      if let name = message.presentationOrigin?.name { target = name }
      if let data = message.toolCall?.arguments?.data(using: .utf8),
        let arguments = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
      {
        if let value = arguments["target"] as? String { target = value }
        if let value = arguments["message"] as? String { body = value }
      }
    }
    summary = message.toolCall?.status == "running" ? "Sending message…" : message.toolCall?.status == "failed" ? "Delivery failed" : "View handoff and response"
    response = [message.toolCall?.error, message.toolCall?.result, message.text].compactMap { $0 }.first { !$0.isEmpty }
      ?? "Waiting for Hermes to report delivery."
  }
}

/// The compact connection card's copy, from the web's ConnectionPanel.
struct ConnectionCopy: Equatable {
  var title: String
  var detail: String
  var setup = false
  static func compact(code: String?, appUnavailable: Bool) -> ConnectionCopy {
    if appUnavailable { return ConnectionCopy(title: "Reconnecting to the app", detail: "Your conversation stays here and your draft is kept. We'll check again automatically.") }
    switch code ?? "unreachable" {
    case "not_configured": return ConnectionCopy(title: "Connect your household to Hermes", detail: "Set up the connection once on the computer running this app. Your existing assistants will appear here automatically.", setup: true)
    case "invalid_config": return ConnectionCopy(title: "The connection needs a small correction", detail: "The saved Hermes address or token is incomplete. Run setup on the computer hosting this app to correct it.", setup: true)
    case "unauthorized": return ConnectionCopy(title: "Hermes didn't accept the connection", detail: "The saved connection token needs to be updated. Your conversations are still with Hermes.", setup: true)
    case "addon_missing": return ConnectionCopy(title: "Hermes is reachable. One step remains.", detail: "This installation needs the compatible connection add-on before it can safely send messages or recover work.", setup: true)
    case "incompatible": return ConnectionCopy(title: "Hermes and this app need matching versions", detail: "Run the connection check on the app's computer for the required version and update instructions.", setup: true)
    case "connecting": return ConnectionCopy(title: "Connecting to Hermes", detail: "Checking the connection and restoring your assistants.")
    case "reconnecting": return ConnectionCopy(title: "Reconnecting to Hermes", detail: "Your draft is kept. Existing work stays with Hermes, and messages won't be resent automatically.")
    case "closed": return ConnectionCopy(title: "The connection is restarting", detail: "Your draft is kept. We'll reconnect automatically.")
    default: return ConnectionCopy(title: "Hermes is temporarily unavailable", detail: "Your draft is kept. We'll reconnect automatically when Hermes is reachable again.")
    }
  }
}

/// The web's shimmering activity line: a highlight sweeps across while the assistant is busy.
struct ShimmerText: View {
  var text: String
  var moving: Bool
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  var body: some View {
    let label = Text(text).font(.footnote)
    if moving && !reduceMotion {
      label.foregroundStyle(.secondary).overlay {
        TimelineView(.animation) { context in
          let progress = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 2.8) / 2.8
          label.foregroundStyle(.primary).mask {
            GeometryReader { proxy in
              LinearGradient(colors: [.clear, .black, .clear], startPoint: .leading, endPoint: .trailing)
                .frame(width: proxy.size.width * 0.5).offset(x: proxy.size.width * (1.5 * progress - 0.5))
            }
          }
        }.accessibilityHidden(true)
      }
    } else {
      label.foregroundStyle(moving ? .secondary : .primary)
    }
  }
}

/// A server timestamp in the web's wording, refreshed each minute so "Just now" ages.
struct WhenText: View {
  var value: String
  var inline = false
  var body: some View {
    TimelineView(.everyMinute) { context in Text(When.format(value, now: context.date, inline: inline)) }
  }
}

/// The web's robot icon (src/components/Icon.tsx), which SF Symbols has no match for.
struct RobotGlyph: View {
  var body: some View {
    Canvas { context, size in
      let scale = min(size.width, size.height) / 24
      var path = Path()
      path.addRoundedRect(in: CGRect(x: 4, y: 6, width: 16, height: 14), cornerSize: CGSize(width: 3, height: 3))
      for (from, to) in [((12.0, 3.0), (12.0, 6.0)), ((1, 11), (1, 15)), ((23, 11), (23, 15)), ((9, 16), (15, 16)), ((8, 11), (8.01, 11)), ((16, 11), (16.01, 11))] {
        path.move(to: CGPoint(x: from.0, y: from.1)); path.addLine(to: CGPoint(x: to.0, y: to.1))
      }
      context.stroke(path.applying(CGAffineTransform(scaleX: scale, y: scale)), with: .foreground,
        style: StrokeStyle(lineWidth: 1.8 * scale, lineCap: .round, lineJoin: .round))
    }.accessibilityHidden(true)
  }
}

/// A checkbox like the web's, for a confirmation that reads as a sentence.
struct CheckboxStyle: ToggleStyle {
  func makeBody(configuration: Configuration) -> some View {
    Button { configuration.isOn.toggle() } label: {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Image(systemName: configuration.isOn ? "checkmark.square.fill" : "square").foregroundStyle(configuration.isOn ? Palette.accent : Palette.muted)
        configuration.label.multilineTextAlignment(.leading).frame(maxWidth: .infinity, alignment: .leading)
      }
    }.buttonStyle(.plain).accessibilityAddTraits(.isToggle).accessibilityValue(configuration.isOn ? "1" : "0")
  }
}

/// Where the transcript's content sits in its scroll view, for following and holding a place.
struct TranscriptMetrics: Equatable {
  var top: CGFloat = 0
  var height: CGFloat = 0
}
