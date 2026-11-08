import Darwin
import Foundation

/// A durable record of every invocation this Mac accepted, as JSON lines in Application Support.
///
/// - An ID is written, and synced, before any work starts, so it never runs twice.
/// - Its result is written when it finishes and kept until the server acknowledges it.
/// - An ID that was accepted but has no result when the app starts again gets `uncertain`.
public final class InvocationJournal: @unchecked Sendable {
  public enum Lookup: Equatable {
    /// Recorded now; the caller runs it.
    case started
    case inProgress
    case finished(ActionOutcome)
    /// The ID was used before with different arguments.
    case mismatch
  }

  struct Entry {
    var id: String
    var fingerprint: String
    var acceptedAt: Date
    var outcome: ActionOutcome?
    var finishedAt: Date?
    var acked = false
  }

  /// Acknowledged IDs are remembered this long so a repeat is still answered, not rerun.
  public static let ackedRetention: TimeInterval = 30 * 24 * 3600
  /// An unacknowledged result older than this is dropped; the server's call ended long ago.
  public static let unackedRetention: TimeInterval = 7 * 24 * 3600
  static let compactAfterLines = 4000

  private let url: URL
  private let now: @Sendable () -> Date
  private let lock = NSLock()
  private var entries: [String: Entry] = [:]
  private var order: [String] = []
  private var linesSinceCompaction = 0

  public init(url: URL, now: @escaping @Sendable () -> Date = Date.init) throws {
    self.url = url
    self.now = now
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try load()
    // Anything accepted without a result was cut off by a quit or crash: it may have run.
    for id in order where entries[id]?.outcome == nil {
      entries[id]?.outcome = .failure(
        ActionError(.uncertain, "WildBots for Mac stopped while this action was running, so it may or may not have finished."))
      entries[id]?.finishedAt = now()
    }
    try compact()
  }

  /// Records `id` as accepted, or reports what is already known about it.
  public func begin(id: String, fingerprint: String) throws -> Lookup {
    try lock.withLock {
      if let entry = entries[id] {
        guard entry.fingerprint == fingerprint else { return .mismatch }
        if let outcome = entry.outcome { return .finished(outcome) }
        return .inProgress
      }
      try append(["t": "accepted", "id": .string(id), "fp": .string(fingerprint), "at": .number(now().timeIntervalSince1970)])
      entries[id] = Entry(id: id, fingerprint: fingerprint, acceptedAt: now())
      order.append(id)
      return .started
    }
  }

  public func finish(id: String, outcome: ActionOutcome) throws {
    try lock.withLock {
      guard entries[id] != nil, entries[id]?.outcome == nil else { return }
      try append(["t": "result", "id": .string(id), "outcome": outcome.json, "at": .number(now().timeIntervalSince1970)])
      entries[id]?.outcome = outcome
      entries[id]?.finishedAt = now()
    }
  }

  public func acknowledge(id: String) throws {
    try lock.withLock {
      guard let entry = entries[id], entry.outcome != nil, !entry.acked else { return }
      try append(["t": "acked", "id": .string(id)])
      entries[id]?.acked = true
    }
    if lock.withLock({ linesSinceCompaction }) >= Self.compactAfterLines { try? compact() }
  }

  /// Marks every waiting result delivered. Used when this Mac links again as a new device: the
  /// old device's results mean nothing to the new link. The IDs stay recorded and never rerun.
  public func discardUnacknowledged() throws {
    for (id, _) in unacknowledged() { try acknowledge(id: id) }
  }

  /// Results to send again after reconnecting, oldest first.
  public func unacknowledged() -> [(id: String, outcome: ActionOutcome)] {
    lock.withLock {
      order.compactMap { id in
        guard let entry = entries[id], !entry.acked, let outcome = entry.outcome else { return nil }
        return (id, outcome)
      }
    }
  }

  // MARK: Storage

