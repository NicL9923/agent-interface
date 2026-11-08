import Darwin
import Foundation

/// A durable record of every invocation this Mac accepted, as JSON lines in Application Support.
///
/// - An ID is written, and synced, before any work starts, so it never runs twice.
/// - Its result is written when it finishes and kept until the server acknowledges it.
/// - An ID that was accepted but has no result when the app starts again gets `uncertain`.
/// - A journal that exists but cannot be read stops the app from starting rather than being
///   replaced by an empty one, which would forget every ID it held.
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

  /// Every accepted ID is remembered this long from its acceptance, so a repeat is answered, not rerun.
  public static let ackedRetention: TimeInterval = 30 * 24 * 3600
  /// An unacknowledged result older than this loses its value, because the server's call ended
  /// long ago. Its ID stays for `ackedRetention` and a repeat answers `uncertain`.
  public static let unackedRetention: TimeInterval = 7 * 24 * 3600
  static let expiredOutcome = ActionOutcome.failure(
    ActionError(.uncertain, "This action finished more than 7 days ago and its result is no longer available."))
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

  /// Reads the journal record by record. Only a torn final record, cut off by a crash in the
  /// middle of an append, is skipped; any other damage, or a journal that exists but cannot be
  /// read, throws so nothing is compacted over it and no action runs.
  private func load() throws {
    let fd = open(url.path, O_RDONLY | O_CLOEXEC)
    if fd < 0 {
      let code = errno
      if code == ENOENT { return }
      throw unreadable(String(cString: strerror(code)))
    }
    defer { close(fd) }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 1 << 16)
    while true {
      let count = buffer.withUnsafeMutableBytes { read(fd, $0.baseAddress, $0.count) }
      if count < 0 {
        if errno == EINTR { continue }
        throw unreadable(String(cString: strerror(errno)))
      }
      if count == 0 { break }
      data.append(contentsOf: buffer[0..<count])
    }
    let records = data.split(separator: UInt8(ascii: "\n"), omittingEmptySubsequences: false)
    for (index, raw) in records.enumerated() where !raw.isEmpty {
      guard let text = String(data: Data(raw), encoding: .utf8), let record = try? JSONValue.parse(text) else {
        // Only the last record can lack its newline, and only a crash mid-append leaves it so.
        if index == records.count - 1 { continue }
        throw unreadable("record \(index + 1) is damaged")
      }
      let last = index == records.count - 1
      guard let id = record["id"]?.stringValue, !id.isEmpty else {
        if last { continue }
        throw unreadable("record \(index + 1) has no invocation ID")
      }
      switch record["t"]?.stringValue {
      case "accepted":
        // An accepted record is what stops an ID from running twice, so a malformed or repeated one
        // is damage, never something to skip.
        guard entries[id] == nil, let fingerprint = record["fp"]?.stringValue, !fingerprint.isEmpty,
          let seconds = record["at"]?.doubleValue
        else {
          if last { continue }
          throw unreadable("record \(index + 1) is not a valid accepted invocation")
        }
        let at = Date(timeIntervalSince1970: seconds)
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

  private func unreadable(_ reason: String) -> ActionError {
    ActionError(
      .failed,
      "The invocation journal at \(ActionError.quoted(url.path)) could not be read (\(reason)). WildBots for Mac runs no "
        + "actions until it can, so that none runs twice.")
  }

  /// Rewrites the journal with only what is still needed: unacknowledged results in full for 7
  /// days, and every ID with its fingerprint and whether it finished for 30 days from acceptance.
  public func compact() throws {
    try lock.withLock {
      let current = now()
      var keptOrder: [String] = []
      var lines: [String] = []
      for id in order {
        guard var entry = entries[id] else { continue }
        let finished = entry.finishedAt ?? entry.acceptedAt
        if entry.outcome != nil, current.timeIntervalSince(entry.acceptedAt) > Self.ackedRetention {
          entries[id] = nil
          continue
        }
        if !entry.acked, entry.outcome != nil, current.timeIntervalSince(finished) > Self.unackedRetention {
          // The value goes; the ID stays, so a late repeat is answered and never rerun.
          entry.outcome = Self.expiredOutcome
          entry.acked = true
          entries[id] = entry
        }
        keptOrder.append(id)
        lines.append(
          JSONValue.object([
            "t": "accepted", "id": .string(id), "fp": .string(entry.fingerprint),
            "at": .number(entry.acceptedAt.timeIntervalSince1970),
          ]).serialized)
        if let outcome = entry.outcome {
          // An acknowledged value is no longer needed in full; keep only that it finished.
          let stored =
            !entry.acked || outcome == Self.expiredOutcome
            ? outcome : ActionOutcome.failure(ActionError(.failed, "This action already finished and its result was delivered."))
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
