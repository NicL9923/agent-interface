import Foundation

/// One line of the Activity list. It records who asked for what and how it ended: command
/// text and paths, never file contents, written content or command output.
public struct ActivityEntry: Codable, Equatable, Sendable, Identifiable {
  public var id: String
  public var at: Date
  public var assistantId: String
  public var assistantName: String?
  public var scheduled: Bool
  public var action: String
  /// The command or path, from `ActionRequest.summary`.
  public var detail: String
  /// `ok`, or the error code.
  public var outcome: String
  /// The error message, or a short non-content summary such as an exit code.
  public var note: String?
  public var durationMs: Int?

  public init(
    id: String, at: Date, assistantId: String, assistantName: String?, scheduled: Bool, action: String, detail: String,
    outcome: String, note: String? = nil, durationMs: Int? = nil
  ) {
    self.id = id
    self.at = at
    self.assistantId = assistantId
    self.assistantName = assistantName
    self.scheduled = scheduled
    self.action = action
    self.detail = detail
    self.outcome = outcome
    self.note = note
    self.durationMs = durationMs
  }
}

/// The newest `limit` activity entries, as JSON lines in Application Support.
public final class ActivityLog: @unchecked Sendable {
  public let limit: Int
  private let url: URL
  private let lock = NSLock()
  private var cache: [ActivityEntry]

  public init(url: URL, limit: Int = 1000) {
    self.url = url
    self.limit = limit
    try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    let lines = (try? String(contentsOf: url, encoding: .utf8))?.split(separator: "\n") ?? []
    cache = Array(lines.compactMap { try? decoder.decode(ActivityEntry.self, from: Data($0.utf8)) }.suffix(limit))
  }

  /// Newest first.
  public var entries: [ActivityEntry] { lock.withLock { Array(cache.suffix(limit).reversed()) } }

  public func append(_ entry: ActivityEntry) {
    lock.withLock {
      cache.append(entry)
      let encoder = JSONEncoder()
      encoder.dateEncodingStrategy = .iso8601
      encoder.outputFormatting = [.sortedKeys]
      guard let line = try? encoder.encode(entry) else { return }
      if cache.count > limit + limit / 5 {
        // Rewrite now and then rather than on every append.
        cache.removeFirst(cache.count - limit)
        let all = cache.compactMap { try? encoder.encode($0) }.map { String(decoding: $0, as: UTF8.self) }
        try? (all.joined(separator: "\n") + "\n").write(to: url, atomically: true, encoding: .utf8)
      } else if let handle = FileHandle(forWritingAtPath: url.path) ?? create() {
        defer { try? handle.close() }
        _ = try? handle.seekToEnd()
        try? handle.write(contentsOf: line + Data("\n".utf8))
      }
      chmod(url.path, 0o600)
    }
  }

  public func clear() {
    lock.withLock {
      cache = []
      try? FileManager.default.removeItem(at: url)
    }
  }

  private func create() -> FileHandle? {
    FileManager.default.createFile(atPath: url.path, contents: nil, attributes: [.posixPermissions: 0o600])
    return FileHandle(forWritingAtPath: url.path)
  }
}

extension ActivityEntry {
  static let refusals: Set<String> = [
    ErrorCode.notAllowed, .unattendedNotAllowed, .paused, .invalidArguments, .busy, .outsideFolders, .protectedPath,
    .screenLocked, .permissionNeeded, .sandboxUnavailable, .inProgress,
  ].reduce(into: []) { $0.insert($1.rawValue) }

  /// Refused before anything happened on the Mac, so there is nothing to tell the person about.
  public var wasRefused: Bool { Self.refusals.contains(outcome) }

  /// An assistant the person has not allowed asked for something: the Activity list offers to allow it.
  public var allowSuggestion: Ability? {
    guard outcome == ErrorCode.notAllowed.rawValue else { return nil }
    return ActionRequest.ability(for: action)
  }
}
