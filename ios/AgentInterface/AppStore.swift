import AuthenticationServices
import ImageIO
import SwiftUI
import UniformTypeIdentifiers
import CryptoKit

/// The app's state. Views observe only the properties they read; bookkeeping no view reads is
/// `@ObservationIgnored`, so changing it renders nothing.
@MainActor @Observable
final class AppStore: NSObject, ASWebAuthenticationPresentationContextProviding {
  var host = UserDefaults.standard.string(forKey: DeviceDefaults.host) ?? ""
  var api: APIClient? { didSet { updateScope() } }
  var bootstrap: Bootstrap? {
    didSet { updateScope(); appliedBootstrapTag = nil; publishWidgetSnapshot(); updateEcho(); scheduleAdditions() }
  }
  /// The signed-in account on this server, kept apart from `bootstrap` so views keyed by the
  /// account, such as every image in the transcript, render again only when it changes.
  private(set) var scope: String?
  private func updateScope() {
    let next = bootstrap.flatMap { boot in api.map { Data(($0.baseURL.absoluteString + "|" + boot.user.id).utf8).base64URLEncoded } }
    guard next != scope else { return }
    scope = next
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
  var conversation: Conversation? {
    didSet {
      appliedConversationTag = nil
      if conversation != oldValue { cachedArtifacts = nil; updateEcho(conversationChanged: true) }
    }
  }
  /// The ETags of the bootstrap and conversation bodies last applied. A poll answering with the
  /// same body skips decoding and applying it. Any other change to the value forgets its tag.
  @ObservationIgnored private var appliedBootstrapTag: String?
  @ObservationIgnored private var appliedConversationTag: String?
  /// The open conversation as shown: with the echo of a message still on its way at its end.
  private(set) var transcript: Conversation?
  /// The transcript grouped into turns, computed once per change instead of on every render.
  private(set) var turns: [ConversationTurn] = []
  /// The open assistant's sent messages, shown in the transcript at once while Send keeps spinning
  /// until Hermes answers, and each kept until Hermes's own copy arrives, as on the web.
  private(set) var echoes: [SentEcho] = []
  @ObservationIgnored private var echoTimer: Task<Void, Never>?
  /// When the earliest accepted echo whose run never showed runs out of patience.
  @ObservationIgnored private var echoDeadline: Date?
  var selectedBotId: String? {
    didSet { cachedArtifacts = nil; followChanged(from: followed(oldValue)) }
  }
  var routineResult: RoutineResultDestination?
  var todayRequest: UUID?
  /// A voice message to start in this assistant's chat, from the Talk to assistant control.
  var listenRequest: ListenRequest?
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
  var error: String?
  /// A short message for home, such as an assistant that is no longer available.
  var notice: String?
  /// The assistant this person just lost access to, so views showing it close.
  var leftBotId: String?
  /// Set before deleting, so the deleted assistant leaves without a message.
  @ObservationIgnored var deletedBotId: String?
  /// After leaving an assistant, home stays open instead of choosing another one.
  @ObservationIgnored private var stayHome = false
  var signingIn = false
  var loading = false
  var sending = false { didSet { updateEcho() } }
  /// Files on their way into drafts; see `AttachmentUploads.swift`.
  let uploads = AttachmentUploads()
  /// The household's Hermes update; see `HermesUpgrade.swift`.
  let upgrade = HermesUpgrade()
  override init() {
    super.init()
    uploads.store = self
    upgrade.store = self
  }
  var appUnavailable = false
  var interruptionReviewed = false
  var authConfig: AuthConfig?
  var restoring = false
  var sessionExpired = false
  var conversationRequest: UUID?
  var preferencesSaving = false
  var preferencesSaveFailed = false
  var preferencesDraft: Preferences?
  @ObservationIgnored private var preferencesFailureMessage: String?
  @ObservationIgnored private var queuedPreferences: Preferences?
  /// This device's notification switch and onboarding card for the signed-in account.
  var deviceNotifications = DeviceNotificationState()
  var openedFile: PreviewFile?
  /// The shared desktop's availability for the Settings row. Nil until the first read.
  var computerStatus: ComputerStatus?
  /// Builds the client for a server address. Tests substitute a client with a mock transport.
  @ObservationIgnored var makeClient: (URL) -> APIClient = { APIClient(baseURL: $0) }
  @ObservationIgnored private var authSession: ASWebAuthenticationSession?
  @ObservationIgnored private var pollTask: Task<Void, Never>?
  /// Latest live reply patch, retained across overlapping conversation reads. A read applied with
  /// a patch since dropped must apply again, even if the server's body is unchanged.
  @ObservationIgnored private var latestInflight: Inflight? { didSet { appliedConversationTag = nil } }
  /// Household roster stream, independent of the selected conversation.
  @ObservationIgnored private var rosterTask: Task<Void, Never>?
  /// The open conversation's change stream and when it last spoke.
  @ObservationIgnored private var eventTask: Task<Void, Never>?
  @ObservationIgnored private var eventBotId: String?
  @ObservationIgnored private var streamHeardAt: ContinuousClock.Instant?
  @ObservationIgnored private(set) var conversationRefreshedAt: ContinuousClock.Instant?
  /// Conversation reads started and not yet finished; tests wait for none before moving time.
  @ObservationIgnored private(set) var conversationReadsInFlight = 0
  @ObservationIgnored private var conversationRefreshing = false
  /// Conversation reads overlap: polls, change notices, selection and pull to refresh each start
  /// one. A response older than one already applied is dropped, so it cannot undo newer state.
  @ObservationIgnored private var conversationReads = 0
  @ObservationIgnored private var appliedConversationRead = 0
  /// Replies already accounted for in the open conversation. As in the web's conversation hook,
  /// the first successful read after opening is the baseline, even when it matches the cache.
  @ObservationIgnored private var replyWatch: ReplyWatch?
  @ObservationIgnored private var announcements = 0
  /// The latest settled reply for VoiceOver, numbered so a repeat of the same words is read again.
  private(set) var replyAnnouncement: ReplyAnnouncement?
  @ObservationIgnored private var conversationRefreshAgain = false
  /// While the stream is live, change notices drive updates and this slow poll covers a stream
  /// that fails unnoticed, as on the web. Server pings arrive every 25 seconds.
  static let streamFallbackInterval: Duration = .seconds(30)
  static let streamSilence: Duration = .seconds(60)
  @ObservationIgnored private var draftTask: Task<Void, Never>?
  /// Set while an edit waits for its save, so leaving can send it now instead of dropping it.
  @ObservationIgnored private var scheduledDraftSave: UUID?
  @ObservationIgnored private var draftBackgroundTask = UIBackgroundTaskIdentifier.invalid
  @ObservationIgnored private var conversationCache: [String: Conversation] = [:]
  @ObservationIgnored var offlineLibraryRoot = OfflineLibrary.root
  private(set) var offlineSavedAt: Date?
  @ObservationIgnored private var restoredRosterAt: Date?
  private let offlineWriter = OfflineLibraryWriter()
  /// How long a changed offline snapshot waits before it is written; tests shorten it.
  var offlineWriteDelay: Duration {
    get { offlineWriter.delay }
    set { offlineWriter.delay = newValue }
  }
  @ObservationIgnored private var conversationCapturedAt: [String: Date] = [:]
  @ObservationIgnored private var recentChats: [String] = []
  private(set) var cachedChats: Set<String> = []
  private var offlineURL: URL? {
    guard let api, let token = api.token else { return nil }
    return OfflineLibrary.url(origin: api.baseURL.absoluteString, token: token, root: offlineLibraryRoot)
  }
  private func saveOfflineLibrary(immediately: Bool = false) {
    guard !sessionExpired, offlineSavedAt == nil, let bootstrap, let url = offlineURL else { return }
    let allowed = Set(bootstrap.bots.map(\.id))
    let ids = Array(recentChats.filter { allowed.contains($0) }.suffix(OfflineLibrary.maximumChats))
    let chats = conversationCache.filter { ids.contains($0.key) }
    let snapshot = OfflineLibrary(savedAt: Date(), bootstrap: bootstrap, conversations: chats,
      selected: selectedBotId, capturedAt: conversationCapturedAt)
    offlineWriter.replace(snapshot, at: url, immediately: immediately)
  }
  private func clearOfflineLibrary(includingVoice: Bool = true) {
    if let url = offlineURL { offlineWriter.remove(at: url, includingVoice: includingVoice) }
    MarkdownCache.shared.clear()
    ReplyCards.clearCache()
    offlineSavedAt = nil
    restoredRosterAt = nil
  }
  func voiceRecordingURL(botId: String) -> URL? {
    guard !sessionExpired, bootstrap?.bots.contains(where: { $0.id == botId }) == true else { return nil }
    let name = SHA256.hash(data: Data(botId.utf8)).map { String(format: "%02x", $0) }.joined()
    return offlineURL.map { $0.deletingPathExtension().appendingPathExtension(name + ".m4a") }
  }
  @ObservationIgnored private(set) var generation = UUID()
  @ObservationIgnored private var selectionGeneration = UUID()
  @ObservationIgnored private var fileTask: Task<Void, Never>?
  @ObservationIgnored private var failures = 0
  /// Turns of history one request covers, the same page the web client uses.
  static let historyPageTurns = 20
  /// How long bootstrap may go unrefreshed while the connection is healthy. Actions that change
  /// it, a foreground return and pull to refresh all refresh it sooner.
  static let bootstrapInterval: Duration = .seconds(45)
  /// Tests substitute a clock they advance by hand.
  @ObservationIgnored var now: () -> ContinuousClock.Instant = { .now }
  @ObservationIgnored private var bootstrapRefreshedAt: ContinuousClock.Instant?
  @ObservationIgnored private var bootstrapReads = 0
  @ObservationIgnored private var appliedBootstrapRead = 0
  /// Oldest loaded message per assistant. Polls ask for everything from there on, so the window
  /// grows with new turns instead of sliding past the turn being read, as on the web.
  @ObservationIgnored private var historyStarts: [String: String] = [:]
  /// Bumped when earlier history is added, so a poll that asked for the narrower window earlier
  /// cannot replace it when its response arrives late.
  @ObservationIgnored private var windowGeneration = 0
  /// Files from before the loaded window, fetched when the file list is opened. They are good
  /// while the message they were fetched before is still loaded, as on the web.
  private(set) var earlierFileCache: [String: EarlierFilePage] = [:] { didSet { cachedArtifacts = nil } }
  struct EarlierFilePage {
    var sessionId: String?
    var before: String?
    var messages: [EarlierFiles.Entry]
  }
  var loadingEarlierFiles = false
  /// The bot and session whose earlier files failed to load, shown as a notice in the file list
  /// instead of an error banner. Opening the list again retries, as on the web.
  private(set) var earlierFilesFailure: String?
  var loadingEarlier = false
  var bot: Bot? { bootstrap?.bots.first { $0.id == selectedBotId } }
  var connected: Bool {
    bootstrap?.connection.connected == true && !appUnavailable && !sessionExpired
      && !cachedChats.contains(selectedBotId ?? "")
  }
  var activity: ActivityState {
    connected ? conversation?.activity.state ?? bot?.activity ?? .idle : .disconnected
  }
  var active: Bool { activity.active }
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
    case draft, draftAdditions, pending, recovered, selected, notifications, notificationPrompt, goalResume
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

  /// Reopens the saved server. A stored sign-in goes straight to bootstrap, because
  /// `/auth/config` only matters for signing in and an outage there must not strand the person.
  func restore() async {
    guard !host.isEmpty, !restoring else { return }
    restoring = true
    defer { restoring = false }
    do {
      if api == nil { api = makeClient(try ConnectionAddress.parse(host)) }
      error = nil
      if api?.token != nil {
        if bootstrap == nil, let api, let url = offlineURL,
          let snapshot = OfflineLibrary.read(url),
          let expiry = UserDefaults.standard.string(forKey: DeviceDefaults.expiry(api.baseURL)),
          let expires = ServerDate.parse(expiry), expires > Date() {
          bootstrap = snapshot.bootstrap
          // Sends still unsettled come back before any draft is ready, so nothing joins a sent copy.
          loadPendings(snapshot.bootstrap.bots)
          conversationCache = snapshot.conversations
          conversationCapturedAt = snapshot.capturedAt
          cachedChats = Set(snapshot.conversations.keys)
          recentChats = Array(snapshot.conversations.keys.sorted())
          restoredRosterAt = snapshot.savedAt
          offlineSavedAt = snapshot.selected.flatMap { snapshot.capturedAt[$0] } ?? snapshot.savedAt
          appUnavailable = true
          if let id = snapshot.selected, bootstrap?.bots.contains(where: { $0.id == id }) == true {
            selectedBotId = id
            conversation = conversationCache[id]
            let cachedDraft: Draft? = read(key(.draft, id))
            draft = cachedDraft ?? Draft()
            draftReady = cachedDraft != nil
          }
        }
        await refreshBootstrap()
        if api?.token != nil { startPolling() }
      } else {
        try await ensureAuthConfig()
      }
    } catch { report(error) }
  }
  /// Retries a launch that could not reach the server. Called when the app returns to the foreground.
  func resume() async {
    if bootstrap != nil {
      if !sessionExpired { startPolling() }
    } else if api != nil, !sessionExpired {
      await restore()
    }
  }
  /// Sign-in needs the server's native-auth version. Fetch it when needed instead of at launch.
  @discardableResult func ensureAuthConfig() async throws -> AuthConfig {
    if let authConfig { return authConfig }
    guard let requested = api else {
      throw APIError(message: "Connect to an app server first.", status: 0)
    }
    let config: AuthConfig = try await requested.publicGet("/auth/config")
    guard api === requested else { throw CancellationError() }
    guard config.nativeAuthVersion == 1 else {
      throw APIError(
        message: "Update this app server to a version with native iOS sign-in support.",
        status: 409)
    }
    authConfig = config
    return config
  }
  func connect() async {
    guard !loading else { return }
    loading = true
    defer { loading = false }
    do {
      let url = try ConnectionAddress.parse(host)
      let candidate = APIClient(baseURL: url)
      let config: AuthConfig = try await candidate.publicGet("/auth/config")
      guard config.nativeAuthVersion == 1 else {
        throw APIError(
          message:
            "Update this app server to a version with native iOS sign-in support, then retry.",
          status: 409)
      }
      api = candidate
      authConfig = config
      host = url.absoluteString
      UserDefaults.standard.set(host, forKey: DeviceDefaults.host)
      error = nil
      if candidate.token != nil {
        await refreshBootstrap()
        startPolling()
      }
    } catch { report(error) }
  }
  func signIn() async {
    guard let api, !signingIn else { return }
    signingIn = true
    error = nil
    defer {
      signingIn = false
      authSession = nil
    }
    let authGeneration = generation
    do {
      try await ensureAuthConfig()
      let pkce = try PKCE()
      var url = URLComponents(url: try api.url("/native/sign-in"), resolvingAgainstBaseURL: false)!
      url.queryItems = [
        URLQueryItem(name: "state", value: pkce.state),
        URLQueryItem(name: "code_challenge", value: pkce.challenge),
        URLQueryItem(name: "code_challenge_method", value: "S256"),
      ]
      let callback: URL = try await withCheckedThrowingContinuation { continuation in
        // Sendable: the session may answer off the main actor, and only resumes the continuation.
        let session = ASWebAuthenticationSession(url: url.url!, callbackURLScheme: "agentinterface")
        { @Sendable url, error in
          if let url {
            continuation.resume(returning: url)
          } else {
            continuation.resume(
              throwing: error ?? APIError(message: "Sign-in was cancelled.", status: 0))
          }
        }
        session.presentationContextProvider = self
        session.prefersEphemeralWebBrowserSession = true
        authSession = session
        if !session.start() {
          continuation.resume(
            throwing: APIError(message: "Could not open the system sign-in browser.", status: 0))
        }
      }
      let code = try pkce.code(from: callback)
      let result: TokenExchange = try await api.publicWrite(
        "/auth/native/exchange", ["code": code, "state": pkce.state, "codeVerifier": pkce.verifier])
      guard generation == authGeneration else { return }
      try SecureToken.save(result.token, host: api.baseURL.absoluteString)
      api.token = result.token
      sessionExpired = false
      UserDefaults.standard.set(
        result.expiresAt, forKey: DeviceDefaults.expiry(api.baseURL))
      await refreshBootstrap()
      startPolling()
    } catch {
      guard generation == authGeneration else { return }
      if (error as? ASWebAuthenticationSessionError)?.code != .canceledLogin { report(error) }
    }
  }
  func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
      .first { $0.isKeyWindow } ?? ASPresentationAnchor()
  }
  func startPolling() {
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
  private func hearReplies(in value: Conversation, botId id: String) {
    let (next, reply) = ReplyWatch.next(replyWatch ?? ReplyWatch(), value, baseline: replyWatch == nil)
    replyWatch = next
    guard let reply else { return }
    announcements += 1
    replyAnnouncement = ReplyAnnouncement(id: announcements, botId: id, text: ReplyWatch.snippet(reply.text))
    if viewingBotId == id { buzz(.replied) }
  }
  /// Ends polling and the change stream together, so neither outlives the other.
  private func stopPolling() {
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
  /// Refreshes the household roster when its visible assistants change.
  private func watchRoster() {
    guard rosterTask == nil, let api else { return }
    rosterTask = Task { [weak self] in
      var failures = 0
      while !Task.isCancelled {
        do {
          let lines = try await api.events("/api/events")
          guard let self, !Task.isCancelled else { return }
          failures = 0
          await self.refreshBootstrap()
          for try await line in lines {
            guard !Task.isCancelled else { return }
            if line == "data: roster" { await self.refreshBootstrap() }
          }
        } catch {}
        guard let self, !Task.isCancelled, !self.sessionExpired else { return }
        failures += 1
        try? await Task.sleep(for: .seconds(min(30, 3 * failures)))
      }
    }
  }
  /// Follows the change stream of the conversation on screen, reconnecting with a growing delay.
  private func watchConversation() {
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
              if event == "inflight", let data = String(line.dropFirst(5)).data(using: .utf8),
                 let patch = try? JSONDecoder().decode(Inflight.self, from: data), self.selectedBotId == patch.botId {
                self.latestInflight = patch
                if let current = self.conversation {
                  let value = patch.applying(to: current)
                  self.conversation = value
                  self.conversationCache[patch.botId] = value
                }
              } else if event != "inflight" && line != "data: ping" {
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
  private func requestConversationRefresh() {
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
          upgrade.reset(); computerStatus = nil
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
      report(error)
    }
  }
  /// Another member made the open assistant personal, or it was deleted: return home and stop asking for it.
  func leave(_ id: String) async {
    for upload in uploads.items.filter({ $0.botId == id }) { uploads.remove(upload.id) }
    conversationCache[id] = nil
    conversationCapturedAt[id] = nil
    cachedChats.remove(id)
    saveOfflineLibrary()
    if deletedBotId == id { deletedBotId = nil } else { notice = "That assistant is no longer available to you." }
    error = nil
    stayHome = true
    if pendings[id] == nil { receipts[id] = nil }
    await select(nil)
    leftBotId = id
  }
  private static func missing(_ error: Error) -> Bool { (error as? APIError)?.code == "assistant_not_found" }
  func select(_ id: String?, navigate: Bool = true) async {
    if id != nil { stayHome = false; notice = nil }
    persistDraft()
    flushDraft()
    selectionGeneration = UUID()
    latestInflight = nil
    // Opening reads the conversation itself, so its view arriving on screen needs no read of its own.
    openingBotId = id
    conversationRefreshedAt = nil
    defer { if openingBotId == id { openingBotId = nil } }
    selectedBotId = id
    if id != nil && navigate { conversationRequest = UUID() }
    conversation = id.flatMap { conversationCache[$0] }
    offlineSavedAt = id.flatMap { cachedChats.contains($0) ? conversationCapturedAt[$0] : nil } ?? restoredRosterAt
    draftReady = false
    interruptionReviewed = false
    receipt = pending?.botId == id ? receipt : nil
    save(id, key(.selected))
    guard let id, let api, bootstrap != nil else {
      draft = Draft()
      return
    }
    let cached: Draft? = read(key(.draft, id))
    draft = cached ?? Draft()
    if cached?.dirty == true { draftReady = true }
    // Like the web, a chat opens at its latest page; the window grows from there.
    historyStarts[id] = nil
    replyWatch = nil
    let selectedGeneration = selectionGeneration
    do {
      // The draft is a quick local read. It settles first so the conversation's copy merges onto it.
      let remote: SavedDraft? = try await api.get("/bots/\(APIClient.component(id))/draft")
      guard selectionGeneration == selectedGeneration else { return }
      loadDraft(remote, botId: id)
    } catch {
      guard selectionGeneration == selectedGeneration else { return }
      if Self.missing(error) { await leave(id); return }
      draftReady = cached != nil
      // The web's wording. Polls keep reading the draft with the conversation.
      if cached?.dirty != true { report(APIError(message: "Your saved draft could not be loaded. Retrying. \(error.localizedDescription)", status: 0)) }
    }
    await refreshConversation()
  }
  private func conversationPath(_ id: String, query: String) -> String {
    "/bots/\(APIClient.component(id))/conversation?\(query)"
  }
  func refreshConversation() async {
    guard let id = selectedBotId, let api, bootstrap != nil else { return }
    let selectedGeneration = selectionGeneration
    let requestedWindow = windowGeneration
    let query = historyStarts[id].map { "start=\(APIClient.component($0))" }
      ?? "turns=\(Self.historyPageTurns)"
    conversationReads += 1
    let read = conversationReads
    conversationReadsInFlight += 1
    defer { conversationReadsInFlight -= 1 }
    // A draft still to load or to save again needs the conversation's copy applied every time.
    let skippable = draftReady && !(draft.dirty == true && settled(id))
    do {
      let response: (value: Conversation?, etag: String?) = try await api.changed(
        conversationPath(id, query: query), since: skippable ? appliedConversationTag : nil)
      guard selectedGeneration == selectionGeneration, requestedWindow == windowGeneration,
        read > appliedConversationRead
      else { return }
      appliedConversationRead = read
      conversationRefreshedAt = now()
      // Echoes settle against each current read, changed or not.
      defer { if !echoes.isEmpty { updateEcho() } }
      // The conversation applied last time, unchanged: nothing to decode, merge or render.
      guard let value = response.value else { conversationCapturedAt[id] = Date(); return }
      hearReplies(in: value, botId: id)
      historyStarts[id] = value.messages.first?.id
      apply(value, botId: id)
      appliedConversationTag = response.etag
    } catch is CancellationError {} catch {
      // A failure that a newer read or a wider window has already overtaken says nothing current.
      guard selectedGeneration == selectionGeneration, requestedWindow == windowGeneration,
        read > appliedConversationRead
      else { return }
      if Self.missing(error) {
        await leave(id)
      } else {
        appUnavailable = true
        failures += 1
        report(error)
      }
    }
  }
  /// Adds one more page of history above what is loaded. A failure is reported but does not
  /// mark the server unavailable, because the loaded conversation is still current.
  func loadEarlier() async {
    guard let id = selectedBotId, let api, !loadingEarlier,
      let first = conversation?.messages.first?.id, (conversation?.earlier ?? 0) > 0
    else { return }
    let selectedGeneration = selectionGeneration
    loadingEarlier = true
    defer { loadingEarlier = false }
    conversationReads += 1
    let read = conversationReads
    conversationReadsInFlight += 1
    defer { conversationReadsInFlight -= 1 }
    do {
      let query = "start=\(APIClient.component(first))&turns=\(Self.historyPageTurns)"
      let value: Conversation = try await api.get(conversationPath(id, query: query))
      guard selectedGeneration == selectionGeneration else { return }
      windowGeneration += 1
      historyStarts[id] = value.messages.first?.id
      guard read > appliedConversationRead else {
        // A newer read landed while this page loaded. Keep the wider window, but read it fresh
        // instead of showing this older snapshot of the recent turns.
        await refreshConversation()
        return
      }
      appliedConversationRead = read
      hearReplies(in: value, botId: id)
      apply(value, botId: id)
    } catch is CancellationError {} catch {
      if selectedGeneration == selectionGeneration { report(error) }
    }
  }
  /// Every file the open conversation knows, oldest first, with where it came from. Listed once per
  /// change of its inputs, not on every render of the header that counts them.
  var conversationArtifacts: [Artifact] {
    // The cache is not observed, so a view reading it still follows the inputs it comes from.
    _ = conversation; _ = earlierFileCache; _ = selectedBotId
    if let cachedArtifacts { return cachedArtifacts }
    let value = Artifacts.list(conversation, earlier: currentEarlierFiles?.messages ?? [])
    cachedArtifacts = value
    return value
  }
  @ObservationIgnored private var cachedArtifacts: [Artifact]?
  var conversationFiles: [FileRef] { conversationArtifacts.map(\.file) }
  var earlierFilesFailed: Bool {
    earlierFilesFailure != nil && earlierFilesFailure == earlierFilesKey
  }
  private var earlierFilesKey: String? {
    selectedBotId.map { "\($0):\(conversation?.sessionId ?? "")" }
  }
  /// Whether the file list has anything to show or fetch.
  var hasConversationFiles: Bool {
    !conversationFiles.isEmpty || (conversation?.earlierFiles ?? 0) > 0
  }
  /// The header badge count, as the web counts it: known files plus earlier ones not yet fetched.
  var conversationFileCount: Int {
    conversationFiles.count + (currentEarlierFiles == nil ? conversation?.earlierFiles ?? 0 : 0)
  }
  private var currentEarlierFiles: EarlierFilePage? {
    guard let id = selectedBotId, let page = earlierFileCache[id],
      page.sessionId == conversation?.sessionId,
      page.before == nil || conversation?.messages.contains(where: { $0.id == page.before }) == true
    else { return nil }
    return page
  }
  /// Fetches the files of the history before the loaded window. Called when the file list opens.
  func loadEarlierFiles() async {
    guard let id = selectedBotId, let api, let current = conversation,
      (current.earlierFiles ?? 0) > 0, !loadingEarlierFiles, currentEarlierFiles == nil
    else { return }
    let selectedGeneration = selectionGeneration
    let before = current.messages.first?.id
    let key = earlierFilesKey
    earlierFilesFailure = nil
    loadingEarlierFiles = true
    defer { loadingEarlierFiles = false }
    do {
      let suffix = before.map { "?before=\(APIClient.component($0))" } ?? ""
      let page: EarlierFiles = try await api.get("/bots/\(APIClient.component(id))/files\(suffix)")
      guard selectedGeneration == selectionGeneration else { return }
      earlierFileCache[id] = EarlierFilePage(sessionId: current.sessionId, before: before, messages: page.messages)
    } catch is CancellationError {} catch {
      if selectedGeneration == selectionGeneration { earlierFilesFailure = key }
    }
  }
  private func apply(_ value: Conversation, botId id: String) {
    cachedChats.remove(id)
    if offlineSavedAt != nil { offlineSavedAt = nil }
    let value = latestInflight?.applying(to: value) ?? value
    let changed = conversationCache[id] != value
    conversationCapturedAt[id] = Date()
    if conversation?.activity.runId != value.activity.runId
      || conversation?.activity.state != .interrupted && value.activity.state == .interrupted
    {
      interruptionReviewed = false
    }
    // An unchanged poll leaves the transcript alone instead of rendering it again.
    if conversation != value { conversation = value }
    conversationCache[id] = value
    recentChats.removeAll { $0 == id }; recentChats.append(id)
    while recentChats.count > OfflineLibrary.maximumChats {
      let expired = recentChats.removeFirst()
      conversationCache[expired] = nil; cachedChats.remove(expired)
    }
    if changed { saveOfflineLibrary() }
    // The conversation carries the saved draft, so a draft that failed to load has now loaded.
    clearDraftLoadFailure()
    // Polling also brings in a draft changed on another device, or a send made there, and
    // settles a copy kept unsaved while saves were in flight.
    if !draftReady || (value.draft?.revision ?? 0) != (draft.baseRevision ?? 0) || draft.dirty == true && settled(id) {
      loadDraft(value.draft, botId: id)
    }
  }
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
  private func flushDraft(inBackground: Bool = false) {
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
  /// Saves in flight per cached draft. A copy is not marked saved while an older save may land.
  /// The edit sequences of the saves in flight, per cached draft.
  @ObservationIgnored private var draftSavesInFlight: [String: [Int]] = [:]
  /// Consecutive failed saves per cached draft, for the retry backoff: 1 s, 2 s, 4 s, up to 30 s.
  @ObservationIgnored private var draftSaveFailures: [String: Int] = [:]
  /// When a failed draft may retry. Until then only a new edit saves it, not a poll.
  @ObservationIgnored private var draftRetryAt: [String: ContinuousClock.Instant] = [:]
  /// The last edit sequence per cached draft, for the life of the store. A copy adopted from the
  /// server forgets its own, so a new edit never reuses one an older save in flight carries.
  @ObservationIgnored private var draftSeqs: [String: Int] = [:]
  private func nextDraftSeq(_ botId: String?) -> Int {
    let localKey = botId.flatMap { key(.draft, $0) } ?? ""
    let next = max(draftSeqs[localKey] ?? 0, draft.seq ?? 0) + 1
    draftSeqs[localKey] = next
    return next
  }
  private func settled(_ botId: String) -> Bool { key(.draft, botId).map { draftSavesInFlight[$0] == nil } ?? true }
  /// Saves a draft on its base revision, then merges the response into the open copy and the
  /// cached copy as they are now. Kept edits after a conflict save again on the new base.
  private func saveDraft(_ snapshot: Draft, botId: String, retries: Int = 3) async throws {
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
  /// Writes the open draft to this device now. Leaving, switching, signing out and every merge call
  /// it, which also writes a typing pause's pending copy at once.
  private func persistDraft() {
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
  @ObservationIgnored private var draftPersistTask: Task<Void, Never>?
  static let draftPersistDelay: Duration = .milliseconds(300)
  /// A typing pause this long saves the open draft to the server.
  static let draftSaveDelay: Duration = .milliseconds(600)
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
    sending = true
    error = nil
    let currentGeneration = generation
    defer { if currentGeneration == generation { sending = false } }
    do {
      let value: Receipt = try await api.write(
        "/bots/\(APIClient.component(id))/messages", submission)
      guard currentGeneration == generation else { return }
      await handleReceipt(value, botId: id)
      if value.status == "accepted" { buzz(.sent); Task { await LiveActivityController.shared.sent(to: id) } }
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
    guard let api, !sending else { return }
    let currentGeneration = generation
    for pending in pendings.values.sorted(by: { $0.botId < $1.botId }) {
      if let check = submissionChecks[pending.requestId], now() < check.next { continue }
      do {
        let value: Receipt = try await api.get(
          "/submissions/\(APIClient.component(pending.requestId))")
        guard currentGeneration == generation, !sending else { return }
        checkedSubmission(pending.requestId)
        await handleReceipt(value, botId: pending.botId)
      } catch {
        guard currentGeneration == generation else { return }
        checkedSubmission(pending.requestId)
        report(error)
        return
      }
    }
    submissionChecks = submissionChecks.filter { id, _ in pendings.values.contains { $0.requestId == id } }
  }
  /// How long an unconfirmed send waits between checks: 1.5 s, 5 s, 15 s, then a minute. A new
  /// send, a retry of it, a change notice from its conversation or Reconnect asks again at once.
  static let submissionCheckDelays: [Duration] = [.seconds(1.5), .seconds(5), .seconds(15), .seconds(60)]
  @ObservationIgnored private var submissionChecks: [String: (count: Int, next: ContinuousClock.Instant)] = [:]
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
  private func loadPendings(_ bots: [Bot]) {
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
    guard value.status != "uncertain" else { return }
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
  private func refused(_ submission: PendingSubmission) {
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
  /// Follows the open assistant's submissions and keeps each echo until Hermes's copy replaces it.
  /// Every input it reads calls it when it changes.
  private func updateEcho(conversationChanged: Bool = false) {
    let now = Date()
    // Only a conversation on screen is kept current, so only it can retire an echo or anchor one.
    let current = followedBotId == nil ? nil : conversation
    let next = SentEcho.nextEchoes(
      echoes, pending: pending, receipt: receipt, sending: sending, conversation: current,
      sender: bootstrap.map { Sender(id: $0.user.id, name: $0.user.name) }, now: now)
    let changed = next != echoes
    if changed { echoes = next }
    if changed || conversationChanged {
      transcript = SentEcho.transcript(conversation, echoes)
      turns = transcript?.presentationTurns ?? []
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
  static let draftLoadFailure = "Your saved draft could not be loaded."
  /// The web drops its "could not be loaded" notice once a later read of the draft succeeds.
  private func clearDraftLoadFailure() {
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
  private func loadDraft(_ remote: SavedDraft?, botId: String) {
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
  func reconnect() async {
    guard let api else { return }
    let currentGeneration = generation
    do {
      let _: RuntimeStatus = try await api.write("/connection/retry", [String: String]())
      guard currentGeneration == generation else { return }
      submissionChecks = [:]
      await refreshBootstrap()
      await refreshConversation()
      await reconcilePending()
    } catch { if currentGeneration == generation { report(error) } }
  }
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
  @discardableResult func setPreferences(_ value: Preferences) async -> Bool {
    guard let api else { return false }
    let currentGeneration = generation
    do {
      var update = value
      update.modelFavorites = nil
      let saved: Preferences = try await api.write("/preferences", update, method: "PATCH")
      guard currentGeneration == generation else { return false }
      bootstrap?.preferences = saved
      return true
    } catch { if currentGeneration == generation { report(error) }; return false }
  }
  /// Account-owned queue survives closing Settings. A slow earlier save cannot win over a later edit.
  func queuePreferences(_ value: Preferences) {
    if preferencesSaveFailed && error == preferencesFailureMessage { error = nil }
    preferencesFailureMessage = nil
    preferencesDraft = value; queuedPreferences = value; preferencesSaveFailed = false
    guard !preferencesSaving else { return }
    preferencesSaving = true
    let currentGeneration = generation
    Task {
      defer { if currentGeneration == generation { preferencesSaving = false } }
      while let next = queuedPreferences, currentGeneration == generation {
        queuedPreferences = nil
        let saved = await setPreferences(next)
        guard currentGeneration == generation else { return }
        if !saved { preferencesSaveFailed = true; preferencesFailureMessage = error; return }
      }
      if currentGeneration == generation { preferencesDraft = nil }
    }
  }
  func discardPreferenceChanges() {
    if error == preferencesFailureMessage { error = nil }
    queuedPreferences = nil; preferencesDraft = nil; preferencesSaveFailed = false; preferencesFailureMessage = nil
  }
  private func resetPreferenceSaves() {
    queuedPreferences = nil; preferencesDraft = nil; preferencesSaveFailed = false; preferencesFailureMessage = nil; preferencesSaving = false
  }
  func togglePin(_ id: String) async {
    guard var preferences = preferencesDraft ?? bootstrap?.preferences else { return }
    if preferences.favorites.contains(id) { preferences.favorites.removeAll { $0 == id } }
    else { preferences.favorites.append(id) }
    queuePreferences(preferences)
  }
  /// Conversation views on screen per assistant, counted because the next can appear before the
  /// last one disappears.
  private(set) var conversationScreens: [String: Int] = [:]
  /// The open assistant while its conversation is on screen, in the iPad detail pane or under a
  /// sheet. Only it is polled and streamed: home, Today and Search leave the conversation alone,
  /// and it is read again as soon as it returns.
  var followedBotId: String? { followed(selectedBotId) }
  private func followed(_ id: String?) -> String? { id.flatMap { conversationScreens[$0] != nil ? $0 : nil } }
  /// The assistant `select` is opening; its own read makes the view's arrival need none.
  @ObservationIgnored private var openingBotId: String?
  func conversationShown(_ botId: String, _ shown: Bool) {
    let before = followedBotId
    let count = (conversationScreens[botId] ?? 0) + (shown ? 1 : -1)
    conversationScreens[botId] = count > 0 ? count : nil
    followChanged(from: before)
  }
  private func followChanged(from before: String?) {
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
  /// The chat on screen while the app is active. Reporting it keeps this person's other devices
  /// quiet about it and marks it read there, as the web does.
  @ObservationIgnored private(set) var viewingBotId: String?
  @ObservationIgnored private var presenceBeat: Task<Void, Never>?
  @ObservationIgnored private var presenceReports: Task<Void, Never>?
  /// Sheets over the chat, such as settings or files. A covered chat is not being read, as on the web.
  private(set) var chatCovers = 0
  func cover(_ shown: Bool) { chatCovers = max(0, chatCovers + (shown ? 1 : -1)) }
  func viewing(_ botId: String?) {
    guard botId != viewingBotId else { return }
    if let previous = viewingBotId { reportPresence(previous, "left") }
    viewingBotId = botId
    presenceBeat?.cancel()
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
  private func reportPresence(_ botId: String, _ state: String) {
    guard let api, !sessionExpired else { return }
    let report = ChatPresenceReport(client: NotificationController.shared.deviceId, state: state)
    // Presence is a hint, so a failed report stays quiet, as on the web. One goes at a time, so
    // leaving one chat can never land after arriving in the next.
    let previous = presenceReports
    presenceReports = Task {
      await previous?.value
      let _: EmptyResponse? = try? await api.write("/bots/\(APIClient.component(botId))/presence", report, method: "PUT")
    }
  }
  func markRead(_ messageId: String?) {
    guard let id = selectedBotId, let api else { return }
    let position = ReadPosition(messageId: messageId)
    // A reading position is a hint, so a failed save stays quiet, as on the web.
    Task {
      let _: ReadPosition? = try? await api.write(
        "/bots/\(APIClient.component(id))/read-position", position, method: "PUT")
    }
  }
  /// Why files cannot be attached to this assistant's draft right now, in the web's words.
  static let attachWhileSending = "Wait a moment for your message to send."
  func attachUnavailable(_ botId: String) -> String? {
    if !supports(.uploads) {
      let reason = bootstrap?[capability: .uploads]?.reason ?? ""
      return reason.isEmpty ? "Hermes can't receive files right now." : reason
    }
    if !draftReady || selectedBotId != botId { return "Your draft is still loading." }
    if sending { return Self.attachWhileSending }
    if attachmentSlots(botId) <= 0 { return "A message can carry up to \(UploadRules.maxAttachments) attachments." }
    return nil
  }
  func attachmentSlots(_ botId: String) -> Int {
    UploadRules.maxAttachments - draft.attachments.count - uploads.items.filter { $0.botId == botId }.count
  }
  /// An uploaded file joins its assistant's draft. `uploaded` drops its staged entry once the
  /// draft holds it.
  func attachUploaded(_ file: FileRef, botId: String, uploaded: () -> Void) async throws {
    if selectedBotId == botId && draftReady {
      var next = draft; next.attachments.append(file); updateDraft(next)
      uploaded()
    } else {
      let localKey = key(.draft, botId)
      var target: Draft = read(localKey) ?? Draft()
      target.attachments.append(file); target.dirty = true; target.seq = (target.seq ?? 0) + 1
      save(target, localKey)
      // A draft read already in flight must merge this cached attachment, not replace it.
      if selectedBotId == botId { draft = target }
      uploaded()
      try await saveDraft(target, botId: botId)
    }
  }
  func attachAppleSnapshot(_ data: Data, botId: String) async throws {
    guard let api, connected, supports(.uploads), !uploads.uploading, !sending, pendings[botId] == nil, bootstrap?.bots.contains(where: { $0.id == botId }) == true else {
      throw APIError(message: "Reconnect to this assistant before sharing a snapshot.", status: 409)
    }
    let currentGeneration = generation
    let localKey = key(.draft, botId)
    var target: Draft
    if selectedBotId == botId {
      guard draftReady else { throw APIError(message: "Wait for this assistant's draft to finish loading.", status: 409) }
      target = draft
    } else {
      let remote: SavedDraft? = try await api.get("/bots/\(APIClient.component(botId))/draft")
      let cached: Draft? = read(localKey)
      target = Draft.merge(cached ?? Draft(), with: remote).draft
    }
    guard target.attachments.count < 10 else { throw APIError(message: "This draft already has 10 attachments. Send or remove one first.", status: 400) }
    uploads.uploading = true
    defer { if currentGeneration == generation { uploads.uploading = false; Task { await self.uploads.drain() } } }
    let file = try await api.upload(botId: botId, name: "apple-selected-snapshot.txt", mime: "text/plain", data: data)
    guard currentGeneration == generation else { throw CancellationError() }
    // Draft editing remains possible during uploads. Read it again before appending.
    if selectedBotId == botId { target = draft }
    else if let cached: Draft = read(localKey), cached.dirty == true { target = cached }
    guard target.attachments.count < 10 else { throw APIError(message: "This draft filled up while uploading. Remove an attachment before sharing again.", status: 409) }
    target.attachments.append(file)
    if target.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { target.text = "Use this selected Calendar and Reminders snapshot. It was shared from my iPhone and is current only as of its capture time." }
    target.dirty = true
    if selectedBotId == botId { updateDraft(target) }
    else {
      save(target, localKey)
      try await saveDraft(target, botId: botId)
    }
  }
  func open(_ file: FileRef) {
    fileTask?.cancel()
    let currentGeneration = generation
    fileTask = Task {
      do {
        guard let api else { return }
        let data = try await api.data(path: "/api/files/\(APIClient.component(file.id))")
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
          "AgentInterface-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent(
          URL(fileURLWithPath: file.name).lastPathComponent)
        try data.write(to: url, options: [.atomic, .completeFileProtection])
        guard !Task.isCancelled, currentGeneration == generation else {
          try? FileManager.default.removeItem(at: directory)
          return
        }
        openedFile = PreviewFile(url: url)
      } catch { if currentGeneration == generation { report(error) } }
    }
  }
  /// Revokes this device's server session, then clears it locally. If the server cannot be
  /// reached the token is kept and this returns false, unless `localOnly` accepts that the
  /// server-side session stays valid until it expires.
  @discardableResult func signOut(localOnly: Bool = false) async -> Bool {
    persistDraft()
    if let api, api.token != nil {
      var revoked = true
      do { let _: EmptyResponse = try await api.write("/auth/logout", [String: String]()) } catch {
        // A session the server already rejected has nothing left to revoke.
        if !((error as? APIError)?.isSessionExpired ?? false) { revoked = false }
        if !revoked && !localOnly {
          self.error =
            "Sign-out could not be completed. Reconnect and retry so this device's server session and notifications can be revoked. \(error.localizedDescription)"
          return false
        }
      }
      clearOfflineLibrary()
      try? SecureToken.save(nil, host: api.baseURL.absoluteString)
      api.token = nil
      api.csrf = nil
      if !revoked {
        self.error =
          "Signed out on this device only. The server could not be reached, so this device's session stays valid there until it expires, and notifications may still be delivered. Sign in on that server again to revoke it."
      }
    }
    stopPolling()
    cachedChats.removeAll()
    draftTask?.cancel()
    scheduledDraftSave = nil
    fileTask?.cancel()
    generation = UUID()
    selectionGeneration = UUID()
    bootstrap = nil
    conversation = nil
    conversationCache.removeAll()
    conversationCapturedAt.removeAll()
    recentChats.removeAll()
    historyStarts.removeAll()
    earlierFileCache.removeAll()
    bootstrapRefreshedAt = nil
    selectedBotId = nil
    stayHome = false
    notice = nil
    draft = Draft()
    draftReady = false
    pendings = [:]
    earlyAdditions = []
    receipts = [:]
    submissionChecks = [:]
    sending = false
    uploads.reset()
    uploads.notice = []
    appUnavailable = false
    sessionExpired = false
    upgrade.reset(); computerStatus = nil
    resetPreferenceSaves()
    return true
  }
  /// A failed read keeps the last known status, like the web panel, which only notes it can't reach the computer.
  func refreshComputer() async {
    guard let api, api.token != nil, !sessionExpired else { return }
    let currentGeneration = generation
    guard let value: ComputerStatus = try? await api.get("/computer"), currentGeneration == generation else { return }
    computerStatus = value
  }
  /// Returns false when the server could not be reached to revoke the session. The caller
  /// then asks before repeating with `localOnly`, which still lets the person leave.
  @discardableResult func changeConnection(localOnly: Bool = false) async -> Bool {
    guard await signOut(localOnly: localOnly) else { return false }
    api = nil
    authConfig = nil
    return true
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
