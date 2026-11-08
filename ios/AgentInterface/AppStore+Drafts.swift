import SwiftUI

// The open draft: editing, saving to this device and the server, and merging what the server sends back.
extension AppStore {
  func updateDraft(_ value: Draft) {
    // Callers change the words and files. The revision bookkeeping stays this copy's, and each
    // edit gets the next sequence, so a response to an older save is never taken for this one.
    // One assignment, so a keystroke publishes once.
    var next = draft
    next.text = value.text
    next.attachments = value.attachments
    next.dirty = true
    next.seq = nextDraftSeq(selectedBotId)
    draft = next
    persistDraftSoon()
    draftTask?.cancel()
    scheduledDraftSave = nil
    guard draftReady, let botId = selectedBotId else { return }
    let token = UUID()
    scheduledDraftSave = token
    draftTask = Task {
      try? await Task.sleep(for: Self.draftSaveDelay)
      guard !Task.isCancelled, self.scheduledDraftSave == token else { return }
      self.startDraftSave(botId: botId)
    }
  }
  /// Sends the open draft's save now, unless it is the text being sent. One save at a time: a
  /// save in flight checks again when its response is merged, and is never cancelled, because it
  /// may already have reached the server. Leaving (`force`) sends anyway.
  @discardableResult private func startDraftSave(botId: String, force: Bool = false) -> Bool {
    scheduledDraftSave = nil
    if !force, !settled(botId) { return false }
    let snapshot = draft
    let sent = pendings[botId]
    guard sent == nil || !snapshot.isSentCopy || sent?.text != snapshot.text || sent?.attachments != snapshot.attachments
    else { return false }
    let currentGeneration = generation
    Task {
      do { try await self.saveDraft(snapshot, botId: botId) } catch is CancellationError {} catch {
        if currentGeneration == self.generation { self.report(error) }
      }
    }
    return true
  }
  /// Sends a waiting edit now, when switching assistants or leaving the app, instead of
  /// dropping it. Leaving gets a short background task to finish the saves in flight.
  func flushDraft(inBackground: Bool = false) {
    draftTask?.cancel()
    var started = false
    // The latest edit always goes, unless a save of exactly that edit is already in flight.
    if draftReady, draft.dirty == true, let botId = selectedBotId, let localKey = key(.draft, botId),
      draftSavesInFlight[localKey]?.contains(draft.seq ?? 0) != true
    {
      started = startDraftSave(botId: botId, force: true)
    }
    scheduledDraftSave = nil
    guard inBackground, started || !draftSavesInFlight.isEmpty, draftBackgroundTask == .invalid else { return }
    draftBackgroundTask = UIApplication.shared.beginBackgroundTask(withName: "Save draft") { [weak self] in
      self?.endDraftBackgroundTask()
    }
  }
  private func endDraftBackgroundTask() {
    guard draftBackgroundTask != .invalid else { return }
    UIApplication.shared.endBackgroundTask(draftBackgroundTask)
    draftBackgroundTask = .invalid
  }
  private func nextDraftSeq(_ botId: String?) -> Int {
    let localKey = botId.flatMap { key(.draft, $0) } ?? ""
    let next = max(draftSeqs[localKey] ?? 0, draft.seq ?? 0) + 1
    draftSeqs[localKey] = next
    return next
  }
  func settled(_ botId: String) -> Bool { key(.draft, botId).map { draftSavesInFlight[$0] == nil } ?? true }
  /// Saves a draft on its base revision, then merges the response into the open copy and the
  /// cached copy as they are now. Kept edits after a conflict save again on the new base.
  func saveDraft(_ snapshot: Draft, botId: String, retries: Int = 3) async throws {
    guard let api, let localKey = key(.draft, botId) else { return }
    let currentGeneration = generation
    let seq = snapshot.seq ?? 0
    draftSavesInFlight[localKey, default: []].append(seq)
    let server: SavedDraft
    var conflict = false
    do {
      defer {
        var left = draftSavesInFlight[localKey] ?? []
        if let index = left.firstIndex(of: seq) { left.remove(at: index) }
        draftSavesInFlight[localKey] = left.isEmpty ? nil : left
        if draftSavesInFlight.isEmpty { endDraftBackgroundTask() }
      }
      do {
        server = try await api.write(
          "/bots/\(APIClient.component(botId))/draft", DraftSave(snapshot), method: "PUT")
      } catch let error as APIError where error.code == DraftConflict.code {
        guard let body = error.body, let refused = try? JSONDecoder().decode(DraftConflict.self, from: body)
        else { throw error }
        server = refused.draft
        conflict = true
      }
    } catch is CancellationError {
      throw CancellationError()
    } catch {
      // A failed or timed-out save leaves the copy unsaved: check the rule again after a backoff.
      guard currentGeneration == generation else { throw error }
      let count = (draftSaveFailures[localKey] ?? 0) + 1
      draftSaveFailures[localKey] = count
      let delay = Duration.seconds(min(30, pow(2, Double(count - 1))))
      draftRetryAt[localKey] = now() + delay
      Task {
        try? await Task.sleep(for: delay)
        guard currentGeneration == self.generation else { return }
        self.ensureDraftSaved(botId)
      }
      throw error
    }
    draftSaveFailures[localKey] = nil
    draftRetryAt[localKey] = nil
    guard currentGeneration == generation else { return }
    let settled = draftSavesInFlight[localKey] == nil
    // A 409 answering the latest edit is the server's word, even if older than the copy.
    let update = { (local: Draft) in
      Draft.merge(local, with: server, authoritative: conflict && settled && local.seq == snapshot.seq, settled: settled).draft
    }
    var next: Draft?
    if let cached: Draft = read(localKey) {
      next = update(cached)
      save(next, localKey)
    }
    if selectedBotId == botId {
      draft = update(draft)
      persistDraft()
      if draftReady { next = draft }
    }
    // The server now has this text, or a send made it obsolete.
    if !conflict || next?.dirty != true { save(Optional<Bool>.none, key(.recovered, botId)) }
    ensureDraftSaved(botId, retries: retries - 1)
  }
  /// The one rule after every response or merge: a copy left unsaved, with no save in flight or
  /// waiting, saves again.
  private func ensureDraftSaved(_ botId: String, retries: Int = 3) {
    guard settled(botId), let localKey = key(.draft, botId) else { return }
    // A failing save retries on its backoff, however often the conversation polls.
    if let retryAt = draftRetryAt[localKey], now() < retryAt { return }
    if selectedBotId == botId && draftReady {
      if draft.dirty == true, scheduledDraftSave == nil { startDraftSave(botId: botId) }
    } else if let cached: Draft = read(localKey), cached.dirty == true, retries > 0 {
      Task { try? await self.saveDraft(cached, botId: botId, retries: retries) }
    }
  }
  /// Writes the open draft to this device now. Leaving, switching, signing out, every merge and text
  /// landing from outside the composer call it, which also writes a typing pause's pending copy at once.
  func persistDraft() {
    draftPersistTask?.cancel()
    draftPersistTask = nil
    if draftReady, let botId = selectedBotId { save(draft, key(.draft, botId)) }
  }
  /// Typing writes the local copy after a short pause instead of encoding it on every keystroke.
  private func persistDraftSoon() {
    draftPersistTask?.cancel()
    draftPersistTask = Task { [weak self] in
      try? await Task.sleep(for: Self.draftPersistDelay)
      guard !Task.isCancelled else { return }
      self?.persistDraft()
    }
  }
  static let draftPersistDelay: Duration = .milliseconds(300)
  /// A typing pause this long saves the open draft to the server.
  static let draftSaveDelay: Duration = .milliseconds(600)
  /// The one message on its way, if any. Accepted ones read as ordinary messages.
  var outgoing: SentEcho.Delivery? { echoes.lazy.compactMap(\.delivery).first }
  /// Whether the open draft is the message on its way. The transcript shows it, so the composer
  /// reads empty, and read-only: until Hermes answers, a draft and its send are told apart only by
  /// their content, so the draft must stay the sent copy.
  var sendingDraft: Bool { SentEcho.sendingDraft(draft, pending: pending, sending: sending) }
  /// The draft as the composer shows it: empty while its message is on its way.
  var composerDraft: Draft {
    guard sendingDraft else { return draft }
    var shown = draft
    shown.text = ""
    shown.attachments = []
    return shown
  }
  /// An edit in the composer. One made while its draft is on its way is ignored: the composer is
  /// read-only then, and this keeps any other path from changing the sent copy.
  func editComposer(_ edit: (inout Draft) -> Void) {
    guard !sendingDraft else { return }
    var next = draft
    edit(&next)
    updateDraft(next)
  }
  static let draftLoadFailure = "Your saved draft could not be loaded."
  /// The web drops its "could not be loaded" notice once a later read of the draft succeeds.
  func clearDraftLoadFailure() {
    if error?.hasPrefix(Self.draftLoadFailure) == true { error = nil }
  }
  /// Adds a voice transcript to the open assistant's draft on its own line, as the web does.
  @discardableResult func appendTranscript(_ text: String, botId: String) -> Bool {
    guard selectedBotId == botId, draftReady else { return false }
    editComposer {
      $0.text = $0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? text : $0.text + "\n" + text
    }
    return true
  }
  /// Shows the draft once a read returns, merged with this device's copy. Unsaved edits that
  /// survive the merge, such as a draft recovered by Discard, then save on their base revision,
  /// so the server refuses them if it moved on.
  func loadDraft(_ remote: SavedDraft?, botId: String) {
    let merged = Draft.merge(draftReady ? draft : read(key(.draft, botId)) ?? draft, with: remote, settled: settled(botId))
    let changed = merged.draft != draft
    if changed { draft = merged.draft }
    if !draftReady { draftReady = true }
    clearDraftLoadFailure()
    if changed { persistDraft() }
    if draft.dirty != true { save(Optional<Bool>.none, key(.recovered, botId)) }
    ensureDraftSaved(botId)
  }
  /// Puts a pending message back in front of whatever the person has typed since, unless the
  /// draft still holds it, as the web's `restoreSent` does.
  static func draft(restoring old: PendingSubmission, into current: Draft) -> Draft {
    var next = current
    if !next.text.contains(old.text) {
      next.text = [old.text, next.text].filter { !$0.isEmpty }.joined(separator: "\n\n")
    }
    let missing = old.attachments.filter { file in !current.attachments.contains { $0.id == file.id } }
    next.attachments = missing + current.attachments
    return next
  }
}
