import AuthenticationServices
import ImageIO
import SwiftUI
import UniformTypeIdentifiers
import CryptoKit

/// The app's state. Views observe only the properties they read; bookkeeping no view reads is
/// `@ObservationIgnored`, so changing it renders nothing. Behavior lives in `AppStore+<Concern>.swift`
/// extensions; stored properties stay here because Swift keeps them in the class body.
@MainActor @Observable
final class AppStore: NSObject, ASWebAuthenticationPresentationContextProviding {
  var host = UserDefaults.standard.string(forKey: DeviceDefaults.host) ?? ""
  var api: APIClient? { didSet { updateScope() } }
  var bootstrap: Bootstrap? {
    didSet {
      updateScope(); appliedBootstrapTag = nil; publishWidgetSnapshot(); updateEcho(); scheduleAdditions()
      updateActivity(); noteRead([followedBotId])
    }
  }
  /// The signed-in account on this server, kept apart from `bootstrap` so views keyed by the
  /// account, such as every image in the transcript, render again only when it changes.
  private(set) var scope: String?
  /// The account on a server, as drafts, widgets and the Live Activity name it.
  nonisolated static func scope(server: URL, userId: String) -> String { Data((server.absoluteString + "|" + userId).utf8).base64URLEncoded }
  private func updateScope() {
    let next = bootstrap.flatMap { boot in api.map { Self.scope(server: $0.baseURL, userId: boot.user.id) } }
    guard next != scope else { return }
    scope = next
    // Another account's rooms never show.
    groupCatalog = nil
    accountUsage = nil
    accountUsageReadAt = nil
    // Only a loaded account replaces it; launching, before the account loads, leaves it alone.
    if let next { UserDefaults.standard.set(next, forKey: DeviceDefaults.signedInScope) }
    additions = savedAdditions()
  }
  /// The App Group snapshot widgets read. Tests point it elsewhere or turn it off.
  @ObservationIgnored var widgetSnapshotURL: URL? = WidgetSnapshotStore.defaultURL
  /// Assistants in Spotlight, kept in step with the snapshot. Unit tests leave the system index alone.
  @ObservationIgnored var spotlight: AssistantSpotlight? = ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] == nil ? .system : nil
  /// Assistant pictures for notifications in the App Group. Unit tests leave the App Group alone.
  @ObservationIgnored var senderAvatars: SenderAvatars? = ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] == nil ? SenderAvatars(root: NotificationSenders.root) : nil
  /// Text from Siri, a notification's Reply or the Share inbox waiting for its draft; see `DraftAdditions.swift`.
  var additions: [DraftAddition] = []
  @ObservationIgnored var earlyAdditions: [DraftAddition] = []
  @ObservationIgnored var additionsDrain: Task<Void, Never>?
  @ObservationIgnored var additionsAgain = false
  /// The latest haptic moment; see `Haptics.swift`.
  var haptic: HapticEvent?
  @ObservationIgnored var hapticCount = 0
  /// The latest hardware keyboard shortcut; see `KeyboardCommands.swift`.
  var keyboardCommand: KeyboardCommand?
  @ObservationIgnored var commandCount = 0
  /// Search should take the keyboard when it appears, as after Cmd+F from anywhere else.
  var searchFocusPending = false
  /// The approval each chat's person just declined, until their next message there is accepted. The
  /// transcript says the assistant stopped that step and the message box asks what to do instead.
  var declinedApprovals: [String: String] = [:]
  var conversation: Conversation? {
    didSet {
      appliedConversationTag = nil
      if conversation != oldValue {
        cachedArtifacts = nil; updateEcho(conversationChanged: true); updateActivity(); updateRetryChecks()
      }
    }
  }
  /// The ETags of the bootstrap and conversation bodies last applied. A poll answering with the
  /// same body skips decoding and applying it. Any other change to the value forgets its tag.
  @ObservationIgnored var appliedBootstrapTag: String?
  @ObservationIgnored var appliedConversationTag: String?
  /// The open conversation as shown: with the echo of a message still on its way at its end.
  private(set) var transcript: Conversation?
  /// The transcript grouped into turns, computed once per change instead of on every render.
  private(set) var turns: [ConversationTurn] = []
  /// Each reply's file chips and each revised email draft's changes, computed with the turns.
  internal(set) var replyFiles: [String: [Artifact]] = [:]
  private(set) var draftRevisions: [String: DraftRevision] = [:]
  /// The open assistant's sent messages, shown in the transcript at once while Send keeps spinning
  /// until Hermes answers, and each kept until Hermes's own copy arrives, as on the web.
  private(set) var echoes: [SentEcho] = []
  /// The person's accepted sends, kept in memory after their echo leaves; see `OwnSend`.
  @ObservationIgnored private(set) var ownSends: [OwnSend] = []
  /// The open conversation's no-sender rows that are the person's own sends, so only another member's
  /// reads as the household's; see `SentEcho.ownRows`.
  private(set) var ownRows: Set<String> = []
  @ObservationIgnored private var echoTimer: Task<Void, Never>?
  /// When the earliest accepted echo whose run never showed runs out of patience.
  @ObservationIgnored private var echoDeadline: Date?
  var selectedBotId: String? {
    didSet { cachedArtifacts = nil; updateActivity(); followChanged(from: followed(oldValue)) }
  }
  var routineResult: RoutineResultDestination?
  var todayRequest: UUID?
  /// A voice message to start in this assistant's chat, from the Talk to assistant control.
  var listenRequest: ListenRequest?
  /// The assistants the current Focus lets through; see `FocusFilter.swift`.
  var focus = FocusChoice.saved()
  var draft = Draft()
  var draftReady = false { didSet { if draftReady && !oldValue { scheduleAdditions() } } }
  /// Unconfirmed sends, one per assistant, as the web keeps one per assistant.
  var pendings: [String: PendingSubmission] = [:] { didSet { updateEcho(); scheduleAdditions() } }
  /// The open assistant's unconfirmed send. Setting one files it under its own assistant.
  var pending: PendingSubmission? {
    get { selectedBotId.flatMap { pendings[$0] } }
    set {
      if let newValue { pendings[newValue.botId] = newValue } else if let id = selectedBotId { pendings[id] = nil }
    }
  }
  /// The latest submission receipt per assistant.
  var receipts: [String: Receipt] = [:] { didSet { updateEcho() } }
  var receipt: Receipt? {
    get { selectedBotId.flatMap { receipts[$0] } }
    set { if let id = selectedBotId { receipts[id] = newValue } }
  }
  var error: String? { didSet { if connectionError != nil { connectionError = nil } } }
  /// Which poll the current `error` came from, or nil for a failed action such as a send. A later
  /// successful read of the same kind clears it, and a chat leaves it to its connection card.
  private(set) var connectionError: PollRead?
  enum PollRead: Equatable, Sendable { case roster, chat, submissions }
  /// Poll errors dismissed during an outage stay dismissed until their own read works again.
  @ObservationIgnored var dismissedPolls: Set<PollRead> = []
  /// A short message for home, such as an assistant that is no longer available.
  var notice: String?
  /// The assistant this person just lost access to, so views showing it close.
  var leftBotId: String?
  /// Set before deleting, so the deleted assistant leaves without a message.
  @ObservationIgnored var deletedBotId: String?
  /// After leaving an assistant, home stays open instead of choosing another one.
  @ObservationIgnored var stayHome = false
  var signingIn = false
  var loading = false
  var sendingRequests: [String: String] = [:] { didSet { updateEcho() } }
  var sending: Bool { selectedBotId.map { sendingRequests[$0] != nil } ?? false }
  /// Files on their way into drafts; see `AttachmentUploads.swift`.
  let uploads = AttachmentUploads()
  /// The household's Hermes update; see `HermesUpgrade.swift`.
  let upgrade = HermesUpgrade()
  override init() {
    super.init()
    uploads.store = self
    upgrade.store = self
  }
  var appUnavailable = false { didSet { updateActivity() } }
  var interruptionReviewed = false
  var authConfig: AuthConfig?
  var restoring = false
  var sessionExpired = false { didSet { updateActivity() } }
  /// When this device last asked to renew its sign-in, so a failing renewal retries hourly.
  @ObservationIgnored var renewalAttemptedAt: Date?
  /// The wall clock sign-in expiry is measured on. Tests substitute one they set by hand.
  @ObservationIgnored var date: () -> Date = { Date() }
  var conversationRequest: UUID?
  var homeRequest: UUID?
  /// The household's group chats, which home lists beside the assistants. Nil until the first read for this account.
  var groupCatalog: GroupCatalog?
  /// The provider accounts' limits and credits, read for the profile menu and the Usage sheet. Nil until the first read for this account.
  var accountUsage: UsageOverview?
  /// Bumped by every reset, so a read that started before one never replaces the account it changed.
  @ObservationIgnored var accountUsageGeneration = 0
  /// When `accountUsage` was last read, for refreshing it once it is a minute old.
  @ObservationIgnored var accountUsageReadAt: Date?
  /// The account scope whose household stream has sent a `groups` notice: that server pushes catalog changes.
  var groupNoticeScope: String?
  @ObservationIgnored var groupLoadId = UUID()
  var preferencesSaving = false
  var preferencesSaveFailed = false
  var preferencesDraft: Preferences?
  @ObservationIgnored var preferencesFailureMessage: String?
  @ObservationIgnored var queuedPreferences: Preferences?
  /// This device's notification switch and onboarding card for the signed-in account.
  var deviceNotifications = DeviceNotificationState()
  var openedFile: PreviewFile?
  /// The shared desktop's availability for the Settings row. Nil until the first read.
  var computerStatus: ComputerStatus?
  /// The computer screen the transcript asked for: Watch on the live row, or Take over on a handoff.
  var openComputer: ComputerOpening?
  /// The terminal screen the transcript asked for: Open terminal on an assistant's terminal request.
  var openTerminal: TerminalOpening?
  /// A confirm-it's-you sign-in is on screen, so a second one does not start.
  @ObservationIgnored var confirmingIdentity = false
  /// Builds the client for a server address. Tests substitute a client with a mock transport.
  @ObservationIgnored var makeClient: (URL) -> APIClient = { APIClient(baseURL: $0) }
  @ObservationIgnored var authSession: ASWebAuthenticationSession?
  @ObservationIgnored var pollTask: Task<Void, Never>?
  /// Latest live reply patch, retained across overlapping conversation reads. A read applied with
  /// a patch since dropped must apply again, even if the server's body is unchanged.
  @ObservationIgnored var latestInflight: Inflight? { didSet { appliedConversationTag = nil } }
  /// Household roster stream, independent of the selected conversation.
  @ObservationIgnored var rosterTask: Task<Void, Never>?
  /// The open conversation's change stream and when it last spoke.
  @ObservationIgnored var eventTask: Task<Void, Never>?
  @ObservationIgnored var eventBotId: String?
  @ObservationIgnored var streamHeardAt: ContinuousClock.Instant?
  @ObservationIgnored var conversationRefreshedAt: ContinuousClock.Instant?
  /// Conversation reads started and not yet finished; tests wait for none before moving time.
  @ObservationIgnored var conversationReadsInFlight = 0
  @ObservationIgnored var conversationRefreshing = false
  /// Conversation reads overlap: polls, change notices, selection and pull to refresh each start
  /// one. A response older than one already applied is dropped, so it cannot undo newer state.
  @ObservationIgnored var conversationReads = 0
  @ObservationIgnored var appliedConversationRead = 0
  /// Replies already accounted for in the open conversation. As in the web's conversation hook,
  /// the first successful read after opening is the baseline, even when it matches the cache.
  @ObservationIgnored var replyWatch: ReplyWatch?
  @ObservationIgnored private var announcements = 0
  /// The latest settled reply for VoiceOver, numbered so a repeat of the same words is read again.
  private(set) var replyAnnouncement: ReplyAnnouncement?
  @ObservationIgnored var conversationRefreshAgain = false
  /// While the stream is live, change notices drive updates and this slow poll covers a stream
  /// that fails unnoticed, as on the web. Server pings arrive every 25 seconds.
  static let streamFallbackInterval: Duration = .seconds(30)
  static let streamSilence: Duration = .seconds(60)
  @ObservationIgnored var draftTask: Task<Void, Never>?
  /// Set while an edit waits for its save, so leaving can send it now instead of dropping it.
  @ObservationIgnored var scheduledDraftSave: UUID?
  @ObservationIgnored var draftBackgroundTask = UIBackgroundTaskIdentifier.invalid
  @ObservationIgnored var conversationCache: [String: Conversation] = [:]
  @ObservationIgnored var offlineLibraryRoot = OfflineLibrary.root
  var offlineSavedAt: Date?
  @ObservationIgnored var restoredRosterAt: Date?
  let offlineWriter = OfflineLibraryWriter()
  /// How long a changed offline snapshot waits before it is written; tests shorten it.
  var offlineWriteDelay: Duration {
    get { offlineWriter.delay }
    set { offlineWriter.delay = newValue }
  }
  @ObservationIgnored var conversationCapturedAt: [String: Date] = [:]
  @ObservationIgnored var recentChats: [String] = []
  var cachedChats: Set<String> = [] { didSet { updateActivity() } }
  @ObservationIgnored var generation = UUID()
  @ObservationIgnored var selectionGeneration = UUID()
  @ObservationIgnored var fileTask: Task<Void, Never>?
  @ObservationIgnored var failures = 0
  /// Turns of history one request covers, the same page the web client uses.
  static let historyPageTurns = 20
  /// How long bootstrap may go unrefreshed while the connection is healthy. Actions that change
  /// it, a foreground return and pull to refresh all refresh it sooner.
  static let bootstrapInterval: Duration = .seconds(45)
  /// Tests substitute a clock they advance by hand.
  @ObservationIgnored var now: () -> ContinuousClock.Instant = { .now }
  /// The wait before reconnecting after repeated refused growth notices. A production timer;
  /// tests substitute one they control, so no test waits real seconds for the backoff.
  @ObservationIgnored var resyncPause: (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
  @ObservationIgnored var bootstrapRefreshedAt: ContinuousClock.Instant?
  @ObservationIgnored var bootstrapReads = 0
  @ObservationIgnored var appliedBootstrapRead = 0
  /// Oldest loaded message per assistant. Polls ask for everything from there on, so the window
  /// grows with new turns instead of sliding past the turn being read, as on the web.
  @ObservationIgnored var historyStarts: [String: String] = [:]
  /// Bumped when earlier history is added, so a poll that asked for the narrower window earlier
  /// cannot replace it when its response arrives late.
  @ObservationIgnored var windowGeneration = 0
  /// Files from before the loaded window, fetched when the file list is opened. They are good
  /// while the message they were fetched before is still loaded, as on the web.
  var earlierFileCache: [String: EarlierFilePage] = [:] { didSet { cachedArtifacts = nil; refreshReplyFiles() } }
  struct EarlierFilePage {
    var sessionId: String?
    var before: String?
    var messages: [EarlierFiles.Entry]
  }
  var loadingEarlierFiles = false
  /// The bot and session whose earlier files failed to load, shown as a notice in the file list
  /// instead of an error banner. Opening the list again retries, as on the web.
  var earlierFilesFailure: String?
  var loadingEarlier = false
  var bot: Bot? { bootstrap?.bots.first { $0.id == selectedBotId } }
  var connected: Bool {
    bootstrap?.connection.connected == true && !appUnavailable && !sessionExpired
      && !cachedChats.contains(selectedBotId ?? "")
  }
  /// The open assistant's activity as shown. Stored, so a streamed reply patch that leaves it
  /// unchanged renders nothing that reads it, such as the composer and the iPad home rows.
  private(set) var activity: ActivityState = .disconnected
  private func updateActivity() {
    let next = connected ? conversation?.activity.state ?? bot?.activity ?? .idle : .disconnected
    if next != activity { activity = next }
  }
  var active: Bool { activity.active }
  /// Chats read on this device since the roster last said otherwise; see `UnreadChats`.
  private(set) var readHere = UnreadChats()
  /// Whether home shows this assistant's chat as unread. The chat on screen never is.
  func unread(_ bot: Bot) -> Bool { readHere.unread(bot, open: followedBotId) }
  /// The chat on screen, and one just left, count as read here until their latest message changes.
  func noteRead(_ ids: [String?]) {
    var next = readHere
    next.keep(bootstrap?.bots ?? [], user: bootstrap?.user.id)
    for case let id? in ids { if let bot = bootstrap?.bots.first(where: { $0.id == id }) { next.read(bot) } }
    if next != readHere { readHere = next }
  }
  var canSend: Bool {
    draftReady && connected && !sending && !uploads.uploading && !uploads.items.contains { $0.botId == selectedBotId } && pending == nil
      && draft.text.utf16.count <= Self.maxMessageLength
      && (!draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        || !draft.attachments.isEmpty)
      && supports(active ? .steering : .chat)
      && (activity != .interrupted || interruptionReviewed)
  }
  /// The server's limit, counted in UTF-16 code units as JavaScript counts string length.
  nonisolated static let maxMessageLength = 50_000
  func supports(_ key: CapabilityKey) -> Bool { bootstrap?[capability: key]?.supported == true }
  func reason(_ key: CapabilityKey) -> String {
    bootstrap?[capability: key]?.reason
      ?? "This capability is unavailable from the connected Hermes installation."
  }
  /// What the app keeps in UserDefaults per scope, optionally per assistant. `DeviceDefaults` holds
  /// the keys that outlive a scope.
  enum StorageKind: String {
    case draft, draftAdditions, sharedTextReceipts, pending, recovered, selected, notifications, notificationPrompt, goalResume, formReply
  }
  func key(_ kind: StorageKind, _ bot: String? = nil) -> String? {
    scope.map { "native.\($0).\(kind.rawValue)\(bot.map { ".\($0)" } ?? "")" }
  }
  func read<T: Decodable>(_ key: String?) -> T? {
    guard let key, let data = UserDefaults.standard.data(forKey: key) else { return nil }
    return try? JSONDecoder().decode(T.self, from: data)
  }
  func save<T: Encodable>(_ value: T?, _ key: String?) {
    guard let key else { return }
    if let value, let data = try? JSONEncoder().encode(value) {
      UserDefaults.standard.set(data, forKey: key)
    } else {
      UserDefaults.standard.removeObject(forKey: key)
    }
  }

  // MARK: State owned by the concern extensions
  // Internal rather than private only because an extension in another file reads and writes it.
  // Views change store state through its methods, never by assigning these.

  @ObservationIgnored var prefetchTask: Task<Void, Never>?
  @ObservationIgnored var prefetchRun: UUID?
  @ObservationIgnored var prefetchAgain = false
  /// When each chat was last read, by opening, polling or reading ahead.
  @ObservationIgnored var chatReadAt: [String: ContinuousClock.Instant] = [:]
  @ObservationIgnored var suspended = false
  @ObservationIgnored var cachedArtifacts: [Artifact]?
  /// Saves in flight per cached draft. A copy is not marked saved while an older save may land.
  /// The edit sequences of the saves in flight, per cached draft.
  @ObservationIgnored var draftSavesInFlight: [String: [Int]] = [:]
  /// Consecutive failed saves per cached draft, for the retry backoff: 1 s, 2 s, 4 s, up to 30 s.
  @ObservationIgnored var draftSaveFailures: [String: Int] = [:]
  /// When a failed draft may retry. Until then only a new edit saves it, not a poll.
  @ObservationIgnored var draftRetryAt: [String: ContinuousClock.Instant] = [:]
  /// The last edit sequence per cached draft, for the life of the store. A copy adopted from the
  /// server forgets its own, so a new edit never reuses one an older save in flight carries.
  @ObservationIgnored var draftSeqs: [String: Int] = [:]
  @ObservationIgnored var draftPersistTask: Task<Void, Never>?
  @ObservationIgnored var submissionChecks: [String: (count: Int, next: ContinuousClock.Instant)] = [:]
  var retryAttempt: RetryAttempt? { didSet { updateRetryChecks() } }
  @ObservationIgnored var retryChecks: Task<Void, Never>?
  @ObservationIgnored var retryCheckKey: String?
  /// Receipt checks for an unconfirmed retry: at once, then after 2 seconds, doubling to every 30.
  /// Tests shorten them.
  @ObservationIgnored var retryCheckDelays: (first: Duration, slowest: Duration) = (.seconds(2), .seconds(30))
  /// Set by `openConversation(botId:atMessage:)`; the conversation clears it once shown.
  var focusedMessage: MessageFocus?
  /// Asks the open conversation to scroll to its first pending question, secure request or approval,
  /// as the composer's status dock does.
  var attentionScrollRequest: UUID?
  @ObservationIgnored var openRequests = 0
  /// Counts selections, so an open-at bound to one notices any other.
  @ObservationIgnored var selections = 0
  @ObservationIgnored var requestedWindow: (botId: String, start: String, previous: String?, selection: Int, account: String?)?
  /// Conversation views on screen per assistant, counted because the next can appear before the
  /// last one disappears.
  var conversationScreens: [String: Int] = [:]
  /// The assistant `select` is opening; its own read makes the view's arrival need none.
  @ObservationIgnored var openingBotId: String?
  /// The chat on screen while the app is active. Reporting it keeps this person's other devices
  /// quiet about it and marks it read there, as the web does.
  @ObservationIgnored var viewingBotId: String?
  @ObservationIgnored var presenceBeat: Task<Void, Never>?
  @ObservationIgnored var presenceReports: Task<Void, Never>?
  /// Sheets over the chat, such as settings or files. A covered chat is not being read, as on the web.
  var chatCovers = 0
  @ObservationIgnored var computerEpoch = 0
  /// The native desktop screen's exit cleanup still on its way. Sign-out waits for it, up to
  /// `desktopCleanupWait`, before revoking the session the cleanup's release needs.
  @ObservationIgnored var desktopCleanup: Task<Void, Never>?
  @ObservationIgnored var desktopCleanupWait: Duration = .seconds(5)
  /// Set while sign-out waits for that cleanup.
  @ObservationIgnored var awaitingDesktopCleanup = false
  @ObservationIgnored var computerWrites = 0

  // MARK: Derived presentation state

  /// Follows the open assistant's submissions and keeps each echo until Hermes's copy replaces it.
  /// Every input it reads calls it when it changes.
  func updateEcho(conversationChanged: Bool = false) {
    let now = Date()
    // Only a conversation on screen is kept current, so only it can retire an echo or anchor one.
    let current = followedBotId == nil ? nil : conversation
    let sender = bootstrap.map { Sender(id: $0.user.id, name: $0.user.name) }
    let next = SentEcho.nextEchoes(
      echoes, pending: pending, receipt: receipt, sending: sending, conversation: current, sender: sender, now: now)
    // A send is kept from its echo's last step, so it is worked out before the echoes change.
    let sends = SentEcho.nextSends(ownSends, before: echoes, after: next, receipt: receipt, sender: sender, conversation: current)
    if sends != ownSends { ownSends = sends }
    let rows = SentEcho.ownRows(sends, in: conversation)
    if rows != ownRows { ownRows = rows }
    let changed = next != echoes
    if changed { echoes = next }
    if changed || conversationChanged {
      transcript = SentEcho.transcript(conversation, echoes)
      turns = transcript?.presentationTurns ?? []
      refreshReplyFiles()
      draftRevisions = DraftDiff.revisions(transcript?.messages ?? [])
    }
    // An accepted message that never shows is checked again once its patience runs out. Only the
    // open conversation can retire one, so another assistant's echo waits for its return.
    let deadline = next.filter { $0.status == .accepted && !$0.ran && $0.request.botId == current?.botId }
      .compactMap { $0.acceptedAt?.addingTimeInterval(SentEcho.patience + 0.1) }.min()
    guard deadline != echoDeadline else { return }
    echoTimer?.cancel()
    echoDeadline = deadline
    echoTimer = deadline.map { deadline in
      Task { [weak self] in
        try? await Task.sleep(for: .seconds(max(0, deadline.timeIntervalSince(now))))
        guard !Task.isCancelled else { return }
        self?.echoDeadline = nil
        self?.updateEcho()
      }
    }
  }
  func hearReplies(in value: Conversation, botId id: String) {
    let (next, reply) = ReplyWatch.next(replyWatch ?? ReplyWatch(), value, baseline: replyWatch == nil)
    replyWatch = next
    guard let reply else { return }
    announcements += 1
    replyAnnouncement = ReplyAnnouncement(id: announcements, botId: id, text: ReplyWatch.snippet(reply.text))
    if viewingBotId == id { buzz(.replied) }
  }

  // MARK: Writes and errors

  func perform<V: Encodable>(_ path: String, _ value: V, method: String = "POST") async throws {
    guard let api else { throw APIError(message: "Connect to an app server first.", status: 0) }
    let currentGeneration = generation
    do {
      let _: EmptyResponse = try await api.write(path, value, method: method)
      guard currentGeneration == generation else { throw CancellationError() }
    } catch {
      guard currentGeneration == generation else { throw CancellationError() }
      throw error
    }
  }
  /// A failed poll. One the person dismissed, or the same failure again, leaves the banner as it is.
  func reportPoll(_ failure: Error, _ read: PollRead) {
    if failure is CancellationError { return }
    let expired = (failure as? APIError)?.isSessionExpired ?? false
    if !expired, dismissedPolls.contains(read) || connectionError == read && error == failure.localizedDescription { return }
    report(failure)
    if error != nil, !sessionExpired { connectionError = read }
  }
  func pollSucceeded(_ read: PollRead) {
    dismissedPolls.remove(read)
    if connectionError == read { error = nil }
  }
  /// The error banner's close button. A poll error stays closed until its read works again.
  func dismissError() {
    if let connectionError { dismissedPolls.insert(connectionError) }
    error = nil
  }
  func report(_ error: Error) {
    if error is CancellationError { return }
    self.error = error.localizedDescription
    if let apiError = error as? APIError, apiError.isSessionExpired {
      clearOfflineLibrary()
      if let api { try? SecureToken.save(nil, host: api.baseURL.absoluteString) }
      api?.token = nil
      stopPolling()
      sessionExpired = true
    }
  }
}
/// Resumes a continuation exactly once, for whichever of several racing waits finishes first.
@MainActor final class ResumeOnce {
  private var continuation: CheckedContinuation<Void, Never>?
  init(_ continuation: CheckedContinuation<Void, Never>) { self.continuation = continuation }
  func resume() {
    continuation?.resume()
    continuation = nil
  }
}
struct PreviewFile: Identifiable {
  let id = UUID()
  var url: URL
}
/// A reply for VoiceOver to read, worded as the web's status region.
struct ReplyAnnouncement: Equatable {
  var id: Int
  var botId: String
  var text: String
}
