import CryptoKit
import Foundation

/// A bounded read-only copy for this installation and this exact sign-in session.
/// Secure prompts, tool output, draft/admission state, and credentials never enter it.
struct OfflineLibrary: Codable {
  var savedAt: Date
  var bootstrap: Bootstrap
  var conversations: [String: Conversation]
  var selected: String?
  var capturedAt: [String: Date]
  init(savedAt: Date, bootstrap: Bootstrap, conversations: [String: Conversation], selected: String? = nil,
       capturedAt: [String: Date]? = nil) {
    self.savedAt = savedAt; self.bootstrap = bootstrap; self.conversations = conversations; self.selected = selected
    self.capturedAt = capturedAt ?? conversations.mapValues { _ in savedAt }
  }
  static let maximumBytes = 2 * 1024 * 1024
  static let maximumChats = 5

  static var root: URL {
    FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("OfflineLibrary", isDirectory: true)
  }
  static func url(origin: String, token: String, root: URL = Self.root) -> URL {
    func digest(_ value: String) -> String { SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined() }
    return root.appendingPathComponent(digest(origin), isDirectory: true).appendingPathComponent(digest(token) + ".json")
  }
  static func read(_ url: URL) -> Self? {
    guard let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize,
      size <= maximumBytes, let data = try? Data(contentsOf: url),
      var value = try? JSONDecoder().decode(Self.self, from: data),
      Date().timeIntervalSince(value.savedAt) < 7 * 24 * 3600
    else { return nil }
    value.conversations = value.conversations.filter { id, _ in
      value.capturedAt[id].map { Date().timeIntervalSince($0) < 7 * 24 * 3600 } ?? false
    }
    return value
  }
  /// `read` away from the main actor, so a launch with a full library keeps its first frames.
  @concurrent static func load(_ url: URL) async -> OfflineLibrary? { read(url) }
  static func conversation(_ value: Conversation) -> Conversation {
    var copy = value
    copy.messages = Array(value.messages.filter {
      $0.isConversationVisible && !$0.isInternalActivity && !$0.isToolActivity && $0.toolCall == nil && !$0.id.hasSuffix("-inflight")
    }.suffix(100)).map { message in
      Message(id: message.id, role: message.role, text: message.text, createdAt: message.createdAt,
        sender: message.sender, files: message.files, origin: message.origin)
    }
    copy.attention = nil; copy.approvals = []; copy.toolCalls = nil; copy.draft = nil; copy.readPosition = nil
    copy.activity = Activity(state: .disconnected)
    return copy
  }
  func encoded() -> Data? {
    var copy = self
    let live = bootstrap
    copy.bootstrap = Bootstrap(user: live.user, household: [], preferences: live.preferences,
      bots: live.bots.map { bot in
        Bot(id: bot.id, name: bot.name, description: bot.description, model: bot.model,
          provider: bot.provider, shared: bot.shared, ownerId: bot.ownerId, avatar: bot.avatar,
          sessionId: bot.sessionId, activity: .disconnected, lastMessage: bot.lastMessage)
      }, capabilities: [:], connection: RuntimeStatus(connected: false), nativeApp: live.nativeApp)
    copy.conversations = copy.conversations.mapValues(Self.conversation)
    copy.conversations = copy.conversations.filter { id, _ in
      copy.capturedAt[id].map { Date().timeIntervalSince($0) < 7 * 24 * 3600 } ?? false
    }
    copy.capturedAt = copy.capturedAt.filter { copy.conversations[$0.key] != nil }
    var data = try? JSONEncoder().encode(copy)
    while (data?.count ?? 0) > Self.maximumBytes, !copy.conversations.isEmpty {
      let discard = copy.conversations.keys.sorted().first { $0 != copy.selected } ?? copy.conversations.keys.sorted().first!
      copy.conversations[discard] = nil
      copy.capturedAt[discard] = nil
      data = try? JSONEncoder().encode(copy)
    }
    guard let data, data.count <= Self.maximumBytes else { return nil }
    return data
  }
  func write(_ url: URL) {
    if let data = encoded() { Self.install(data, at: url) }
  }
  static func install(_ data: Data, at url: URL) {
    do {
      try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
      let prefix = url.deletingPathExtension().lastPathComponent + "."
      for old in try FileManager.default.contentsOfDirectory(at: url.deletingLastPathComponent(), includingPropertiesForKeys: nil)
        where !old.lastPathComponent.hasPrefix(prefix) {
        try? FileManager.default.removeItem(at: old)
      }
      var directory = url.deletingLastPathComponent()
      var values = URLResourceValues(); values.isExcludedFromBackup = true
      try directory.setResourceValues(values)
      try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    } catch { /* Offline reading is optional; live data and drafts remain authoritative. */ }
  }
}


/// Owns debounce, background encoding and a deletion fence. Callers never coordinate writes.
@MainActor final class OfflineLibraryWriter {
  private let disk = Disk()
  private var pending: Task<Void, Never>?
  /// The debounce for a changed snapshot, so frequent polls write at most once per pause.
  var delay: Duration = .seconds(5)
  func replace(_ snapshot: OfflineLibrary, at url: URL, immediately: Bool = false) {
    pending?.cancel()
    let ticket = disk.advance()
    let disk = disk, delay = delay
    pending = Task {
      if !immediately { try? await Task.sleep(for: delay) }
      guard !Task.isCancelled else { return }
      await Task.detached(priority: .utility) { disk.write(snapshot, at: url, ticket: ticket, force: immediately) }.value
    }
  }
  func remove(at url: URL, includingVoice: Bool = true) {
    pending?.cancel(); pending = nil
    disk.remove(url, includingVoice: includingVoice)
  }
  private final class Disk: @unchecked Sendable {
    private let lock = NSLock()
    private var ticket = 0
    private var fingerprint: Data?
    private var lastWrite = Date.distantPast
    private var lastURL: URL?
    func advance() -> Int { lock.withLock { ticket += 1; return ticket } }
    func remove(_ url: URL, includingVoice: Bool) {
      lock.withLock {
        ticket += 1; fingerprint = nil
        try? FileManager.default.removeItem(at: includingVoice ? url.deletingLastPathComponent() : url)
      }
    }
    func write(_ snapshot: OfflineLibrary, at url: URL, ticket expected: Int, force: Bool) {
      // Encoding and size reduction run outside the main actor and the filesystem fence.
      guard let data = snapshot.encoded() else { return }
      var content = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
      content["savedAt"] = nil; content["capturedAt"] = nil
      let hash = (try? JSONSerialization.data(withJSONObject: content, options: [.sortedKeys])).map { Data(SHA256.hash(data: $0)) }
      lock.withLock {
        guard ticket == expected else { return }
        guard force || lastURL != url || fingerprint != hash || Date().timeIntervalSince(lastWrite) >= 3600 else { return }
        OfflineLibrary.install(data, at: url)
        fingerprint = hash; lastWrite = Date(); lastURL = url
      }
    }
  }
}
