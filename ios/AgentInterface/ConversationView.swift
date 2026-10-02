import SwiftUI
import UniformTypeIdentifiers

struct ConversationView: View {
  var bot: Bot
  var edit: () -> Void
  @EnvironmentObject private var store: AppStore
  @Environment(\.colorScheme) private var scheme
  @State private var importFiles = false
  @State private var voiceOpen = false
  @State private var stopConfirm = false
  @State private var retryConfirm = false
  @State private var actionBusy = false
  @State private var visibleMessage: String?
  @State private var restoredBot: String?
  @State private var readSaveTask: Task<Void, Never>?
  @State private var latestTrigger = 0
  @State private var viewportHeight: CGFloat = 0
  @State private var nearBottom = true
  @FocusState private var composerFocused: Bool
  var body: some View {
    VStack(spacing: 0) {
      header
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
      ToolbarItem(placement: .topBarTrailing) {
        Button(action: edit) { Image(systemName: "ellipsis.circle") }.accessibilityLabel(
          "Configure \(bot.name)")
      }
    }
    .sheet(isPresented: $voiceOpen) { VoiceMessageSheet(botId: bot.id).environmentObject(store) }
    .fileImporter(
      isPresented: $importFiles, allowedContentTypes: [.png, .jpeg, .webP, .gif, .pdf, .plainText],
      allowsMultipleSelection: true
    ) { result in
      switch result {
      case .success(let urls): Task { await store.attach(urls: urls) }
      case .failure(let error): store.report(error)
      }
    }
    .confirmationDialog(
      "Stop the current task? Completed actions remain in the conversation.",
      isPresented: $stopConfirm, titleVisibility: .visible
    ) {
      Button("Stop task", role: .destructive) {
        run {
          try await store.perform("/bots/\(APIClient.component(bot.id))/stop", [String: String]())
        }
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
  }
  private var header: some View {
    HStack(spacing: 12) {
      AvatarView(
        avatar: bot.avatar ?? AvatarConfig(), state: store.activity, size: 58, name: bot.name)
      VStack(alignment: .leading, spacing: 4) {
        Text(store.activity.label).font(.headline)
        Text(
          store.conversation?.activity.detail
            ?? (bot.shared
              ? "One shared conversation for your household"
              : "Your persistent assistant conversation")
        ).font(.caption).foregroundStyle(.secondary).lineLimit(3)
      }
      Spacer(minLength: 0)
      if !store.connected {
        Button {
          Task { await store.reconnect() }
        } label: {
          Image(systemName: "arrow.clockwise")
        }.accessibilityLabel("Reconnect").disabled(store.sessionExpired)
      }
      if store.active && store.supports("stop") {
        Button {
          stopConfirm = true
        } label: {
          Image(systemName: "stop.circle")
        }.accessibilityLabel("Stop task").disabled(actionBusy || !store.connected)
      }
    }.padding(.horizontal, 16).padding(.vertical, 10)
  }
  private var transcript: some View {
    ScrollViewReader { proxy in
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 18) {
          if store.conversation == nil {
            ProgressView("Loading conversation…").frame(maxWidth: .infinity).padding(40)
          } else if store.conversation?.messages.isEmpty == true {
            VStack(alignment: .leading, spacing: 8) {
              Text("Hello, \(store.bootstrap?.user.name ?? "there")").font(.title2.bold())
              Text("Ask \(bot.name) a question. This conversation stays with your assistant.")
                .foregroundStyle(.secondary)
            }.padding(.vertical, 36).id("welcome")
          }
          StarterActionsView(botId:bot.id)
          ForEach(store.conversation?.visibleMessages ?? []) { message in
            MessageView(
              message: message, advanced: store.bootstrap?.preferences.presentation == "advanced"
            )
            .id(message.id)
          }
          if store.active { liveActivity }
          ForEach(store.conversation?.approvals.filter { $0.status == "pending" } ?? []) {
            approval in approvalCard(approval)
          }
          ForEach(store.conversation?.attention ?? []) { request in
            AttentionView(request: request, botId: bot.id)
          }
          if let conversation = store.conversation,
            store.bootstrap?.preferences.presentation == "advanced"
              || !conversation.activityMessages.isEmpty
          {
            DisclosureGroup("Activity details") {
              Text(conversation.activity.detail ?? store.activity.label).font(.footnote)
              ForEach(conversation.activityMessages.suffix(8)) { message in
                ToolActivityView(message: message)
              }
              if store.bootstrap?.preferences.presentation == "advanced" {
                LabeledContent("Model", value: bot.model).font(.caption)
                if let provider = bot.provider {
                  LabeledContent("Provider", value: provider).font(.caption)
                }
                if let detail = store.bootstrap?.connection.detail {
                  Text(detail).font(.caption).foregroundStyle(.secondary)
                }
              }
            }
          }
          if !(store.conversation?.files.isEmpty ?? true) {
            DisclosureGroup("Conversation files") {
              ForEach(store.conversation?.files ?? []) {
                FileAttachmentView(file: $0).padding(.vertical, 6)
              }
            }
          }
          Color.clear.frame(height: 1).id("latest").onGeometryChange(for: CGFloat.self) {
            $0.frame(in: .named("transcript")).maxY
          } action: { bottom in
            nearBottom = bottom <= viewportHeight + 120
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
      .overlay(alignment: .bottomTrailing) {
        if !nearBottom {
          Button {
            proxy.scrollTo("latest", anchor: .bottom)
            store.markRead(store.conversation?.messages.last?.id)
          } label: {
            Image(systemName: "arrow.down").padding(10).background(.regularMaterial, in: Circle())
          }.accessibilityLabel("Jump to latest message").padding(12).transition(.opacity)
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
  private var liveActivity: some View {
    HStack(alignment: .center, spacing: 12) {
      AvatarView(avatar: bot.avatar ?? AvatarConfig(), state: store.activity, size: 44, name: bot.name)
      VStack(alignment: .leading, spacing: 4) {
        Text(store.activity == .blocked ? "\(bot.name) needs your help" : "\(bot.name) is \(store.activity.label.lowercased())").font(.subheadline.bold())
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
        }.padding(10).background(Color.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
      } else if let receipt = store.receipt,
        receipt.status == "rejected" || receipt.status == "interrupted"
      {
        Text(receipt.message ?? "The message was \(receipt.status). Your draft is saved.").font(
          .footnote
        ).foregroundStyle(.orange)
      }
      if !store.draft.attachments.isEmpty {
        ScrollView(.horizontal) {
          HStack {
            ForEach(store.draft.attachments) { file in
              HStack {
                Image(systemName: file.mime.hasPrefix("image/") ? "photo" : "doc")
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
      HStack(alignment: .bottom, spacing: 10) {
        Button { voiceOpen = true } label: { Image(systemName: "mic").frame(width: 36, height: 44) }
          .accessibilityLabel("Record voice message").disabled(!store.draftReady || !store.connected || store.sending)
        Button {
          importFiles = true
        } label: {
          Image(systemName: "paperclip").font(.title3).frame(width: 40, height: 44)
        }.accessibilityLabel("Attach image, PDF, or text file").disabled(
          !store.draftReady || store.uploading || !store.connected || !store.supports("uploads")
            || store.draft.attachments.count >= 10)
        TextField(
          store.active ? "Guide the current task…" : "Message \(bot.name)…",
          text: Binding(
            get: { store.draft.text },
            set: {
              var value = store.draft
              value.text = $0
              store.updateDraft(value)
            }), axis: .vertical
        ).lineLimit(1...6).focused($composerFocused).padding(12).background(
          Palette.raised(scheme), in: RoundedRectangle(cornerRadius: 14)
        ).disabled(!store.draftReady).accessibilityIdentifier("messageComposer")
        Button {
          Task {
            await store.send()
            composerFocused = false
            latestTrigger += 1
          }
        } label: {
          Image(
            systemName: store.sending
              ? "hourglass" : store.active ? "arrow.turn.up.right" : "arrow.up"
          ).font(.headline).frame(width: 44, height: 44)
            .foregroundStyle(store.canSend ? Palette.surface(scheme) : Palette.muted)
            .background(store.canSend ? Palette.accent : Palette.line, in: Circle())
            .contentShape(Circle())
        }.buttonStyle(.plain).disabled(!store.canSend)
          .accessibilityLabel(store.active ? "Send guidance" : "Send message")
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
    }.padding(12).background(.regularMaterial)
  }
  private func approvalCard(_ approval: Approval) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      Label(approval.title, systemImage: "hand.raised").font(.headline)
      MarkdownView(text: approval.detail)
      if let expiry = approval.expiresAt {
        Text("Expires \(expiry)").font(.caption).foregroundStyle(.secondary)
      }
      HStack {
        Button("Approve") { approve(approval, "approved") }.buttonStyle(.borderedProminent)
        Button("Deny", role: .destructive) { approve(approval, "denied") }.buttonStyle(.bordered)
      }.disabled(actionBusy || !store.connected || !store.supports("approvals"))
      Text("Either household member can decide. Hermes enforces the decision.").font(.caption)
        .foregroundStyle(.secondary)
    }.padding(16).background(Palette.raised(scheme), in: RoundedRectangle(cornerRadius: 14))
  }
  private func approve(_ approval: Approval, _ decision: String) {
    run {
      try await store.perform(
        "/bots/\(APIClient.component(bot.id))/approvals/\(APIClient.component(approval.id))",
        ["decision": decision])
    }
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
  @EnvironmentObject private var store: AppStore
  @Environment(\.colorScheme) private var scheme
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack {
        Text(
          message.sender?.name
            ?? (message.role == "assistant"
              ? "Assistant"
              : message.role == "tool" ? message.toolName ?? "Tool" : message.role.capitalized)
        ).font(.caption.bold())
        Spacer()
        if let date = message.createdAt, let value = ServerDate.parse(date) {
          Text(value, style: .time).font(.caption2).foregroundStyle(.secondary)
        }
      }
      if let envelope = message.agentEnvelope {
        Label("\(envelope.name) → \(store.bot?.name ?? "Assistant")", systemImage: "arrow.left.arrow.right").font(.caption.bold()).foregroundStyle(Palette.accent)
        Text("Agent message").font(.caption).foregroundStyle(.secondary)
        Text(envelope.body).textSelection(.enabled)
      } else if message.isAgentExchange {
        Label("Agent handoff", systemImage: "arrow.left.arrow.right").font(.caption.bold()).foregroundStyle(Palette.accent)
        ToolActivityView(message: message)
      } else if message.isToolActivity {
        if !advanced,let call=message.toolCall { ActionReceiptView(call:call) } else { ToolActivityView(message:message) }
      } else {
        ReplyContentView(message: message)
        if message.role == "assistant" && !message.text.isEmpty { SpokenReplyButton(text: ReplyCards.spokenText(message.text)) }
        if advanced && message.toolCall != nil { ToolActivityView(message: message) }
        if !advanced,let call=message.toolCall { ActionReceiptView(call:call) }
      }
      if advanced, let reasoning = message.reasoning, !reasoning.isEmpty {
        DisclosureGroup("Reasoning") {
          MarkdownView(text: reasoning).font(.footnote).foregroundStyle(.secondary)
        }
      }
      ForEach(message.files ?? []) { FileAttachmentView(file: $0) }
    }.padding(message.role == "user" || message.isAgentExchange ? 14 : 0).background(
      message.isAgentExchange ? Palette.raised(scheme) : message.role == "user" ? Palette.user(scheme) : Color.clear,
      in: RoundedRectangle(cornerRadius: 14)
    ).accessibilityElement(children: .contain)
  }
}
struct ToolActivityView: View {
  var message: Message
  var body: some View {
    DisclosureGroup {
      VStack(alignment: .leading, spacing: 8) {
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
          Text(status.capitalized).font(.caption).foregroundStyle(.secondary)
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
