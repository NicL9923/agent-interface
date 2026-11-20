import SwiftUI

// When the screen shows a lost connection, as the web's `App.tsx` decides it with `useOutage`.
// What is lost is a fact at once (`connected`); what the app shows of it waits out a loss that may be
// a blip. Two outages are timed: the household's (the app, Hermes or the device's network) and the
// open chat's own failed reads, scoped to that chat while it is on screen.
extension AppStore {
  /// The household is lost: the device is offline, or the app or Hermes cannot be reached. A sign-in
  /// that ended has its own prompt, and before the first household read the launch screen speaks.
  var householdDown: Bool {
    bootstrap != nil && !sessionExpired && (deviceOffline || !householdConnected)
  }
  /// Nothing waits when there is nothing to wait out: a loss that needs a person, or Hermes never
  /// reached in this session once a household read has answered.
  var householdDownForCertain: Bool {
    (bootstrapAnswered && !everConnected)
      || (!deviceOffline && !appUnavailable && ConnectionCopy.needsSetup(bootstrap?.connection))
  }
  /// The household's loss or the open chat's is on screen, including the second it lingers.
  var connectionShown: Bool { appOutage.shown || chatOutage.shown }
  /// A loss is being timed and nothing shows it yet.
  var connectionPending: Bool { appOutage.pending || chatOutage.pending }

  func updateOutages() {
    let now = now()
    var app = appOutage, chat = chatOutage
    app.update(down: householdDown, definite: householdDownForCertain, at: now)
    app.advance(to: now)
    // The chat's own loss is timed only while that chat is on screen. Leaving it is not its end, and
    // coming back to it starts its grace period again.
    let onScreen = followedBotId
    chat.update(down: onScreen != nil && readFailedFor == onScreen, scope: onScreen ?? "", at: now)
    chat.advance(to: now)
    if app != appOutage { appOutage = app }
    if chat != chatOutage { chatOutage = chat }
    scheduleOutageTimer()
    announceConnection()
  }
  /// Wakes at the earlier of the two outages' next deadlines. A deadline already behind the clock
  /// is taken at once, not dropped.
  private func scheduleOutageTimer() {
    let next = [appOutage.deadline, chatOutage.deadline].compactMap { $0 }.min()
    guard next != outageDeadline || (next != nil && outageTimer == nil) else { return }
    outageTimer?.cancel()
    outageTimer = nil
    outageDeadline = next
    guard let next else { return }
    outageTimer = Task { [weak self] in
      try? await self?.outagePause(next)
      guard let self, !Task.isCancelled else { return }
      self.outageTimer = nil
      self.outageDeadline = nil
      self.updateActivity()
    }
  }
  /// Forgets both outages, as another account or a sign-out starts over.
  func resetOutages() {
    outageTimer?.cancel()
    outageTimer = nil
    outageDeadline = nil
    appOutage = Outage()
    chatOutage = Outage()
    connectionNews = ""
    announcedRecoveries = 0
    bootstrapAnswered = false
    everConnected = false
    staleRosterSince = nil
    readRetry?.cancel()
    readRetry = nil
    readFailures = 0
    readFailedFor = nil
  }

