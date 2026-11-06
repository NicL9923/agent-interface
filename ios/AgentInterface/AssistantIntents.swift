import AppIntents
import SwiftUI

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

/// Who needs the person and who is working, said and shown without opening the app. It reads the
/// widgets' snapshot, refreshed first with the app's own sign-in when it is more than a minute old.
struct CheckAssistantsIntent: AppIntent {
  static var title: LocalizedStringResource { "Check on assistants" }
  static var description: IntentDescription {
    IntentDescription("Tells you which assistants need you and which are working, without opening WildBots.")
  }
  static var openAppWhenRun: Bool { false }
  init() {}
  /// Siri gives up after a few seconds; a slow server leaves the snapshot as it was.
  static let refreshPatience: Duration = .seconds(4)
  @MainActor func perform() async throws -> some IntentResult & ProvidesDialog & ShowsSnippetView {
    let url = AssistantEntityQuery.snapshotURL
    if WidgetSnapshotStore.read(from: url).map({ Date().timeIntervalSince($0.generatedAt) > 60 }) ?? true {
      await withTaskGroup(of: Void.self) { group in
        group.addTask { @MainActor in await BackgroundRefresh.refreshWidgets() }
        group.addTask { try? await Task.sleep(for: Self.refreshPatience) }
        await group.next()
        group.cancelAll()
      }
    }
    guard let snapshot = WidgetSnapshotStore.read(from: url) else { throw AssistantIntentError.signedOut }
    let now = Date()
    return .result(dialog: IntentDialog(stringLiteral: snapshot.spokenSummary(at: now)), view: AssistantStatusSnippet(snapshot: snapshot))
  }
}

extension WidgetSnapshot {
  /// What Siri says: each assistant that needs the person, then who is working, and how old the news is
  /// when the snapshot is stale.
  func spokenSummary(at now: Date) -> String {
    func names(_ list: [Assistant]) -> String { ListFormatter.localizedString(byJoining: list.map(\.name)) }
    let ordered = self.ordered
    let attention = ordered.filter(\.needsAttention), working = ordered.filter(\.isWorking)
    var parts = attention.map { "\($0.name) \($0.activity == "waiting" ? "needs your approval" : "needs your input")." }
    if !working.isEmpty { parts.append("\(names(working)) \(working.count == 1 ? "is" : "are") working.") }
    if parts.isEmpty { parts = ["All caught up. Nobody needs you and nothing is running."] }
    if isStale(at: now) {
      let age = RelativeDateTimeFormatter().localizedString(for: generatedAt, relativeTo: now)
      parts.insert("WildBots last checked \(age), so this may be out of date.", at: 0)
    }
    return parts.joined(separator: " ")
  }
}

/// The card Siri and Shortcuts show under the answer: the same rows as the widget, at most five.
struct AssistantStatusSnippet: View {
  var snapshot: WidgetSnapshot
  var body: some View {
    let rows = snapshot.ordered.filter { $0.needsAttention || $0.isWorking }.prefix(5)
    VStack(alignment: .leading, spacing: 8) {
      if rows.isEmpty {
        Label("All caught up", systemImage: "checkmark.circle.fill").foregroundStyle(WidgetPalette.color(.done))
      }
      ForEach(Array(rows)) { assistant in
        HStack(spacing: 8) {
          AssistantGlyphView(color: WidgetPalette.hex(assistant.color) ?? WidgetPalette.brand).frame(width: 18, height: 18)
          Text(assistant.name).fontWeight(.semibold).lineLimit(1)
          Spacer(minLength: 4)
          Text(assistant.status ?? "").foregroundStyle(WidgetPalette.color(assistant.phase)).lineLimit(1)
        }.font(.subheadline).accessibilityElement(children: .combine)
      }
      Text("Updated \(snapshot.generatedAt, style: .relative) ago").font(.caption2).foregroundStyle(.secondary)
    }.padding()
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
    AppShortcut(
      intent: CheckAssistantsIntent(),
      phrases: [
        "What's waiting in \(.applicationName)", "Does anyone need me in \(.applicationName)",
        "Check on my assistants in \(.applicationName)",
      ],
      shortTitle: "Check on assistants", systemImageName: "person.crop.circle.badge.exclamationmark")
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
