import Foundation

/// The live connection to the voice model.
@MainActor protocol TalkTransport: AnyObject, Sendable {
  /// Connects with a short-lived secret. Each server event arrives as JSON text on the main actor;
  /// `closed` reports an end Talk did not ask for, once.
  func open(secret: String, model: String, event: @escaping @MainActor (String) -> Void, closed: @escaping @MainActor (String) -> Void)
  func send(_ text: String)
  func close()
}

/// OpenAI's Realtime WebSocket. The server mints the secret with the whole session fixed, so the
/// app only streams audio and the tool loop's events. Nothing else, such as cookies or the app
/// server's token, goes to OpenAI.
@MainActor final class RealtimeSocket: TalkTransport {
  static let endpoint = URL(string: "wss://api.openai.com/v1/realtime")!
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

  static func request(secret: String, model: String) -> URLRequest {
    var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false)!
    components.queryItems = [URLQueryItem(name: "model", value: model)]
    var request = URLRequest(url: components.url!)
    request.setValue("Bearer \(secret)", forHTTPHeaderField: "Authorization")
    request.timeoutInterval = 20
    return request
  }

  func open(secret: String, model: String, event: @escaping @MainActor (String) -> Void, closed: @escaping @MainActor (String) -> Void) {
    close()
    let task = session.webSocketTask(with: Self.request(secret: secret, model: model))
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
          closed(Self.message(task))
          return
        }
      }
    }
  }

  private static func message(_ task: URLSessionWebSocketTask) -> String {
    if let response = task.response as? HTTPURLResponse, !(200..<300).contains(response.statusCode), response.statusCode != 101 {
      return "OpenAI did not accept the voice call (HTTP \(response.statusCode)). Start Talk again."
    }
    return task.closeCode == .invalid ? "Could not reach OpenAI. Check your connection, then start Talk again."
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
