import CryptoKit
import SwiftUI

// The offline library and the chats read ahead of a tap, which fill the same cache.
extension AppStore {
  var offlineURL: URL? {
    guard let api, let token = api.token else { return nil }
    return OfflineLibrary.url(origin: api.baseURL.absoluteString, token: token, root: offlineLibraryRoot)
  }
  func saveOfflineLibrary(immediately: Bool = false) {
    // An unknown roster says nothing to save; the last good library stays.
    guard !sessionExpired, offlineSavedAt == nil, let bootstrap, bootstrap.rosterUnknown != true, let url = offlineURL else { return }
    // An assistant a cached roster left out keeps its saved chat, and its row for the next launch.
    let allowed = Set(knownBots.map(\.id))
    let ids = Array(recentChats.filter { allowed.contains($0) }.suffix(OfflineLibrary.maximumChats))
    let chats = conversationCache.filter { ids.contains($0.key) }
    let snapshot = OfflineLibrary(savedAt: Date(), bootstrap: bootstrap, conversations: chats,
      selected: selectedBotId, capturedAt: conversationCapturedAt,
      departed: unconfirmedDepartures.isEmpty ? nil : unconfirmedDepartures)
    offlineWriter.replace(snapshot, at: url, immediately: immediately)
  }
  func clearOfflineLibrary(includingVoice: Bool = true) {
    if let url = offlineURL { offlineWriter.remove(at: url, includingVoice: includingVoice) }
    MarkdownCache.shared.clear()
    ReplyCards.clearCache()
    offlineSavedAt = nil
    restoredRosterAt = nil
  }
  /// Where the composer records for this assistant. A change ends the recording, so it stays the same for
  /// one a cached roster left out, and goes when a connected roster says it left.
  func voiceRecordingURL(botId: String) -> URL? {
    guard !sessionExpired, knownBot(botId) != nil else { return nil }
    return voiceClipURL(botId: botId)
  }
  /// Where an assistant's recording is kept, listed or not, so one a cached roster left out is still
  /// deleted when a connected roster says it left.
  func voiceClipURL(botId: String) -> URL? {
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

  // MARK: Notification service extension prefetch

  /// Keeps the App Group's prefetch config in step with the signed-in server and account.
  func syncNotificationPrefetch(_ bootstrap: Bootstrap?) {
    guard let root = prefetchRoot else { return }
    guard let bootstrap, let api, api.token != nil, !sessionExpired else {
      NotificationPrefetchStore.clear(root: root)
      return
    }
    let config = NotificationPrefetchConfig(
      origin: api.baseURL.absoluteString,
      account: NotificationActions.accountMarker(bootstrap.user.id)
    )
    NotificationPrefetchStore.writeConfig(config, root: root)
  }

  func clearNotificationPrefetch() {
    guard let root = prefetchRoot else { return }
    NotificationPrefetchStore.clear(root: root)
  }

  /// Drops staged prefetch data only when it belongs to another account, so restoring this
  /// account's disconnected offline library never wipes conversations prefetched while closed.
  func clearOtherAccountPrefetch(_ bootstrap: Bootstrap) {
    guard let root = prefetchRoot else { return }
    let account = NotificationActions.accountMarker(bootstrap.user.id)
    if let existing = NotificationPrefetchStore.readConfig(root: root), existing.account != account {
      NotificationPrefetchStore.clear(root: root)
    }
  }

  func removePrefetchedConversation(_ botId: String) {
    guard let root = prefetchRoot, let bootstrap else { return }
    NotificationPrefetchStore.remove(
      account: NotificationActions.accountMarker(bootstrap.user.id),
      botId: botId,
      root: root
    )
  }

  /// Merges conversations prefetched by the notification service extension into memory so
  /// opening or resuming a chat renders the new message immediately before the network responds.
  @discardableResult
  func absorbPrefetchedConversations(only targetBotId: String? = nil) -> Bool {
    guard !sessionExpired, let root = prefetchRoot, let bootstrap else { return false }
    let account = NotificationActions.accountMarker(bootstrap.user.id)
    let entries: [PrefetchedConversation]
    if let targetBotId {
      entries = NotificationPrefetchStore.read(account: account, botId: targetBotId, root: root).map { [$0] } ?? []
    } else {
      entries = NotificationPrefetchStore.readAll(account: account, root: root)
    }
    guard !entries.isEmpty else { return false }
    var changed = false
    for entry in entries {
      let removeAfter = offlineSavedAt == nil
      guard knownBot(entry.botId) != nil else {
        NotificationPrefetchStore.remove(account: account, botId: entry.botId, root: root)
        continue
      }
      guard entry.fetchedAt > (conversationCapturedAt[entry.botId] ?? .distantPast) else {
        if removeAfter { NotificationPrefetchStore.remove(account: account, botId: entry.botId, root: root) }
        continue
      }
      guard let decoded = try? JSONDecoder().decode(Conversation.self, from: entry.payload),
        decoded.botId == entry.botId
      else {
        NotificationPrefetchStore.remove(account: account, botId: entry.botId, root: root)
        continue
      }
      let next = latestInflight?.botId == entry.botId ? (latestInflight?.applying(to: decoded) ?? decoded) : decoded
      conversationCapturedAt[entry.botId] = entry.fetchedAt
      if conversationCache[entry.botId] != next {
        conversationCache[entry.botId] = next
        changed = true
      }
      recentChats.removeAll { $0 == entry.botId }
      recentChats.append(entry.botId)
      while recentChats.count > OfflineLibrary.maximumChats {
        let discardIndex = recentChats.firstIndex { $0 != selectedBotId } ?? 0
        let expired = recentChats.remove(at: discardIndex)
        conversationCache[expired] = nil
        cachedChats.remove(expired)
      }
      if selectedBotId == entry.botId {
        let widenedWindow: Bool = {
          guard let current = conversation, current.botId == entry.botId,
            let currentFirst = current.messages.first?.id,
            !next.messages.contains(where: { $0.id == currentFirst }),
            let currentEarlier = current.earlier, let nextEarlier = next.earlier
          else { return false }
          return currentEarlier < nextEarlier
        }()
        if !widenedWindow {
          if conversation != next { conversation = next }
          historyStarts[entry.botId] = next.messages.first?.id
        }
        if cachedChats.contains(entry.botId) { offlineSavedAt = entry.fetchedAt }
      }
      if removeAfter {
        NotificationPrefetchStore.remove(account: account, botId: entry.botId, root: root)
      }
    }
    if changed { saveOfflineLibrary() }
    return changed
  }
}
