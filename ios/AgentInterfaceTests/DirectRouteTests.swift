import Foundation
import XCTest

@testable import AgentInterface

/// A direct route's listener: a private address with its own answers and failures.
private final class RouteHost: FakeHost, @unchecked Sendable {
  let origin: URL
  private let lock = NSLock()
  private var seen: [URLRequest] = []
  private var failure: URLError?
  private var status = 200
  private var body = #"{"routes":[]}"#
  init() {
    // A fresh address per host, so tests never share a registered route.
    origin = URL(string: "https://10.\(Int.random(in: 1...254)).\(Int.random(in: 1...254)).\(Int.random(in: 1...254)):3443")!
  }
  var failing: URLError? { get { lock.withLock { failure } } set { lock.withLock { failure = newValue } } }
  func answer(status: Int, body: String) { lock.withLock { self.status = status; self.body = body } }
  var requests: [URLRequest] { lock.withLock { seen } }
  func receive(_ exchange: FakeExchange) {
    let (failure, status, body) = lock.withLock { () -> (URLError?, Int, String) in
      seen.append(exchange.request)
      return (self.failure, self.status, self.body)
    }
    if let failure { exchange.fail(failure); return }
    exchange.respond(status: status, data: Data(body.utf8))
  }
  func route(_ kind: DirectRoute.Kind) -> DirectRoute {
    DirectRoute(kind: kind, url: origin, certificateSha256: String(repeating: "A", count: 43))
  }
}

@MainActor final class DirectRouteTests: XCTestCase {
  private var servers: [URL] = []
  override func tearDown() {
    for server in servers { UserDefaults.standard.removeObject(forKey: DeviceDefaults.directRoutes(server)) }
    super.tearDown()
  }

