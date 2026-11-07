import CryptoKit
import Foundation
import Network
import Security

/// Another address of the signed-in server, such as its LAN or tailnet address. The app prefers one
/// it can reach over the primary origin. See "Direct routes" in docs/native-api.md.
struct DirectRoute: Codable, Hashable, Sendable {
  enum Kind: String, Codable, Sendable { case lan, tailnet }
  var kind: Kind
  /// `https://ADDRESS:PORT`.
  var url: URL
  /// base64url SHA-256 of the listener certificate's DER bytes, the only certificate accepted there.
  var certificateSha256: String
  /// LAN before tailnet; both before the primary origin.
  var rank: Int { kind == .lan ? 0 : 1 }
  var endpoint: String? { DirectRoutePins.endpoint(host: url.host, port: url.port) }
  /// A route the app can use: HTTPS to an IPv4 address and explicit port with nothing but an origin,
  /// and a 32-byte pin. The server advertises only addresses, never names a resolver could redirect.
  var usable: Bool {
    url.scheme == "https" && url.host.flatMap { IPv4Address($0) } != nil && endpoint != nil
      && ["", "/"].contains(url.path) && url.query == nil && url.user == nil
      && certificateSha256.count == 43 && certificateSha256.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }
  }
}

/// The server's route list. A route this app version cannot read, such as a future kind, is skipped
/// rather than failing the whole list.
struct DirectRoutesResponse: Decodable, Sendable {
  var routes: [DirectRoute]
  private struct Lenient: Decodable { var route: DirectRoute?; init(from decoder: Decoder) { route = try? DirectRoute(from: decoder) } }
  private enum Keys: String, CodingKey { case routes }
  init(routes: [DirectRoute]) { self.routes = routes }
  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: Keys.self)
    routes = try container.decode([Lenient].self, forKey: .routes).compactMap(\.route).filter(\.usable)
  }
}

enum DirectRoutePins {
  static func endpoint(host: String?, port: Int?) -> String? {
    guard let host, !host.isEmpty, let port, port > 0 else { return nil }
    return "\(host.lowercased()):\(port)"
  }

  enum Decision: Equatable { case trust, refuse }
  /// A direct route's address accepts exactly the certificate the server advertised over a trusted
  /// route, whatever any certificate authority says.
  static func decide(pin: String, leaf: Data?) -> Decision {
    guard let leaf else { return .refuse }
    return Data(SHA256.hash(data: leaf)).base64URLEncoded == pin ? .trust : .refuse
  }
  static func leaf(of trust: SecTrust) -> Data? {
    (SecTrustCopyCertificateChain(trust) as? [SecCertificate])?.first.map { SecCertificateCopyData($0) as Data }
  }
}

/// The API sessions' delegate: redirects stay on the primary origin, and a TLS handshake with any
/// other host is refused. Requests on a direct route carry their own `DirectTaskDelegate`, which
/// answers first, so reaching this for another host means a request lost its pin: fail closed.
/// Checked Sendable: URLSession calls it on its own queue; its state is immutable.
final class APISessionDelegate: NSObject, URLSessionTaskDelegate, Sendable {
  let origin: URL
  init(origin: URL) { self.origin = origin }
  func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) {
    // A direct route never redirects, so only the primary origin may redirect, and only to itself.
    guard let url = request.url, url.scheme == origin.scheme, url.host == origin.host,
      url.port == origin.port
    else {
      completionHandler(nil)
      return
    }
    completionHandler(request)
  }
  /// Whether a challenge comes from the primary origin's host, which keeps the system's own
  /// evaluation. The host alone decides, so no reading of a default port can lock the app out of
  /// its own server; route requests never reach this, since their own delegate answers first.
  func isOrigin(host: String) -> Bool {
    host.lowercased() == origin.host?.lowercased()
  }
  // Task level only: without a session-level method, URLSession sends connection challenges such
  // as server trust here, after the request's own delegate. The async form has no completion
  // closure whose Sendable annotation could drift from the SDK's and leave it silently unmatched.
  func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge) async
    -> (URLSession.AuthChallengeDisposition, URLCredential?)
  {
    let space = challenge.protectionSpace
    guard space.authenticationMethod == NSURLAuthenticationMethodServerTrust else { return (.performDefaultHandling, nil) }
    return isOrigin(host: space.host) ? (.performDefaultHandling, nil) : (.cancelAuthenticationChallenge, nil)
  }
}