  /// Words or files show in the open chat's message box. Only then does the notice say the draft is kept.
  /// A message on its way shows in the transcript and leaves the box empty (`composerDraft`); files still
  /// uploading show in the tray beside it.
  var hasDraft: Bool {
    let shown = composerDraft
    return followedBotId != nil
      && (!shown.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !shown.attachments.isEmpty
        || uploads.items.contains { $0.botId == selectedBotId })
  }
  /// What the connection notice says now. The household's loss speaks for both while it is on
  /// screen; otherwise the notice is the open chat's.
  func connectionCopy(hasDraft: Bool) -> ConnectionCopy {
    let app = appOutage.shown
    return .of(connection: bootstrap?.connection, offline: deviceOffline, appUnavailable: appUnavailable,
      chatOnly: !app, lasting: app ? appOutage.lasting : chatOutage.lasting, hasDraft: hasDraft)
  }
  /// The connection notice above the composer shows. Not for a chat still showing its saved copy
  /// while home is live, which says so itself.
  var connectionCardShown: Bool {
    bootstrap != nil && connectionShown && !(offlineSavedAt != nil && householdConnected && !deviceOffline)
  }
  /// The open chat's error banner shows `error`. A failed poll is the connection notice's news: it waits
  /// out the grace period with the notice, and once the notice shows the error would only repeat it.
  /// VoiceOver hears only the errors this shows; `announceConnection` says the rest, once.
  var chatErrorShown: Bool {
    error != nil && (connectionError == nil || !(connectionCardShown || connectionPending))
  }
  /// What the banner shows: `error` while `chatErrorShown`. The chat announces each change of this, not
  /// of `error`, so an error that comes into view as the notice clears is heard though its text is the same.
  var chatErrorBanner: String? { chatErrorShown ? error : nil }
  /// Why Send and Stop are refused for the connection, for VoiceOver: a disabled button gives no
  /// reason on a touch screen. During the grace period the chat still looks connected, so the
  /// reason says it here; once the notice shows, it says more and this only names the wait.
  var connectionReason: String? {
    guard !connected, !sessionExpired, bootstrap != nil, !cachedChats.contains(selectedBotId ?? "") else { return nil }
    if !connectionShown { return Self.checkingConnection }
    return hasDraft ? Self.waitingWithDraft : Self.waitingForConnection
  }
  /// A write refused as it set out, because the connection it needs went down after it was asked for.
  func connectionRefused() -> ConnectionRefused {
    ConnectionRefused(errorDescription: connectionReason ?? Self.waitingForConnection)
  }
  static let checkingConnection = "Checking the connection. Try again in a moment."
  static let waitingForConnection = "Waiting for the connection."
  static let waitingWithDraft = "Waiting for the connection. Your draft is kept."

  /// Tells VoiceOver once when a loss shows, again when its words change, as when it lasts, and
  /// "Connected again." when a loss that was on screen ends. The web's live region; here one
  /// announcement per change. The news is held without the draft sentence, so typing the first
  /// word of a draft during one loss does not say it all again.
  private func announceConnection() {
    let spoken = bootstrap != nil && (appOutage.spoken || chatOutage.spoken)
    let news = spoken ? connectionCopy(hasDraft: false).spoken : ""
    let recoveries = appOutage.recoveries + chatOutage.recoveries
    let recovered = recoveries > announcedRecoveries
    announcedRecoveries = recoveries
    if news != connectionNews {
      connectionNews = news
      if spoken { announce(connectionCopy(hasDraft: hasDraft).spoken); return }
    }
    // A warning being said now takes the place of anything that came back.
    if recovered && !spoken { announce(Self.connectedAgain) }
  }
  static let connectedAgain = "Connected again."

  // MARK: Failed conversation reads

  /// A conversation read for `id` failed. It is retried after `ReadRetry.delay`, and the first
  /// failure in a row asks bootstrap what is down: while it finds Hermes connected, the loss is the
  /// chat's alone.
  func conversationReadFailed(_ id: String) {
    let first = readFailedFor != id
    readFailures = first ? 1 : readFailures + 1
    readFailedFor = id
    scheduleReadRetry(id)
    if first { Task { await self.refreshBootstrap() } }
  }
  /// Sets the failed chat's next read after the wait its failures so far have earned.
  func scheduleReadRetry(_ id: String) {
    let wait = ReadRetry.delay(after: readFailures)
    let selection = selectionGeneration
    readRetry?.cancel()
    readRetry = Task { [weak self] in
      try? await self?.readRetryPause(wait)
      guard let self, !Task.isCancelled else { return }
      self.readRetry = nil
      // Not while the app is away, the device offline or the sign-in gone; returning, coming back
      // online or opening the chat again reads anyway.
      guard selection == self.selectionGeneration, !self.suspended, !self.deviceOffline,
        self.api?.token != nil, !self.sessionExpired, self.followedBotId == id
      else { return }
      self.requestConversationRefresh()
    }
  }
  /// The open chat's reads are failing, so its retry decides when it is read next, with the waits of
  /// `ReadRetry`; the poll would read it every pass. Opening it, returning to the app, coming back online,
  /// pull to refresh and Reconnect now still read it at once.
  var chatReadWaits: Bool { readFailedFor != nil && readFailedFor == followedBotId }
  /// A conversation read succeeded, or the chat changed: the failures and their retry are over.
  func conversationReadsRecovered() {
    readRetry?.cancel()
    readRetry = nil
    readFailures = 0
    if readFailedFor != nil { readFailedFor = nil }
  }
}

/// A write refused as it set out, because the connection it needs is down. Its message is the reason
/// Send gives, never the write's own failure wording, since nothing was sent.
struct ConnectionRefused: LocalizedError { var errorDescription: String? }