  private func json(_ routes: [DirectRoute]) -> String {
    String(decoding: try! JSONEncoder().encode(["routes": routes]), as: UTF8.self)
  }
  /// A primary origin that advertises `routes`, each route host registered and answering its probe.
  private func installation(_ routes: [(RouteHost, DirectRoute.Kind)]) -> (FakeServer, APIClient, [DirectRoute]) {
    let advertised = routes.map { $0.0.route($0.1) }
    let body = json(advertised)
    let primary = FakeServer { request in
      request.url?.path == "/api/native/routes" ? .init(body: body) : .init(body: #"{"ok":true}"#)
    }
    servers.append(primary.origin)
    for (host, _) in routes {
      FakeExchange.register(host)
      host.answer(status: 200, body: body)
    }
    return (primary, primary.api(), advertised)
  }

  func testPrefersTheLanRouteThatAnswersAndSendsTheSignedInApiThere() async throws {
    let lan = RouteHost(), tailnet = RouteHost()
    // The server's order puts tailnet first here, so the app's own rank is what picks LAN.
    let (primary, api, routes) = installation([(tailnet, .tailnet), (lan, .lan)])
    await api.runRouteCheck()
    XCTAssertEqual(api.activeRoute, routes[1])
    let before = primary.requests.count
    _ = try await api.data(path: "/api/bootstrap")
    XCTAssertEqual(primary.requests.count, before, "the read went to the primary origin")
    let sent = try XCTUnwrap(lan.requests.last)
    XCTAssertEqual(sent.url?.absoluteString, lan.origin.absoluteString + "/api/bootstrap")
    XCTAssertEqual(sent.value(forHTTPHeaderField: "Authorization"), "Bearer synthetic-session-token")
  }

  func testUsesTheNextRouteWhenTheBestDoesNotAnswer() async {
    let lan = RouteHost(), tailnet = RouteHost()
    let (_, api, routes) = installation([(lan, .lan), (tailnet, .tailnet)])
    lan.failing = URLError(.cannotConnectToHost)
    await api.runRouteCheck()
    XCTAssertEqual(api.activeRoute, routes[1])
  }

  func testAProbeThatAnswersWithoutTheSignedInApiDoesNotCount() async {
    let lan = RouteHost()
    let (_, api, _) = installation([(lan, .lan)])
    lan.answer(status: 401, body: #"{"code":"session_expired"}"#)
    await api.runRouteCheck()
    XCTAssertNil(api.activeRoute)
  }

  func testAServerWithoutRoutesForgetsTheOnesItAdvertisedBefore() async {
    let lan = RouteHost()
    let (_, api, _) = installation([(lan, .lan)])
    await api.runRouteCheck()
    XCTAssertNotNil(api.activeRoute)
    // An older server, or one with direct routes turned off since.
    let older = FakeServer(answer: { _ in .init(status: 404, body: #"{"error":"API endpoint not found"}"#) })
    servers.append(older.origin)
    let client = older.api()
    client.directRoutes = [lan.route(.lan)]
    await client.runRouteCheck()
    XCTAssertEqual(client.directRoutes, [])
    XCTAssertNil(client.activeRoute)
  }

  func testRoutesAreRememberedPerServerAcrossLaunchesButChosenAgain() async {
    let lan = RouteHost()
    let (primary, api, routes) = installation([(lan, .lan)])
    await api.runRouteCheck()
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [FakeExchange.self]
    let relaunched = APIClient(baseURL: primary.origin, session: URLSession(configuration: config))
    XCTAssertEqual(relaunched.directRoutes, routes)
    XCTAssertNil(relaunched.activeRoute, "a route is probed before it is used")
    XCTAssertEqual(relaunched.pins.pin(host: lan.origin.host!, port: 3443), routes[0].certificateSha256)
  }

  func testAReadThatFailsOnTheRouteIsSentOnThePrimaryOriginAndTheRouteRests() async throws {
    let lan = RouteHost()
    let (primary, api, _) = installation([(lan, .lan)])
    var clock = Date(timeIntervalSince1970: 1_000_000)
    api.now = { clock }
    await api.runRouteCheck()
    lan.failing = URLError(.timedOut)
    _ = try await api.data(path: "/api/bootstrap")
    XCTAssertEqual(primary.lastRequest?.url?.path, "/api/bootstrap")
    XCTAssertNil(api.activeRoute)
    // The route answers again, but a route that just failed is not trusted for a while.
    lan.failing = nil
    await api.runRouteCheck()
    XCTAssertNil(api.activeRoute)
    clock.addTimeInterval(APIClient.routeCooldown + 1)
    await api.runRouteCheck()
    XCTAssertEqual(api.activeRoute?.url, lan.origin)
  }

  func testAWriteIsNotSentAgainWhenTheRouteMayHaveReceivedIt() async throws {
    let lan = RouteHost()
    let (primary, api, _) = installation([(lan, .lan)])
    await api.runRouteCheck()
    lan.failing = URLError(.timedOut)
    do {
      _ = try await api.data(path: "/api/bots/household/messages", method: "POST", body: Data("{}".utf8), contentType: "application/json")
      XCTFail("A write that may have reached the server must not be repeated")
    } catch let error as APIError {
      XCTAssertEqual(error.code, "CONNECTION_UNAVAILABLE")
    }
    XCTAssertFalse(primary.requests.contains { $0.httpMethod == "POST" })
    XCTAssertNil(api.activeRoute)
  }

  func testAWriteIsSentOnThePrimaryOriginWhenTheRouteNeverConnected() async throws {
    let lan = RouteHost()
    let (primary, api, _) = installation([(lan, .lan)])
    await api.runRouteCheck()
    // A pin refusal cancels the handshake; nothing was sent.
    lan.failing = URLError(.cancelled)
    _ = try await api.data(path: "/api/bots/household/messages", method: "POST", body: Data("{}".utf8), contentType: "application/json")
    XCTAssertEqual(primary.requests.filter { $0.httpMethod == "POST" }.map { $0.url?.path }, ["/api/bots/household/messages"])
  }

  func testARouteTheServerRefusesIsLeftForThePrimaryOrigin() async throws {
    let lan = RouteHost()
    let (primary, api, _) = installation([(lan, .lan)])
    await api.runRouteCheck()
    lan.answer(status: 403, body: #"{"error":"This address serves only the iOS app's signed-in API.","code":"direct_route_refused"}"#)
    _ = try await api.data(path: "/api/bots/household/messages", method: "POST", body: Data("{}".utf8), contentType: "application/json")
    XCTAssertEqual(primary.requests.filter { $0.httpMethod == "POST" }.count, 1)
    XCTAssertNil(api.activeRoute)
  }

  func testAnotherForbiddenAnswerOnTheRouteIsTheServersAnswer() async throws {
    let lan = RouteHost()
    let (primary, api, _) = installation([(lan, .lan)])
    await api.runRouteCheck()
    lan.answer(status: 403, body: #"{"error":"Only administrators can do that."}"#)
    do {
      _ = try await api.data(path: "/api/hermes/upgrade/install", method: "POST", body: Data("{}".utf8), contentType: "application/json")
      XCTFail("expected the 403")
    } catch let error as APIError { XCTAssertEqual(error.status, 403) }
    XCTAssertFalse(primary.requests.contains { $0.httpMethod == "POST" })
    XCTAssertNotNil(api.activeRoute)
  }

  func testSignedOutRequestsAndSignOutUseThePrimaryOrigin() async throws {
    let lan = RouteHost()
    let (primary, api, _) = installation([(lan, .lan)])
    await api.runRouteCheck()
    let lanBefore = lan.requests.count
    _ = try await api.data(path: "/api/auth/config", authenticated: false)
    XCTAssertEqual(primary.lastRequest?.url?.path, "/api/auth/config")
    XCTAssertEqual(lan.requests.count, lanBefore)
    api.token = nil
    XCTAssertNil(api.activeRoute)
  }

  func testANetworkChangeLeavesTheRouteAndForgetsRestingRoutes() async {
    let lan = RouteHost()
    let (_, api, routes) = installation([(lan, .lan)])
    await api.runRouteCheck()
    api.routeCooldowns[routes[0]] = .distantFuture
    api.networkChanged()
    XCTAssertNil(api.activeRoute)
    XCTAssertTrue(api.routeCooldowns.isEmpty)
    api.routeCheck?.cancel()
  }

  func testRoutesTheAppCannotUseAreSkippedNotFatal() throws {
    let pin = String(repeating: "A", count: 43)
    let body = """
      {"routes":[
        {"kind":"lan","url":"https://192.168.1.20:3443","certificateSha256":"\(pin)"},
        {"kind":"satellite","url":"https://192.168.1.21:3443","certificateSha256":"\(pin)"},
        {"kind":"lan","url":"http://192.168.1.22:3443","certificateSha256":"\(pin)"},
        {"kind":"lan","url":"https://192.168.1.23","certificateSha256":"\(pin)"},
        {"kind":"lan","url":"https://192.168.1.24:3443/api","certificateSha256":"\(pin)"},
        {"kind":"tailnet","url":"https://100.100.0.6:3443","certificateSha256":"short"},
        {"kind":"tailnet","url":"https://100.100.0.6:3443"}
      ]}
      """
    let decoded: DirectRoutesResponse = try APIClient.decode(Data(body.utf8), from: "/api/native/routes")
    XCTAssertEqual(decoded.routes.map(\.url.absoluteString), ["https://192.168.1.20:3443"])
  }

  func testOnlyAPinnedAddressAcceptsItsOwnCertificate() {
    // SHA-256("abc"), base64url: FIPS 180-2's test vector, computed independently of the app.
    let abc = "ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0"
    XCTAssertEqual(DirectRoutePins.decide(pin: abc, leaf: Data("abc".utf8)), .trust)
    XCTAssertEqual(DirectRoutePins.decide(pin: abc, leaf: Data("abd".utf8)), .refuse)
    XCTAssertEqual(DirectRoutePins.decide(pin: abc, leaf: nil), .refuse)
    // The primary origin, and any address no route names, keeps the system's evaluation.
    XCTAssertEqual(DirectRoutePins.decide(pin: nil, leaf: Data("abc".utf8)), .standard)
    let pins = DirectRoutePins()
    pins.set([DirectRoute(kind: .lan, url: URL(string: "https://192.168.1.20:3443")!, certificateSha256: abc)])
    XCTAssertEqual(pins.pin(host: "192.168.1.20", port: 3443), abc)
    XCTAssertNil(pins.pin(host: "192.168.1.20", port: 443))
    XCTAssertNil(pins.pin(host: "agentui.example.test", port: 443))
  }
}