/// One request's delegate on a direct route. The route's pin travels with the request, so a route
/// list refreshed mid-flight cannot loosen it, and the delegate remembers refusing a certificate,
/// which proves the request was never sent. It also reports upload progress.
/// Checked Sendable: `refusedCertificate` is lock-guarded; everything else is immutable.
final class DirectTaskDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
  let pin: String
  let report: (@MainActor @Sendable (Double) -> Void)?
  private let lock = NSLock()
  private var refusedCertificate = false
  init(pin: String, report: (@MainActor @Sendable (Double) -> Void)? = nil) {
    self.pin = pin
    self.report = report
  }
  var refused: Bool { lock.withLock { refusedCertificate } }
  /// Whether `leaf` is the pinned certificate. A refusal is remembered.
  func accepts(_ leaf: Data?) -> Bool {
    let trusted = DirectRoutePins.decide(pin: pin, leaf: leaf) == .trust
    if !trusted { lock.withLock { refusedCertificate = true } }
    return trusted
  }
  func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge) async
    -> (URLSession.AuthChallengeDisposition, URLCredential?)
  {
    let space = challenge.protectionSpace
    guard space.authenticationMethod == NSURLAuthenticationMethodServerTrust, let trust = space.serverTrust else {
      return (.performDefaultHandling, nil)
    }
    // Cancelling ends the handshake before any request, so the bearer token never reaches that address.
    return accepts(DirectRoutePins.leaf(of: trust)) ? (.useCredential, URLCredential(trust: trust)) : (.cancelAuthenticationChallenge, nil)
  }
  func urlSession(
    _ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64,
    totalBytesSent: Int64, totalBytesExpectedToSend: Int64
  ) {
    guard let report, totalBytesExpectedToSend > 0 else { return }
    let fraction = Double(totalBytesSent) / Double(totalBytesExpectedToSend)
    Task { @MainActor in report(fraction) }
  }
}

/// Watches the device's network path. Its own deinit stops the monitor, so the main-actor client
/// that owns it needs no isolated deinit. Checked Sendable: `last` is lock-guarded and the monitor
/// is set once in init.
final class NetworkPathWatch: @unchecked Sendable {
  private let monitor = NWPathMonitor()
  private let lock = NSLock()
  private var last: String?
  /// `changed` runs on a background queue when the path differs from its previous report. The
  /// monitor's first report describes the current path, so it is only remembered.
  init(changed: @escaping @Sendable () -> Void) {
    // Weak: the monitor holds this handler, and a strong capture would keep both alive forever.
    monitor.pathUpdateHandler = { [weak self] path in
      guard let self else { return }
      let signature = "\(path.status)|" + path.availableInterfaces.map { "\($0.name):\($0.type)" }.joined(separator: ",")
      let report = self.lock.withLock { () -> Bool in
        defer { self.last = signature }
        return self.last != nil && self.last != signature
      }
      if report { changed() }
    }
    monitor.start(queue: DispatchQueue(label: "dev.agentinterface.network-path", qos: .utility))
  }
  deinit { monitor.cancel() }
}

extension APIClient {
  /// How long a route that failed while in use is skipped, unless the network changes.
  static let routeCooldown: TimeInterval = 60
  /// How often the routes are rechecked while polling, so a better one is found without a trigger.
  static let routeRecheckInterval: TimeInterval = 120
  /// A probe that takes longer than this is not worth preferring over the primary origin.
  static let routeProbeTimeout: TimeInterval = 3

  /// The routes this server advertised last, kept per server across launches.
  static func storedRoutes(for server: URL) -> [DirectRoute] {
    guard let data = UserDefaults.standard.data(forKey: DeviceDefaults.directRoutes(server)),
      let routes = try? JSONDecoder().decode([DirectRoute].self, from: data)
    else { return [] }
    return routes.filter(\.usable)
  }
  func storeRoutes() {
    UserDefaults.standard.set(try? JSONEncoder().encode(directRoutes), forKey: DeviceDefaults.directRoutes(baseURL))
  }

  /// `path` on the active route, or on the primary origin when no route is active.
  func transportURL(_ path: String, on route: DirectRoute?) throws -> URL {
    let primary = try url(path)
    guard let route, var components = URLComponents(url: primary, resolvingAgainstBaseURL: false) else { return primary }
    components.scheme = route.url.scheme
    components.host = route.url.host
    components.port = route.url.port
    guard let url = components.url else { return primary }
    return url
  }

