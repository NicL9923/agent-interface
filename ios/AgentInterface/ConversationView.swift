import SwiftUI
import UniformTypeIdentifiers

/// Reports the chat as read while it is on screen, uncovered, and the app is in use.
private struct ReadingChat: ViewModifier {
  var botId: String
  @State private var visible = false
  @Environment(AppStore.self) private var store
  @Environment(\.scenePhase) private var scenePhase
  func body(content: Content) -> some View {
    content
      .onAppear { visible = true; update(scenePhase, store.chatCovers) }
      .onChange(of: scenePhase, initial: true) { _, phase in update(phase, store.chatCovers) }
      .onChange(of: store.chatCovers) { _, covers in update(scenePhase, covers) }
      .onDisappear { visible = false; store.leave(botId) }
  }
  private func update(_ phase: ScenePhase, _ covers: Int) {
    if visible && phase == .active && covers == 0 { store.viewing(botId) } else { store.leave(botId) }
  }
}
/// Marks a sheet as covering the chat underneath for as long as it shows.
private struct CoveringChat: ViewModifier {
  let store: AppStore
  func body(content: Content) -> some View {
    content.onAppear { store.cover(true) }.onDisappear { store.cover(false) }
  }
}
extension View {
  func coveringChat(_ store: AppStore) -> some View { modifier(CoveringChat(store: store)) }
}

