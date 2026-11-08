import Foundation

/// What the Mac keeps after linking: the server it linked to and its own device credential.
public struct DeviceCredential: Codable, Equatable, Sendable {
  public var server: String
  public var deviceId: String
  public var credential: String
  public var name: String
  public init(server: String, deviceId: String, credential: String, name: String) {
    self.server = server
    self.deviceId = deviceId
    self.credential = credential
    self.name = name
  }
  public var authorization: String { "Device \(deviceId).\(credential)" }
}

public protocol CredentialStore: Sendable {
  func load() -> DeviceCredential?
  func save(_ credential: DeviceCredential) throws
  func delete()
}

/// Close codes the server uses on the link socket.
public enum LinkCloseCode {
  public static let unauthorized = 4401
  public static let notMember = 4403
  public static let unavailable = 4404
  public static let replaced = 4409
  /// Used by this app when it drops a silent socket.
  static let heartbeatTimeout = 4000
}

public struct LinkClosed: Error, Equatable {
  public var code: Int?
  public init(code: Int?) { self.code = code }
}

public protocol LinkSocket: AnyObject, Sendable {
  func send(_ text: String) async throws
  /// The next text frame. Throws `LinkClosed` with the close code when the socket ends.
  func receive() async throws -> String
  func ping() async throws
  func close(code: Int)
}

public protocol LinkConnector: Sendable {
  func connect(url: URL, authorization: String) async throws -> LinkSocket
}

public enum LinkStatus: Equatable, Sendable {
  case unlinked(reason: String?)
  case connecting
  case linked
  case retrying(at: Date, reason: String)
  /// The server refused this Mac in a way retrying cannot fix; reconnecting needs the person.
  case stopped(reason: String)
}

public enum Backoff {
  /// 1, 2, 4, 8, 16, 32, then 60 seconds after each consecutive failure.
  public static func delay(afterFailures failures: Int) -> TimeInterval {
    guard failures > 0 else { return 0 }
    return min(60, pow(2, Double(min(failures, 7) - 1)))
  }
}

public enum LinkEndpoint {
  /// `https://host` becomes `wss://host/api/mac/link`; `http` (loopback only) becomes `ws`.
  public static func url(server: String) -> URL? {
    guard var components = URLComponents(string: server), let scheme = components.scheme?.lowercased() else { return nil }
    components.scheme = scheme == "http" ? "ws" : "wss"
    components.path = "/api/mac/link"
    components.query = nil
    components.fragment = nil
    return components.url
  }
}

