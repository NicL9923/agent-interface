import SwiftUI

// Which chat is on screen: what gets polled and streamed, and what other devices hear.
extension AppStore {
  /// The open assistant while its conversation is on screen, in the iPad detail pane or under a
  /// sheet. Only it is polled and streamed: home, Today and Search leave the conversation alone,
  /// and it is read again as soon as it returns.
  var followedBotId: String? { followed(selectedBotId) }
  func followed(_ id: String?) -> String? { id.flatMap { conversationScreens[$0] != nil ? $0 : nil } }
  func conversationShown(_ botId: String, _ shown: Bool) {
    let before = followedBotId
    let count = (conversationScreens[botId] ?? 0) + (shown ? 1 : -1)
    conversationScreens[botId] = count > 0 ? count : nil
    // The chat's own loss is timed only while it is on screen.
    if followedBotId != before { updateActivity() }
    followChanged(from: before)
  }
  func followChanged(from before: String?) {
    noteRead([before, followedBotId])
    guard followedBotId != before, pollTask != nil else { updateEcho(); return }
    watchConversation()
    // Back on screen without opening it again, after nothing was read while it was away. Like
    // opening it, the first read is the reply announcement baseline. Its echoes wait for that
    // read, so a message on its way is not retired against the copy from before.
    guard let id = followedBotId, openingBotId != id,
      conversationRefreshedAt.map({ now() - $0 >= .seconds(1.5) }) ?? true
    else { updateEcho(); return }
    replyWatch = nil
    appliedConversationTag = nil
    requestConversationRefresh()
  }
  func cover(_ shown: Bool) { chatCovers = max(0, chatCovers + (shown ? 1 : -1)) }
  func viewing(_ botId: String?) {
    // The same chat starts again under an account that loaded since it opened.
    guard botId != viewingBotId || botId != nil && presenceScope != scope else { return }
    if let previous = viewingBotId { reportPresence(previous, "left") }
    viewingBotId = botId
    presenceBeat?.cancel()
    presenceScope = scope
    guard let botId else { return }
    Task { await NotificationController.shared.removeDelivered(bots: [botId]) }
    // The server forgets a device 45 seconds after its last beat.
    presenceBeat = Task { [weak self] in
      while !Task.isCancelled {
        self?.reportPresence(botId, "active")
        try? await Task.sleep(for: .seconds(15))
      }
    }
  }
  /// The next chat can appear before this one disappears, so only the chat still on screen stops.
  func leave(_ botId: String) {
    if viewingBotId == botId { viewing(nil) }
  }
  /// The account changed: presence started for the last one ends without another word. The server records
  /// a presence report as a read for whoever sends it, so none goes out for the next account until its
  /// own chat appears.
  func endPresence() {
    presenceBeat?.cancel()
    presenceBeat = nil
    viewingBotId = nil
    presenceScope = nil
  }
  /// Reports for the account the chat was opened under only. A report already queued holds the client it
  /// was queued with, which a later sign-in retires.
  private func reportPresence(_ botId: String, _ state: String) {
    guard let api, !sessionExpired, let presenceScope, presenceScope == scope else { return }
    let report = ChatPresenceReport(client: NotificationController.shared.deviceId, state: state)
    // Presence is a hint, so a failed report stays quiet, as on the web. One goes at a time, so
    // leaving one chat can never land after arriving in the next.
    let previous = presenceReports
    presenceReports = Task {
      await previous?.value
      let _: EmptyResponse? = try? await api.write("/bots/\(APIClient.component(botId))/presence", report, method: "PUT")
    }
  }
  /// Where the person has read to in `botId`'s chat, with the client it was read under. Nil unless that chat is
  /// the one open now, so a message and a client from two accounts, or two chats, never meet in one place.
  func readPlace(_ messageId: String, in botId: String) -> ReadPlace? {
    guard let api, selectedBotId == botId, conversation?.botId == botId else { return nil }
    return ReadPlace(messageId: messageId, botId: botId, client: api)
  }
  /// Saves a place in its own chat, through its own client, whatever is open or signed in by now. The task ends
  /// once the position was saved or refused.
  @discardableResult func markRead(_ place: ReadPlace) -> Task<Void, Never> {
    // A reading position is a hint, so a failed save stays quiet, as on the web.
    Task {
      let _: ReadPosition? = try? await place.client.write(
        "/bots/\(APIClient.component(place.botId))/read-position", ReadPosition(messageId: place.messageId), method: "PUT")
    }
  }
  /// `markRead` once the reader pauses. Cancelling it while it waits saves nothing.
  func markReadSoon(_ place: ReadPlace) -> Task<Void, Never> {
    Task {
      try? await readPause(.milliseconds(350))
      guard !Task.isCancelled else { return }
      await markRead(place).value
    }
  }
}

/// How far a person read in one chat, and the sign-in they read it under.
struct ReadPlace {
  var messageId: String
  var botId: String
  var client: APIClient
}
