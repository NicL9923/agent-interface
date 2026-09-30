import AuthenticationServices
import SwiftUI
import UniformTypeIdentifiers

@MainActor
final class AppStore: NSObject, ObservableObject, ASWebAuthenticationPresentationContextProviding {
  @Published var host = UserDefaults.standard.string(forKey: "connection.host") ?? ""
  @Published var api: APIClient?
  @Published var bootstrap: Bootstrap?
  @Published var conversation: Conversation?
  @Published var selectedBotId: String?
  @Published var draft = Draft()
  @Published var draftReady = false
  @Published var pending: PendingSubmission?
  @Published var receipt: Receipt?
  @Published var error: String?
  @Published var signingIn = false
  @Published var loading = false
  @Published var sending = false
  @Published var uploading = false
  @Published var appUnavailable = false
  @Published var interruptionReviewed = false
  @Published var authConfig: AuthConfig?
  @Published var sessionExpired = false
  @Published var notificationStatus = "Notifications are off"
  @Published var openedFile: PreviewFile?
  @Published var upgradeStatus: UpgradeStatus?
  @Published var upgradeBusy = false
  @Published var upgradeError: String?
  @Published var upgradeInstallUncertain = false
  private var upgradeRequest: UpgradeInstallRequest?
  private var authSession: ASWebAuthenticationSession?
  private var pollTask: Task<Void, Never>?
  private var draftTask: Task<Void, Never>?
  private var conversationCache: [String: Conversation] = [:]
  private var generation = UUID()
  private var selectionGeneration = UUID()
  private var fileTask: Task<Void, Never>?
  private var failures = 0
  var bot: Bot? { bootstrap?.bots.first { $0.id == selectedBotId } }
  var connected: Bool {
    bootstrap?.connection.connected == true && !appUnavailable && !sessionExpired
  }
  var activity: ActivityState {
    connected ? conversation?.activity.state ?? bot?.activity ?? .idle : .disconnected
  }
  var active: Bool { activity.active }
  var canSend: Bool {
    draftReady && connected && !sending && !uploading && pending == nil
      && (draft.text.count <= 50000)
      && (!draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        || !draft.attachments.isEmpty)
      && supports(active ? "steering" : "chat")
      && (activity != .interrupted || interruptionReviewed)
  }
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