/// Keeps one link socket open while the Mac is linked: hello, resend unacknowledged results,
/// answer invocations, reconnect with backoff, and drop a socket that has gone silent.
public actor LinkClient {
  public struct Timing: Sendable {
    public var heartbeatInterval: TimeInterval = 20
    public var heartbeatTimeout: TimeInterval = 60
    /// Multiplies every backoff delay; tests shrink it.
    public var backoffScale: Double = 1
    public init() {}
  }

  private let connector: LinkConnector
  private let credentials: CredentialStore
  private let dispatcher: Dispatcher
  private let journal: InvocationJournal
  private let appVersion: String
  private let state: @Sendable () -> MacState
  private let onStatus: @Sendable (LinkStatus) -> Void
  private let onRevoked: @Sendable () -> Void
  private let timing: Timing

  private var loop: Task<Void, Never>?
  private var socket: LinkSocket?
  private var generation = 0
  private var failures = 0
  private var lastActivity = Date()
  private var wake: CheckedContinuation<Void, Never>?
  private var wakeRequested = false
  private var sleepToken = 0
  private var revokedByServer = false
  public private(set) var status: LinkStatus = .unlinked(reason: nil)

  public init(
    connector: LinkConnector, credentials: CredentialStore, dispatcher: Dispatcher, journal: InvocationJournal,
    appVersion: String, timing: Timing = Timing(), state: @escaping @Sendable () -> MacState,
    onStatus: @escaping @Sendable (LinkStatus) -> Void = { _ in }, onRevoked: @escaping @Sendable () -> Void = {}
  ) {
    self.connector = connector
    self.credentials = credentials
    self.dispatcher = dispatcher
    self.journal = journal
    self.appVersion = appVersion
    self.timing = timing
    self.state = state
    self.onStatus = onStatus
    self.onRevoked = onRevoked
  }

  public func start() {
    guard loop == nil else { return }
    failures = 0
    wakeRequested = false
    loop = Task { await self.run() }
  }

  public func stop() {
    loop?.cancel()
    loop = nil
    socket?.close(code: 1000)
    socket = nil
    generation += 1
    wakeUp()
    publish(.unlinked(reason: nil))
  }

  /// After wake or a network change: reconnect at once instead of waiting out the backoff.
  public func nudge() {
    failures = 0
    wakeUp()
  }

  /// Tells the server the Mac's state changed (pause, lock, folders, grants).
  public func sendState() async {
    guard let socket, status == .linked else { return }
    try? await socket.send(LinkCodec.state(state()))
  }

  // MARK: Loop

  private func run() async {
    while !Task.isCancelled {
      guard let credential = credentials.load(), let url = LinkEndpoint.url(server: credential.server) else {
        publish(.unlinked(reason: nil))
        loop = nil
        return
      }
      publish(.connecting)
      let code = await session(url: url, credential: credential)
      if Task.isCancelled { return }
      let reason: String
      switch code {
      case LinkCloseCode.unauthorized:
        endLink(reason: "This Mac was unlinked from WildBots.")
        return
      case LinkCloseCode.notMember:
        publish(.stopped(reason: "The account that linked this Mac is no longer in the household."))
        loop = nil
        return
      case LinkCloseCode.replaced:
        publish(.stopped(reason: "Another copy of WildBots connected with this Mac's link. Reconnect to take it back."))
        loop = nil
        return
      case LinkCloseCode.unavailable:
        reason = "The server has Mac links turned off."
      default:
        reason = "Could not reach the server."
      }
      failures += 1
      let delay = Backoff.delay(afterFailures: failures) * timing.backoffScale
      publish(.retrying(at: Date().addingTimeInterval(delay), reason: reason))
      await sleep(delay)
    }
  }

  private func endLink(reason: String) {
    credentials.delete()
    dispatcher.cancelAll()
    socket = nil
    loop = nil
    publish(.unlinked(reason: reason))
    onRevoked()
  }

  /// One socket's life. Returns its close code, or nil for a network failure or a silent socket.
  private func session(url: URL, credential: DeviceCredential) async -> Int? {
    let socket: LinkSocket
    do {
      socket = try await connector.connect(url: url, authorization: credential.authorization)
    } catch {
      return (error as? LinkClosed)?.code
    }
    if Task.isCancelled {
      socket.close(code: 1000)
      return nil
    }
    generation += 1
    let current = generation
    self.socket = socket
    revokedByServer = false
    lastActivity = Date()
    do {
      try await socket.send(LinkCodec.hello(appVersion: appVersion, state: state()))
      for (id, outcome) in journal.unacknowledged() {
        try await socket.send(LinkCodec.result(id: id, outcome: outcome))
      }
    } catch {
      socket.close(code: 1000)
      return (error as? LinkClosed)?.code
    }
    let code = await withTaskGroup(of: Int?.self) { group -> Int? in
      group.addTask { await self.receiveLoop(socket, generation: current) }
      group.addTask { await self.heartbeat(socket, generation: current) }
      let first = await group.next() ?? nil
      group.cancelAll()
      return first
    }
    socket.close(code: 1000)
    if self.socket === socket { self.socket = nil }
    return revokedByServer ? LinkCloseCode.unauthorized : code
  }

  private func receiveLoop(_ socket: LinkSocket, generation: Int) async -> Int? {
    while !Task.isCancelled {
      let text: String
      do {
        text = try await socket.receive()
      } catch {
        return (error as? LinkClosed)?.code
      }
      lastActivity = Date()
      let message = LinkCodec.decode(text)
      switch message {
      case .welcome:
        failures = 0
        wakeRequested = false
        publish(.linked)
      case .ack(let id):
        try? journal.acknowledge(id: id)
      case .revoked:
        revokedByServer = true
        dispatcher.cancelAll()
        socket.close(code: 1000)
        return LinkCloseCode.unauthorized
      case .invoke, .malformedInvoke:
        Task {
          guard let answer = await dispatcher.handle(message) else { return }
          await self.deliver(id: answer.id, outcome: answer.outcome, generation: generation)
        }
      case .ignored:
        continue
      }
    }
    return nil
  }

  /// Sends a result on the socket it arrived on. If that socket is gone, the result waits in the
  /// journal and goes out after the next hello.
  private func deliver(id: String, outcome: ActionOutcome, generation: Int) async {
    guard generation == self.generation, let socket else { return }
    try? await socket.send(LinkCodec.result(id: id, outcome: outcome))
  }

  private func heartbeat(_ socket: LinkSocket, generation: Int) async -> Int? {
    while !Task.isCancelled {
      try? await Task.sleep(nanoseconds: UInt64(timing.heartbeatInterval * 1_000_000_000))
      if Task.isCancelled { return nil }
      if Date().timeIntervalSince(lastActivity) > timing.heartbeatTimeout {
        socket.close(code: LinkCloseCode.heartbeatTimeout)
        return nil
      }
      Task {
        if (try? await socket.ping()) != nil { self.touch(generation: generation) }
      }
    }
    return nil
  }

  private func touch(generation: Int) {
    if generation == self.generation { lastActivity = Date() }
  }

  // MARK: Helpers

  private func publish(_ status: LinkStatus) {
    self.status = status
    onStatus(status)
  }

  private func sleep(_ seconds: TimeInterval) async {
    if wakeRequested {
      wakeRequested = false
      return
    }
    sleepToken += 1
    let token = sleepToken
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      wake = continuation
      Task {
        try? await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
        self.timerFired(token: token)
      }
    }
  }

  private func timerFired(token: Int) {
    guard token == sleepToken, let wake else { return }
    self.wake = nil
    wake.resume()
  }

  /// Ends a backoff wait now, or makes the next one end at once when none is in progress.
  private func wakeUp() {
    if let wake {
      self.wake = nil
      wake.resume()
    } else {
      wakeRequested = true
    }
  }
}
