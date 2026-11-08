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
    try ShareInbox.save(capture, in: root)
    var edited = capture; edited.text = "My edited shared text"; edited.botId = "garden"
    try ShareInbox.save(edited, in: root)
    let restored = try JSONDecoder().decode(SharedCapture.self, from: Data(contentsOf: root.appendingPathComponent(capture.id + ".json")))
    precondition(restored.text == edited.text && restored.botId == "garden", "Edits were lost when reopening a saved share")
    let blocked = root.appendingPathComponent("not-a-directory")
    try Data().write(to: blocked)
    do { try ShareInbox.save(edited, in: blocked); preconditionFailure("A failed save was reported as successful") }
    catch { }
    var importing = capture
    var held: [String] = []
    do {
      _ = try ShareInbox.transferText(&importing, hold: { held.append($0.text); return true }, save: { try ShareInbox.save($0, in: blocked) })
      preconditionFailure("A failed capture update was reported as successful")
    } catch { }
    precondition(importing.text.isEmpty && held == [capture.text], "Accepted text must be cleared even when saving fails")
    try ShareInbox.save(importing, in: root)
    _ = try ShareInbox.transferText(&importing, hold: { held.append($0.text); return true }, save: { try ShareInbox.save($0, in: root) })
    let afterRetry = try JSONDecoder().decode(SharedCapture.self, from: Data(contentsOf: root.appendingPathComponent(capture.id + ".json")))
    precondition(held == [capture.text] && afterRetry.text.isEmpty, "Retry must save the cleared capture without holding text twice")
    var rejected = capture
    let accepted = try ShareInbox.transferText(&rejected, hold: { _ in false }, save: { _ in preconditionFailure("Rejected text was saved") })
    precondition(!accepted && rejected.text == capture.text, "Rejected text must remain in the capture")
    // A receipt read back after a relaunch still knows its share's text, and only that share's text.
    let receipt = SharedTextReceipt(capture: capture.id, text: capture.text, at: now)
    let reread = try JSONDecoder().decode([SharedTextReceipt].self, from: JSONEncoder().encode([receipt]))
    precondition(reread.first?.matches(capture) == true, "A saved receipt no longer matched its share")
    precondition(!reread[0].matches(edited), "New words typed into a share matched the text it already added")
    var twin = capture; twin.id = UUID().uuidString
    precondition(!reread[0].matches(twin), "The same words from another share matched")
    let stale = SharedTextReceipt(capture: twin.id, text: twin.text, at: now.addingTimeInterval(-ShareInbox.lifetime - 1))
    let kept = SharedTextReceipt.recording([receipt], in: [stale], now: now)
    precondition(kept == [receipt], "A receipt outlived the shares it can match, or a new one was dropped")
    var unsafe = capture; unsafe.files = ["../outside.txt"]
    precondition(!ShareInbox.valid(unsafe), "A file escaped its capture directory")
    do { try ShareInbox.save(unsafe, in: root); preconditionFailure("An invalid share was written") }
    catch { }
    print("Share inbox edits, failed saves, text receipts, orphan cleanup and file bounds checks passed.")
  }
}
