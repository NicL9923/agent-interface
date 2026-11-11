import SwiftUI

// Retrying a failed turn (contract C1).
extension AppStore {
  // MARK: I1 transcript entry points

  /// What this device knows about the retry of one failed turn (contract C1), as the web's
  /// `useTurnRetry` keeps it: being sent, being checked while its outcome is unknown, or settled,
  /// with the request it follows, its own or the one that claimed the turn first.
  struct RetryAttempt: Equatable {
    enum State: Equatable { case sending, checking, settled }
    var turn: String
    var state: State
    var requestId: String?
    /// The receipt that settled it.
    var receipt: Receipt? = nil
  }
  /// The open conversation's failed turn that Retry would resend: the person, the assistant, the
  /// message and the failed run identify it.
  private var retryTurn: (key: String, message: Message, runId: String, botId: String)? {
    guard let conversation, conversation.botId == selectedBotId, let message = RetryTurn.target(conversation) else { return nil }
    let runId = conversation.activity.runId ?? ""
    return ([bootstrap?.user.id ?? "", conversation.botId, message.id, runId].joined(separator: "\u{0}"), message, runId, conversation.botId)
  }
  /// Retry as the open conversation offers it, or nil once anyone's retry of the turn settled, as
  /// the server's `retry` claim or a receipt here says.
  var retryOffer: RetryOffer? {
    guard let turn = retryTurn else { return nil }
    let local = retryAttempt?.turn == turn.key ? retryAttempt : nil
    let claim = conversation?.retry.flatMap { $0.retryOf == turn.message.id ? $0 : nil }
    if local?.state == .settled || claim.map({ $0.status != "uncertain" }) == true { return nil }
    let checking = local?.state != .sending && (local?.state == .checking || claim?.status == "uncertain")
    return RetryOffer(message: turn.message, turn: turn.key, busy: local?.state == .sending, checking: checking,
      followed: local?.requestId ?? claim?.requestId, resendable: supports(.idempotency))
  }
  struct RetryOffer: Equatable {
    var message: Message
    var turn: String
    var busy: Bool
    /// The outcome is unknown and is being checked by the followed request's ID.
    var checking: Bool
    var followed: String?
    /// Hermes can look a request up by its ID, which sending the same request again relies on.
    var resendable: Bool
    var enabled: Bool { !busy && (!checking || resendable) }
  }
  private struct RetryRequest: Encodable {
    var requestId: String
    var text: String
    var attachments: [FileRef]
    var retryOf: String
    var reviewedUncertain: Bool?
  }