  func restore() async {
    guard !host.isEmpty else { return }
    do {
      let url = try ConnectionAddress.parse(host)
      api = APIClient(baseURL: url)
      authConfig = try await api?.publicGet("/auth/config")
      guard authConfig?.nativeAuthVersion == 1 else {
        throw APIError(
          message: "Update this app server to a version with native iOS sign-in support.",
          status: 409)
      }
      if api?.token != nil {
        await refreshBootstrap()
        startPolling()
      }
    } catch { report(error) }
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
      guard authConfig?.nativeAuthVersion == 1 else {
        throw APIError(message: "Update the app server to support native iOS sign-in.", status: 409)
      }
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
    pollTask?.cancel()
    pollTask = Task { [weak self] in
      while !Task.isCancelled {
        guard let self else { return }
        if let api = self.api,
          let expiry = UserDefaults.standard.string(
            forKey: "connection.expiry.\(api.baseURL.absoluteString)"),
          let date = ServerDate.parse(expiry), date.timeIntervalSinceNow < 60
        {
          self.sessionExpired = true
          self.error =
            "Your sign-in is expiring. Sign in again to keep using this server. Your drafts are saved."
          return
        }
        await self.refreshBootstrap()
        await self.refreshConversation()
        await self.reconcilePending()
        let seconds = self.failures == 0 ? 1.5 : min(30, pow(2, Double(min(self.failures, 5))))
        try? await Task.sleep(for: .seconds(seconds))
      }
    }
  }
  func suspend() {
    pollTask?.cancel()
    pollTask = nil
    persistDraft()
    draftTask?.cancel()
  }
  func refreshBootstrap() async {
    guard let api, api.token != nil else { return }
    let currentGeneration = generation
    do {
      var value: Bootstrap = try await api.get("/bootstrap")
      guard generation == currentGeneration else { return }
      if let previous = bootstrap, previous.user.id == value.user.id, !value.connection.connected {
        value.bots = previous.bots
      }
      if let previous = bootstrap, previous.user.id != value.user.id {
        persistDraft()
        draftTask?.cancel()
        selectionGeneration = UUID()
        generation = UUID()
        selectedBotId = nil
        conversation = nil
        conversationCache.removeAll()
        draft = Draft()
        draftReady = false
        pending = nil
        receipt = nil
        sending = false
        uploading = false
        interruptionReviewed = false
        resetUpgrade()
      }
      bootstrap = value
      api.csrf = value.csrfToken
      appUnavailable = false
      failures = 0
      if pending == nil { pending = read(key("pending")) }
      if selectedBotId == nil || !value.bots.contains(where: { $0.id == selectedBotId }) {
        let last: String? = read(key("selected"))
        let next =
          value.bots.first { $0.id == last }?.id ?? value.bots.first {
            $0.id == value.preferences.defaultBotId
          }?.id ?? value.bots.first?.id
        await select(next)
      }
    } catch is CancellationError {} catch {
      guard generation == currentGeneration else { return }
      failures += 1
      appUnavailable = true
      report(error)
    }
  }
  func select(_ id: String?) async {
    persistDraft()
    draftTask?.cancel()
    selectionGeneration = UUID()
    selectedBotId = id
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
    let selectedGeneration = selectionGeneration
    do {
      let remote: Draft? = try await api.get("/bots/\(APIClient.component(id))/draft")
      guard selectionGeneration == selectedGeneration else { return }
      if cached?.dirty != true { draft = remote ?? cached ?? Draft() }
      draftReady = true
      await refreshConversation()
    } catch {
      guard selectionGeneration == selectedGeneration else { return }
      draftReady = cached != nil
      report(error)
    }
  }
  func refreshConversation() async {
    guard let id = selectedBotId, let api, bootstrap != nil else { return }
    let selectedGeneration = selectionGeneration
    do {
      let value: Conversation = try await api.get("/bots/\(APIClient.component(id))/conversation")
      guard selectedGeneration == selectionGeneration else { return }
      if conversation?.activity.runId != value.activity.runId
        || conversation?.activity.state != .interrupted && value.activity.state == .interrupted
      {
        interruptionReviewed = false
      }
      conversation = value
      conversationCache[id] = value
      if !draftReady {
        draft = value.draft ?? Draft()
        draftReady = true
      }
    } catch is CancellationError {} catch {
      if selectedGeneration == selectionGeneration {
        appUnavailable = true
        failures += 1
        report(error)
      }
    }
  }
  func updateDraft(_ value: Draft) {
    draft = value
    draft.dirty = true
    persistDraft()
    draftTask?.cancel()
    guard draftReady, let api, let botId = selectedBotId, let localKey = key("draft", botId) else {
      return
    }
    let snapshot = draft
    let currentGeneration = generation
    draftTask = Task {
      do {
        try await Task.sleep(for: .milliseconds(600))
        guard !Task.isCancelled,
          self.pending?.botId != botId || self.pending?.text != snapshot.text
            || self.pending?.attachments != snapshot.attachments
        else { return }
        let _: Draft = try await api.write(
          "/bots/\(APIClient.component(botId))/draft", snapshot, method: "PUT")
        guard currentGeneration == self.generation else { return }
        if self.draft == snapshot && self.selectedBotId == botId {
          self.draft.dirty = false
          self.persistDraft()
        } else {
          var cached: Draft? = self.read(localKey)
          if cached == snapshot {
            cached?.dirty = false
            self.save(cached, localKey)
          }
        }
      } catch is CancellationError {} catch {
        if currentGeneration == self.generation { self.report(error) }
      }
    }
  }
  private func persistDraft() {
    if draftReady, let botId = selectedBotId { save(draft, key("draft", botId)) }
  }
  func send(reviewedUncertain: Bool = false) async {
    guard let api, let id = selectedBotId, !sending else { return }
    let submission: PendingSubmission
    if reviewedUncertain, var old = pending, old.botId == id {
      old.reviewedUncertain = true
      submission = old
    } else {
      guard canSend else { return }
      submission = PendingSubmission(
        requestId: UUID().uuidString.lowercased(), botId: id, text: draft.text,
        attachments: draft.attachments, reviewedInterruption: interruptionReviewed)
    }
    pending = submission
    save(submission, key("pending"))
    sending = true
    error = nil
    let currentGeneration = generation
    defer { if currentGeneration == generation { sending = false } }
    do {
      let value: Receipt = try await api.write(
        "/bots/\(APIClient.component(id))/messages", submission)
      guard currentGeneration == generation else { return }
      await handleReceipt(value)
    } catch {
      guard currentGeneration == generation else { return }
      report(error)
      if let failure = error as? APIError, (400..<500).contains(failure.status),
        failure.status != 408
      {
        pending = nil
        save(Optional<PendingSubmission>.none, key("pending"))
        receipt = Receipt(
          requestId: submission.requestId, status: "rejected", message: failure.message)
      } else {
        receipt = Receipt(
          requestId: submission.requestId, status: "uncertain",
          message:
            "Checking whether Hermes accepted this message. The original request ID is preserved.")
      }
    }
    await refreshConversation()
  }
  func reconcilePending() async {
    guard let pending, let api, !sending else { return }
    let currentGeneration = generation
    do {
      let value: Receipt = try await api.get(
        "/submissions/\(APIClient.component(pending.requestId))")
      guard currentGeneration == generation else { return }
      await handleReceipt(value)
    } catch { if currentGeneration == generation { report(error) } }
  }
  private func handleReceipt(_ value: Receipt) async {
    receipt = value
    guard let original = pending, value.requestId == original.requestId else { return }
    guard value.status != "uncertain" else { return }
    if value.status == "accepted" {
      if selectedBotId == original.botId && draft.text == original.text
        && draft.attachments == original.attachments
      {
        draftTask?.cancel()
        draft = Draft(dirty: false)
        persistDraft()
      } else {
        let draftKey = key("draft", original.botId)
        let cached: Draft? = read(draftKey)
        if cached?.text == original.text && cached?.attachments == original.attachments {
          save(Draft(dirty: false), draftKey)
        }
      }
    }
    pending = nil
    save(Optional<PendingSubmission>.none, key("pending"))
  }
  func acknowledgeInterruptedSubmission() {
    pending = nil
    save(Optional<PendingSubmission>.none, key("pending"))
    receipt = nil
    interruptionReviewed = true
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
  func setPreferences(_ value: Preferences) async {
    guard let api else { return }
    let currentGeneration = generation
    do {
      let saved: Preferences = try await api.write("/preferences", value, method: "PATCH")
      guard currentGeneration == generation else { return }
      bootstrap?.preferences = saved
    } catch { if currentGeneration == generation { report(error) } }
  }
  func markRead(_ messageId: String?) {
    guard let id = selectedBotId, let api else { return }
    let position = ReadPosition(messageId: messageId)
    let currentGeneration = generation
    save(position, key("read", id))
    Task {
      do {
        let _: ReadPosition = try await api.write(
          "/bots/\(APIClient.component(id))/read-position", position, method: "PUT")
      } catch { if currentGeneration == self.generation { self.report(error) } }
    }
  }
  func readMessageId() -> String? {
    let local: ReadPosition? = read(key("read", selectedBotId))
    return conversation?.readPosition?.messageId ?? local?.messageId
  }
  func attach(urls: [URL]) async {
    guard let api, let id = selectedBotId, draftReady, !uploading else { return }
    guard draft.attachments.count + urls.count <= 10 else {
      error = "Attach up to 10 files per message."
      return
    }
    let currentGeneration = generation
    uploading = true
    defer { if currentGeneration == generation { uploading = false } }
    let localKey = key("draft", id)
    for url in urls {
      let accessed = url.startAccessingSecurityScopedResource()
      defer { if accessed { url.stopAccessingSecurityScopedResource() } }
      do {
        let resource = try url.resourceValues(forKeys: [.fileSizeKey, .contentTypeKey])
        guard (resource.fileSize ?? 0) <= 20 * 1024 * 1024 else {
          throw APIError(message: "Files must be no larger than 20 MB.", status: 400)
        }
        let mime =
          resource.contentType?.preferredMIMEType ?? UTType(filenameExtension: url.pathExtension)?
          .preferredMIMEType ?? "application/octet-stream"
        let file = try await api.upload(
          botId: id, name: url.lastPathComponent, mime: mime, data: Data(contentsOf: url))
        guard currentGeneration == generation else { return }
        if selectedBotId == id {
          var next = draft
          next.attachments.append(file)
          updateDraft(next)
        } else {
          var target: Draft = read(localKey) ?? Draft()
          target.attachments.append(file)
          target.dirty = true
          save(target, localKey)
          let _: Draft = try await api.write(
            "/bots/\(APIClient.component(id))/draft", target, method: "PUT")
        }
      } catch { if currentGeneration == generation { report(error) } }
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
  @discardableResult func signOut() async -> Bool {
    persistDraft()
    if let api, api.token != nil {
      do { let _: EmptyResponse = try await api.write("/auth/logout", [String: String]()) } catch {
        self.error =
          "Sign-out could not be completed. Reconnect and retry so this device's server session and notifications can be revoked. \(error.localizedDescription)"
        return false
      }
      try? SecureToken.save(nil, host: api.baseURL.absoluteString)
      api.token = nil
      api.csrf = nil
    }
    pollTask?.cancel()
    draftTask?.cancel()
    fileTask?.cancel()
    generation = UUID()
    selectionGeneration = UUID()
    bootstrap = nil
    conversation = nil
    conversationCache.removeAll()
    selectedBotId = nil
    draft = Draft()
    draftReady = false
    pending = nil
    receipt = nil
    sending = false
    uploading = false
    appUnavailable = false
    sessionExpired = false
    resetUpgrade()
    return true
  }
  private func resetUpgrade() {
    upgradeStatus = nil
    upgradeBusy = false
    upgradeError = nil
    upgradeInstallUncertain = false
    upgradeRequest = nil
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
  private func upgradeOperation(_ action: String?) async {
    guard let api, api.token != nil, !sessionExpired, !upgradeBusy else { return }
    let currentGeneration = generation
    upgradeBusy = true
    defer { if currentGeneration == generation { upgradeBusy = false } }
    do {
      let value: UpgradeStatus
      if action == "install", let upgradeRequest {
        value = try await api.write("/hermes/upgrade/install", upgradeRequest)
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
      if action == "install", status == nil || status == 0 || (status ?? 0) >= 500 {
        upgradeInstallUncertain = true
        upgradeError = "The update request may have reached the server. Refresh its status before trying again. \(error.localizedDescription)"
      }
    }
  }
  func changeConnection() async {
    if await signOut() {
      api = nil
      authConfig = nil
    }
  }
  func report(_ error: Error) {
    if error is CancellationError { return }
    self.error = error.localizedDescription
    if let apiError = error as? APIError, apiError.status == 401 {
      if let api { try? SecureToken.save(nil, host: api.baseURL.absoluteString) }
      api?.token = nil
      pollTask?.cancel()
      sessionExpired = true
    }
  }
}
struct PreviewFile: Identifiable {
  let id = UUID()
  var url: URL
}
