import Foundation

/// The live connection to the voice model.
@MainActor protocol TalkTransport: AnyObject, Sendable {
  /// Connects with a short-lived secret. Each server event arrives as JSON text on the main actor;
  /// `closed` reports an end Talk did not ask for, once.
  func open(secret: String, model: String, event: @escaping @MainActor (String) -> Void, closed: @escaping @MainActor (String) -> Void)
  func open(session: TalkSession, event: @escaping @MainActor (String) -> Void, closed: @escaping @MainActor (String) -> Void)
  func send(_ text: String)
  func close()
}

extension TalkTransport {
  func open(session: TalkSession, event: @escaping @MainActor (String) -> Void, closed: @escaping @MainActor (String) -> Void) {
    open(secret: session.clientSecret, model: session.model, event: event, closed: closed)
  }
}

/// OpenAI and xAI Grok Voice Realtime WebSocket. The server mints the short-lived secret; nothing
/// else, such as cookies or the app server's token, goes to the voice provider.
@MainActor final class RealtimeSocket: TalkTransport {
  static let endpoint = URL(string: "wss://api.openai.com/v1/realtime")!
  static let xaiEndpoint = URL(string: "wss://api.x.ai/v1/realtime")!
  private let session: URLSession
  private var task: URLSessionWebSocketTask?
  private var reader: Task<Void, Never>?

  init() {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpShouldSetCookies = false
    configuration.httpCookieAcceptPolicy = .never
    configuration.urlCache = nil
    configuration.waitsForConnectivity = false
    session = URLSession(configuration: configuration)
  }

  static func request(secret: String, model: String, wsUrl: String? = nil, provider: String? = nil) -> URLRequest {
    let targetUrl: URL
    if let wsUrl, let explicit = URL(string: wsUrl) {
      targetUrl = explicit
    } else {
      let base = provider == "xai" ? xaiEndpoint : endpoint
      var components = URLComponents(url: base, resolvingAgainstBaseURL: false)!
      components.queryItems = [URLQueryItem(name: "model", value: model)]
      targetUrl = components.url!
    }
    var request = URLRequest(url: targetUrl)
    request.setValue("Bearer \(secret)", forHTTPHeaderField: "Authorization")
    request.timeoutInterval = 20
    return request
  }

  func open(secret: String, model: String, event: @escaping @MainActor (String) -> Void, closed: @escaping @MainActor (String) -> Void) {
    open(session: TalkSession(clientSecret: secret, expiresAt: 0, model: model, voice: TalkVoice.default), event: event, closed: closed)
  }

  func open(session talkSession: TalkSession, event: @escaping @MainActor (String) -> Void, closed: @escaping @MainActor (String) -> Void) {
    close()
    let providerName = talkSession.provider == "xai" ? "xAI" : "OpenAI"
    let task = session.webSocketTask(with: Self.request(secret: talkSession.clientSecret, model: talkSession.model, wsUrl: talkSession.wsUrl, provider: talkSession.provider))
    // Realtime events with audio are small; a generous bound still stops a runaway frame.
    task.maximumMessageSize = 4 * 1024 * 1024
    self.task = task
    task.resume()
    reader = Task { [weak self] in
      while !Task.isCancelled {
        do {
          let message = try await task.receive()
          guard !Task.isCancelled, self?.task === task else { return }
          switch message {
          case .string(let text): event(text)
          case .data(let data): if let text = String(data: data, encoding: .utf8) { event(text) }
          @unknown default: break
          }
        } catch {
          guard !Task.isCancelled, self?.task === task else { return }
          self?.task = nil
          closed(Self.message(task, providerName: providerName))
          return
        }
      }
    }
  }

  private static func message(_ task: URLSessionWebSocketTask, providerName: String) -> String {
    if let response = task.response as? HTTPURLResponse, !(200..<300).contains(response.statusCode), response.statusCode != 101 {
      return "\(providerName) did not accept the voice call (HTTP \(response.statusCode)). Start Talk again."
    }
    return task.closeCode == .invalid ? "Could not reach \(providerName). Check your connection, then start Talk again."
      : "The voice connection closed. Start Talk again."
  }

  func send(_ text: String) {
    guard let task else { return }
    task.send(.string(text)) { _ in }
  }

  func close() {
    reader?.cancel()
    reader = nil
    task?.cancel(with: .normalClosure, reason: nil)
    task = nil
  }
}
