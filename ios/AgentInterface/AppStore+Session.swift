import AuthenticationServices
import SwiftUI

// Connecting to a server, signing in and out, and keeping the sign-in renewed.
extension AppStore {

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
          let expiry = UserDefaults.standard.string(forKey: DeviceDefaults.expiry(api.baseURL)),
          let expires = ServerDate.parse(expiry), expires > Date(),
          let snapshot = await OfflineLibrary.load(url), bootstrap == nil, self.api === api {
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
    suspended = false
    // The network may have changed while the app was away.
    if !sessionExpired { api?.checkRoutes(force: true) }
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
      let (code, pkce) = try await authorize(api: api)
      let result: TokenExchange = try await api.publicWrite(
        "/auth/native/exchange", ["code": code, "state": pkce.state, "codeVerifier": pkce.verifier])
      guard generation == authGeneration else { return }
      try SecureToken.save(result.token, host: api.baseURL.absoluteString)
      api.token = result.token
      sessionExpired = false
      renewalAttemptedAt = nil
      UserDefaults.standard.set(
        result.expiresAt, forKey: DeviceDefaults.expiry(api.baseURL))
      await refreshBootstrap()
      startPolling()
    } catch {
      guard generation == authGeneration else { return }
      if (error as? ASWebAuthenticationSessionError)?.code != .canceledLogin { report(error) }
    }
  }
  /// Runs the system sign-in browser and returns the one-time code with the PKCE request that
  /// owns it. `purpose` only changes the page's wording (`confirm` asks the same household
  /// account to prove it is them again); the code is redeemed by the caller.
  func authorize(api: APIClient, purpose: String? = nil) async throws -> (code: String, pkce: PKCE) {
    let pkce = try PKCE()
    #if DEBUG
      // UI tests cannot drive the system sign-in browser; the fixture server accepts any code.
      if api.baseURL.host?.hasSuffix(".native-fixture.invalid") == true { return ("fixture-code", pkce) }
    #endif
    var url = URLComponents(url: try api.url("/native/sign-in"), resolvingAgainstBaseURL: false)!
    url.queryItems = [
      URLQueryItem(name: "state", value: pkce.state),
      URLQueryItem(name: "code_challenge", value: pkce.challenge),
      URLQueryItem(name: "code_challenge_method", value: "S256"),
    ] + (purpose.map { [URLQueryItem(name: "purpose", value: $0)] } ?? [])
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
      // On purpose: household iPads are shared, and a persistent browser session would hand the
      // next member this member's Google sign-in. Renewal keeps active members signed in instead.
      session.prefersEphemeralWebBrowserSession = true
      authSession = session
      if !session.start() {
        continuation.resume(
          throwing: APIError(message: "Could not open the system sign-in browser.", status: 0))
      }
    }
    return (try pkce.code(from: callback), pkce)
  }
  /// Extends this device's sign-in in place while it is in use, so an active member never meets the
  /// weekly sign-in again. The poll loop asks, which covers launch, the foreground and every pass;
  /// `SignInRenewal` keeps it to once an hour. A failure stays quiet and retries later, and a 401
  /// means the session is gone, so it signs out as an expired session does.
  func renewSignInIfDue() async {
    guard let api, let token = api.token, !sessionExpired else { return }
    let key = DeviceDefaults.expiry(api.baseURL)
    let expiry = UserDefaults.standard.string(forKey: key).flatMap { ServerDate.parse($0) }
    guard SignInRenewal.due(expiresAt: expiry, lastAttempt: renewalAttemptedAt, now: date()) else { return }
    renewalAttemptedAt = date()
    let currentGeneration = generation
    do {
      let renewed: TokenRenewal = try await api.write("/auth/native/renew", [String: String]())
      guard generation == currentGeneration, self.api === api, api.token == token,
        ServerDate.parse(renewed.expiresAt) != nil
      else { return }
      UserDefaults.standard.set(renewed.expiresAt, forKey: key)
    } catch {
      guard generation == currentGeneration, self.api === api, api.token == token,
        var failure = error as? APIError, failure.status == 401
      else { return }
      failure.code = APIError.sessionExpiredCode
      report(failure)
    }
  }
  func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
      .first { $0.isKeyWindow } ?? ASPresentationAnchor()
  }
  /// Revokes this device's server session, then clears it locally. If the server cannot be
  /// reached the token is kept and this returns false, unless `localOnly` accepts that the
  /// server-side session stays valid until it expires.
  @discardableResult func signOut(localOnly: Bool = false) async -> Bool {
    persistDraft()
    await awaitDesktopCleanup()
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
      UserDefaults.standard.removeObject(forKey: DeviceDefaults.signedInScope)
      api.token = nil
      api.csrf = nil
      if !revoked {
        self.error =
          "Signed out on this device only. The server could not be reached, so this device's session stays valid there until it expires, and notifications may still be delivered. Sign in on that server again to revoke it."
      }
    }
    stopPolling()
    resetAccountContent()
    return true
  }
  /// Every account boundary clears the same account-owned content and async request identities.
  func resetAccountContent() {
    cachedChats.removeAll()
    interruptionReviewed = false
    NotificationController.shared.clearPendingNavigation()
    draftTask?.cancel()
    scheduledDraftSave = nil
    fileTask?.cancel()
    generation = UUID()
    selectionGeneration = UUID()
    bootstrap = nil
    conversation = nil
    conversationCache.removeAll()
    conversationCapturedAt.removeAll()
    resetPrefetch()
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
    sendingRequests = [:]
    uploads.reset()
    uploads.notice = []
    appUnavailable = false
    sessionExpired = false
    dismissedPolls = []
    renewalAttemptedAt = nil
    upgrade.reset(); computerStatus = nil; openComputer = nil; openTerminal = nil
    resetPreferenceSaves()
    listenRequest = nil
    routineResult = nil
  }
  /// Returns false when the server could not be reached to revoke the session. The caller
  /// then asks before repeating with `localOnly`, which still lets the person leave.
  @discardableResult func changeConnection(localOnly: Bool = false) async -> Bool {
    guard await signOut(localOnly: localOnly) else { return false }
    api = nil
    authConfig = nil
    return true
  }
}
