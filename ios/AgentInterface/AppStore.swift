import AuthenticationServices
import ImageIO
import SwiftUI
import UniformTypeIdentifiers

@MainActor
final class AppStore: NSObject, ObservableObject, ASWebAuthenticationPresentationContextProviding {
  @Published var host = UserDefaults.standard.string(forKey: "connection.host") ?? ""
  @Published var api: APIClient?
  @Published var bootstrap: Bootstrap? { didSet { publishWidgetSnapshot() } }
  /// The App Group snapshot widgets read. Tests point it elsewhere or turn it off.
  var widgetSnapshotURL: URL? = WidgetSnapshotStore.defaultURL
  @Published var conversation: Conversation? {
    didSet { if conversation != oldValue { turns = conversation?.presentationTurns ?? [] } }
  }
  /// The open conversation grouped into turns, computed once per change instead of on every render.
  private(set) var turns: [ConversationTurn] = []
  @Published var selectedBotId: String?
  @Published var routineResult: RoutineResultDestination?
  @Published var todayRequest: UUID?
  @Published var draft = Draft()
  @Published var draftReady = false
  /// Unconfirmed sends, one per assistant, as the web keeps one per assistant.
  @Published var pendings: [String: PendingSubmission] = [:]
  /// The open assistant's unconfirmed send. Setting one files it under its own assistant.
  var pending: PendingSubmission? {
    get { selectedBotId.flatMap { pendings[$0] } }
    set {
      if let newValue { pendings[newValue.botId] = newValue } else if let id = selectedBotId { pendings[id] = nil }
    }
  }
  /// The latest submission receipt per assistant.
  @Published var receipts: [String: Receipt] = [:]
  var receipt: Receipt? {
    get { selectedBotId.flatMap { receipts[$0] } }
    set { if let id = selectedBotId { receipts[id] = newValue } }
  }
  @Published var error: String?
  /// A short message for home, such as an assistant that is no longer available.
  @Published var notice: String?
  /// The assistant this person just lost access to, so views showing it close.
  @Published var leftBotId: String?
  /// Set before deleting, so the deleted assistant leaves without a message.
  var deletedBotId: String?
  /// After leaving an assistant, home stays open instead of choosing another one.
  private var stayHome = false
  @Published var signingIn = false
  @Published var loading = false
  @Published var sending = false
  @Published var uploading = false
  @Published var attachmentUploads: [AttachmentUpload] = []
  /// Files from the last attempt to attach that could not be added, each with its reason.
  @Published var attachNotice: [String] = []
  private var uploadTasks: [UUID: Task<Void, Never>] = [:]
  @Published var appUnavailable = false
  @Published var interruptionReviewed = false
  @Published var authConfig: AuthConfig?
  @Published var restoring = false
  @Published var sessionExpired = false
  @Published var conversationRequest: UUID?
  @Published var preferencesSaving = false
  @Published var preferencesSaveFailed = false
  @Published var preferencesDraft: Preferences?
  private var preferencesFailureMessage: String?
  private var queuedPreferences: Preferences?
  /// This device's notification switch and onboarding card for the signed-in account.
  @Published var deviceNotifications = DeviceNotificationState()
  @Published var openedFile: PreviewFile?
  @Published var upgradeStatus: UpgradeStatus?
  @Published var upgradeBusy = false
  @Published var upgradeError: String?
  @Published var upgradeInstallUncertain = false
  /// True only while a check, install or recovery request is in flight, not for status polls.
  @Published var upgradeSubmitting = false
  /// The shared desktop's availability for the Settings row. Nil until the first read.
  @Published var computerStatus: ComputerStatus?
  private var upgradeRequest: UpgradeInstallRequest?
  /// Builds the client for a server address. Tests substitute a client with a mock transport.
  var makeClient: (URL) -> APIClient = { APIClient(baseURL: $0) }
  private var authSession: ASWebAuthenticationSession?
  private var pollTask: Task<Void, Never>?
  /// Latest live reply patch, retained across overlapping conversation reads.
  private var latestInflight: Inflight?
  /// Household roster stream, independent of the selected conversation.
  private var rosterTask: Task<Void, Never>?
  /// The open conversation's change stream and when it last spoke.
  private var eventTask: Task<Void, Never>?
  private var eventBotId: String?
  private var streamHeardAt: ContinuousClock.Instant?
  private var conversationRefreshedAt: ContinuousClock.Instant?
  private var conversationRefreshing = false
  /// Conversation reads overlap: polls, change notices, selection and pull to refresh each start
  /// one. A response older than one already applied is dropped, so it cannot undo newer state.
  private var conversationReads = 0
  private var appliedConversationRead = 0
  /// Replies already accounted for in the open conversation. As in the web's conversation hook,
  /// the first successful read after opening is the baseline, even when it matches the cache.
  private var replyWatch: ReplyWatch?
  private var announcements = 0
  /// The latest settled reply for VoiceOver, numbered so a repeat of the same words is read again.
  @Published private(set) var replyAnnouncement: ReplyAnnouncement?
  private var conversationRefreshAgain = false
  /// While the stream is live, change notices drive updates and this slow poll covers a stream
  /// that fails unnoticed, as on the web. Server pings arrive every 25 seconds.
  static let streamFallbackInterval: Duration = .seconds(30)
  static let streamSilence: Duration = .seconds(60)
  private var draftTask: Task<Void, Never>?
  /// Set while an edit waits for its save, so leaving can send it now instead of dropping it.
  private var scheduledDraftSave: UUID?
  private var draftBackgroundTask = UIBackgroundTaskIdentifier.invalid
  private var conversationCache: [String: Conversation] = [:]
  private var generation = UUID()
  private var selectionGeneration = UUID()
  private var fileTask: Task<Void, Never>?
  private var failures = 0
  /// Turns of history one request covers, the same page the web client uses.
  static let historyPageTurns = 20
  /// How long bootstrap may go unrefreshed while the connection is healthy. Actions that change
  /// it, a foreground return and pull to refresh all refresh it sooner.
  static let bootstrapInterval: Duration = .seconds(45)
  /// Tests substitute a clock they advance by hand.
  var now: () -> ContinuousClock.Instant = { .now }
  private var bootstrapRefreshedAt: ContinuousClock.Instant?
  /// Oldest loaded message per assistant. Polls ask for everything from there on, so the window
  /// grows with new turns instead of sliding past the turn being read, as on the web.
  private var historyStarts: [String: String] = [:]
  /// Bumped when earlier history is added, so a poll that asked for the narrower window earlier
  /// cannot replace it when its response arrives late.
  private var windowGeneration = 0
  /// Files from before the loaded window, fetched when the file list is opened. They are good
  /// while the message they were fetched before is still loaded, as on the web.
  @Published private var earlierFileCache: [String: EarlierFilePage] = [:]
  private struct EarlierFilePage {
    var sessionId: String?
    var before: String?
    var messages: [EarlierFiles.Entry]
  }
  @Published var loadingEarlierFiles = false
  /// The bot and session whose earlier files failed to load, shown as a notice in the file list
  /// instead of an error banner. Opening the list again retries, as on the web.
  @Published private var earlierFilesFailure: String?
  @Published var loadingEarlier = false
  var bot: Bot? { bootstrap?.bots.first { $0.id == selectedBotId } }
  var connected: Bool {
    bootstrap?.connection.connected == true && !appUnavailable && !sessionExpired
  }
  var activity: ActivityState {
    connected ? conversation?.activity.state ?? bot?.activity ?? .idle : .disconnected
  }
  var active: Bool { activity.active }
  var canSend: Bool {
    draftReady && connected && !sending && !uploading && !attachmentUploads.contains { $0.botId == selectedBotId } && pending == nil
      && draft.text.utf16.count <= Self.maxMessageLength
      && (!draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        || !draft.attachments.isEmpty)
      && supports(active ? "steering" : "chat")
      && (activity != .interrupted || interruptionReviewed)
  }
  /// The server's limit, counted in UTF-16 code units as JavaScript counts string length.
  static let maxMessageLength = 50_000
  func supports(_ key: String) -> Bool { bootstrap?.capabilities[key]?.supported == true }
  func reason(_ key: String) -> String {
    bootstrap?.capabilities[key]?.reason
      ?? "This capability is unavailable from the connected Hermes installation."
  }
  var scope: String? {
    guard let user = bootstrap?.user.id, let api else { return nil }
    return Data((api.baseURL.absoluteString + "|" + user).utf8).base64URLEncoded
  }
  func key(_ kind: String, _ bot: String? = nil) -> String? {
    scope.map { "native.\($0).\(kind)\(bot.map { ".\($0)" } ?? "")" }
  }
  private func read<T: Decodable>(_ key: String?) -> T? {
    guard let key, let data = UserDefaults.standard.data(forKey: key) else { return nil }
    return try? JSONDecoder().decode(T.self, from: data)
  }
  private func save<T: Encodable>(_ value: T?, _ key: String?) {
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
      UserDefaults.standard.set(host, forKey: "connection.host")
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
        let session = ASWebAuthenticationSession(url: url.url!, callbackURLScheme: "agentinterface")
        { url, error in
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
        result.expiresAt, forKey: "connection.expiry.\(api.baseURL.absoluteString)")
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
      let expiry = UserDefaults.standard.string(
        forKey: "connection.expiry.\(api.baseURL.absoluteString)"),
      let date = ServerDate.parse(expiry), date.timeIntervalSinceNow < 60
    {
      sessionExpired = true
      stopStream()
      error =
        "Your sign-in is expiring. Sign in again to keep using this server. Your drafts are saved."
      return false
    }
    watchRoster()
    watchConversation()
    await refreshBootstrap(ifDue: true)
    if conversationDue { await refreshConversation() }
    await reconcilePending()
    // Files added while the connection was down start once it returns, as on the web.
    if connected, !uploading, attachmentUploads.contains(where: { $0.status == .queued }) {
      Task { await self.drainUploads() }
    }
    return true
  }
  private func hearReplies(in value: Conversation, botId id: String) {
    let (next, reply) = ReplyWatch.next(replyWatch ?? ReplyWatch(), value, baseline: replyWatch == nil)
    replyWatch = next
    guard let reply else { return }
    announcements += 1
    replyAnnouncement = ReplyAnnouncement(id: announcements, botId: id, text: ReplyWatch.snippet(reply.text))
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
      eventBotId == selectedBotId, now() - heard < Self.streamSilence
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
  /// Follows the selected assistant's change stream, reconnecting with a growing delay.
  private func watchConversation() {
    guard eventBotId != selectedBotId || eventTask == nil else { return }
    eventTask?.cancel()
    streamHeardAt = nil
    eventBotId = selectedBotId
    latestInflight = nil
    guard let id = selectedBotId, let api else { eventTask = nil; return }
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
    do {
      var value: Bootstrap = try await api.get("/bootstrap?roster=lean")
      guard generation == currentGeneration else { return }
      if let previous = bootstrap, previous.user.id == value.user.id, !value.connection.connected {
        value.bots = previous.bots
      }
      if let previous = bootstrap, previous.user.id != value.user.id {
        persistDraft()
        draftTask?.cancel()
        scheduledDraftSave = nil
        selectionGeneration = UUID()
        generation = UUID()
        selectedBotId = nil
        stayHome = false
        conversation = nil
        conversationCache.removeAll()
        historyStarts.removeAll()
        earlierFileCache.removeAll()
        draft = Draft()
        draftReady = false
        pendings = [:]
        receipts = [:]
        sending = false
        uploading = false
        clearUploads()
        interruptionReviewed = false
        resetUpgrade()
        resetPreferenceSaves()
      }
      bootstrap = value
      api.csrf = value.csrfToken
      Task { await self.drainUploads() }
      appUnavailable = false
      failures = 0
      loadPendings(value.bots)
      if let open = selectedBotId, value.connection.connected, !value.bots.contains(where: { $0.id == open }) {
        await leave(open)
      } else if !stayHome, selectedBotId == nil || !value.bots.contains(where: { $0.id == selectedBotId }) {
        let last: String? = read(key("selected"))
        let next =
          value.bots.first { $0.id == last }?.id ?? value.bots.first {
            $0.id == value.preferences.defaultBotId
          }?.id ?? value.bots.first?.id
        await select(next, navigate: false)
      }
    } catch is CancellationError {} catch {
      guard generation == currentGeneration else { return }
      failures += 1
      appUnavailable = true
      report(error)
    }
  }
  /// Another member made the open assistant personal, or it was deleted: return home and stop asking for it.
  func leave(_ id: String) async {
    for upload in attachmentUploads.filter({ $0.botId == id }) { removeUpload(upload.id) }
    conversationCache[id] = nil
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
    selectedBotId = id
    if id != nil && navigate { conversationRequest = UUID() }
    conversation = id.flatMap { conversationCache[$0] }
    draftReady = false
    interruptionReviewed = false
    receipt = pending?.botId == id ? receipt : nil
    save(id, key("selected"))
    guard let id, let api, bootstrap != nil else {
      draft = Draft()
      return
    }
    let cached: Draft? = read(key("draft", id))
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
    do {
      let value: Conversation = try await api.get(conversationPath(id, query: query))
      guard selectedGeneration == selectionGeneration, requestedWindow == windowGeneration,
        read > appliedConversationRead
      else { return }
      appliedConversationRead = read
      hearReplies(in: value, botId: id)
      historyStarts[id] = value.messages.first?.id
      conversationRefreshedAt = now()
      apply(value, botId: id)
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
  /// Every file the open conversation knows, oldest first, with where it came from.
  var conversationArtifacts: [Artifact] {
    Artifacts.list(conversation, earlier: currentEarlierFiles?.messages ?? [])
  }
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
    let value = latestInflight?.applying(to: value) ?? value
    if conversation?.activity.runId != value.activity.runId
      || conversation?.activity.state != .interrupted && value.activity.state == .interrupted
    {
      interruptionReviewed = false
    }
    // An unchanged poll leaves the transcript alone instead of rendering it again.
    if conversation != value { conversation = value }
    conversationCache[id] = value
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
    draft.text = value.text
    draft.attachments = value.attachments
    draft.dirty = true
    draft.seq = nextDraftSeq(selectedBotId)
    persistDraft()
    draftTask?.cancel()
    scheduledDraftSave = nil
    guard draftReady, let botId = selectedBotId else { return }
    let token = UUID()
    scheduledDraftSave = token
    draftTask = Task {
      try? await Task.sleep(for: .milliseconds(600))
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
    guard sent == nil || sent?.text != snapshot.text || sent?.attachments != snapshot.attachments
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
    if draftReady, draft.dirty == true, let botId = selectedBotId, let localKey = key("draft", botId),
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
  private var draftSavesInFlight: [String: [Int]] = [:]
  /// Consecutive failed saves per cached draft, for the retry backoff: 1 s, 2 s, 4 s, up to 30 s.
  private var draftSaveFailures: [String: Int] = [:]
  /// When a failed draft may retry. Until then only a new edit saves it, not a poll.
  private var draftRetryAt: [String: ContinuousClock.Instant] = [:]
  /// The last edit sequence per cached draft, for the life of the store. A copy adopted from the
  /// server forgets its own, so a new edit never reuses one an older save in flight carries.
  private var draftSeqs: [String: Int] = [:]
  private func nextDraftSeq(_ botId: String?) -> Int {
    let localKey = botId.flatMap { key("draft", $0) } ?? ""
    let next = max(draftSeqs[localKey] ?? 0, draft.seq ?? 0) + 1
    draftSeqs[localKey] = next
    return next
  }
  private func settled(_ botId: String) -> Bool { key("draft", botId).map { draftSavesInFlight[$0] == nil } ?? true }
  /// Saves a draft on its base revision, then merges the response into the open copy and the
  /// cached copy as they are now. Kept edits after a conflict save again on the new base.
  private func saveDraft(_ snapshot: Draft, botId: String, retries: Int = 3) async throws {
    guard let api, let localKey = key("draft", botId) else { return }
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
      draftRetryAt[localKey] = .now + delay
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
    if !conflict || next?.dirty != true { save(Optional<Bool>.none, key("recovered", botId)) }
    ensureDraftSaved(botId, retries: retries - 1)
  }
  /// The one rule after every response or merge: a copy left unsaved, with no save in flight or
  /// waiting, saves again.
  private func ensureDraftSaved(_ botId: String, retries: Int = 3) {
    guard settled(botId), let localKey = key("draft", botId) else { return }
    // A failing save retries on its backoff, however often the conversation polls.
    if let retryAt = draftRetryAt[localKey], ContinuousClock.now < retryAt { return }
    if selectedBotId == botId && draftReady {
      if draft.dirty == true, scheduledDraftSave == nil { startDraftSave(botId: botId) }
    } else if let cached: Draft = read(localKey), cached.dirty == true, retries > 0 {
      Task { try? await self.saveDraft(cached, botId: botId, retries: retries) }
    }
  }
  private func persistDraft() {
    if draftReady, let botId = selectedBotId { save(draft, key("draft", botId)) }
  }
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
    save(submission, key("pending", id))
    // Until the server shows the send, a save of the sent text from this copy is not new work.
    markSent(submission, true)
    sending = true
    error = nil
    let currentGeneration = generation
    defer { if currentGeneration == generation { sending = false } }
    do {
      let value: Receipt = try await api.write(
        "/bots/\(APIClient.component(id))/messages", submission)
      guard currentGeneration == generation else { return }
      await handleReceipt(value, botId: id)
      if value.status == "accepted" { Task { await LiveActivityController.shared.sent(to: id) } }
    } catch {
      guard currentGeneration == generation else { return }
      report(error)
      // As on the web, any answer below 500 is the server refusing the message. That includes 408:
      // the server stopped waiting for the request before handling it.
      if let failure = error as? APIError, (400..<500).contains(failure.status) {
        clearPending(id)
        markSent(submission, false)
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
  func reconcilePending() async {
    guard let api, !sending else { return }
    let currentGeneration = generation
    for pending in pendings.values.sorted(by: { $0.botId < $1.botId }) {
      do {
        let value: Receipt = try await api.get(
          "/submissions/\(APIClient.component(pending.requestId))")
        guard currentGeneration == generation, !sending else { return }
        await handleReceipt(value, botId: pending.botId)
      } catch {
        if currentGeneration == generation { report(error) }
        return
      }
    }
  }
  private func clearPending(_ botId: String) {
    pendings[botId] = nil
    save(Optional<PendingSubmission>.none, key("pending", botId))
  }
  /// Reads each assistant's unconfirmed send. One saved by an older version, which held a single
  /// send for every assistant, moves to its own assistant.
  private func loadPendings(_ bots: [Bot]) {
    if let legacy: PendingSubmission = read(key("pending")) {
      let current: PendingSubmission? = read(key("pending", legacy.botId))
      if current == nil { save(legacy, key("pending", legacy.botId)) }
      save(Optional<PendingSubmission>.none, key("pending"))
    }
    for bot in bots where pendings[bot.id] == nil {
      if let stored: PendingSubmission = read(key("pending", bot.id)) { pendings[bot.id] = stored }
    }
  }
  private func handleReceipt(_ value: Receipt, botId: String) async {
    receipts[botId] = value
    guard let original = pendings[botId], value.requestId == original.requestId else { return }
    guard value.status != "uncertain" else { return }
    if value.status == "accepted" {
      // The server clears its copy for this send, which a later save here must not mistake
      // for a send from another device.
      if selectedBotId == original.botId && draftReady {
        if draft.text == original.text && draft.attachments == original.attachments {
          draftTask?.cancel()
          scheduledDraftSave = nil
        }
        draft = draft.sent(original)
        persistDraft()
      } else {
        let draftKey = key("draft", original.botId)
        if let cached: Draft = read(draftKey) { save(cached.sent(original), draftKey) }
      }
    }
    if value.status == "rejected" || value.status == "interrupted" { markSent(original, false) }
    clearPending(botId)
  }
  /// Records or forgets, on the copy it came from, the text this device sent.
  private func markSent(_ submission: PendingSubmission, _ sent: Bool) {
    let hash = sent ? Draft.contentHash(submission.text, submission.attachments) : nil
    let base = sent ? submission.draftBaseRevision ?? 0 : nil
    if let localKey = key("draft", submission.botId), var cached: Draft = read(localKey) {
      cached.sentHash = hash
      cached.sentBase = base
      save(cached, localKey)
    }
    if selectedBotId == submission.botId {
      draft.sentHash = hash
      draft.sentBase = base
      persistDraft()
    }
  }
  /// Gives up on a send the server never confirmed, for example one that was lost before it
  /// arrived. The message may still show up, so its text and attachments go back into the
  /// draft of the assistant it was written for, where the person decides whether to send again.
  /// Without an assistant, it is the open assistant's send.
  func discardUnconfirmedSubmission(botId: String? = nil) {
    guard let id = botId ?? selectedBotId, let old = pendings[id], !sending,
      let localKey = key("draft", old.botId)
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
    save(true, key("recovered", old.botId))
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
    var next = draft
    next.text =
      next.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? text : next.text + "\n" + text
    updateDraft(next)
    return true
  }
  /// Shows the draft once a read returns, merged with this device's copy. Unsaved edits that
  /// survive the merge, such as a draft recovered by Discard, then save on their base revision,
  /// so the server refuses them if it moved on.
  private func loadDraft(_ remote: SavedDraft?, botId: String) {
    let merged = Draft.merge(draftReady ? draft : read(key("draft", botId)) ?? draft, with: remote, settled: settled(botId))
    let changed = merged.draft != draft
    draft = merged.draft
    draftReady = true
    clearDraftLoadFailure()
    if changed { persistDraft() }
    if draft.dirty != true { save(Optional<Bool>.none, key("recovered", botId)) }
    ensureDraftSaved(botId)
  }
  /// Puts a pending message back in front of whatever the person has typed since.
  static func draft(restoring old: PendingSubmission, into current: Draft) -> Draft {
    var next = current
    if !next.text.contains(old.text) {
      next.text = [old.text, next.text].filter { !$0.isEmpty }.joined(separator: "\n\n")
    }
    next.attachments =
      old.attachments + next.attachments.filter { file in !old.attachments.contains { $0.id == file.id } }
    return next
  }
  func reconnect() async {
    guard let api else { return }
    let currentGeneration = generation
    do {
      let _: RuntimeStatus = try await api.write("/connection/retry", [String: String]())
      guard currentGeneration == generation else { return }
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
  func attachUnavailable(_ botId: String) -> String? {
    if !supports("uploads") {
      let reason = bootstrap?.capabilities["uploads"]?.reason ?? ""
      return reason.isEmpty ? "Hermes can't receive files right now." : reason
    }
    if !draftReady || selectedBotId != botId { return "Your draft is still loading." }
    if attachmentSlots(botId) <= 0 { return "A message can carry up to \(UploadRules.maxAttachments) attachments." }
    return nil
  }
  private func attachmentSlots(_ botId: String) -> Int {
    UploadRules.maxAttachments - draft.attachments.count - attachmentUploads.filter { $0.botId == botId }.count
  }
  /// Adds files to the open assistant's draft as the web composer does: every file that can't be
  /// attached is named in one notice, with its size and the limit, and the rest upload in order.
  func attach(urls: [URL], problems earlier: [String] = []) async {
    guard !urls.isEmpty || !earlier.isEmpty, let id = selectedBotId else { return }
    if let reason = attachUnavailable(id) { attachNotice = [reason]; return }
    let slots = attachmentSlots(id)
    var problems = earlier
    var accepted = 0
    var staged = false
    for url in urls {
      let accessed = url.startAccessingSecurityScopedResource()
      defer { if accessed { url.stopAccessingSecurityScopedResource() } }
      let name = url.lastPathComponent
      do {
        let resource = try url.resourceValues(forKeys: [.fileSizeKey, .contentTypeKey])
        let size = resource.fileSize ?? 0
        let mime: String
        switch UploadRules.prepare(name: name, mime: UploadRules.mime(of: url, contentType: resource.contentType), size: size) {
        case .failure(let problem): problems.append(problem.message); continue
        case .success(let value): mime = value
        }
        accepted += 1
        guard accepted <= slots else { continue }
        // The picked file may be gone once the picker closes, so upload a private copy.
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("upload-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let copy = directory.appendingPathComponent(name)
        do { try FileManager.default.copyItem(at: url, to: copy) }
        catch { try? FileManager.default.removeItem(at: directory); throw error }
        attachmentUploads.append(AttachmentUpload(botId: id, url: copy, name: name, mime: mime, size: size))
        staged = true
      } catch {
        problems.append("\(name) can't be attached. \(error.localizedDescription)")
      }
    }
    if accepted > slots {
      let left = accepted - slots
      problems.append("A message can carry up to \(UploadRules.maxAttachments) attachments, so \(left) of these \(left == 1 ? "wasn't" : "weren't") added.")
    }
    attachNotice = problems
    if staged { await drainUploads() }
  }
  /// Attaches images that exist only in memory: a paste, a new photo or a library pick. Each gets
  /// a readable name, such as "Pasted image 14.03.22.png", and formats the server cannot take,
  /// such as HEIC, are converted.
  func attach(images: [Data], named prefix: String) async {
    guard !images.isEmpty else { return }
    let now = Date()
    var urls: [URL] = []
    var problems: [String] = []
    for (index, data) in images.enumerated() {
      do {
        let image = try Self.uploadableImage(data)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("image-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent(UploadRules.imageName(prefix, at: now, index: index, ext: image.ext))
        try image.data.write(to: url, options: .atomic)
        urls.append(url)
      } catch {
        let name = UploadRules.imageName(prefix, at: now, index: index, ext: "png")
        problems.append(data.count > UploadRules.maxBytes
          ? "\(name) is \(UploadRules.formatBytes(data.count)). Each attachment can be up to \(UploadRules.formatBytes(UploadRules.maxBytes))."
          : "\(name) can't be attached. Use \(UploadRules.kinds).")
      }
    }
    await attach(urls: urls, problems: problems)
    for url in urls { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
  }
  /// GIFs keep their animation; other images go through the share extension's conversion.
  private static func uploadableImage(_ data: Data) throws -> (data: Data, ext: String) {
    if let source = CGImageSourceCreateWithData(data as CFData, nil),
      let type = CGImageSourceGetType(source).flatMap({ UTType($0 as String) }), type == .gif,
      data.count <= UploadRules.maxBytes
    { return (data, "gif") }
    return try ShareImage.prepare(data)
  }
  /// Cancels a file still uploading, or removes one that failed.
  func removeUpload(_ id: UUID) {
    uploadTasks.removeValue(forKey: id)?.cancel()
    forgetUpload(id)
  }
  /// Drops a file's entry and private copy without touching its upload, which may be the caller.
  private func forgetUpload(_ id: UUID) {
    guard let upload = attachmentUploads.first(where: { $0.id == id }) else { return }
    try? FileManager.default.removeItem(at: upload.url.deletingLastPathComponent())
    attachmentUploads.removeAll { $0.id == id }
  }
  private func clearUploads() { for id in attachmentUploads.map(\.id) { removeUpload(id) } }
  func retryUpload(_ uploadId: UUID) async {
    guard let index = attachmentUploads.firstIndex(where: { $0.id == uploadId }),
      attachmentUploads[index].status == .failed
    else { return }
    attachmentUploads[index].status = .queued
    attachmentUploads[index].progress = 0
    attachmentUploads[index].error = nil
    await drainUploads()
  }
  /// Uploads queued files one at a time, in the order they were added. A failed attempt always
  /// waits for explicit Retry; a file queued while disconnected starts once the connection returns.
  func drainUploads() async {
    guard !uploading, connected, api != nil else { return }
    let currentGeneration = generation
    uploading = true
    defer { if currentGeneration == generation { uploading = false } }
    while currentGeneration == generation, connected,
      let next = attachmentUploads.first(where: { $0.status == .queued }) {
      let task = Task { await self.uploadAttachment(next.id) }
      uploadTasks[next.id] = task
      await task.value
      uploadTasks[next.id] = nil
    }
  }
  private func uploadAttachment(_ uploadId: UUID) async {
    guard let api, let index = attachmentUploads.firstIndex(where: { $0.id == uploadId }) else { return }
    let upload = attachmentUploads[index]
    attachmentUploads[index].status = .uploading
    attachmentUploads[index].progress = 0
    attachmentUploads[index].error = nil
    let currentGeneration = generation
    do {
      let data = try Data(contentsOf: upload.url)
      var file = try await api.upload(botId: upload.botId, name: upload.name, mime: upload.mime, data: data) { [weak self] sent in
        guard let self, currentGeneration == self.generation,
          let index = self.attachmentUploads.firstIndex(where: { $0.id == uploadId })
        else { return }
        self.attachmentUploads[index].record(sent: sent)
      }
      guard currentGeneration == generation, attachmentUploads.contains(where: { $0.id == uploadId }) else { return }
      if file.size == nil { file.size = upload.size }
      // No network replay: Retry uploads only this file and never sends the message.
      if selectedBotId == upload.botId && draftReady {
        var next = draft; next.attachments.append(file); updateDraft(next)
        forgetUpload(uploadId)
      } else {
        let localKey = key("draft", upload.botId)
        var target: Draft = read(localKey) ?? Draft()
        target.attachments.append(file); target.dirty = true; target.seq = (target.seq ?? 0) + 1
        save(target, localKey)
        // A draft read already in flight must merge this cached attachment, not replace it.
        if selectedBotId == upload.botId { draft = target }
        forgetUpload(uploadId)
        try await saveDraft(target, botId: upload.botId)
      }
    } catch is CancellationError {
    } catch {
      guard currentGeneration == generation else { return }
      if let index = attachmentUploads.firstIndex(where: { $0.id == uploadId }) {
        attachmentUploads[index].status = .failed
        attachmentUploads[index].error = error.localizedDescription
      } else { report(error) }
    }
  }
  func attachAppleSnapshot(_ data: Data, botId: String) async throws {
    guard let api, connected, supports("uploads"), !uploading, !sending, pendings[botId] == nil, bootstrap?.bots.contains(where: { $0.id == botId }) == true else {
      throw APIError(message: "Reconnect to this assistant before sharing a snapshot.", status: 409)
    }
    let currentGeneration = generation
    let localKey = key("draft", botId)
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
    uploading = true
    defer { if currentGeneration == generation { uploading = false; Task { await self.drainUploads() } } }
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
      try? SecureToken.save(nil, host: api.baseURL.absoluteString)
      api.token = nil
      api.csrf = nil
      if !revoked {
        self.error =
          "Signed out on this device only. The server could not be reached, so this device's session stays valid there until it expires, and notifications may still be delivered. Sign in on that server again to revoke it."
      }
    }
    stopPolling()
    draftTask?.cancel()
    scheduledDraftSave = nil
    fileTask?.cancel()
    generation = UUID()
    selectionGeneration = UUID()
    bootstrap = nil
    conversation = nil
    conversationCache.removeAll()
    historyStarts.removeAll()
    earlierFileCache.removeAll()
    bootstrapRefreshedAt = nil
    selectedBotId = nil
    stayHome = false
    notice = nil
    draft = Draft()
    draftReady = false
    pendings = [:]
    receipts = [:]
    sending = false
    uploading = false
    clearUploads()
    attachNotice = []
    appUnavailable = false
    sessionExpired = false
    resetUpgrade()
    resetPreferenceSaves()
    return true
  }
  private func resetUpgrade() {
    upgradeStatus = nil
    upgradeBusy = false
    upgradeError = nil
    upgradeInstallUncertain = false
    upgradeSubmitting = false
    computerStatus = nil
    upgradeRequest = nil
  }
  /// A failed read keeps the last known status, like the web panel, which only notes it can't reach the computer.
  func refreshComputer() async {
    guard let api, api.token != nil, !sessionExpired else { return }
    let currentGeneration = generation
    guard let value: ComputerStatus = try? await api.get("/computer"), currentGeneration == generation else { return }
    computerStatus = value
  }
  func refreshUpgrade() async {
    await upgradeOperation(nil)
  }
  func checkUpgrade() async {
    guard upgradeStatus?.canCheck == true else { return }
    await upgradeOperation("check")
  }
  func installUpgrade(candidateRevision: String) async {
    guard upgradeStatus?.canInstall == true, !upgradeInstallUncertain,
      upgradeStatus?.candidate?.revision == candidateRevision else { return }
    if upgradeRequest?.candidateRevision != candidateRevision {
      upgradeRequest = UpgradeInstallRequest(candidateRevision: candidateRevision, requestId: UUID().uuidString)
    }
    await upgradeOperation("install")
  }
  func controlUpgrade(_ action: String, operationId: String) async {
    guard let status = upgradeStatus, status.operationId == operationId, !upgradeInstallUncertain else { return }
    let permitted = action == "retry" ? status.canRetry : action == "cancel" ? status.canCancel : action == "restart_service" ? status.canRestartService : false
    guard permitted == true else { return }
    await upgradeOperation(action)
  }
  private func upgradeOperation(_ action: String?) async {
    guard let api, api.token != nil, !sessionExpired, !upgradeBusy else { return }
    let currentGeneration = generation
    upgradeBusy = true
    upgradeSubmitting = action != nil
    defer { if currentGeneration == generation { upgradeBusy = false; upgradeSubmitting = false } }
    do {
      let value: UpgradeStatus
      if action == "install", let upgradeRequest {
        value = try await api.write("/hermes/upgrade/install", upgradeRequest)
      } else if let action, ["retry", "cancel", "restart_service"].contains(action), let operationId = upgradeStatus?.operationId {
        value = try await api.write("/hermes/upgrade/control", UpgradeControlRequest(action: action, operationId: operationId, requestId: UUID().uuidString))
      } else if action == "check" {
        value = try await api.write("/hermes/upgrade/check", [String: String]())
      } else {
        value = try await api.get("/hermes/upgrade")
      }
      guard currentGeneration == generation else { return }
      upgradeStatus = value
      upgradeError = nil
      upgradeInstallUncertain = false
      if ["succeeded", "failed", "rolled_back"].contains(value.phase) { upgradeRequest = nil }
    } catch {
      guard currentGeneration == generation, !(error is CancellationError) else { return }
      let status = (error as? APIError)?.status
      if status == 401 { report(error) }
      if status == 404 {
        upgradeError = "This app server doesn't support Hermes updates yet. Ask the self-hoster to update the app server."
      } else {
        upgradeError = error.localizedDescription
      }
      if action != nil, status == nil || status == 0 || (status ?? 0) >= 500 {
        upgradeInstallUncertain = true
        upgradeError = "The update request may have reached the server. Refresh its status before trying again. \(error.localizedDescription)"
      }
    }
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