  /// Fetches the route list and moves to the best route that answers. Without `force`, at most once
  /// per `routeRecheckInterval`. A check already running absorbs a forced one by running again.
  func checkRoutes(force: Bool = false) {
    guard token != nil, !localCookieAuth else { return }
    if routeCheck != nil {
      if force { routeRecheckQueued = true }
      return
    }
    if !force, let at = routesCheckedAt, now().timeIntervalSince(at) < Self.routeRecheckInterval { return }
    if pathWatch == nil, watchesNetwork {
      pathWatch = NetworkPathWatch { [weak self] in Task { @MainActor [weak self] in self?.networkChanged() } }
    }
    routeCheck = Task { [weak self] in
      await self?.runRouteCheck()
      guard let self else { return }
      self.routeCheck = nil
      if self.routeRecheckQueued {
        self.routeRecheckQueued = false
        self.checkRoutes(force: true)
      }
    }
  }

  func runRouteCheck() async {
    routesCheckedAt = now()
    // A network change or another sign-in while this runs makes its answers stale.
    let generation = routeGeneration
    do {
      let response: DirectRoutesResponse = try await get("/native/routes")
      directRoutes = response.routes
    } catch let error as APIError where error.status == 404 {
      // A server from before direct routes.
      directRoutes = []
    } catch {
      // Keep what is known: the probes below still say which routes answer.
    }
    let started = now()
    let candidates = directRoutes.filter { (routeCooldowns[$0] ?? .distantPast) <= started }
    let answered = await withTaskGroup(of: DirectRoute?.self) { group in
      for route in candidates { group.addTask { await self.probe(route) ? route : nil } }
      var found: Set<DirectRoute> = []
      for await route in group { if let route { found.insert(route) } }
      return found
    }
    // The server lists LAN first; among routes of one kind its order decides.
    let best = candidates.filter(answered.contains).enumerated().min { ($0.element.rank, $0.offset) < ($1.element.rank, $1.offset) }?.element
    guard routeGeneration == generation, token != nil else { return }
    activeRoute = best
  }

  /// Whether `route` answers the signed-in API with its pinned certificate within the probe timeout.
  func probe(_ route: DirectRoute) async -> Bool {
    guard let token, let url = URL(string: "/api/native/routes", relativeTo: route.url)?.absoluteURL else { return false }
    var request = URLRequest(url: url)
    request.timeoutInterval = Self.routeProbeTimeout
    request.cachePolicy = .reloadIgnoringLocalCacheData
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.httpShouldHandleCookies = false
    guard let answer = try? await session.data(for: request, delegate: DirectTaskDelegate(pin: route.certificateSha256)),
      (answer.1 as? HTTPURLResponse)?.statusCode == 200,
      (try? JSONDecoder().decode(DirectRoutesResponse.self, from: answer.0)) != nil
    else { return false }
    return true
  }

  /// Records that `route` failed a request and returns whether the request may be sent again on the
  /// primary origin. The route stops being used at once and is skipped by checks for a while.
  /// `unsent` means the request provably never reached the server: its own delegate refused the
  /// certificate, or the listener answered with its refusal before handling anything.
  func directRouteFailed(_ route: DirectRoute, error: Error? = nil, unsent: Bool = false, method: String) -> Bool {
    let code = (error as? URLError)?.code
    // Cancelled without a refusal of its own: someone cancelled it, and the route did nothing wrong.
    if !unsent && (error is CancellationError || code == .cancelled) { return false }
    if activeRoute == route { activeRoute = nil }
    routeCooldowns[route] = now().addingTimeInterval(Self.routeCooldown)
    checkRoutes(force: true)
    if unsent { return true }
    guard let code else { return false }
    return Self.neverSent.contains(code) || ["GET", "HEAD"].contains(method)
  }

  /// Failures to open the connection or finish the handshake, which end before the request leaves
  /// the device, so sending it again cannot repeat it. A timeout or a lost connection may come after
  /// the server acted, so only reads are sent again after those; writes keep their usual retry rules.
  static let neverSent: Set<URLError.Code> = [
    .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed, .notConnectedToInternet,
    .secureConnectionFailed, .serverCertificateUntrusted, .serverCertificateHasBadDate,
    .serverCertificateHasUnknownRoot, .serverCertificateNotYetValid, .appTransportSecurityRequiresSecureConnection,
  ]

  /// The device joined or left a network: what was reachable may not be now, and the reverse.
  func networkChanged() {
    routeGeneration += 1
    routeCooldowns.removeAll()
    activeRoute = nil
    checkRoutes(force: true)
  }
}
