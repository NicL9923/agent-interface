import AppIntents
import Foundation

/// A question from Siri or Shortcuts waiting to land in an assistant's draft. It is never sent:
/// the person reviews it in the chat. It names the account it was asked in, so a different
/// sign-in cannot receive it, and it lapses if the app cannot take it soon. The store holds it as
/// a `DraftAddition`.
struct AskRequest: Equatable {
  var botId: String
  var text: String
  var scope: String
  var at: Date
  static let patience: TimeInterval = 5 * 60
}

enum AssistantIntentError: Error, CustomLocalizedStringResourceConvertible {
  case signedOut, missing, empty, tooLong
  var localizedStringResource: LocalizedStringResource {
    switch self {
    case .signedOut: "Open WildBots and sign in first."
    case .missing: "That assistant is no longer available."
    case .empty: "Say what you want to ask."
    case .tooLong: "That message is too long. WildBots accepts up to 50,000 characters."
    }
  }
}

extension AskRequest {
  /// Checks a question against the snapshot the entities came from. The snapshot is the only
  /// view of the account an intent has, and it is gone after sign-out.
  static func make(botId: String, text: String, snapshot: WidgetSnapshot?, now: Date = Date()) throws -> AskRequest {
    guard let snapshot else { throw AssistantIntentError.signedOut }
    guard snapshot.assistants.contains(where: { $0.id == botId }) else { throw AssistantIntentError.missing }
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { throw AssistantIntentError.empty }
    guard trimmed.utf16.count <= AppStore.maxMessageLength else { throw AssistantIntentError.tooLong }
    return AskRequest(botId: botId, text: trimmed, scope: snapshot.scope, at: now)
  }
}

struct OpenAssistantIntent: AppIntent {
  static var title: LocalizedStringResource { "Open assistant" }
  static var description: IntentDescription { IntentDescription("Opens a conversation with one of your assistants.") }
  static var openAppWhenRun: Bool { true }
  @Parameter(title: "Assistant") var assistant: AssistantEntity
  static var parameterSummary: some ParameterSummary { Summary("Open \(\.$assistant)") }
  init() {}
  init(assistant: AssistantEntity) { self.assistant = assistant }
  /// The same link a widget row or notification opens.
  var destination: URL { DeepLink.bot(assistant.id) }
  @MainActor func perform() async throws -> some IntentResult {
    await NotificationController.shared.open(destination)
    return .result()
  }
}

struct AskAssistantIntent: AppIntent {
  static var title: LocalizedStringResource { "Ask an assistant" }
  static var description: IntentDescription {
    IntentDescription("Puts your message in an assistant's draft and opens the chat so you can review it. Nothing is sent until you send it.")
  }
  static var openAppWhenRun: Bool { true }
  @Parameter(title: "Assistant") var assistant: AssistantEntity
  @Parameter(title: "Message", requestValueDialog: "What do you want to ask?") var message: String
  static var parameterSummary: some ParameterSummary { Summary("Ask \(\.$assistant) \(\.$message)") }
  init() {}
  init(assistant: AssistantEntity, message: String) { self.assistant = assistant; self.message = message }
  @MainActor func perform() async throws -> some IntentResult {
    let request = try AskRequest.make(
      botId: assistant.id, text: message, snapshot: WidgetSnapshotStore.read(from: AssistantEntityQuery.snapshotURL))
    NotificationController.shared.ask(request)
    return .result()
  }
}

struct OpenTodayIntent: AppIntent {
  static var title: LocalizedStringResource { "Open Today" }
  static var description: IntentDescription { IntentDescription("Opens what is new, waiting and in progress across your assistants.") }
  static var openAppWhenRun: Bool { true }
  init() {}
  var destination: URL { DeepLink.today }
  @MainActor func perform() async throws -> some IntentResult {
    await NotificationController.shared.open(destination)
    return .result()
  }
}

/// Phrases always include the app's name, which Siri requires and which keeps them from
/// colliding with other apps' assistants.
struct WildBotsShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: OpenAssistantIntent(),
      phrases: [
        "Open \(\.$assistant) in \(.applicationName)", "Talk to \(\.$assistant) in \(.applicationName)",
        "Chat with \(\.$assistant) in \(.applicationName)",
      ],
      shortTitle: "Open assistant", systemImageName: "bubble.left.and.bubble.right")
    AppShortcut(
      intent: AskAssistantIntent(),
      phrases: ["Ask \(\.$assistant) in \(.applicationName)", "Ask \(\.$assistant) using \(.applicationName)"],
      shortTitle: "Ask assistant", systemImageName: "text.bubble")
    AppShortcut(
      intent: OpenTodayIntent(),
      phrases: ["Open Today in \(.applicationName)", "What is new in \(.applicationName)", "Show my \(.applicationName) recap"],
      shortTitle: "Open Today", systemImageName: "calendar")
  }
}

extension NotificationController {
  /// Opens a widget, notification or Shortcuts link, the one way every outside entry reaches a chat.
  /// `at` is when the link was asked for, which a link handed over from the widget extension keeps.
  func open(_ url: URL, at: Date = Date()) async {
    guard let path = DeepLink.relativePath(for: url) else { return }
    if path.hasSuffix("&listen=1") { listenLinkAt = at }
    pendingURL = path
    await openPendingConversation()
  }
  /// Hands a question to the store, or keeps it until the store exists, as when Siri launched the app.
  func ask(_ request: AskRequest) {
    if let store { store.queueAsk(request) } else { earlyAsk = request }
  }
}
