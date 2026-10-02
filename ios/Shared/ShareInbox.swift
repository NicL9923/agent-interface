import Foundation

struct SharedCapture: Codable, Identifiable {
  var id: String
  var scope: String
  var botId: String?
  var text: String
  var files: [String]
  var createdAt: Date
}
struct ShareContext: Codable {
  struct Assistant: Codable, Identifiable { var id: String; var name: String }
  var scope: String
  var bots: [Assistant]
}
enum ShareInbox {
  static let group = "group.dev.agentinterface.shared"
  static var root: URL? { FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)?.appendingPathComponent("ShareInbox", isDirectory: true) }
  static func context() -> ShareContext? { guard let root, let data = try? Data(contentsOf: root.appendingPathComponent("context.json")) else { return nil }; return try? JSONDecoder().decode(ShareContext.self, from: data) }
  static func setContext(_ value: ShareContext?) {
    guard let root else { return }
    try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    if let value, let data = try? JSONEncoder().encode(value) { try? data.write(to: root.appendingPathComponent("context.json"), options: .atomic) }
    else { try? FileManager.default.removeItem(at: root.appendingPathComponent("context.json")) }
  }
  static func pending(scope: String) -> [SharedCapture] {
    guard let root else { return [] }
    let files = (try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? []
    return files.filter { $0.pathExtension == "json" && $0.lastPathComponent != "context.json" }.compactMap { url in
      guard let data = try? Data(contentsOf: url), let capture = try? JSONDecoder().decode(SharedCapture.self, from: data), valid(capture) else { return nil }
      if capture.scope != scope || Date().timeIntervalSince(capture.createdAt) > 86400 * 7 { remove(capture); return nil }
      return capture
    }.sorted { $0.createdAt < $1.createdAt }
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
