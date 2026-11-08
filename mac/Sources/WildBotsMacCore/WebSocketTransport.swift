import Foundation

/// The link socket over `URLSessionWebSocketTask`, with no cookies and no Origin header.
public struct URLSessionLinkConnector: LinkConnector {
  public init() {}

  public func connect(url: URL, authorization: String) async throws -> LinkSocket {
    let socket = WebSocketConnection()
    try await socket.open(url: url, authorization: authorization)
    return socket
  }
}

final class WebSocketConnection: NSObject, LinkSocket, URLSessionWebSocketDelegate, @unchecked Sendable {
  private let lock = NSLock()
  private var session: URLSession?
  private var task: URLSessionWebSocketTask?
  private var opening: CheckedContinuation<Void, Error>?
  private var closeCode: Int?

  func open(url: URL, authorization: String) async throws {
    let config = URLSessionConfiguration.ephemeral
    config.httpCookieStorage = nil
    config.httpShouldSetCookies = false
    config.urlCache = nil
    config.timeoutIntervalForRequest = 30
    let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
    var request = URLRequest(url: url)
    request.setValue(authorization, forHTTPHeaderField: "Authorization")
    request.httpShouldHandleCookies = false
    let task = session.webSocketTask(with: request)
    task.maximumMessageSize = maxFrameBytes
    lock.withLock {
      self.session = session
      self.task = task
    }
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      lock.withLock { opening = continuation }
      task.resume()
    }
  }

  func send(_ text: String) async throws {
    guard let task = lock.withLock({ task }) else { throw LinkClosed(code: nil) }
    do {
      try await task.send(.string(text))
    } catch {
      throw LinkClosed(code: lock.withLock { closeCode })
    }
  }

  func receive() async throws -> String {
    guard let task = lock.withLock({ task }) else { throw LinkClosed(code: nil) }
    while true {
      let message: URLSessionWebSocketTask.Message
      do {
        message = try await task.receive()
      } catch {
        let code = lock.withLock { closeCode } ?? (task.closeCode == .invalid ? nil : task.closeCode.rawValue)
        throw LinkClosed(code: code)
      }
      switch message {
      case .string(let text): return text
      case .data(let data):
        if let text = String(data: data, encoding: .utf8) { return text }
      @unknown default:
        continue
      }
    }
  }

  func ping() async throws {
    guard let task = lock.withLock({ task }) else { throw LinkClosed(code: nil) }
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      task.sendPing { error in
        if let error { continuation.resume(throwing: error) } else { continuation.resume() }
      }
    }
  }

  func close(code: Int) {
    let (task, session) = lock.withLock { (self.task, self.session) }
    task?.cancel(with: URLSessionWebSocketTask.CloseCode(rawValue: code) ?? .normalClosure, reason: nil)
    session?.finishTasksAndInvalidate()
  }

  // MARK: URLSessionWebSocketDelegate

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
    let continuation = lock.withLock { () -> CheckedContinuation<Void, Error>? in
      defer { opening = nil }
      return opening
    }
    continuation?.resume()
  }

  func urlSession(
    _ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
    reason: Data?
  ) {
    lock.withLock { self.closeCode = closeCode.rawValue }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    let (continuation, code) = lock.withLock { () -> (CheckedContinuation<Void, Error>?, Int?) in
      defer { opening = nil }
      return (opening, closeCode)
    }
    // Only a close code ends the link. An HTTP error before the upgrade, which a proxy may
    // produce for its own reasons, is retried and never deletes the credential.
    continuation?.resume(throwing: LinkClosed(code: code))
  }
}
