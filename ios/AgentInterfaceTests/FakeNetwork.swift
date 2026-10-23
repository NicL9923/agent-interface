import Foundation
import XCTest

@testable import AgentInterface

/// A server a test owns. Each one has its own host, so tests share no state and cannot answer
/// each other's requests, even when they run in one process.
protocol FakeHost: AnyObject, Sendable {
  var origin: URL { get }
  func receive(_ exchange: FakeExchange)
}

/// One request a test's `FakeHost` is answering, standing between `URLSession` and the test.
final class FakeExchange: URLProtocol, @unchecked Sendable {
  /// Weak, so a finished test's server goes away with it instead of living for the whole run.
  private final class Entry { weak var host: FakeHost?; init(_ host: FakeHost) { self.host = host } }
  private static let lock = NSLock()
  nonisolated(unsafe) private static var hosts: [String: Entry] = [:]
  static func register(_ host: FakeHost) {
    lock.withLock {
      hosts = hosts.filter { $0.value.host != nil }
      hosts[host.origin.host!] = Entry(host)
    }
  }
  static func remove(host: String) { _ = lock.withLock { hosts.removeValue(forKey: host) } }

  /// An API client whose every request goes to `host`, authenticated as a fixture session.
  @MainActor static func client(for host: FakeHost, token: String = "synthetic-session-token") -> APIClient {
    register(host)
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [FakeExchange.self]; config.httpCookieStorage = nil; config.urlCache = nil
    let api = APIClient(baseURL: host.origin, session: URLSession(configuration: config))
    api.token = token
    return api
  }

  /// The request's body, whether URLSession handed it over as data or as a stream.
  static func body(_ request: URLRequest) -> Data? {
    if let body = request.httpBody { return body }
    guard let stream = request.httpBodyStream else { return nil }
    stream.open(); defer { stream.close() }
    var result = Data(), buffer = [UInt8](repeating: 0, count: 4096)
    while stream.hasBytesAvailable {
      let count = stream.read(&buffer, maxLength: buffer.count)
      if count <= 0 { break }
      result.append(contentsOf: buffer.prefix(count))
    }
    return result
  }

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    guard let name = request.url?.host, let host = Self.lock.withLock({ Self.hosts[name]?.host }) else {
      client?.urlProtocol(self, didFailWithError: URLError(.badURL)); return
    }
    host.receive(self)
  }
  override func stopLoading() {}
  func fail(_ error: URLError) { client?.urlProtocol(self, didFailWithError: error) }
  /// Opens a server event stream that stays open until the client goes away.
  func openStream() {
    guard let url = request.url, let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "text/event-stream; charset=utf-8"]) else { return }
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data("retry: 3000\n\n".utf8))
  }
  func send(_ text: String) { client?.urlProtocol(self, didLoad: Data(text.utf8)) }
  func respond(status: Int, data: Data, headers: [String: String] = [:]) {
    guard let url = request.url, let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers.merging(["Content-Type": "application/json"]) { value, _ in value }) else { return }
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: data)
    client?.urlProtocolDidFinishLoading(self)
  }
}

/// The small server most tests need: it records what it was asked and answers with a status and
/// body the test sets, or with whatever `answer` returns for the request.
final class FakeServer: FakeHost, @unchecked Sendable {
  struct Reply {
    var status = 200
    var body = "{}"
  }
  let origin = URL(string: "https://fake-\(UUID().uuidString.lowercased()).example.test")!
  private let lock = NSLock()
  private var seen: [(request: URLRequest, body: Data?)] = []
  private var answer: ((URLRequest) -> Reply)?
  private var fixed = Reply()
  private var failure: URLError?
  init(answer: ((URLRequest) -> Reply)? = nil) { self.answer = answer }

  /// Answers every request with this, unless an `answer` closure decides per request.
  var reply: Reply { get { lock.withLock { fixed } } set { lock.withLock { fixed = newValue } } }
  /// Fails every request at the network, as a cancelled or dropped connection does.
  var failing: URLError? { get { lock.withLock { failure } } set { lock.withLock { failure = newValue } } }
  var requests: [URLRequest] { lock.withLock { seen.map(\.request) } }
  var bodies: [Data] { lock.withLock { seen.map { $0.body ?? Data() } } }
  var lastRequest: URLRequest? { lock.withLock { seen.last?.request } }
  var lastBody: Data? { lock.withLock { seen.last?.body } }
  /// The last request's body as a JSON object, empty when it had none.
  func lastJSON() throws -> [String: Any] {
    guard let body = lastBody, !body.isEmpty else { return [:] }
    return try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
  }
  @MainActor func api(token: String = "synthetic-session-token") -> APIClient { FakeExchange.client(for: self, token: token) }

  func receive(_ exchange: FakeExchange) {
    let body = FakeExchange.body(exchange.request)
    let (reply, failure) = lock.withLock { () -> (Reply, URLError?) in
      seen.append((exchange.request, body))
      return (answer?(exchange.request) ?? fixed, self.failure)
    }
    if let failure { exchange.fail(failure); return }
    exchange.respond(status: reply.status, data: Data(reply.body.utf8))
  }
}
