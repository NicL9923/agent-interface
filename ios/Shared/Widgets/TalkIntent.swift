import AppIntents
import Foundation

/// Opens an assistant's chat and starts a voice message: the action behind the Talk to assistant
/// control in Control Center, on the Lock Screen and on the Action button. It is built into both
/// the app and the widget extension, as controls that open the app must be.
struct TalkToAssistantIntent: OpenIntent {
  static var title: LocalizedStringResource { "Talk to assistant" }
  static var description: IntentDescription { IntentDescription("Opens a conversation with one of your assistants and starts a voice message.") }
  @Parameter(title: "Assistant") var target: AssistantEntity
  init() {}
  init(target: AssistantEntity) { self.target = target }
  @MainActor func perform() async throws -> some IntentResult {
    await IntentLinks.open(DeepLink.bot(target.id, listen: true))
    return .result()
  }
}

/// The control's setting: which assistant it talks to.
@available(iOS 18.0, *)
struct ChooseTalkAssistantIntent: ControlConfigurationIntent {
  static var title: LocalizedStringResource { "Choose assistant" }
  @Parameter(title: "Assistant") var assistant: AssistantEntity?
  init() {}
}

/// How an intent reaches the app's navigation. In the app the handler opens the link at once.
/// iOS may run the intent in the widget extension instead, which cannot navigate the app, so the
/// link waits in the App Group for the app to open it as it becomes active.
@MainActor enum IntentLinks {
  static var handler: ((URL) async -> Void)?
  static var pendingURL: URL? {
    FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: ShareInbox.group)?
      .appendingPathComponent("Widgets", isDirectory: true).appendingPathComponent("pending-link.json")
  }
  /// A link older than this was not meant for the app's next activation.
  static let patience: TimeInterval = 60
  /// A link and when it was asked for, so the wait does not refresh its deadline.
  struct Pending: Codable, Equatable { var url: URL; var at: Date }

  static func open(_ url: URL, store location: URL? = pendingURL) async {
    if let handler { return await handler(url) }
    guard let location, let data = try? JSONEncoder().encode(Pending(url: url, at: Date())) else { return }
    try? FileManager.default.createDirectory(at: location.deletingLastPathComponent(), withIntermediateDirectories: true)
    try? data.write(to: location, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
  }
  /// The waiting link, once, if it is still fresh.
  static func takePending(from location: URL? = pendingURL, now: Date = Date()) -> Pending? {
    guard let location, let data = try? Data(contentsOf: location) else { return nil }
    try? FileManager.default.removeItem(at: location)
    guard let pending = try? JSONDecoder().decode(Pending.self, from: data), abs(now.timeIntervalSince(pending.at)) < patience else { return nil }
    return pending
  }
}
