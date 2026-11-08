import CryptoKit
import SwiftUI

// The offline library and the chats read ahead of a tap, which fill the same cache.
extension AppStore {
  var offlineURL: URL? {
    guard let api, let token = api.token else { return nil }
    return OfflineLibrary.url(origin: api.baseURL.absoluteString, token: token, root: offlineLibraryRoot)
  }
  func saveOfflineLibrary(immediately: Bool = false) {
    guard !sessionExpired, offlineSavedAt == nil, let bootstrap, let url = offlineURL else { return }
    let allowed = Set(bootstrap.bots.map(\.id))
    let ids = Array(recentChats.filter { allowed.contains($0) }.suffix(OfflineLibrary.maximumChats))
    let chats = conversationCache.filter { ids.contains($0.key) }
    let snapshot = OfflineLibrary(savedAt: Date(), bootstrap: bootstrap, conversations: chats,
      selected: selectedBotId, capturedAt: conversationCapturedAt)
    offlineWriter.replace(snapshot, at: url, immediately: immediately)
  }
  func clearOfflineLibrary(includingVoice: Bool = true) {
    if let url = offlineURL { offlineWriter.remove(at: url, includingVoice: includingVoice) }
    MarkdownCache.shared.clear()
    ReplyCards.clearCache()
    offlineSavedAt = nil
    restoredRosterAt = nil
  }
  func voiceRecordingURL(botId: String) -> URL? {
    guard !sessionExpired, bootstrap?.bots.contains(where: { $0.id == botId }) == true else { return nil }
    let name = SHA256.hash(data: Data(botId.utf8)).map { String(format: "%02x", $0) }.joined()
    return offlineURL.map { $0.deletingPathExtension().appendingPathExtension(name + ".m4a") }
  }
  // MARK: Chats opened ahead of the tap
  /// Chats read ahead per pass. Reads go one at a time, because the server serializes some of them.
  static let prefetchChats = 3
  /// A chat read or refreshed this recently is not read ahead again.
  static let prefetchFreshness: TimeInterval = 15
  private var canPrefetch: Bool {
    api?.token != nil && bootstrap != nil && !suspended && !sessionExpired && offlineSavedAt == nil
      && !NetworkReachability.shared.offline
  }
  var isPrefetching: Bool { prefetchTask != nil }
  /// The chat is kept in the offline library, so a new one needs room under the same cap.
  private func canCache(_ id: String) -> Bool {
    bootstrap?.bots.contains { $0.id == id } == true
      && (recentChats.contains(id) || recentChats.count < OfflineLibrary.maximumChats)
  }
  /// The chats the person is most likely to tap from home: unread ones, then the latest opened.
  /// The one on screen is read by its own polls.
  var likelyChatIds: [String] {
    let unread = (bootstrap?.bots ?? []).filter { self.unread($0) }.map(\.id)
    var ids: [String] = []
    for id in unread + recentChats.reversed() where id != followedBotId && !ids.contains(id) && canCache(id) {
      ids.append(id)
      if ids.count == Self.prefetchChats { break }
    }
    return ids
  }
  /// Refreshes the saved copy of the likely chats, so opening one shows its latest messages at once.
  /// This only fills the cache `select` reads: it applies no draft, echo, reply or selection.
  func prefetchLikelyChats() {
    guard canPrefetch else { return }
    if prefetchTask != nil { prefetchAgain = true; return }
    let run = UUID(), account = generation
    prefetchRun = run
    prefetchTask = Task { [weak self] in
      repeat {
        guard let self else { return }
        self.prefetchAgain = false
        for id in self.likelyChatIds where self.prefetchDue(id) {
          guard !Task.isCancelled, self.generation == account, self.canPrefetch else { break }
          await self.prefetchConversation(id)
        }
      } while self?.prefetchAgain == true && !Task.isCancelled
      if self?.prefetchRun == run { self?.prefetchTask = nil; self?.prefetchRun = nil }
    }
  }
  func cancelPrefetch() {
    prefetchTask?.cancel(); prefetchTask = nil; prefetchRun = nil; prefetchAgain = false
  }
  /// Another account's chats are not this one's to read ahead.
  func resetPrefetch() {
    cancelPrefetch()
    chatReadAt.removeAll()
  }
  private func prefetchDue(_ id: String) -> Bool {
    chatReadAt[id].map { now() - $0 >= .seconds(Self.prefetchFreshness) } ?? true
  }
  private func prefetchConversation(_ id: String) async {
    guard let api else { return }
    let account = generation, started = Date()
    // Stamped before the read, so a failing chat is not asked again at once.
    chatReadAt[id] = now()
    // A failure says nothing the open chat's own reads would not: opening reads again and reports.
    guard let value: Conversation = try? await api.get(conversationPath(id, query: "turns=\(Self.historyPageTurns)")),
      generation == account, canPrefetch, canCache(id), id != followedBotId, openingBotId != id,
      // Opening or polling it while this read ran left a copy at least as new.
      conversationCapturedAt[id].map({ $0 < started }) ?? true
    else { return }
    cachedChats.remove(id)
    conversationCapturedAt[id] = Date()
    if !recentChats.contains(id) { recentChats.insert(id, at: 0) }
    if conversationCache[id] != value {
      conversationCache[id] = value
      saveOfflineLibrary()
    }
  }
}
