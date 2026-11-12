import SwiftUI

// Opening a chat and reading its conversation, its history and its files.
extension AppStore {
  /// Another member made the open assistant personal, or it was deleted: return home and stop asking for it.
  func leave(_ id: String) async {
    for upload in uploads.items.filter({ $0.botId == id }) { uploads.remove(upload.id) }
    conversationCache[id] = nil
    conversationCapturedAt[id] = nil
    cachedChats.remove(id)
    saveOfflineLibrary()
    if deletedBotId == id { deletedBotId = nil } else { notice = "That assistant is no longer available to you." }
    error = nil
    stayHome = true
    if pendings[id] == nil { receipts[id] = nil }
    await select(nil)
    leftBotId = id
  }
  private static func missing(_ error: Error) -> Bool { (error as? APIError)?.code == "assistant_not_found" }
  func select(_ id: String?, navigate: Bool = true) async {
    selections += 1
    // A window an open-at asked for belongs to the selection it was made in.
    requestedWindow = nil
    if id != nil { stayHome = false; notice = nil }
    persistDraft()
    flushDraft()
    selectionGeneration = UUID()
    latestInflight = nil
    // Opening reads the conversation itself, so its view arriving on screen needs no read of its own.
    openingBotId = id
    conversationRefreshedAt = nil
    defer { if openingBotId == id { openingBotId = nil } }
    selectedBotId = id
    if id != nil && navigate { conversationRequest = UUID() }
    conversation = id.flatMap { conversationCache[$0] }
    offlineSavedAt = id.flatMap { cachedChats.contains($0) ? conversationCapturedAt[$0] : nil } ?? restoredRosterAt
    draftReady = false
    interruptionReviewed = false
    receipt = pending?.botId == id ? receipt : nil
    save(id, key(.selected))
    guard let id, let api, bootstrap != nil else {
      draft = Draft()
      return
    }
    let cached: Draft? = read(key(.draft, id))
    draft = cached ?? Draft()
    if cached?.dirty == true { draftReady = true }
    // Like the web, a chat opens at its latest page; the window grows from there.
    historyStarts[id] = nil
    replyWatch = nil
    let selectedGeneration = selectionGeneration
    // The draft and the conversation are asked for together, as the web does. The conversation
    // waits to apply until the draft has settled, so its copy still merges onto the draft.
    let draftLoad = Task {
      do {
        let remote: SavedDraft? = try await api.get("/bots/\(APIClient.component(id))/draft")
        guard self.selectionGeneration == selectedGeneration else { return }
        self.loadDraft(remote, botId: id)
      } catch {
        guard self.selectionGeneration == selectedGeneration else { return }
        if Self.missing(error) { await self.leave(id); return }
        self.draftReady = cached != nil
        // The web's wording. Polls keep reading the draft with the conversation.
        if cached?.dirty != true { self.report(APIError(message: "Your saved draft could not be loaded. Retrying. \(error.localizedDescription)", status: 0)) }
      }
    }
    await withTaskCancellationHandler {
      // An unsaved edit may start its save as the draft loads, and the conversation must see that
      // save finished, not in flight. That case, being rare, keeps the draft strictly first.
      if cached?.dirty == true { await draftLoad.value }
      await refreshConversation(after: draftLoad)
      await draftLoad.value
    } onCancel: { draftLoad.cancel() }
  }
  func conversationPath(_ id: String, query: String) -> String {
    "/bots/\(APIClient.component(id))/conversation?\(query)"
  }
  /// `draftLoad` is the draft read opening this chat started alongside it. Whatever this read
  /// brings waits for the draft to settle before it applies.
  func refreshConversation(after draftLoad: Task<Void, Never>? = nil) async {
    guard let id = selectedBotId, let api, bootstrap != nil else { return }
    let selectedGeneration = selectionGeneration
    let requestedWindow = windowGeneration
    let query = historyStarts[id].map { "start=\(APIClient.component($0))" }
      ?? "turns=\(Self.historyPageTurns)"
    conversationReads += 1
    let read = conversationReads
    conversationReadsInFlight += 1
    defer { conversationReadsInFlight -= 1 }
    // A draft still to load or to save again needs the conversation's copy applied every time.
    // One still loading is assumed to load; if it does not, the copy is read again below.
    let needsCopy = { !self.draftReady || self.draft.dirty == true && self.settled(id) }
    let skippable = draftLoad != nil ? !(draft.dirty == true && settled(id)) : !needsCopy()
    do {
      var response: (value: Conversation?, etag: String?) = try await api.changed(
        conversationPath(id, query: query), since: skippable ? appliedConversationTag : nil)
      await draftLoad?.value
      if response.value == nil, selectedGeneration == selectionGeneration, needsCopy() {
        response = try await api.changed(conversationPath(id, query: query), since: nil)
      }
      guard selectedGeneration == selectionGeneration, requestedWindow == windowGeneration,
        read > appliedConversationRead
      else { return }
      appliedConversationRead = read
      conversationRefreshedAt = now()
      pollSucceeded(.chat)
      // Echoes settle against each current read, changed or not.
      defer { if !echoes.isEmpty { updateEcho() } }
      // The conversation applied last time, unchanged: nothing to decode, merge or render.
      guard let value = response.value else { conversationCapturedAt[id] = Date(); chatReadAt[id] = now(); return }
      hearReplies(in: value, botId: id)
      historyStarts[id] = value.messages.first?.id
      apply(value, botId: id)
      appliedConversationTag = response.etag
    } catch is CancellationError {} catch {
      await draftLoad?.value
      // A failure that a newer read or a wider window has already overtaken says nothing current.
      guard selectedGeneration == selectionGeneration, requestedWindow == windowGeneration,
        read > appliedConversationRead
      else { return }
      if Self.missing(error) {
        await leave(id)
      } else {
        appUnavailable = true
        failures += 1
        reportPoll(error, .chat)
      }
    }
  }
  /// Adds one more page of history above what is loaded, as the web does: it reads only the turns before
  /// the first loaded message and puts them in front of it, keeping the live state the view already has.
  /// A failure is reported but does not mark the server unavailable, because the loaded conversation is
  /// still current.
  func loadEarlier() async {
    guard let id = selectedBotId, api != nil, !loadingEarlier,
      let first = conversation?.messages.first?.id, (conversation?.earlier ?? 0) > 0
    else { return }
    loadingEarlier = true
    defer { loadingEarlier = false }
    await readEarlier(of: id, before: first, whole: false)
  }
  /// One read of the page before `first`. `whole` asks the old way, `start=` that message, which answers
  /// everything from there to the newest message and replaces the view.
  private func readEarlier(of id: String, before first: String, whole: Bool) async {
    guard let api else { return }
    let selectedGeneration = selectionGeneration
    let requestedWindow = windowGeneration
    conversationReads += 1
    let read = conversationReads
    conversationReadsInFlight += 1
    defer { conversationReadsInFlight -= 1 }
    do {
      let anchor = APIClient.component(first)
      let query = whole ? "start=\(anchor)&turns=\(Self.historyPageTurns)" : "before=\(anchor)&turns=\(Self.historyPageTurns)"
      let value: Conversation = try await api.get(conversationPath(id, query: query))
      guard selectedGeneration == selectionGeneration else { return }
      if !whole, value.before == first {
        // The window was moved while the page loaded, as by opening at a message: this page is for the
        // window before it, and the person's request wins.
        guard requestedWindow == windowGeneration else { return }
        // Only the page's messages and files go in front of the message. The view keeps its own live
        // state, draft and version, which a newer read may have moved on since this one began.
        guard conversation?.botId == id, let merged = conversation?.prepending(value, before: first) else {
          // The view no longer starts at that message, as after a turn that replaced everything: read
          // the page whole, with everything after it.
          await readEarlier(of: id, before: first, whole: true)
          return
        }
        windowGeneration += 1
        historyStarts[id] = value.messages.first?.id ?? first
        conversation = merged
        conversationCache[id] = merged
        saveOfflineLibrary()
        // A read asked before the window moved is dropped when it answers, with whatever newer turns it
        // carried, so the whole window is read again.
        if conversationReadsInFlight > 1 { await refreshConversation() }
        return
      }
      // A whole read, or an answer that does not name the message because the history lost it: the
      // latest page, which replaces the view as any read does.
      windowGeneration += 1
      historyStarts[id] = value.messages.first?.id
      guard read > appliedConversationRead else {
        // A newer read landed while this page loaded. Keep the wider window, but read it fresh
        // instead of showing this older snapshot of the recent turns.
        await refreshConversation()
        return
      }
      appliedConversationRead = read
      hearReplies(in: value, botId: id)
      apply(value, botId: id)
    } catch is CancellationError {} catch {
      if selectedGeneration == selectionGeneration { report(error) }
    }
  }
  /// Every file the open conversation knows, oldest first, with where it came from. Listed once per
  /// change of its inputs, not on every render of the header that counts them.
  var conversationArtifacts: [Artifact] {
    // The cache is not observed, so a view reading it still follows the inputs it comes from.
    _ = conversation; _ = earlierFileCache; _ = selectedBotId
    if let cachedArtifacts { return cachedArtifacts }
    let value = Artifacts.list(conversation, earlier: currentEarlierFiles?.messages ?? [])
    cachedArtifacts = value
    return value
  }
  var conversationFiles: [FileRef] { conversationArtifacts.map(\.file) }
  var earlierFilesFailed: Bool {
    earlierFilesFailure != nil && earlierFilesFailure == earlierFilesKey
  }
  private var earlierFilesKey: String? {
    selectedBotId.map { "\($0):\(conversation?.sessionId ?? "")" }
  }
  /// Whether the file list has anything to show or fetch.
  var hasConversationFiles: Bool {
    !conversationFiles.isEmpty || (conversation?.earlierFiles ?? 0) > 0
  }
  /// The header badge count, as the web counts it: known files plus earlier ones not yet fetched.
  var conversationFileCount: Int {
    conversationFiles.count + (currentEarlierFiles == nil ? conversation?.earlierFiles ?? 0 : 0)
  }
  /// Each reply's chips, attributed from the same history as the file list. A window that starts after
  /// the beginning reads the files before it, only when it holds a reply with files of its own; until
  /// they arrive it shows none rather than a guess.
  func refreshReplyFiles() {
    let earlier = currentEarlierFiles?.messages
    replyFiles = Artifacts.windowReplyFiles(transcript, earlier: earlier)
    guard let window = transcript, earlier == nil, Artifacts.needsEarlier(window), !loadingEarlierFiles, !earlierFilesFailed,
      !Artifacts.replyFiles(window.messages, artifacts: Artifacts.list(window)).isEmpty else { return }
    Task { await loadEarlierFiles() }
  }
  private var currentEarlierFiles: EarlierFilePage? {
    guard let id = selectedBotId, let page = earlierFileCache[id],
      // Only the page for this exact window start: after older turns load, a page read for a later
      // start would count files the window now shows as earlier ones.
      page.sessionId == conversation?.sessionId, page.before == conversation?.messages.first?.id
    else { return nil }
    return page
  }
  /// Fetches the files of the history before the loaded window. Called when the file list opens.
  func loadEarlierFiles() async {
    guard let id = selectedBotId, let api, let current = conversation,
      Artifacts.needsEarlier(current), !loadingEarlierFiles, currentEarlierFiles == nil
    else { return }
    let selectedGeneration = selectionGeneration
    let before = current.messages.first?.id
    let key = earlierFilesKey
    earlierFilesFailure = nil
    loadingEarlierFiles = true
    // However this read ends, even for an assistant no longer open, the window now on screen is looked
    // at again: its own read may have waited for this one.
    defer { loadingEarlierFiles = false; refreshReplyFiles() }
    do {
      let suffix = before.map { "?before=\(APIClient.component($0))" } ?? ""
      let page: EarlierFiles = try await api.get("/bots/\(APIClient.component(id))/files\(suffix)")
      guard selectedGeneration == selectionGeneration else { return }
      earlierFileCache[id] = EarlierFilePage(sessionId: current.sessionId, before: before, messages: page.messages)
    } catch is CancellationError {} catch {
      if selectedGeneration == selectionGeneration { earlierFilesFailure = key }
    }
  }
  private func apply(_ value: Conversation, botId id: String) {
    cachedChats.remove(id)
    if offlineSavedAt != nil { offlineSavedAt = nil }
    let value = latestInflight?.applying(to: value) ?? value
    let changed = conversationCache[id] != value
    conversationCapturedAt[id] = Date()
    chatReadAt[id] = now()
    if conversation?.activity.runId != value.activity.runId
      || conversation?.activity.state != .interrupted && value.activity.state == .interrupted
    {
      interruptionReviewed = false
    }
    // An unchanged poll leaves the transcript alone instead of rendering it again.
    if conversation != value { conversation = value }
    conversationCache[id] = value
    recentChats.removeAll { $0 == id }; recentChats.append(id)
    while recentChats.count > OfflineLibrary.maximumChats {
      let expired = recentChats.removeFirst()
      conversationCache[expired] = nil; cachedChats.remove(expired)
    }
    if changed { saveOfflineLibrary() }
    // The conversation carries the saved draft, so a draft that failed to load has now loaded.
    clearDraftLoadFailure()
    // Polling also brings in a draft changed on another device, or a send made there, and
    // settles a copy kept unsaved while saves were in flight.
    if !draftReady || (value.draft?.revision ?? 0) != (draft.baseRevision ?? 0) || draft.dirty == true && settled(id) {
      loadDraft(value.draft, botId: id)
    }
  }