  private func append(_ record: JSONValue) throws {
    let line = record.serialized + "\n"
    let fd = open(url.path, O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC, 0o600)
    guard fd >= 0 else { throw ActionError(.failed, "The invocation journal could not be opened.") }
    defer { close(fd) }
    let bytes = Array(line.utf8)
    var written = 0
    while written < bytes.count {
      let result = bytes.withUnsafeBytes { write(fd, $0.baseAddress! + written, bytes.count - written) }
      if result < 0 {
        if errno == EINTR { continue }
        throw ActionError(.failed, "The invocation journal could not be written.")
      }
      written += result
    }
    guard fsync(fd) == 0 else { throw ActionError(.failed, "The invocation journal could not be saved.") }
    linesSinceCompaction += 1
  }

  private func load() throws {
    guard let data = FileManager.default.contents(atPath: url.path), let text = String(data: data, encoding: .utf8)
    else { return }
    for line in text.split(separator: "\n") {
      // A torn last line from a crash mid-write is skipped; everything before it stands.
      guard let record = try? JSONValue.parse(String(line)), let id = record["id"]?.stringValue else { continue }
      switch record["t"]?.stringValue {
      case "accepted":
        guard entries[id] == nil, let fingerprint = record["fp"]?.stringValue else { continue }
        let at = Date(timeIntervalSince1970: record["at"]?.doubleValue ?? 0)
        entries[id] = Entry(id: id, fingerprint: fingerprint, acceptedAt: at)
        order.append(id)
      case "result":
        guard entries[id] != nil, let outcome = record["outcome"].flatMap(ActionOutcome.init(json:)) else { continue }
        entries[id]?.outcome = outcome
        entries[id]?.finishedAt = Date(
          timeIntervalSince1970: record["at"]?.doubleValue ?? 0)
      case "acked":
        entries[id]?.acked = true
      default:
        continue
      }
    }
  }

  /// Rewrites the journal with only what is still needed: unacknowledged results in full, and
  /// the IDs and fingerprints of recently acknowledged ones.
  public func compact() throws {
    try lock.withLock {
      let current = now()
      var keptOrder: [String] = []
      var lines: [String] = []
      for id in order {
        guard let entry = entries[id] else { continue }
        let finished = entry.finishedAt ?? entry.acceptedAt
        if entry.acked, current.timeIntervalSince(finished) > Self.ackedRetention { entries[id] = nil; continue }
        if !entry.acked, entry.outcome != nil, current.timeIntervalSince(finished) > Self.unackedRetention {
          entries[id] = nil
          continue
        }
        keptOrder.append(id)
        lines.append(
          JSONValue.object([
            "t": "accepted", "id": .string(id), "fp": .string(entry.fingerprint),
            "at": .number(entry.acceptedAt.timeIntervalSince1970),
          ]).serialized)
        if let outcome = entry.outcome {
          // An acknowledged value is no longer needed in full; keep only that it finished.
          let stored = entry.acked ? ActionOutcome.failure(ActionError(.failed, "This action already finished and its result was delivered.")) : outcome
          lines.append(
            JSONValue.object([
              "t": "result", "id": .string(id), "outcome": stored.json,
              "at": .number(finished.timeIntervalSince1970),
            ]).serialized)
          if entry.acked { lines.append(JSONValue.object(["t": "acked", "id": .string(id)]).serialized) }
        }
      }
      order = keptOrder
      let temp = url.deletingLastPathComponent().appendingPathComponent(".journal-\(UUID().uuidString)")
      let contents = Data((lines.map { $0 + "\n" }.joined()).utf8)
      guard FileManager.default.createFile(atPath: temp.path, contents: contents, attributes: [.posixPermissions: 0o600])
      else { throw ActionError(.failed, "The invocation journal could not be compacted.") }
      let fd = open(temp.path, O_RDONLY | O_CLOEXEC)
      if fd >= 0 {
        fsync(fd)
        close(fd)
      }
      guard rename(temp.path, url.path) == 0 else {
        unlink(temp.path)
        throw ActionError(.failed, "The invocation journal could not be compacted.")
      }
      linesSinceCompaction = 0
    }
  }
}
