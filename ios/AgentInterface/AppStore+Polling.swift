import SwiftUI

// The poll loop, the household and conversation change streams, and the bootstrap they refresh.
extension AppStore {
  func startPolling() {
    suspended = false
    stopPolling()
    pollTask = Task { [weak self] in
      while !Task.isCancelled {
        guard let self, await self.pollOnce() else { return }
        let seconds = self.failures == 0 ? 1.5 : min(30, pow(2, Double(min(self.failures, 5))))
        try? await Task.sleep(for: .seconds(seconds))
      }
    }
  }
  /// One pass of the poll loop. Returns false once the sign-in is expiring, which ends polling.
  func pollOnce() async -> Bool {
    let currentGeneration = generation
    await renewSignInIfDue()
    // Signing out, switching accounts or suspending during renewal ends this pass before it
    // starts any stream for a session that is gone.
    guard !Task.isCancelled, generation == currentGeneration, api?.token != nil else { return false }
    if let api,
      let expiry = UserDefaults.standard.string(forKey: DeviceDefaults.expiry(api.baseURL)),
      let date = ServerDate.parse(expiry), date.timeIntervalSinceNow < 60
    {
      clearOfflineLibrary()
      sessionExpired = true
      stopStream()
      error =
        "Your sign-in is expiring. Sign in again to keep using this server. Your drafts are saved."
      return false
    }
    watchRoster()
    watchConversation()
    await refreshBootstrap(ifDue: true)
    if followedBotId != nil, conversationDue { await refreshConversation() }
    await reconcilePending()
    // Files added while the connection was down start once it returns, as on the web.
    if connected, !uploads.uploading, uploads.items.contains(where: { $0.status == .queued }) {
      Task { await self.uploads.drain() }
    }
    return true
  }
  /// Ends polling and the change stream together, so neither outlives the other.
  func stopPolling() {
    pollTask?.cancel()
    pollTask = nil
    stopStream()
  }
  private func stopStream() {
    rosterTask?.cancel()
    rosterTask = nil
    latestInflight = nil
    eventTask?.cancel()
    eventTask = nil
    eventBotId = nil
    streamHeardAt = nil
  }
  /// Without a live stream the conversation is polled every pass, as before streams existed.
  private var conversationDue: Bool {
    guard let heard = streamHeardAt, let refreshed = conversationRefreshedAt,
      eventBotId == followedBotId, now() - heard < Self.streamSilence
    else { return true }
    return now() - refreshed >= Self.streamFallbackInterval
  }
  /// Refreshes the household roster when its visible assistants change, and the group catalog when
  /// the rooms this person can see change. Other notices, such as ones from a newer server, are ignored.
  private func watchRoster() {
    guard rosterTask == nil, let api else { return }
    rosterTask = Task { [weak self] in
      var failures = 0
      while !Task.isCancelled {
        do {
          let lines = try await api.events("/api/events")
          guard let self, !Task.isCancelled else { return }
          failures = 0
          // Notices sent before the subscription are lost, so connecting counts as one. A server
          // that sends `groups` also sends one on every connect, so the catalog needs no read here.
          await self.refreshBootstrap()
          for try await line in lines {
            guard !Task.isCancelled else { return }
            if line == "data: roster" { await self.refreshBootstrap() }
            if line == "data: groups" { self.groupNoticeScope = self.scope; await self.refreshGroups() }
          }
        } catch {}
        guard let self, !Task.isCancelled, !self.sessionExpired else { return }
        failures += 1
        try? await Task.sleep(for: .seconds(min(30, 3 * failures)))
      }
    }
  }
  /// Follows the change stream of the conversation on screen, reconnecting with a growing delay.
  func watchConversation() {
    let followed = followedBotId
    guard eventBotId != followed || eventTask == nil else { return }
    eventTask?.cancel()
    streamHeardAt = nil
    eventBotId = followed
    latestInflight = nil
    guard let id = followed, let api else { eventTask = nil; return }
    eventTask = Task { [weak self] in
      var failures = 0
      while !Task.isCancelled {
        do {
          let lines = try await api.events("/api/bots/\(APIClient.component(id))/events?inflight=1")
          guard let self, !Task.isCancelled else { return }
          failures = 0
          self.streamHeardAt = self.now()
          // Notices sent before the subscription are lost, so connecting counts as one.
          self.latestInflight = nil
          self.requestConversationRefresh()
          var event = ""
          for try await line in lines {
            guard !Task.isCancelled else { return }
            self.streamHeardAt = self.now()
            if line.hasPrefix("event:") { event = String(line.dropFirst(6)).trimmingCharacters(in: .whitespaces) }
            if line.hasPrefix("data:") {
              if event == "inflight" {
                // Each patch carries the whole reply so far, so it decodes away from the main actor.
                if let data = String(line.dropFirst(5)).data(using: .utf8),
                  let patch: Inflight = try? await APIClient.decoded(data, from: "/api/bots/events"),
                  !Task.isCancelled, self.selectedBotId == patch.botId {
                  self.latestInflight = patch
                  if let current = self.conversation {
                    let value = patch.applying(to: current)
                    self.conversation = value
                    self.conversationCache[patch.botId] = value
                  }
                }
              } else if line != "data: ping" {
                self.latestInflight = nil
                // The conversation changed, so an unconfirmed send there is worth asking about now.
                if let pending = self.pendings[id] { self.submissionChecks[pending.requestId] = nil }
                self.requestConversationRefresh()
              }
              event = ""
            }
          }
        } catch {}
        guard let self, !Task.isCancelled, !self.sessionExpired else { return }
        self.streamHeardAt = nil
        failures += 1
        try? await Task.sleep(for: .seconds(min(30, 3 * failures)))
      }
    }
  }
  /// One refresh at a time; a notice during one asks for one more after it.
  func requestConversationRefresh() {
    if conversationRefreshing { conversationRefreshAgain = true; return }
    conversationRefreshing = true
    Task {
      repeat {
        conversationRefreshAgain = false
        await refreshConversation()
      } while conversationRefreshAgain
      conversationRefreshing = false
    }
  }
  func suspend() {
    suspended = true
    cancelPrefetch()
    stopPolling()
    // The next poll loop starts with a fresh bootstrap.
    bootstrapRefreshedAt = nil
    persistDraft()
    flushDraft(inBackground: true)
    saveOfflineLibrary(immediately: true)
  }
  /// Bootstrap costs the server several Hermes calls, so the poll loop asks for it only when it
  /// is due. A failure, an outage or a missing roster is always due, because recovery needs it.
  private var bootstrapDue: Bool {
    guard let last = bootstrapRefreshedAt, bootstrap != nil, failures == 0, !appUnavailable,
      bootstrap?.connection.connected == true
    else { return true }
    return now() - last >= Self.bootstrapInterval
  }
  func refreshBootstrap(ifDue: Bool = false) async {
    guard let api, api.token != nil, !ifDue || bootstrapDue else { return }
    bootstrapRefreshedAt = now()
    let currentGeneration = generation
    bootstrapReads += 1
    let bootstrapRead = bootstrapReads
    do {
      let response: (value: Bootstrap?, etag: String?) = try await api.changed("/bootstrap?roster=lean", since: appliedBootstrapTag)
      guard generation == currentGeneration, bootstrapRead > appliedBootstrapRead else { return }
      appliedBootstrapRead = bootstrapRead
      pollSucceeded(.roster)
      // The body applied last time, unchanged: nothing to decode, merge or publish to views.
      guard var value = response.value ?? bootstrap else { return }
      var applied = false
      if response.value != nil {
        if let previous = bootstrap, previous.user.id == value.user.id, !value.connection.connected {
          value.bots = previous.bots
        }
        if let previous = bootstrap, previous.user.id == value.user.id, value.connection.connected,
          Set(previous.bots.map(\.id)) != Set(value.bots.map(\.id)) {
          let removed = Set(previous.bots.map(\.id)).subtracting(value.bots.map(\.id))
          if !removed.isEmpty {
            clearOfflineLibrary(includingVoice: false)
            for id in removed {
              conversationCache[id] = nil; cachedChats.remove(id); conversationCapturedAt[id] = nil
              if let clip = voiceRecordingURL(botId: id) { try? FileManager.default.removeItem(at: clip) }
            }
            recentChats.removeAll { removed.contains($0) }
            // Recheck redacted references without destroying the open view or its scroll anchor.
            conversationRefreshedAt = nil
          }
        }
        if let previous = bootstrap, previous.user.id != value.user.id {
          clearOfflineLibrary()
          persistDraft()
          draftTask?.cancel()
          scheduledDraftSave = nil
          selectionGeneration = UUID()
          generation = UUID()
          selectedBotId = nil
          stayHome = false
          conversation = nil
          conversationCache.removeAll()
          conversationCapturedAt.removeAll()
          resetPrefetch()
          historyStarts.removeAll()
          earlierFileCache.removeAll()
          draft = Draft()
          draftReady = false
          pendings = [:]
          receipts = [:]
          submissionChecks = [:]
          sending = false
          uploads.reset()
          interruptionReviewed = false
          upgrade.reset(); computerStatus = nil; openComputer = nil
          resetPreferenceSaves()
        }
        if bootstrap != value { bootstrap = value; applied = true }
        appliedBootstrapTag = response.etag
      }
      // Publishing follows a changed roster; an unchanged one still renews the widgets' freshness.
      if !applied { publishWidgetSnapshot() }
      restoredRosterAt = nil
      if offlineSavedAt != nil, !cachedChats.contains(selectedBotId ?? "") { offlineSavedAt = nil }
      api.csrf = value.csrfToken
      Task { await self.uploads.drain() }
      if appUnavailable { appUnavailable = false }
      failures = 0
      saveOfflineLibrary()
      loadPendings(value.bots)
      if let open = selectedBotId, value.connection.connected, !value.bots.contains(where: { $0.id == open }) {
        await leave(open)
      } else if !stayHome, selectedBotId == nil || !value.bots.contains(where: { $0.id == selectedBotId }) {
        let last: String? = read(key(.selected))
        let next =
          value.bots.first { $0.id == last }?.id ?? value.bots.first {
            $0.id == value.preferences.defaultBotId
          }?.id ?? value.bots.first?.id
        await select(next, navigate: false)
      }
    } catch is CancellationError {} catch {
      guard generation == currentGeneration, bootstrapRead > appliedBootstrapRead else { return }
      failures += 1
      appUnavailable = true
      reportPoll(error, .roster)
    }
  }
  func reconnect() async {
    guard let api else { return }
    let currentGeneration = generation
    do {
      let _: RuntimeStatus = try await api.write("/connection/retry", [String: String]())
      guard currentGeneration == generation else { return }
      submissionChecks = [:]
      await refreshBootstrap()
      if groupCatalog != nil { await refreshGroups() }
      await refreshConversation()
      await reconcilePending()
    } catch { if currentGeneration == generation { report(error) } }
  }
}
