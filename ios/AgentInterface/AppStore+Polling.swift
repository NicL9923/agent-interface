import SwiftUI

// The poll loop, the household and conversation change streams, and the bootstrap they refresh.
extension AppStore {
  func startPolling() {
    guard !suspended else { return }
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
    guard !suspended, !Task.isCancelled, generation == currentGeneration, api?.token != nil else { return false }
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
    // Finds a LAN or tailnet route to this server, at most every couple of minutes.
    api?.checkRoutes()
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
          let stream = try await api.events("/api/events")
          guard let self, !Task.isCancelled else { return }
          failures = 0
          // Notices sent before the subscription are lost, so connecting counts as one. A server
          // that sends `groups` also sends one on every connect, so the catalog needs no read here.
          // A server that sends `groups` sends one on every connect, so each connect proves it again.
          // Until then home polls as for an older server; the poll sleeps first, so this costs no read.
          self.groupNoticeScope = nil
          await self.refreshBootstrap()
          for try await line in stream.lines {
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
  /// The stream sends a live reply whole once, then only what it grew by (`?inflight=2`), so a long
  /// reply is not sent again in full on every tick.
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
      // Growth notices refused since one last applied. The first reconnects at once; repeats wait
      // longer each time, so a reply this app cannot read never reconnects on every tick.
      var refused = 0
      while !Task.isCancelled {
        var resync = false
        do {
          let stream = try await api.events("/api/bots/\(APIClient.component(id))/events?inflight=2")
          guard let self, !Task.isCancelled else { return }
          failures = 0
          self.streamHeardAt = self.now()
          // Notices sent before the subscription are lost, so connecting counts as one. A new
          // stream starts from a whole reply, so nothing held from the last one is extended.
          self.latestInflight = nil
          self.requestConversationRefresh()
          var event = ""
          reading: for try await line in stream.lines {
            guard !Task.isCancelled else { return }
            self.streamHeardAt = self.now()
            if line.hasPrefix("event:") { event = String(line.dropFirst(6)).trimmingCharacters(in: .whitespaces) }
            if line.hasPrefix("data:") {
              if event == "inflight" {
                // The whole reply so far, so it decodes away from the main actor.
                var patch: Inflight?
                if let data = String(line.dropFirst(5)).data(using: .utf8),
                  let decoded: Inflight = try? await APIClient.decoded(data, from: "/api/bots/events") {
                  patch = decoded
                }
                guard !Task.isCancelled else { return }
                // Growth notices extend exactly this reply. One this app cannot read, or one for
                // another chat, leaves nothing to extend, so the next notice reconnects.
                if let patch, self.selectedBotId == patch.botId { self.showLive(patch) } else { self.latestInflight = nil }
              } else if event == "inflight-delta" {
                // Applies only when it continues exactly the reply held. Anything else is not
                // guessed at: drop the reply, close this stream and open a new one, whose connect
                // reads the conversation and whose server starts again from a whole reply.
                guard let data = String(line.dropFirst(5)).data(using: .utf8),
                  let delta: InflightDelta = try? APIClient.decode(data, from: "/api/bots/events"),
                  let next = self.latestInflight?.extended(by: delta)
                else {
                  self.latestInflight = nil
                  resync = true
                  stream.task.cancel()
                  break reading
                }
                refused = 0
                self.showLive(next)
              } else if line != "data: ping" {
                // The server sends the next live reply whole after this notice.
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
        if resync {
          refused += 1
          // Timer: the first reconnect after a refused notice is immediate; repeats back off.
          if refused > 1 { try? await Task.sleep(for: .seconds(min(30, 3 * (refused - 1)))) }
          continue
        }
        failures += 1
        try? await Task.sleep(for: .seconds(min(30, 3 * failures)))
      }
    }
  }
  /// Shows a live reply from the stream and keeps it for conversation reads to lay over theirs.
  private func showLive(_ patch: Inflight) {
    latestInflight = patch
    if let current = conversation {
      let value = patch.applying(to: current)
      conversation = value
      conversationCache[patch.botId] = value
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
          resetAccountContent()
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
