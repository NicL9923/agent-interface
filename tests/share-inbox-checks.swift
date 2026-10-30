import Foundation

@main struct ShareInboxChecks {
  static func main() throws {
    let manager = FileManager.default
    let output = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
    let root = output.appendingPathComponent(UUID().uuidString, isDirectory: true)
    try manager.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? manager.removeItem(at: root) }
    let now = Date()
    func folder(_ name: String = UUID().uuidString, age: TimeInterval = 0) throws -> URL {
      let path = root.appendingPathComponent(name, isDirectory: true)
      try manager.createDirectory(at: path, withIntermediateDirectories: true)
      try manager.setAttributes([.creationDate: now.addingTimeInterval(-age)], ofItemAtPath: path.path)
      try Data("private shared content".utf8).write(to: path.appendingPathComponent("item.txt"))
      return path
    }
    let orphan = try folder(age: 172800)
    let fresh = try folder()
    let saved = try folder(age: 172800)
    try Data("{}".utf8).write(to: root.appendingPathComponent(saved.lastPathComponent + ".json"))
    let unrelated = try folder("unrelated", age: 172800)
    let outside = output.appendingPathComponent(UUID().uuidString, isDirectory: true)
    try manager.createDirectory(at: outside, withIntermediateDirectories: true)
    defer { try? manager.removeItem(at: outside) }
    let link = root.appendingPathComponent(UUID().uuidString)
    try manager.createSymbolicLink(at: link, withDestinationURL: outside)
    ShareInbox.pruneOrphans(in: root, now: now)
    precondition(!manager.fileExists(atPath: orphan.path), "Old unsaved files were retained")
    precondition(manager.fileExists(atPath: fresh.path), "A share still being prepared was removed")
    precondition(manager.fileExists(atPath: saved.path), "A saved draft's files were removed")
    precondition(manager.fileExists(atPath: unrelated.path), "An unrelated directory was removed")
    precondition(manager.fileExists(atPath: link.path) && manager.fileExists(atPath: outside.path), "A symbolic link was followed or removed")
    let capture = SharedCapture(id: UUID().uuidString, scope: "account", text: "Review before sending", files: ["item.txt"], createdAt: now)
    precondition(ShareInbox.valid(capture), "Valid share refused")
    var unsafe = capture; unsafe.files = ["../outside.txt"]
    precondition(!ShareInbox.valid(unsafe), "A file escaped its capture directory")
    print("Share inbox orphan cleanup and file bounds checks passed.")
  }
}
