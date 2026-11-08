import SwiftUI

// Sending messages and settling unconfirmed sends by their receipts.
extension AppStore {
  func send(reviewedUncertain: Bool = false) async {
    guard let api, let id = selectedBotId, !sending else { return }
    let submission: PendingSubmission
    if reviewedUncertain, var old = pendings[id] {
      old.reviewedUncertain = true
      submission = old
    } else {
      guard canSend else { return }
      submission = PendingSubmission(
        requestId: UUID().uuidString.lowercased(), botId: id, text: draft.text,
        attachments: draft.attachments, reviewedInterruption: interruptionReviewed,
        draftBaseRevision: draft.baseRevision ?? 0)
    }
    pendings[id] = submission
    submissionChecks[submission.requestId] = nil
    save(submission, key(.pending, id))
    // Until the server shows the send, a save of the sent text from this copy is not new work.
    // A retry sends the same request again; the copy it came from is already marked, and a copy
    // edited since is not it.
    if !reviewedUncertain { markSent(submission, true) }
    sendingRequests[id] = submission.requestId
    error = nil
    let currentGeneration = generation
    defer { if currentGeneration == generation, sendingRequests[id] == submission.requestId { sendingRequests[id] = nil } }
    do {
      let value: Receipt = try await api.write(
        "/bots/\(APIClient.component(id))/messages", submission)
      guard currentGeneration == generation else { return }
      await handleReceipt(value, botId: id)
      if value.status == "accepted" { declinedApprovals[id] = nil; buzz(.sent); Task { await LiveActivityController.shared.sent(to: id) } }
      else if value.status == "rejected" || value.status == "interrupted" { buzz(.failed) }
    } catch {
      guard currentGeneration == generation else { return }
      report(error)
      // As on the web, any answer below 500 is the server refusing the message. That includes 408:
      // the server stopped waiting for the request before handling it.
      if let failure = error as? APIError, (400..<500).contains(failure.status) {
        clearPending(id)
        refused(submission)
        buzz(.failed)
        receipts[id] = Receipt(
          requestId: submission.requestId, status: "rejected", message: failure.message)
      } else {
        receipts[id] = Receipt(
          requestId: submission.requestId, status: "uncertain",
          message:
            "Checking whether Hermes accepted this message. The original request ID is preserved.")
      }
    }
    await refreshConversation()
  }
  /// Asks the server about every assistant's unconfirmed send, not only the open one, so a
  /// message that arrived clears that assistant's draft before it is opened again.
  /// Each check waits longer for an answer that stays uncertain, but never resubmits.
  func reconcilePending() async {
    guard let api else { return }
    let currentGeneration = generation
    for pending in pendings.values.sorted(by: { $0.botId < $1.botId }) {
      if sendingRequests[pending.botId] != nil { continue }
      if let check = submissionChecks[pending.requestId], now() < check.next { continue }
      do {
        let value: Receipt = try await api.get(
          "/submissions/\(APIClient.component(pending.requestId))")
        guard currentGeneration == generation else { return }
        if sendingRequests[pending.botId] != nil { continue }
        checkedSubmission(pending.requestId)
        pollSucceeded(.submissions)
        await handleReceipt(value, botId: pending.botId)
      } catch {
        guard currentGeneration == generation else { return }
        checkedSubmission(pending.requestId)
        reportPoll(error, .submissions)
        return
      }
    }
    submissionChecks = submissionChecks.filter { id, _ in pendings.values.contains { $0.requestId == id } }
  }
  /// How long an unconfirmed send waits between checks: 1.5 s, 5 s, 15 s, then a minute. A new
  /// send, a retry of it, a change notice from its conversation or Reconnect asks again at once.
  static let submissionCheckDelays: [Duration] = [.seconds(1.5), .seconds(5), .seconds(15), .seconds(60)]
  private func checkedSubmission(_ requestId: String) {
    let count = (submissionChecks[requestId]?.count ?? 0) + 1
    submissionChecks[requestId] = (count, now() + Self.submissionCheckDelays[min(count, Self.submissionCheckDelays.count) - 1])
  }
  private func clearPending(_ botId: String) {
    pendings[botId] = nil
    save(Optional<PendingSubmission>.none, key(.pending, botId))
  }
  /// Reads each assistant's unconfirmed send. One saved by an older version, which held a single
  /// send for every assistant, moves to its own assistant.
  func loadPendings(_ bots: [Bot]) {
    if let legacy: PendingSubmission = read(key(.pending)) {
      let current: PendingSubmission? = read(key(.pending, legacy.botId))
      if current == nil { save(legacy, key(.pending, legacy.botId)) }
      save(Optional<PendingSubmission>.none, key(.pending))
    }
    for bot in bots where pendings[bot.id] == nil {
      if let stored: PendingSubmission = read(key(.pending, bot.id)) { pendings[bot.id] = stored }
    }
  }
  private func handleReceipt(_ value: Receipt, botId: String) async {
    if receipts[botId] != value { receipts[botId] = value }
    guard let original = pendings[botId], value.requestId == original.requestId else { return }
    guard ["accepted", "rejected", "interrupted"].contains(value.status) else { return }
    if value.status == "accepted" {
      // The server clears its copy for this send, which a later save here must not mistake
      // for a send from another device.
      if selectedBotId == original.botId && draftReady {
        if draft.isSentCopy && draft.text == original.text && draft.attachments == original.attachments {
          draftTask?.cancel()
          scheduledDraftSave = nil
        }
        draft = draft.sent(original)
        persistDraft()
      } else {
        let draftKey = key(.draft, original.botId)
        if let cached: Draft = read(draftKey) { save(cached.sent(original), draftKey) }
      }
    }
    if value.status == "rejected" || value.status == "interrupted" { refused(original) }
    clearPending(botId)
  }
  /// A refused message goes back into its draft, in front of anything that replaced it meanwhile,
  /// such as an edit from another device or the Share inbox, unless the draft still holds it, as
  /// on the web.
  func refused(_ submission: PendingSubmission) {
    markSent(submission, false)
    let open = selectedBotId == submission.botId
    if open && draftReady {
      let target = Self.draft(restoring: submission, into: draft)
      if target != draft { updateDraft(target) }
    } else if let localKey = key(.draft, submission.botId), let cached: Draft = read(localKey) {
      var target = Self.draft(restoring: submission, into: cached)
      guard target != cached else { return }
      target.dirty = true
      save(target, localKey)
      // While the open assistant's draft is still loading, its read merges this cached copy.
      if open { draft = target }
    }
  }
  /// Records or forgets, on the copy it came from, the text this device sent.
  private func markSent(_ submission: PendingSubmission, _ sent: Bool) {
    let hash = sent ? Draft.contentHash(submission.text, submission.attachments) : nil
    let base = sent ? submission.draftBaseRevision ?? 0 : nil
    // The copy's edit sequence identifies it as the sent copy until someone types in it again.
    if let localKey = key(.draft, submission.botId), var cached: Draft = read(localKey) {
      cached.sentHash = hash
      cached.sentBase = base
      if sent { cached.sentSeq = cached.seq ?? 0 }
      save(cached, localKey)
    }
    if selectedBotId == submission.botId {
      draft.sentHash = hash
      draft.sentBase = base
      if sent { draft.sentSeq = draft.seq ?? 0 }
      persistDraft()
    }
  }
  /// Gives up on a send the server never confirmed, for example one that was lost before it
  /// arrived. The message may still show up, so its text and attachments go back into the
  /// draft of the assistant it was written for, where the person decides whether to send again.
  /// Without an assistant, it is the open assistant's send.
  func discardUnconfirmedSubmission(botId: String? = nil) {
    guard let id = botId ?? selectedBotId, let old = pendings[id], !sending,
      let localKey = key(.draft, old.botId)
    else { return }
    let open = selectedBotId == old.botId
    // While the open assistant's draft is still loading, the in-memory draft is not its draft.
    var target = Self.draft(
      restoring: old, into: open && draftReady ? draft : read(localKey) ?? Draft())
    target.dirty = true
    // Taken back: no longer text this device sent.
    target.sentHash = nil
    // Durable first: a dirty local draft wins over any draft read still in flight.
    save(target, localKey)
    save(true, key(.recovered, old.botId))
    clearPending(id)
    receipts[id] = nil
    if open {
      if draftReady {
        draft.sentHash = nil
        updateDraft(target)
      } else { draft = target }
    } else {
      // Best effort: the dirty local draft already wins the next time that assistant opens.
      Task { try? await self.saveDraft(target, botId: old.botId) }
    }
  }
}
