import Foundation

/// Text from outside the composer waiting to join an assistant's draft: a Siri or Shortcuts Ask, a
/// notification's Reply, or the Share inbox's text. None is ever sent for the person. One rule
/// covers them all:
/// - Each names the account it was written for and joins only that account's draft.
/// - An Ask lapses after five minutes; a reply or shared text, which the person typed, waits.
/// - They join in the order they arrived, as one edit.
/// - Only once the assistant's draft is loaded and no send to it is unsettled: until Hermes answers,
///   a draft and its send are told apart by content, so the draft must stay the sent copy.
/// They are saved per account, so a relaunch keeps them. Shared text joins once per share: a receipt is
/// saved before it leaves the queue, and a share already queued or received is taken again without
/// adding it. One drain at a time delivers them, after
/// the operation that made them deliverable has finished, never from inside a property observer:
/// a discarded send restores its draft first, and held text joins on top.
struct DraftAddition: Codable, Equatable, Identifiable {
  enum Source: String, Codable { case ask, reply, share }
  var id = UUID()
  var source: Source
  var botId: String
  var text: String
  var scope: String
  var at = Date()
  /// The chat still opens for it, as it does once for an Ask.
  var opens = false
  /// The Share inbox share this text came from, so retrying that share adds it once.
  var capture: String? = nil
  func lapsed(at now: Date) -> Bool { source == .ask && now.timeIntervalSince(at) >= AskRequest.patience }
}

