import Foundation

/// Up and Down on a hardware keyboard step through this person's earlier messages in the open
/// conversation, newest first, like a shell's history. Recall starts only from an empty composer,
/// and Down past the newest message returns to the empty draft. Typing in a recalled message
/// keeps it as the draft and ends recall, so the arrows move the cursor again.
struct PromptRecall: Equatable {
  /// Earlier messages, newest first, captured when recall started.
  private(set) var history: [String] = []
  /// The message shown, as an index into `history`, or nil when not recalling.
  private(set) var index: Int?
  var recalling: Bool { index != nil }

  /// The text the composer should show after an arrow, or nil to let the text view move the
  /// cursor as usual. `messages` is read only when recall starts.
  mutating func arrow(up: Bool, text: String, messages: () -> [String]) -> String? {
    if let index, history.indices.contains(index), text != history[index] { self = PromptRecall() }
    guard let index else {
      guard up, text.isEmpty else { return nil }
      let earlier = messages()
      guard !earlier.isEmpty else { return nil }
      history = earlier
      self.index = 0
      return earlier[0]
    }
    if up {
      guard index + 1 < history.count else { return history[index] }
      self.index = index + 1
      return history[index + 1]
    }
    guard index > 0 else { self = PromptRecall(); return "" }
    self.index = index - 1
    return history[index - 1]
  }
  /// Forgets recall, as when the conversation changes or a send starts.
  mutating func reset() { self = PromptRecall() }

  /// This person's own messages, newest first, without repeats in a row. Messages from other
  /// household members in a shared chat, scheduled or agent handoffs and activity are left out.
  static func ownMessages(_ messages: [Message], userId: String?) -> [String] {
    var result: [String] = []
    for message in messages.reversed() where message.isHumanMessage && (message.sender == nil || message.sender?.id == userId)
    {
      let text = message.text
      guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, result.last != text else { continue }
      result.append(text)
    }
    return result
  }
}

/// Pasting a lot of text attaches it as a file instead of filling the message, as on the web.
enum LargePaste {
  /// 32 KiB of UTF-8, the web composer's threshold.
  static let threshold = 32 * 1024
  static let fileName = "Pasted text.txt"
  static let notice = "Long pasted text was attached as \(fileName)."
  static func attaches(_ text: String) -> Bool { text.utf8.count >= threshold }
  /// Writes the text to its own private folder for the upload queue, which copies it again.
  static func file(_ text: String) throws -> URL {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("paste-" + UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let url = directory.appendingPathComponent(fileName)
    try Data(text.utf8).write(to: url, options: .atomic)
    return url
  }
}