struct ConversationView: View {
  var bot: Bot
  var edit: () -> Void
  @Environment(AppStore.self) private var store
  @Environment(\.colorScheme) private var scheme
  @State private var checkingConnection = false
  private let reachability = NetworkReachability.shared
  @State private var earlierFailed = false
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
  @State private var fileSheetOpen = false
  @State private var profileOpen = false
  @State private var profileAction: BotProfileAction?
  @State private var composerFocused = false
  @State private var visible = false
  @State private var findOpen = false
  @State private var findQuery = ""
  @State private var findTarget: String?
  /// Matches the server found in this chat's canonical session, for history not loaded yet.
  @State private var findHits: FindHits?
  @FocusState private var findFocused: Bool
  /// A message opened from search or find, highlighted for a moment.
  @State private var highlighted: String?
  /// After Send, the next message on its way is held near the top while its reply grows below.
  @State private var anchorNext = false
  @State private var anchorScrollPending = false
  @State private var sentAnchor: String?
  @State private var anchorTop: CGFloat?
  @State private var contentEnd: CGFloat = 0
  /// Whether the reader sits at the end, where the jump control has nothing to jump to.
  @State private var atEnd = true
  private var matches: [FindMatches.Match] {
    FindMatches.merge(loaded: store.transcript?.messages ?? [], query: findQuery,
      hits: findHits?.query == findQuery ? findHits?.hits ?? [] : [], botId: bot.id, sessionId: store.conversation?.sessionId)
  }
  /// The sent message the transcript holds near the top. When Hermes's copy replaces the echo under
  /// another ID, the person's latest message takes its place.
  private var anchoredMessage: String? {
    guard let sentAnchor, let messages = store.transcript?.messages else { return nil }
    return messages.contains { $0.id == sentAnchor } ? sentAnchor : messages.last { $0.role == "user" }?.id
  }
  /// Room below the sent message so it can sit at the top before its reply fills the screen.
  private var anchorRoom: CGFloat {
    guard anchoredMessage != nil, let anchorTop else { return 0 }
    return max(0, viewportHeight - (contentEnd - anchorTop) - 16)
  }
  var body: some View {
    VStack(spacing: 0) {
      banners
      if findOpen { findBar }
      transcript
      composer
    }.modifier(ReadingChat(botId: bot.id)).background(Palette.surface(scheme)).navigationTitle(bot.name)
    .navigationBarTitleDisplayMode(.inline)
    .bareToolbarItem(.principal) { header }
    .onChange(of: bot.id) { _, _ in earlierFailed = false }
    .sheet(isPresented: $fileSheetOpen) { ConversationFilesView().appStore(store).coveringChat(store) }
    .sheet(isPresented: $profileOpen, onDismiss: profileClosed) { profileSheet }
    // On screen, even under a sheet, the conversation is polled and streamed; elsewhere it is not.
    .onAppear { if !visible { store.conversationShown(bot.id, true) }; visible = true }
    .onDisappear { if visible { store.conversationShown(bot.id, false) }; visible = false }
    .onChange(of: findQuery) { _, _ in findTarget = nil }
    .task(id: "\(findOpen):\(findQuery)") { await searchHistory() }
    .findShortcut(botId: bot.id, open: openFind)
  }
  private var cardShown: Bool {
    !(store.offlineSavedAt != nil && store.householdConnected && !reachability.offline)
      && store.connectionLost(offline: reachability.offline) && store.bootstrap != nil
  }
  @ViewBuilder private var banners: some View {
    // Home is live but this chat is still the copy saved on the device: say so, with its age,
    // until it reloads; Hermes itself is reachable, so the reconnect card would mislead.
    if let date = store.offlineSavedAt, store.householdConnected, !reachability.offline {
      Text("Saved on this device \(date.formatted(date: .abbreviated, time: .shortened)). Reloading this chat…")
        .font(.caption).foregroundStyle(.secondary).padding(8).accessibilityIdentifier("chatSavedCopy")
    } else if cardShown { connectionCard }
    // The connection card already says a poll failed; its error would only repeat it.
    if let error = store.error, store.connectionError == nil || !cardShown {
      ErrorBanner(message: error, dismiss: { store.dismissError() }).padding(.horizontal).padding(.bottom, 8)
    }
    if store.sessionExpired {
      Button("Sign in again. Your draft is saved.") { Task { await store.signIn() } }.buttonStyle(.bordered).padding(8)
    }
  }
  private var findBar: some View {
    let matches = matches
    let position = findTarget.flatMap { id in matches.firstIndex { $0.id == id } }
    return HStack {
      TextField("Find in chat", text: $findQuery).textFieldStyle(.roundedBorder).submitLabel(.search)
        .onSubmit { find(1) }
        .accessibilityIdentifier("findConversation").focused($findFocused)
      Text(FindMatches.status(position: position, count: matches.count)).font(.caption).monospacedDigit()
        .accessibilityIdentifier("findStatus")
      Button { find(-1) } label: { Image(systemName: "chevron.up") }.accessibilityLabel("Previous match").disabled(matches.isEmpty)
      Button { find(1) } label: { Image(systemName: "chevron.down") }.accessibilityLabel("Next match").disabled(matches.isEmpty)
      Button { findOpen = false; findTarget = nil; findHits = nil } label: { Image(systemName: "xmark") }.accessibilityLabel("Close find")
    }.padding(.horizontal).padding(.vertical, 8)
  }
  /// Like a messaging app: the system back button alone on the left, and the assistant in the
  /// middle. Tapping it opens the assistant's card, which holds find, pin, artifacts and settings.
  private var header: some View {
    Button { profileOpen = true } label: {
      // The avatar's shape sits inside its frame with room to move, so no extra gap is needed.
      VStack(spacing: 0) {
        AvatarView(avatar: bot.avatar ?? AvatarConfig(), state: headerState, size: 40, name: bot.name, botId: bot.id)
        Text(bot.name).font(.caption.weight(.semibold)).foregroundStyle(.primary).lineLimit(1)
      }.frame(maxWidth: 220).contentShape(Rectangle())
      // The bar does not grow with text, so the name stops at a size the bar can hold.
      .dynamicTypeSize(...DynamicTypeSize.xLarge)
    }.buttonStyle(.plain)
      .accessibilityElement(children: .ignore).accessibilityLabel(bot.name).accessibilityAddTraits(.isButton)
      .accessibilityHint("Shows find, pin, artifacts and settings").accessibilityIdentifier("botProfile")
  }
  /// The assistant's live state, as home shows it: a finished turn rests.
  private var headerState: ActivityState {
    !store.connected ? .disconnected : store.activity == .done ? .idle : store.activity
  }
  private var profileSheet: some View {
    BotProfileView(bot: bot, state: headerState) { action in
      profileAction = action
      profileOpen = false
    }.appStore(store).coveringChat(store)
  }
  /// Runs once the card has gone, so the next sheet or the find field can take over cleanly.
  private func profileClosed() {
    let action = profileAction
    profileAction = nil
    switch action {
    case .find: openFind()
    case .artifacts: fileSheetOpen = true
    case .settings: edit()
    case nil: break
    }
  }
  private func openFind() {
    findOpen = true
    // The field exists only once the bar is shown.
    Task { @MainActor in findFocused = true }
  }
  /// Moves to the next or previous match. A new query (`delta` 0) starts at the first loaded match, so
  /// typing never reloads the chat; stepping onto history not loaded yet opens the chat there.
  private func find(_ delta: Int) {
    let matches = matches
    guard !matches.isEmpty else { findTarget = nil; return }
    let current = findTarget.flatMap { id in matches.firstIndex { $0.id == id } }
    let index: Int
    if let current { index = (current + delta + matches.count) % matches.count }
    else if delta == 0 { guard let loaded = matches.firstIndex(where: \.loaded) else { return }; index = loaded }
    else { index = delta < 0 ? matches.count - 1 : matches.firstIndex(where: \.loaded) ?? 0 }
    let match = matches[index]
    following = false
    findTarget = match.id
    if match.loaded { highlight(match.id) } else { Task { await store.openConversation(botId: bot.id, atMessage: match.id) } }
  }
  /// After a 300 ms pause in typing, moves to the first loaded match, so the chat does not jump on
  /// every keystroke, then asks the server for matches in this chat's history, as the web's find
  /// does, for two characters or more. A later query cancels this one, and a late answer is dropped.
  private func searchHistory() async {
    guard findOpen, !findQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { findHits = nil; return }
    try? await Task.sleep(for: .milliseconds(300))
    guard !Task.isCancelled else { return }
    if findTarget == nil { find(0) }
    let query = findQuery.trimmingCharacters(in: .whitespacesAndNewlines)
    guard query.count >= 2, let api = store.api else { findHits = nil; return }
    let scope = store.scope, typed = findQuery
    let path = "/search?q=\(query.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "")&botId=\(APIClient.component(bot.id))"
    let result: SearchResponse? = try? await api.get(path)
    guard !Task.isCancelled, scope == store.scope, typed == findQuery else { return }
    let before = matches.count
    findHits = FindHits(query: typed, hits: result?.hits ?? [], failed: result == nil)
    let after = matches.count
    if after != before { AccessibilityNotification.Announcement(after == 1 ? "1 match" : "\(after) matches").post() }
  }
  private var transcript: some View {
    ScrollViewReader { proxy in
      transcriptScroll(proxy)
      .onChange(of: store.conversation?.botId, initial: true) { _, id in
        guard let id, id != openedBot else { return }
        // Like the web, a chat always opens at its latest message, unless search opened it at one.
        openedBot = id
        following = true
        placed = false
        unseen = 0
        visibleMessage = nil
        earlierFailed = false
        sentAnchor = nil; anchorNext = false
        if store.focusedMessage?.botId == id { showFocus(proxy) } else { scrollToLatest(proxy) }
      }
      .onChange(of: store.focusedMessage, initial: true) { _, _ in showFocus(proxy) }
      .onChange(of: store.transcript?.messages.count) { _, _ in if store.focusedMessage != nil { showFocus(proxy) } }
      .onChange(of: store.attentionScrollRequest) { _, request in if request != nil { showAttention(proxy) } }
      .onChange(of: store.outgoing?.id) { _, id in
        guard anchorNext, let id else { return }
        anchorNext = false
        sentAnchor = id
        anchorScrollPending = true
        scrollToAnchor(proxy)
      }
      .onChange(of: anchorRoom) { old, room in
        // The room below the sent message exists only after a layout pass, so the scroll that puts
        // the message at the top runs again once it does.
        if anchorScrollPending && room > 0 && old == 0 { anchorScrollPending = false; scrollToAnchor(proxy) }
      }
      .onChange(of: store.sending) { _, sending in if !sending && store.outgoing == nil { anchorNext = false } }
      .overlay(alignment: .bottom) { if !following && !atEnd && store.conversation != nil { jumpButton(proxy) } }
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
      // After Send, the new message is held near the top and its reply grows below it, instead of
      // the transcript pinning to the bottom. Following resumes once the reader reaches the end.
      .onChange(of: latestTrigger) { _, _ in following = false; anchorNext = true }
      .onChange(of: findTarget) { _, id in
        if let id { following = false; proxy.scrollTo(id, anchor: .center) }
      }
      // VoiceOver reads each settled reply once, as the web's live region does.
      .onChange(of: store.replyAnnouncement) { _, reply in
        if visible, let reply, reply.botId == bot.id { AccessibilityNotification.Announcement("\(bot.name) replied: \(reply.text)").post() }
      }
      .onDisappear {
        readSaveTask?.cancel()
        if let id = readPosition { store.markRead(id) }
      }
    }
  }
  private func transcriptScroll(_ proxy: ScrollViewProxy) -> some View {
    ScrollView {
      // Not lazy: like the web's page, every loaded turn has a real height, so the latest
      // message and a held place can be scrolled to exactly.
      transcriptRows(proxy).scrollTargetLayout().padding(16).frame(maxWidth: 850, alignment: .leading).frame(maxWidth: .infinity)
        .environment(\.transcriptConnected, store.connected)
        .environment(\.transcriptRecipient, bot.name)
        .environment(\.sentAnchor, anchoredMessage)
        .environment(\.scrollTranscript, { id in
          if reduceMotion { proxy.scrollTo(id, anchor: .center) } else { withAnimation(.easeOut(duration: 0.3)) { proxy.scrollTo(id, anchor: .center) } }
        })
        .onPreferenceChange(SentAnchorTop.self) { anchorTop = $0 }
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
    .modifier(DragStopsFollowing(following: $following))
    .scrollDismissesKeyboard(.interactively)
    // A short chat cannot be dragged, so a tap anywhere on the transcript puts the keyboard away
    // too. It runs beside the transcript's own buttons and links rather than instead of them.
    .simultaneousGesture(TapGesture().onEnded { if composerFocused { composerFocused = false } })
    .accessibilityIdentifier("conversationTranscript")
  }
  private func transcriptRows(_ proxy: ScrollViewProxy) -> some View {
    VStack(alignment: .leading, spacing: 18) {
      if (store.conversation?.earlier ?? 0) > 0 { earlierButton(proxy) }
      // The transcript includes a message still on its way.
      if store.conversation != nil && (store.conversation?.earlier ?? 0) == 0 && store.transcript?.messages.isEmpty == false {
        Text("This is the start of your conversation with \(bot.name).").font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity)
      }
      emptyState
      TranscriptTurns(turns: store.turns, advanced: advanced, delivery: store.outgoing,
        liveTurn: store.activity.active ? store.turns.last?.id : nil)
        .environment(\.foundMessage, findTarget ?? highlighted)
      if ![.idle, .done].contains(store.activity) { liveActivity }
      // Questions and secure requests come before approvals, as on the web.
      ForEach(store.conversation?.attention ?? []) { request in
        AttentionView(request: request, botId: bot.id).id("attention-" + request.id)
      }
      ForEach(store.conversation?.approvals.filter { $0.status == "pending" } ?? []) {
        approval in approvalCard(approval).id("approval-" + approval.id)
      }
      // The end of the real content, then room for a sent message to sit at the top.
      Color.clear.frame(height: 0)
        .onGeometryChange(for: CGFloat.self) { $0.frame(in: .named(SentAnchorTop.space)).minY } action: { contentEnd = $0 }
      if anchorRoom > 0 { Color.clear.frame(height: anchorRoom).accessibilityHidden(true) }
      Color.clear.frame(height: 1).id("latest")
    }.coordinateSpace(name: SentAnchorTop.space)
  }
  private func earlierButton(_ proxy: ScrollViewProxy) -> some View {
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
  @ViewBuilder private var emptyState: some View {
    if store.conversation == nil {
      if store.offlineSavedAt != nil {
        ContentUnavailableView("No saved messages", systemImage: "wifi.slash",
          description: Text(store.draftReady ? "Reconnect to load this assistant's conversation. You can keep writing a draft." : "Reconnect to load this assistant's conversation and saved draft."))
      } else { ProgressView("Opening your conversation…").frame(maxWidth: .infinity).padding(40) }
    } else if store.transcript?.messages.isEmpty == true && [.idle, .done].contains(store.activity) {
      VStack(spacing: 14) {
        AvatarView(avatar: bot.avatar ?? AvatarConfig(), size: 112, name: bot.name, forceReducedMotion: true)
        Text("Let's discuss your role.").font(.title2.bold())
        Text(bot.description?.isEmpty == false ? bot.description! : "Tell \(bot.name) what you need help with.").foregroundStyle(.secondary)
        Button("Discuss \(bot.name)'s role") {
          store.editComposer { $0.text = RoleDiscussion.draft(appendingTo: $0.text, description: bot.description) }
          composerFocused = true
        }.buttonStyle(.bordered).disabled(!store.draftReady)
        if !store.supports(.chat) { Text(store.reason(.chat)).font(.footnote).foregroundStyle(.secondary) }
      }.multilineTextAlignment(.center).frame(maxWidth: .infinity).padding(.vertical, 36).id("welcome")
    }
  }
  private func jumpButton(_ proxy: ScrollViewProxy) -> some View {
    let label = unseen == 0 ? "Jump to latest" : "\(unseen) new \(unseen == 1 ? "message" : "messages")"
    return Button { jumpToLatest(proxy) } label: {
      Label(label, systemImage: "arrow.down").font(.subheadline).padding(.horizontal, 16).padding(.vertical, 10).background(.regularMaterial, in: Capsule())
    }.accessibilityLabel(unseen == 0 ? label : label + ", jump to latest").padding(12).transition(.opacity)
  }
  /// Content grew or the reader scrolled. Growth keeps a follower at the end; a scroll decides
  /// whether the reader is following, as the web's scroll handler does.
  private func contentMoved(to next: TranscriptMetrics, _ proxy: ScrollViewProxy) {
    let previous = content
    content = next
    let distance = next.top + next.height - viewportHeight
    let atLatest = distance < 100
    if atLatest != atEnd { atEnd = atLatest }
    // History pages in only once the opened chat is seen at its end, not while it is still at
    // the top waiting for the first scroll.
    if atLatest && following && store.conversation != nil { placed = true }
    if next.height != previous.height {
      if following { scrollToLatest(proxy) }
      return
    }
    // Leaving the end stops following; it starts again only at the true end, and not while a sent
    // message is held at the top with room still below it.
    if following { if !atLatest && Date() >= jumpingUntil { following = false } }
    else if distance < 24 && anchorRoom == 0 { following = true }
    if atLatest { unseen = 0; jumpingUntil = .distantPast }
  }
  /// Puts the sent message at the top of the transcript.
  private func scrollToAnchor(_ proxy: ScrollViewProxy) {
    guard let id = anchoredMessage else { return }
    Task { @MainActor in
      if reduceMotion { proxy.scrollTo(id, anchor: .top) } else { withAnimation(.easeOut(duration: 0.3)) { proxy.scrollTo(id, anchor: .top) } }
    }
  }
  /// Scrolls to the message search or find opened the chat at, once it is loaded, and highlights it.
  private func showFocus(_ proxy: ScrollViewProxy) {
    guard let focus = store.focusedMessage, focus.botId == bot.id,
      store.transcript?.messages.contains(where: { $0.id == focus.messageId }) == true
    else { return }
    store.focusedMessage = nil
    following = false
    // The reader is placed; earlier history pages in as usual from here.
    placed = true
    sentAnchor = nil
    highlight(focus.messageId)
    Task { @MainActor in proxy.scrollTo(focus.messageId, anchor: .center) }
  }
  /// Outlines a message for a moment. Meanwhile a page of history added above keeps it in view.
  private func highlight(_ id: String) {
    highlighted = id
    Task { @MainActor in
      try? await Task.sleep(for: .seconds(2.5))
      guard highlighted == id else { return }
      if reduceMotion { highlighted = nil } else { withAnimation(.easeOut(duration: 0.4)) { highlighted = nil } }
    }
  }
  /// Brings the first card waiting on the person into view, as the composer's status dock asks.
  private func showAttention(_ proxy: ScrollViewProxy) {
    store.attentionScrollRequest = nil
    let target = store.conversation?.attention?.first.map { "attention-" + $0.id }
      ?? store.conversation?.approvals.first { $0.status == "pending" }.map { "approval-" + $0.id }
    guard let target else { return }
    following = false
    Task { @MainActor in
      if reduceMotion { proxy.scrollTo(target, anchor: .top) } else { withAnimation(.easeOut(duration: 0.3)) { proxy.scrollTo(target, anchor: .top) } }
    }
  }
  /// Waits for the layout pass that changed the content, then shows its end.
  private func scrollToLatest(_ proxy: ScrollViewProxy) {
    Task { @MainActor in proxy.scrollTo("latest", anchor: .bottom) }
  }
  private func jumpToLatest(_ proxy: ScrollViewProxy) {
    following = anchorRoom == 0
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
    guard visible, placed, let id = readPosition else { return }
    readSaveTask = Task {
      try? await Task.sleep(for: .milliseconds(350))
      guard !Task.isCancelled else { return }
      store.markRead(id)
    }
  }
  /// The tool the working avatar can hold, as the web picks it: the latest running call while connected.
  /// Beside it, one live line for the running turn: the current tool's receipt and, in Advanced
  /// presentation, the latest line of reasoning. A failed turn offers Retry here.
  private var liveActivity: some View {
    let live = LiveWork(turn: store.turns.last, toolCalls: store.conversation?.toolCalls)
    let working = store.connected && [.thinking, .working].contains(store.activity)
    return HStack(alignment: .center, spacing: 12) {
      AvatarView(avatar: bot.avatar ?? AvatarConfig(), state: store.activity, size: 52, name: bot.name, botId: bot.id,
        prop: store.connected ? AvatarProp.from(toolCalls: store.conversation?.toolCalls) : nil)
      VStack(alignment: .leading, spacing: 4) {
        ShimmerText(
          text: ActivitySentence.text(name: bot.name, state: store.activity, detail: store.conversation?.activity.detail, connectionLost: !store.connected),
          moving: [.thinking, .working, .waiting].contains(store.activity))
        if working, let receipt = live.receipt {
          Text(receipt).font(.caption).foregroundStyle(.secondary).lineLimit(1).accessibilityIdentifier("liveReceipt")
        }
        if working && advanced, let line = live.reasoning {
          Text(line).font(.caption).italic().foregroundStyle(.secondary).lineLimit(2).accessibilityIdentifier("liveReasoning")
        }
        if let target = store.conversation.flatMap(RetryTurn.target), store.pending == nil || store.retrying != nil { retryButton(target) }
      }
      Spacer(minLength: 0)
    }.padding(.vertical, 8).accessibilityElement(children: .contain).accessibilityIdentifier("liveActivity")
  }
  private func retryButton(_ message: Message) -> some View {
    let busy = store.retrying != nil
    return Button { Task { await store.retry(message) } } label: {
      HStack(spacing: 6) {
        if busy { ProgressView().controlSize(.small) } else { Image(systemName: "arrow.clockwise").accessibilityHidden(true) }
        Text(busy ? "Retrying…" : "Retry")
      }
    }.buttonStyle(.bordered).font(.subheadline)
      .disabled(busy || !store.connected || store.pending != nil || !store.supports(.chat))
      .accessibilityHint("Sends your last message again. Your draft stays as it is.")
      .accessibilityIdentifier("retryTurn")
  }
  /// The compact connection card the web shows above the transcript while Hermes is unreachable.
  private var connectionCard: some View {
    let connection = store.bootstrap?.connection
    let copy = ConnectionCopy.compact(code: connection?.code, appUnavailable: store.appUnavailable, offline: reachability.offline)
    return VStack(alignment: .leading, spacing: 6) {
      Text(copy.title).font(.subheadline.bold())
      Text(copy.detail).font(.caption).foregroundStyle(.secondary)
      Button(checkingConnection ? "Checking connection…" : copy.setup ? "Check connection" : "Reconnect now") {
        checkingConnection = true
        Task { await store.reconnect(); checkingConnection = false }
      }.font(.caption).buttonStyle(.bordered).disabled(checkingConnection || reachability.offline).padding(.vertical, 2)
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
    ComposerView(bot: bot, focused: $composerFocused) { latestTrigger += 1 }
  }
  private var advanced: Bool { store.bootstrap?.preferences.presentation == "advanced" }
  private func loadEarlier(_ proxy: ScrollViewProxy) {
    let first = store.conversation?.messages.first?.id
    // The scroll position holds the turn in view while history is added above it. Before the
    // reader has scrolled there is none, so the oldest loaded turn is held instead.
    let anchor = visibleMessage == nil ? store.turns.first?.id : nil
    Task {
      await store.loadEarlier()
      // The store reports a failed page as an error and leaves the window as it was.
      earlierFailed = (store.conversation?.earlier ?? 0) > 0 && store.conversation?.messages.first?.id == first
      // A message just opened from find or search stays in view as history pages in above it.
      // It waits for the layout pass that adds the page, as scrolling to the latest message does.
      if let held = highlighted, !following { Task { @MainActor in proxy.scrollTo(held, anchor: .center) } }
      else if let anchor, !following { proxy.scrollTo(anchor, anchor: .top) }
    }
  }
  private func approvalCard(_ approval: Approval) -> some View {
    ApprovalDecisionView(approval: approval, botId: bot.id)
  }
}
/// A conversation row. Tool calls and reasoning render in the turn's groups, not here.
struct MessageView: View {
  var message: Message
  var continued = false
  /// Set while the person's sent message is on its way: faint while sending, with its progress
  /// in place of the time.
  var delivery: SentEcho.Status? = nil
  @Environment(\.transcriptRecipient) private var recipient
  @Environment(\.colorScheme) private var scheme
  @Environment(\.foundMessage) private var foundMessage
  @Environment(\.sentAnchor) private var sentAnchor
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      if !continued && !message.isAgentExchange && (!label.isEmpty || message.createdAt != nil) {
        attribution
      }
      if message.isAgentExchange {
        AgentExchangeView(message: message, recipient: recipient)
      } else if !message.isToolActivity {
        ReplyContentView(message: message)
      }
      ForEach(message.files ?? []) { FileAttachmentView(file: $0) }
    }.padding(message.role == "user" && !message.isAgentExchange ? 14 : 0).background(
      message.role == "user" && !message.isAgentExchange ? Palette.user(scheme) : Color.clear,
      in: RoundedRectangle(cornerRadius: 14)
    ).padding(.leading, message.role == "user" && !message.isInternalActivity ? 32 : 0)
      .modifier(SendingMessage(delivery: delivery))
      .overlay { if foundMessage == message.id { RoundedRectangle(cornerRadius: 10).stroke(Palette.accent, lineWidth: 2) } }
      .background {
        if sentAnchor == message.id {
          GeometryReader { Color.clear.preference(key: SentAnchorTop.self, value: $0.frame(in: .named(SentAnchorTop.space)).minY) }
        }
      }
      .modifier(ReplyActions(message: message))
      .accessibilityElement(children: .contain)
  }
  private var attribution: some View {
    HStack(spacing: 12) {
      if !label.isEmpty { Text(label).font(.caption.weight(.semibold)) }
      if let delivery {
        Text(delivery == .sending ? "Sending…" : "Not confirmed yet").font(.caption2)
          .foregroundStyle(delivery == .unconfirmed ? AnyShapeStyle(Palette.attention) : AnyShapeStyle(.secondary))
      } else if let date = message.createdAt { WhenText(value: date).font(.caption2) }
    }.foregroundStyle(.secondary)
  }
  private var label: String {
    message.presentationOrigin?.kind == "scheduled" && !message.isInternalActivity ? "Scheduled" : message.sender?.name
      ?? (message.isInternalActivity ? message.presentationOrigin?.title ?? message.activityGroup : message.role == "assistant"
        ? "" : message.role == "tool" ? message.toolName ?? "Tool" : message.role.capitalized)
  }
}
/// A sent message rises into the transcript at once, faint until Hermes accepts it, as on the web.
private struct SendingMessage: ViewModifier {
  var delivery: SentEcho.Status?
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  /// False only for the first frame of a message that appears on its way.
  @State private var risen: Bool
  init(delivery: SentEcho.Status?) {
    self.delivery = delivery
    _risen = State(initialValue: delivery == nil)
  }
  func body(content: Content) -> some View {
    let rising = delivery != nil && !risen && !reduceMotion
    content
      .opacity(rising ? 0 : delivery == .sending ? 0.66 : 1)
      .scaleEffect(rising ? 0.96 : 1, anchor: .bottomTrailing)
      .offset(y: rising ? 14 : 0)
      .animation(.easeInOut(duration: 0.24), value: delivery)
      .onAppear {
        guard !risen else { return }
        if reduceMotion { risen = true } else { withAnimation(.spring(duration: 0.38, bounce: 0.3)) { risen = true } }
      }
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
      ToolOutputView(text: text, label: "\(title) for \(message.displayToolName)").font(.system(.caption, design: .monospaced))
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
/// Short results keep their natural height; long results scroll inside the receipt.
struct ToolOutputView: View {
  var text: String
  var label: String = "Tool output"
  @State private var contentHeight: CGFloat = 1
  var body: some View {
    ScrollView(.vertical) {
      Text(text).textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
        .background(GeometryReader { geometry in
          Color.clear.preference(key: ToolOutputHeight.self, value: geometry.size.height)
        })
    }
    .frame(height: min(contentHeight, 280))
    .scrollDisabled(contentHeight <= 280)
    .scrollBounceBehavior(.basedOnSize)
    .accessibilityElement(children: .contain)
    .accessibilityLabel(label)
    .onPreferenceChange(ToolOutputHeight.self) { contentHeight = $0 }
  }
}
private struct ToolOutputHeight: PreferenceKey {
  static let defaultValue: CGFloat = 0
  static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}
struct AttentionView: View {
  var request: Attention
  var botId: String
  @Environment(AppStore.self) private var store
  @Environment(\.colorScheme) private var scheme
  @Environment(\.scrollTranscript) private var scrollTranscript
  @State private var answers = QuestionAnswers()
  @State private var busy = false
  @FocusState private var focusedQuestion: String?
  private var secure: Bool { request.kind == "secure" && request.secure?.supported == true }
  private var questions: [Question] { request.questions ?? [] }
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text(request.kind == "clarify" ? "A question for you" : secure ? "Secure input for Hermes" : "Continue in Hermes")
        .font(.caption.weight(.semibold)).foregroundStyle(Palette.attention)
      Text(request.title).font(.headline)
      Text(request.detail).textSelection(.enabled)
      if request.kind == "clarify" {
        ForEach(questions) { question in questionView(question).id(questionAnchor(question)) }
        Button(busy ? "Sending answers…" : "Send answers", action: sendAnswers).buttonStyle(.borderedProminent)
          .disabled(busy || !store.connected || !answers.complete(questions))
          .id("answers-" + request.id)
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
      .sensoryFeedback(.selection, trigger: answers.choices)
  }
  private func questionAnchor(_ question: Question) -> String { "question-\(request.id)-\(question.id)" }
  @ViewBuilder private func questionView(_ question: Question) -> some View {
    let options = question.options ?? []
    let multiple = question.multiSelect == true
    VStack(alignment: .leading, spacing: 8) {
      Text(question.prompt).font(.subheadline.weight(.semibold)).accessibilityAddTraits(.isHeader)
      if multiple && !options.isEmpty { Text("Choose any that apply.").font(.caption).foregroundStyle(.secondary) }
      if !options.isEmpty {
        VStack(spacing: 6) {
          ForEach(options.indices, id: \.self) { index in
            QuestionOption(text: options[index], selected: answers.isSelected(index, question), multiple: multiple) {
              if answers.choose(index, in: question) { advance(after: question) }
            }.accessibilityIdentifier("questionOption-\(question.id)-\(index)")
          }
          QuestionOption(text: "Write my own answer", selected: answers.writing.contains(question.id), multiple: multiple) {
            answers.writeOwn(question)
            if answers.writing.contains(question.id) { Task { @MainActor in focusedQuestion = question.id } }
          }.accessibilityIdentifier("questionOwn-\(question.id)")
        }
      }
      if options.isEmpty || answers.writing.contains(question.id) {
        TextField(question.prompt, text: Binding(get: { answers.text[question.id] ?? "" }, set: { answers.text[question.id] = $0 }), axis: .vertical)
          .textFieldStyle(.roundedBorder).labelsHidden().focused($focusedQuestion, equals: question.id)
          .accessibilityLabel(options.isEmpty ? question.prompt : "Your answer: \(question.prompt)")
          .accessibilityIdentifier("questionAnswer-\(question.id)")
      }
    }
  }
  /// After a single choice, the next unanswered question comes into view, its field focused when
  /// it is written; with every question answered, Send answers does.
  private func advance(after question: Question) {
    guard let next = answers.next(after: question, in: questions) else {
      focusedQuestion = nil
      scrollTranscript("answers-" + request.id)
      return
    }
    scrollTranscript(questionAnchor(next))
    if next.options?.isEmpty != false { focusedQuestion = next.id }
  }
  private func sendAnswers() {
    busy = true
    let scope = store.scope
    Task {
      defer { busy = false }
      do {
        try await store.perform(
          "/bots/\(APIClient.component(botId))/requests/\(APIClient.component(request.id))",
          ["answers": answers.payload(questions)])
        guard scope == store.scope else { return }
        store.buzz(.decided)
        await store.refreshConversation()
      } catch { if scope == store.scope { store.buzz(.failed); store.report(error) } }
    }
  }
}
/// One answer to a question, as a row to tap: a radio for one choice, a checkbox for several.
private struct QuestionOption: View {
  var text: String
  var selected: Bool
  var multiple: Bool
  var action: () -> Void
  @Environment(\.colorScheme) private var scheme
  var body: some View {
    Button(action: action) {
      HStack(alignment: .firstTextBaseline, spacing: 10) {
        Image(systemName: multiple ? selected ? "checkmark.square.fill" : "square" : selected ? "largecircle.fill.circle" : "circle")
          .foregroundStyle(selected ? Palette.accent : Palette.muted).accessibilityHidden(true)
        Text(text).multilineTextAlignment(.leading).frame(maxWidth: .infinity, alignment: .leading)
      }.padding(.horizontal, 12).padding(.vertical, 10).contentShape(RoundedRectangle(cornerRadius: 10))
        .background(selected ? Palette.accentSoft : Palette.surface(scheme), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(selected ? Palette.accent : Palette.line))
    }.buttonStyle(.plain)
      .accessibilityAddTraits(selected ? .isSelected : [])
  }
}
/// The person's answers to a question card: chosen options, written answers, and which questions
/// they chose to answer in their own words. One answer per question, as the server takes them; a
/// question with several choices sends them joined with commas.
struct QuestionAnswers: Equatable {
  /// Chosen option indices per question, in the order they were chosen.
  var chosen: [String: [Int]] = [:]
  var writing: Set<String> = []
  var text: [String: String] = [:]
  /// Changes with each choice, for the selection haptic. Typing does not change it.
  var choices: [String: [Int]] { chosen.merging(Dictionary(uniqueKeysWithValues: writing.map { ($0, [-1]) })) { $0 + $1 } }
  func isSelected(_ index: Int, _ question: Question) -> Bool { chosen[question.id]?.contains(index) == true }
  /// Records a tap on an option. Returns true when it settled a single-choice question, so the card
  /// can move on; choices among several toggle and stay.
  mutating func choose(_ index: Int, in question: Question) -> Bool {
    guard let options = question.options, options.indices.contains(index) else { return false }
    if question.multiSelect == true {
      var current = chosen[question.id] ?? []
      if let at = current.firstIndex(of: index) { current.remove(at: at) } else { current.append(index) }
      chosen[question.id] = current.isEmpty ? nil : current
      return false
    }
    chosen[question.id] = [index]
    writing.remove(question.id)
    return true
  }
  /// "Write my own answer": for one choice it replaces the chosen option; among several it adds to them.
  mutating func writeOwn(_ question: Question) {
    if question.multiSelect == true {
      if writing.contains(question.id) { writing.remove(question.id) } else { writing.insert(question.id) }
    } else {
      chosen[question.id] = nil
      writing.insert(question.id)
    }
  }
  func answer(_ question: Question) -> String {
    let options = question.options ?? []
    let written = (text[question.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    if options.isEmpty { return written }
    let picked = (chosen[question.id] ?? []).sorted().compactMap { options.indices.contains($0) ? options[$0] : nil }
    if question.multiSelect == true { return (picked + (writing.contains(question.id) && !written.isEmpty ? [written] : [])).joined(separator: ", ") }
    return writing.contains(question.id) ? written : picked.first ?? ""
  }
  func complete(_ questions: [Question]) -> Bool { questions.allSatisfy { !answer($0).isEmpty } }
  func payload(_ questions: [Question]) -> [String: String] {
    Dictionary(uniqueKeysWithValues: questions.map { ($0.id, answer($0)) })
  }
  /// The first unanswered question after this one, then from the top; nil once all are answered.
  func next(after question: Question, in questions: [Question]) -> Question? {
    guard let index = questions.firstIndex(where: { $0.id == question.id }) else { return nil }
    return (questions[(index + 1)...] + questions[..<index]).first { answer($0).isEmpty }
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
  static func compact(code: String?, appUnavailable: Bool, offline: Bool = false) -> ConnectionCopy {
    if offline { return ConnectionCopy(title: "You're offline", detail: "Your draft is kept on this device. We'll reconnect when you're back online.") }
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
        // A footnote's sweep reads the same at 30 frames a second, at a fraction of the redraws.
        TimelineView(.animation(minimumInterval: 1 / 30)) { context in
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

/// Which reply to read out after a refresh, ported from the web's src/app/reply-announcement.ts.
/// Only a message after the last one seen counts, so history, the first load and a switch stay
/// quiet, and a reply waits until the assistant stops working, so it is read once.
struct ReplyWatch: Equatable {
  struct Heard: Equatable { var text: String; var turn: String? }
  /// The newest saved message already accounted for. Pages of older history never move it.
  var lastId: String?
  /// A reply that arrived while the assistant was still working.
  var waiting: Message?
  /// An unsaved reply already read, or already there on load, until its saved rows arrive.
  var heard: Heard?
  // Hermes shows the unsaved tail of a reply as a message replaced by saved rows with new IDs.
  private static func saved(_ message: Message) -> Bool { !message.id.hasSuffix("-inflight") }
  private static func speakable(_ message: Message) -> Bool {
    message.role == "assistant" && !message.isInternalActivity && !message.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }
  static func next(_ watch: ReplyWatch, _ conversation: Conversation, baseline: Bool) -> (ReplyWatch, Message?) {
    let messages = conversation.messages
    // A turn is named by the prompt that opened it, so the same words in a later turn are new.
    func turn(at index: Int) -> String? { messages[...index].last { $0.role == "user" }?.id }
    let unsaved = messages.last.flatMap { !saved($0) && speakable($0) ? $0 : nil }
    let unsavedHeard = unsaved.map { Heard(text: $0.text, turn: turn(at: messages.count - 1)) }
    let lastId = messages.last(where: saved)?.id
    let known = watch.lastId.flatMap { id in messages.firstIndex { $0.id == id } }
    // A conversation that no longer holds the last message seen was replaced, not extended.
    if baseline || watch.lastId != nil && known == nil { return (ReplyWatch(lastId: lastId, heard: unsavedHeard), nil) }
    let start = (known ?? -1) + 1
    let arrivedAt = start < messages.count ? messages[start...].lastIndex { saved($0) && speakable($0) } : nil
    let arrived = arrivedAt.map { messages[$0] }
    let heard = watch.heard
    func trimmed(_ text: String) -> String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    // The saved rows of a reply that was already read replace it silently.
    if unsaved == nil, let arrived, let arrivedAt, let heard, trimmed(arrived.text) == trimmed(heard.text), turn(at: arrivedAt) == heard.turn {
      return (ReplyWatch(lastId: lastId), nil)
    }
    let unread = unsaved != nil && (unsaved?.text != heard?.text || unsavedHeard?.turn != heard?.turn) ? unsaved : nil
    let latest = unsaved != nil ? unread : arrived
    let reply = latest ?? (unsaved != nil ? nil : watch.waiting.map { waiting in messages.first { $0.id == waiting.id } ?? waiting })
    if let reply, ![.thinking, .working].contains(conversation.activity.state) {
      return (ReplyWatch(lastId: lastId, heard: reply.id == unsaved?.id ? unsavedHeard : heard), reply)
    }
    return (ReplyWatch(lastId: lastId, waiting: reply, heard: heard), nil)
  }
  /// Markdown read aloud as written would spell out its symbols, so keep only the words.
  static func snippet(_ text: String) -> String {
    var plain = text
    for (pattern, template) in snippetRules {
      plain = pattern.stringByReplacingMatches(in: plain, range: NSRange(plain.startIndex..., in: plain), withTemplate: template)
    }
    plain = plain.trimmingCharacters(in: .whitespacesAndNewlines)
    guard plain.count > 200 else { return plain }
    return String(plain.prefix(200)).trimmingCharacters(in: .whitespaces) + "…"
  }
  private static let snippetRules: [(NSRegularExpression, String)] = [
    (#"^(```|~~~)[^\n]*\n[\s\S]*?^\1\s*$"#, " "),
    (#"!?\[([^\]]*)\]\([^)]*\)"#, "$1"),
    (#"^\s{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])\s+"#, ""),
    (#"^\s*\|?[\s:|-]+\|[\s:|-]*$"#, " "),
    (#"[`*_~|]"#, ""),
    (#"\s+"#, " "),
  ].map { (try! NSRegularExpression(pattern: $0.0, options: .anchorsMatchLines), $0.1) }
}

/// Where the sent message held at the top starts, in the transcript content's own coordinates, so
/// scrolling does not change it.
struct SentAnchorTop: PreferenceKey {
  static let space = "transcriptContent"
  static let defaultValue: CGFloat? = nil
  static func reduce(value: inout CGFloat?, nextValue: () -> CGFloat?) { value = nextValue() ?? value }
}
private struct SentAnchorKey: EnvironmentKey { static let defaultValue: String? = nil }
private struct ScrollTranscriptKey: EnvironmentKey { static let defaultValue: @MainActor (String) -> Void = { _ in } }
extension EnvironmentValues {
  var sentAnchor: String? {
    get { self[SentAnchorKey.self] }
    set { self[SentAnchorKey.self] = newValue }
  }
  /// Scrolls the transcript to a view's ID, as a question card does to move on to the next question.
  var scrollTranscript: @MainActor (String) -> Void {
    get { self[ScrollTranscriptKey.self] }
    set { self[ScrollTranscriptKey.self] = newValue }
  }
}

/// A drag stops following at once, so the reader keeps the place they scrolled to while a reply
/// streams in. iOS 17 has no scroll phase; there the transcript's position decides, as before.
private struct DragStopsFollowing: ViewModifier {
  @Binding var following: Bool
  func body(content: Content) -> some View {
    if #available(iOS 18.0, *) {
      content.onScrollPhaseChange { _, phase in if phase == .interacting && following { following = false } }
    } else { content }
  }
}

/// The running turn's live line: the current tool's receipt, as Simple presentation words it, and
/// the latest line of exposed reasoning.
struct LiveWork: Equatable {
  var receipt: String?
  var reasoning: String?
  @MainActor init(turn: ConversationTurn?, toolCalls: [ToolCall]?) {
    let calls = (turn?.activityGroups.flatMap(\.messages).compactMap(\.toolCall) ?? []) + (toolCalls ?? [])
    receipt = calls.last { $0.status == "running" }.map { "\(ActionReceiptView(call: $0).label) · \($0.name)" }
    reasoning = turn?.reasoning.last.flatMap { part in
      part.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.last { !$0.isEmpty }
    }
  }
}

/// The server's matches for find in chat, for the query they answer.
struct FindHits {
  var query: String
  var hits: [SearchHit]
  var failed = false
}

/// Find in chat's matches (contract C2): loaded messages match at once, and the server's hits from
/// the chat's canonical session add the history not loaded yet. Those come first, being older than
/// anything loaded, ordered by their place in the session.
enum FindMatches {
  struct Match: Equatable {
    var id: String
    var loaded: Bool
  }
  static func merge(loaded messages: [Message], query: String, hits: [SearchHit], botId: String, sessionId: String?) -> [Match] {
    guard !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return [] }
    let local = messages.filter(\.isConversationVisible).filter {
      $0.text.localizedStandardContains(query) || ($0.files ?? []).contains { $0.name.localizedStandardContains(query) }
    }.map { Match(id: $0.id, loaded: true) }
    // Only the canonical session's hits open the live chat; other sessions keep their history views.
    guard let sessionId else { return local }
    let known = Set(messages.map(\.id))
    var seen = Set<String>()
    let older = hits.enumerated().compactMap { index, hit -> (Int, Int, String)? in
      guard hit.botId == botId, hit.sessionId == sessionId, let id = hit.messageId, !known.contains(id),
        seen.insert(id).inserted
      else { return nil }
      return (hit.offset ?? Int.max, index, id)
    }.sorted { ($0.0, $0.1) < ($1.0, $1.1) }.map { Match(id: $0.2, loaded: false) }
    return older + local
  }
  /// "2 of 5", or how many there are before one is chosen.
  static func status(position: Int?, count: Int) -> String {
    if count == 0 { return "0 matches" }
    guard let position else { return count == 1 ? "1 match" : "\(count) matches" }
    return "\(position + 1) of \(count)"
  }
}
