import CryptoKit
import Foundation

struct SharedCapture: Codable, Identifiable {
  var id: String
  var scope: String
  var botId: String?
  var text: String
  var files: [String]
  var createdAt: Date
}
/// Shared text that already joined an assistant's draft. The app keeps these per account, so a share
/// retried after the app stopped before saving its emptied inbox copy adds its text once. A receipt
/// matches its share and that exact text: the same words from another share, or new words typed into
/// this one, still join. It is kept for as long as the inbox keeps a share.
struct SharedTextReceipt: Codable, Equatable {
  var capture: String
  var hash: String
  var at: Date
  init(capture: String, text: String, at: Date = Date()) {
    self.capture = capture
    hash = Self.hash(text)
    self.at = at
  }
  func matches(_ value: SharedCapture) -> Bool { capture == value.id && hash == Self.hash(value.text) }
  private static func hash(_ text: String) -> String { SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined() }
  /// The receipts still worth keeping, with these added: a share older than the inbox keeps is gone.
  static func recording(_ new: [SharedTextReceipt], in kept: [SharedTextReceipt], now: Date = Date()) -> [SharedTextReceipt] {
    kept.filter { now.timeIntervalSince($0.at) < ShareInbox.lifetime } + new
  }
}
struct ShareContext: Codable {
  struct Assistant: Codable, Identifiable { var id: String; var name: String }
  var scope: String
  var bots: [Assistant]
}
enum ShareInbox {
  static let group = "group.dev.agentinterface.shared"
  /// How long a share waits in the inbox before it is removed unread.
  static let lifetime: TimeInterval = 86400 * 7
  static var root: URL? { FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)?.appendingPathComponent("ShareInbox", isDirectory: true) }
  static func context() -> ShareContext? { guard let root, let data = try? Data(contentsOf: root.appendingPathComponent("context.json")) else { return nil }; return try? JSONDecoder().decode(ShareContext.self, from: data) }
  static func setContext(_ value: ShareContext?) {
    guard let root else { return }
    try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    if let value, let data = try? JSONEncoder().encode(value) { try? data.write(to: root.appendingPathComponent("context.json"), options: .atomic) }
    else { try? FileManager.default.removeItem(at: root.appendingPathComponent("context.json")) }
  }
  static func save(_ capture: SharedCapture, in directory: URL? = Self.root) throws {
    guard valid(capture) else { throw CocoaError(.fileWriteInvalidFileName) }
    guard let directory else { throw CocoaError(.fileNoSuchFile) }
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    try JSONEncoder().encode(capture).write(to: directory.appendingPathComponent(capture.id + ".json"), options: .atomic)
  }
  /// Once accepted, clear the in-memory text before saving. If saving fails, the caller must
  /// keep this capture open and retry that save before allowing another import. `hold` must
  /// accept a share it already took without adding it again, because a relaunch can find the
  /// saved copy still holding text that was taken just before the app stopped.
  static func transferText(_ capture: inout SharedCapture, hold: (SharedCapture) -> Bool, save: (SharedCapture) throws -> Void) throws -> Bool {
    guard !capture.text.isEmpty else { return true }
    guard hold(capture) else { return false }
    capture.text = ""
    try save(capture)
    return true
  }
  static func pending(scope: String) -> [SharedCapture] {
    guard let root else { return [] }
    pruneOrphans(in: root)
    let files = (try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? []
    return files.filter { $0.pathExtension == "json" && $0.lastPathComponent != "context.json" }.compactMap { url in
      guard let data = try? Data(contentsOf: url), let capture = try? JSONDecoder().decode(SharedCapture.self, from: data), valid(capture) else { return nil }
      if capture.scope != scope || Date().timeIntervalSince(capture.createdAt) > lifetime { remove(capture); return nil }
      return capture
    }.sorted { $0.createdAt < $1.createdAt }
  }
  /// An interrupted extension can leave files without a saved draft. Keep current
  /// work and any directory owned by a JSON capture; prune only old UUID folders.
  static func pruneOrphans(in directory: URL, now: Date = Date()) {
    let manager = FileManager.default
    let entries = (try? manager.contentsOfDirectory(at: directory,
      includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey, .creationDateKey])) ?? []
    for entry in entries where UUID(uuidString: entry.lastPathComponent) != nil {
      guard let values = try? entry.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey, .creationDateKey]),
        values.isDirectory == true, values.isSymbolicLink != true,
        let created = values.creationDate, now.timeIntervalSince(created) > 86400,
        !manager.fileExists(atPath: directory.appendingPathComponent(entry.lastPathComponent + ".json").path)
      else { continue }
      try? manager.removeItem(at: entry)
    }
  }
  static func valid(_ value: SharedCapture) -> Bool {
    UUID(uuidString: value.id) != nil && value.files.count <= 10 && value.text.count <= 50000 && value.files.allSatisfy { !$0.isEmpty && !$0.contains("/") && !$0.contains("\\") && $0 != "." && $0 != ".." }
  }
  static func remove(_ value: SharedCapture) {
    guard valid(value), let root else { return }
    try? FileManager.default.removeItem(at: root.appendingPathComponent(value.id, isDirectory: true))
    try? FileManager.default.removeItem(at: root.appendingPathComponent(value.id + ".json"))
  }
  static func fileURLs(_ value: SharedCapture) -> [URL] {
    guard valid(value), let root else { return [] }
    return value.files.map { root.appendingPathComponent(value.id, isDirectory: true).appendingPathComponent($0) }
  }
}