  /// A message the open conversation should scroll to and highlight once it shows it.
  struct MessageFocus: Equatable {
    var botId: String
    var messageId: String
    var request = UUID()
  }

  /// Opens an assistant's live conversation, as a search hit in its canonical session does (contract
  /// C2). With a message, the conversation loads from that message when it is not loaded yet,
  /// `GET /bots/:id/conversation?start=`, and the view scrolls to it and highlights it briefly.
  /// Earlier history then pages in as usual. Without one, the chat opens at its latest message.
  /// Each call is one operation: a later open, a find step to a loaded message, another account or
  /// another assistant makes it obsolete, and an obsolete one changes neither window nor focus.
  func openConversation(botId: String, atMessage messageId: String?) async {
    // A newer open supersedes the last one, whatever it targets: its window request is dropped too.
    cancelOpeningAtMessage()
    let request = openRequests, account = scope, before = selections
    if selectedBotId != botId || conversation?.botId != botId {
      await select(botId)
      // Bound to the selection it made: any other selection meanwhile makes it obsolete.
      guard selections == before + 1 else { return }
    } else { conversationRequest = UUID() }
    let selection = selections
    let current = { [weak self] in
      self?.openRequests == request && self?.scope == account && self?.selectedBotId == botId && self?.selections == selection
    }
    guard let messageId, current() else { return }
    if conversation?.messages.contains(where: { $0.id == messageId }) != true {
      // The window now starts at the message; polls keep it, and pages add history above it.
      requestedWindow = (botId, messageId, historyStarts[botId], selections, account)
      historyStarts[botId] = messageId
      windowGeneration += 1
      await refreshConversation()
      guard current() else { return }
      requestedWindow = nil
    }
    guard conversation?.messages.contains(where: { $0.id == messageId }) == true else {
      // The message is gone or the read failed: keep the window that did load, at its latest message.
      historyStarts[botId] = conversation?.messages.first?.id
      return
    }
    focusedMessage = MessageFocus(botId: botId, messageId: messageId)
  }
  /// Makes any open-at-message still loading obsolete, as a newer open or find moving to a loaded
  /// message does. A window it asked for and has not applied is dropped: the window before it comes
  /// back, and its read, still on the way, is refused.
  func cancelOpeningAtMessage() {
    openRequests += 1
    guard let requested = requestedWindow else { return }
    requestedWindow = nil
    // Only the selection and account that asked for it, so matching message IDs alone never roll back.
    guard requested.selection == selections, requested.account == scope, historyStarts[requested.botId] == requested.start else { return }
    historyStarts[requested.botId] = requested.previous
    windowGeneration += 1
  }
}