extension AppStore {
  /// Whether additions wait for this assistant: while a send for it is unsettled. A saved send counts
  /// before it is loaded, as on a relaunch whose roster has not answered yet.
  func holdsAdditions(_ botId: String) -> Bool {
    pendings[botId] != nil || key(.pending, botId).map { UserDefaults.standard.object(forKey: $0) != nil } == true
  }
  /// Whether text waits for this assistant's send to settle, for the composer's note.
  func holdsText(for botId: String) -> Bool { holdsAdditions(botId) && additions.contains { $0.botId == botId } }
  /// Adds text or an uploaded shared file to the open assistant's draft, unless it holds additions for now.
  @discardableResult func addShared(text: String = "", file: FileRef? = nil, botId: String) -> Bool {
    guard selectedBotId == botId, draftReady, !holdsAdditions(botId) else { return false }
    var next = draft
    if !text.isEmpty { next.text += (next.text.isEmpty ? "" : "\n\n") + text }
    if let file { next.attachments.append(file) }
    updateDraft(next)
    return true
  }
  /// Queues text for its draft. Returns false, dropping it, when it was written for another account
  /// than the one signed in. Before any sign-in has loaded, it waits to be checked.
  @discardableResult func hold(_ addition: DraftAddition) -> Bool {
    if scope == nil {
      earlyAdditions.append(addition)
    } else {
      guard addition.scope == scope else { return false }
      storeAdditions(savedAdditions() + [addition])
    }
    scheduleAdditions()
    return true
  }
  /// A question from Siri or Shortcuts opens its chat and joins the draft for review.
  func queueAsk(_ request: AskRequest) {
    hold(DraftAddition(source: .ask, botId: request.botId, text: request.text, scope: request.scope, at: request.at, opens: true))
  }
  /// Text typed into a notification's Reply. Its chat is already opening. Returns false when the
  /// reply was written for another account.
  @discardableResult func addNotificationReply(_ text: String, botId: String, account: String) -> Bool {
    guard let user = bootstrap?.user.id, NotificationActions.accountMarker(user) == account, let scope,
      hold(DraftAddition(source: .reply, botId: botId, text: text, scope: scope))
    else {
      report(APIError(message: "That reply was written while another account was signed in, so it was not added to this draft.", status: 0))
      return false
    }
    return true
  }
  /// A share's text for an assistant's draft. Returns false when the share was saved for another
  /// account. A share whose text already joined, or waits to, is taken without adding it again: the
  /// app may have stopped before the emptied share was saved.
  func holdShared(_ capture: SharedCapture, botId: String) -> Bool {
    guard let scope, capture.scope == scope else { return false }
    if sharedTextAdded(capture) { return true }
    return hold(DraftAddition(source: .share, botId: botId, text: capture.text, scope: scope, capture: capture.id))
  }
  /// Whether this share's text is already in a draft or waiting for one, for this account.
  func sharedTextAdded(_ capture: SharedCapture) -> Bool {
    guard scope == capture.scope, !capture.text.isEmpty else { return false }
    return savedAdditions().contains { $0.capture == capture.id && $0.text == capture.text }
      || sharedTextReceipts().contains { $0.matches(capture) }
  }
  func savedAdditions() -> [DraftAddition] { read(key(.draftAdditions)) ?? [] }
  private func sharedTextReceipts() -> [SharedTextReceipt] { read(key(.sharedTextReceipts)) ?? [] }
  private func storeAdditions(_ value: [DraftAddition]) {
    save(value.isEmpty ? nil : value, key(.draftAdditions))
    if additions != value { additions = value }
  }
  /// Starts a drain once the current operation is over, or asks the running one to look again.
  func scheduleAdditions() {
    if additionsDrain != nil { additionsAgain = true; return }
    guard !additions.isEmpty || !earlyAdditions.isEmpty else { return }
    additionsDrain = Task {
      await drainAdditions()
      additionsDrain = nil
    }
  }
  /// Delivers what can land now and waits for it. Tests and callers that just made something
  /// deliverable use it to see the result.
  func deliverAdditions() async {
    scheduleAdditions()
    await additionsDrain?.value
  }
  private func drainAdditions() async {
    repeat {
      additionsAgain = false
      guard let scope, let bots = bootstrap?.bots else { return }
      let early = earlyAdditions.filter { $0.scope == scope }
      earlyAdditions = []
      var held = savedAdditions() + early
      let now = Date()
      held.removeAll { addition in addition.lapsed(at: now) || !bots.contains { $0.id == addition.botId } }
      storeAdditions(held)
      if let id = selectedBotId { landAdditions(for: id) }
      // The earliest Ask that still opens its chat goes next, and its chat takes its text at once. A
      // draft that cannot take it yet keeps it for when that chat can, and the next Ask opens meanwhile,
      // so no chat waits on another. Anything that changed during the opening is read again.
      held = savedAdditions()
      if let index = held.firstIndex(where: \.opens) {
        held[index].opens = false
        storeAdditions(held)
        let id = held[index].botId
        if selectedBotId == id && draftReady { conversationRequest = UUID() } else { await select(id) }
        landAdditions(for: id)
        additionsAgain = true
      }
    } while additionsAgain
  }
  /// Lands an assistant's waiting text in its open draft as one edit, in arrival order, up to the
  /// first Ask that still has to open its chat, so nothing that came later goes ahead of it. Waits
  /// while the draft cannot take text: not open, still loading, or holding a send. An Ask that lapsed
  /// meanwhile, such as while its chat opened, is dropped here rather than landed late.
  private func landAdditions(for id: String) {
    guard selectedBotId == id, draftReady, !holdsAdditions(id) else { return }
    let now = Date(), saved = savedAdditions()
    if saved.contains(where: { $0.lapsed(at: now) }) { storeAdditions(saved.filter { !$0.lapsed(at: now) }) }
    let ready = Array(savedAdditions().filter { $0.botId == id }.prefix { !$0.opens })
    guard !ready.isEmpty, addShared(text: ready.map(\.text).joined(separator: "\n\n"), botId: id) else { return }
    // Saved in this order, the text is never only in memory: the draft, then a receipt for each share,
    // then the queue without them. Stopping between them can add the text twice, never lose it.
    persistDraft()
    let shared = ready.compactMap { addition in addition.capture.map { SharedTextReceipt(capture: $0, text: addition.text) } }
    if !shared.isEmpty { save(SharedTextReceipt.recording(shared, in: sharedTextReceipts()), key(.sharedTextReceipts)) }
    storeAdditions(savedAdditions().filter { addition in !ready.contains { $0.id == addition.id } })
  }
}