  /// Sends the person's message of the failed turn again (contract C1). Every device derives the
  /// same request ID for the turn and the server admits one retry per failed turn, so it can never
  /// run twice; a later retry follows the request that claimed the turn. While the outcome is
  /// unknown it sends the same request again, as reviewed, only when Hermes can look it up. It never
  /// reads, saves or clears the draft and leaves the composer's own send alone.
  func retry() async {
    guard let api, let turn = retryTurn, let offer = retryOffer, offer.enabled, connected, supports(.chat) else { return }
    let again = offer.checking
    retryAttempt = RetryAttempt(turn: turn.key, state: .sending, requestId: offer.followed)
    let requestId = offer.followed ?? RetryTurn.requestId(botId: turn.botId, retryOf: turn.message.id, runId: turn.runId)
    let body = RetryRequest(requestId: requestId, text: turn.message.text, attachments: turn.message.files ?? [],
      retryOf: turn.message.id, reviewedUncertain: again ? true : nil)
    let scope = scope
    do {
      let value: Receipt = try await api.write("/bots/\(APIClient.component(turn.botId))/messages", body)
      guard scope == self.scope else { return }
      settleRetry(turn.key, value)
    } catch {
      guard scope == self.scope, retryTurn?.key == turn.key else { return }
      // Only a first attempt the server refused outright never reached Hermes. Anything else may
      // have, so it is checked by its ID.
      if !again, let failure = error as? APIError, (400..<500).contains(failure.status) {
        retryAttempt = nil
        buzz(.failed)
        report(error)
      } else {
        retryAttempt = RetryAttempt(turn: turn.key, state: .checking, requestId: requestId)
      }
    }
    await refreshConversation()
  }
  /// A receipt for the turn's retry: still unknown, accepted, or refused by Hermes. A refused retry
  /// keeps its ID, which Hermes refuses again, so the person sends the message from the composer.
  private func settleRetry(_ turn: String, _ value: Receipt) {
    guard retryTurn?.key == turn else { return }
    if value.status == "uncertain" {
      retryAttempt = RetryAttempt(turn: turn, state: .checking, requestId: value.requestId)
      return
    }
    retryAttempt = RetryAttempt(turn: turn, state: .settled, requestId: value.requestId, receipt: value)
    if value.admitted {
      buzz(.sent)
      if let botId = selectedBotId { Task { await LiveActivityController.shared.sent(to: botId) } }
    } else if !value.admittedNothing {
      // `retryRefusal` explains it for as long as the turn stays failed. A stop phrase is explained the
      // same way but is no error, so it gets no error tone.
      buzz(.failed)
    }
  }
  /// A refused retry of the open turn, explained from this device's receipt or the server's `retry`
  /// record, so it lasts across reloads and devices. Its ID stays refused, so the person sends the
  /// message again from the composer.
  struct RetryRefusal: Equatable {
    var text: String
    var message: Message
  }
  var retryRefusal: RetryRefusal? {
    guard let turn = retryTurn else { return nil }
    let local = retryAttempt?.turn == turn.key && retryAttempt?.state == .settled ? retryAttempt?.receipt : nil
    let claim = conversation?.retry.flatMap { $0.retryOf == turn.message.id ? $0 : nil }
    let outcome = local ?? claim.map { Receipt(requestId: $0.requestId, status: $0.status, message: $0.message, turn: $0.turn) }
    // A retry whose words were a typed stop phrase reached nobody either: Hermes answers that ID the same
    // way, so the message box sends it anew, as for a refusal.
    guard let outcome, ["rejected", "interrupted"].contains(outcome.status) || outcome.admittedNothing else { return nil }
    let detail = outcome.message.flatMap { $0.isEmpty ? nil : $0 }
    return RetryRefusal(text: detail.map { "\(RetryTurn.refusedNotice) \($0)" } ?? RetryTurn.refusedNotice, message: turn.message)
  }
  /// Puts a refused retry's message in the composer as the web does: its text after the draft's
  /// own, separated by a blank line, and its files after the draft's, as many as a message can
  /// carry. It never replaces the draft and does nothing while the draft is on its way. Returns how
  /// many files did not fit, or nil when the draft cannot change now.
  @discardableResult func putRetriedMessageInDraft(_ message: Message) -> Int? {
    guard let id = selectedBotId, draftReady, !sendingDraft else { return nil }
    let missing = (message.files ?? []).filter { file in !draft.attachments.contains { $0.id == file.id } }
    let added = Array(missing.prefix(max(0, attachmentSlots(id))))
    editComposer { draft in
      let kept = String(draft.text.reversed().drop(while: \.isWhitespace).reversed())
      draft.text = kept.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? message.text : kept + "\n\n" + message.text
      draft.attachments += added.filter { file in !draft.attachments.contains { $0.id == file.id } }
    }
    return missing.count - added.count
  }
  /// Checks an unconfirmed retry by the ID it follows, never sending it as a new request, until a
  /// receipt settles it or the turn changes. Reads only while connected.
  func updateRetryChecks() {
    let offer = retryOffer
    let key = offer.flatMap { offer in offer.checking ? offer.followed.map { "\(offer.turn)|\($0)" } : nil }
    guard key != retryCheckKey else { return }
    retryChecks?.cancel()
    retryCheckKey = key
    guard key != nil, let offer, let followed = offer.followed, let api else { retryChecks = nil; return }
    let (first, slowest) = retryCheckDelays
    retryChecks = Task { [weak self] in
      var delay = first
      while !Task.isCancelled {
        if self?.connected == true, let value: Receipt = try? await api.get("/submissions/\(APIClient.component(followed))") {
          guard !Task.isCancelled else { return }
          if value.status != "uncertain" {
            self?.settleRetry(offer.turn, value)
            await self?.refreshConversation()
            return
          }
        }
        try? await Task.sleep(for: delay)
        delay = min(delay * 2, slowest)
      }
    }
  }
}
