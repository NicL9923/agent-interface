import AppIntents
import Foundation
import os
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
  case signedOut, missing, empty, tooLong, sendDisabled, sendTooLong, rateLimited, failed(String)
  var localizedStringResource: LocalizedStringResource {
    switch self {
    case .signedOut: "Open WildBots and sign in first."
    case .missing: "That item is no longer available."
    case .empty: "Say what you want to ask."
    case .tooLong: "That message is too long. WildBots accepts up to 50,000 characters."
    case .sendDisabled: "Turn on Shortcut message sending in WildBots Settings first."
    case .sendTooLong: "Automated Shortcut messages can contain up to 4,000 characters."
    case .rateLimited: "Wait a few seconds before sending another automated message to this assistant."
    case .failed(let reason): LocalizedStringResource(stringLiteral: reason)
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

// MARK: Automation-friendly intents (Routines & safety-bounded Send)

/// A routine from the active account's non-secret `RoutineSnapshot` for Shortcuts automation.
struct RoutineEntity: AppEntity, Identifiable, Hashable {
  static var typeDisplayRepresentation: TypeDisplayRepresentation { "Routine" }
  static var defaultQuery: RoutineEntityQuery { RoutineEntityQuery() }
  var id: String
  var name: String
  var botName: String
  var displayRepresentation: DisplayRepresentation {
    DisplayRepresentation(title: "\(name)", subtitle: "\(botName)")
  }
  init(id: String, name: String, botName: String) {
    self.id = id
    self.name = name
    self.botName = botName
  }
  init(_ item: RoutineSnapshot.Item) {
    self.init(id: item.id, name: item.name, botName: item.botName)
  }
}

struct RoutineEntityQuery: EntityStringQuery {
  private static let snapshotLocation = OSAllocatedUnfairLock<URL?>(initialState: RoutineSnapshotStore.defaultURL)
  static var snapshotURL: URL? {
    get { snapshotLocation.withLock { $0 } }
    set { snapshotLocation.withLock { $0 = newValue } }
  }
  init() {}
  private var all: [RoutineEntity] {
    RoutineSnapshotStore.read(from: Self.snapshotURL)?.routines.map(RoutineEntity.init) ?? []
  }
  func entities(for identifiers: [String]) async throws -> [RoutineEntity] {
    let known = Dictionary(all.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
    return identifiers.compactMap { known[$0] }
  }
  func entities(matching string: String) async throws -> [RoutineEntity] {
    let words = string.trimmingCharacters(in: .whitespacesAndNewlines)
    return words.isEmpty ? all : all.filter { $0.name.localizedStandardContains(words) || $0.botName.localizedStandardContains(words) }
  }
  func suggestedEntities() async throws -> [RoutineEntity] { all }
}

/// Runs a saved routine once immediately from iOS Shortcuts without opening the app.
struct TryOnceIntent: AppIntent {
  static var title: LocalizedStringResource { "Run routine once" }
  static var description: IntentDescription {
    IntentDescription("Starts a saved WildBots routine immediately using your signed-in account.")
  }
  static var openAppWhenRun: Bool { false }
  static var authenticationPolicy: IntentAuthenticationPolicy { .requiresAuthentication }
  @Parameter(title: "Routine") var routine: RoutineEntity
  static var parameterSummary: some ParameterSummary { Summary("Run \(\.$routine) once") }
  init() {}
  init(routine: RoutineEntity) { self.routine = routine }

  @MainActor func perform() async throws -> some IntentResult & ProvidesDialog {
    let dialog = try await Self.execute(
      routineId: routine.id,
      routineName: routine.name,
      snapshot: RoutineSnapshotStore.read(from: RoutineEntityQuery.snapshotURL),
      signedInScope: NotificationController.shared.store?.scope ?? NotificationController.shared.savedScope(),
      client: NotificationController.shared.store?.api.flatMap { $0.token != nil || $0.localCookieAuth ? $0 : nil }
        ?? NotificationController.shared.actionClient()
    )
    return .result(dialog: IntentDialog(stringLiteral: dialog))
  }

  @MainActor static func execute(
    routineId: String,
    routineName: String,
    snapshot: RoutineSnapshot?,
    signedInScope: String?,
    client: APIClient?
  ) async throws -> String {
    guard let snapshot, let signedInScope, snapshot.scope == signedInScope, let client else {
      throw AssistantIntentError.signedOut
    }
    guard snapshot.routines.contains(where: { $0.id == routineId }) else {
      throw AssistantIntentError.missing
    }
    let requestId = UUID().uuidString.lowercased()
    do {
      let receipt: RoutineRunReceipt = try await client.write(
        "/routines/\(APIClient.component(routineId))/run",
        ["requestId": requestId]
      )
      return receipt.status == "accepted" || receipt.status == "running"
        ? "Started \(routineName)."
        : receipt.summary
    } catch {
      throw AssistantIntentError.failed(error.localizedDescription)
    }
  }
}

/// Opt-in policy and rate-limiter for unattended Shortcut message sending (`SendAssistantMessageIntent`).
/// Disabled by default per account scope so Shortcuts can never send messages unexpectedly.
@MainActor enum ShortcutSendPolicy {
  static let maxMessageLength = 4_000
  static let cooldownSeconds: TimeInterval = 5

  static func key(scope: String) -> String { "native.\(scope).shortcutSendEnabled" }
  static func isEnabled(for scope: String?, defaults: UserDefaults = .standard) -> Bool {
    guard let scope, !scope.isEmpty else { return false }
    return defaults.bool(forKey: key(scope: scope))
  }
  static func setEnabled(_ enabled: Bool, for scope: String?, defaults: UserDefaults = .standard) {
    guard let scope, !scope.isEmpty else { return }
    defaults.set(enabled, forKey: key(scope: scope))
  }

  private static var lastSentAt: [String: Date] = [:]
  static func resetCooldowns() { lastSentAt.removeAll() }

  static func validate(
    botId: String,
    text: String,
    snapshot: WidgetSnapshot?,
    signedInScope: String?,
    defaults: UserDefaults = .standard,
    now: Date = Date()
  ) throws -> String {
    guard let snapshot, let signedInScope, snapshot.scope == signedInScope else {
      throw AssistantIntentError.signedOut
    }
    guard isEnabled(for: signedInScope, defaults: defaults) else {
      throw AssistantIntentError.sendDisabled
    }
    guard snapshot.assistants.contains(where: { $0.id == botId }) else {
      throw AssistantIntentError.missing
    }
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { throw AssistantIntentError.empty }
    guard trimmed.utf16.count <= maxMessageLength else { throw AssistantIntentError.sendTooLong }
    let rateKey = "\(signedInScope)|\(botId)"
    if let last = lastSentAt[rateKey], now.timeIntervalSince(last) < cooldownSeconds {
      throw AssistantIntentError.rateLimited
    }
    lastSentAt[rateKey] = now
    return trimmed
  }
}

/// Safety-bounded Shortcuts intent that sends a message directly to an assistant when the user has
/// explicitly opted in via Settings -> Shortcuts automation.
struct SendAssistantMessageIntent: AppIntent {
  static var title: LocalizedStringResource { "Send message to assistant" }
  static var description: IntentDescription {
    IntentDescription("Sends a message directly to an assistant from an automation. Requires turning on Shortcut message sending in WildBots Settings.")
  }
  static var openAppWhenRun: Bool { false }
  static var authenticationPolicy: IntentAuthenticationPolicy { .requiresAuthentication }
  @Parameter(title: "Assistant") var assistant: AssistantEntity
  @Parameter(title: "Message") var message: String
  static var parameterSummary: some ParameterSummary { Summary("Send \(\.$message) to \(\.$assistant)") }
  init() {}
  init(assistant: AssistantEntity, message: String) { self.assistant = assistant; self.message = message }

  @MainActor func perform() async throws -> some IntentResult & ProvidesDialog {
    let dialog = try await Self.execute(
      botId: assistant.id,
      assistantName: assistant.name,
      message: message,
      snapshot: WidgetSnapshotStore.read(from: AssistantEntityQuery.snapshotURL),
      signedInScope: NotificationController.shared.store?.scope ?? NotificationController.shared.savedScope(),
      client: NotificationController.shared.store?.api.flatMap { $0.token != nil || $0.localCookieAuth ? $0 : nil }
        ?? NotificationController.shared.actionClient()
    )
    return .result(dialog: IntentDialog(stringLiteral: dialog))
  }

  @MainActor static func execute(
    botId: String,
    assistantName: String,
    message: String,
    snapshot: WidgetSnapshot?,
    signedInScope: String?,
    client: APIClient?,
    defaults: UserDefaults = .standard,
    now: Date = Date()
  ) async throws -> String {
    let trimmed = try ShortcutSendPolicy.validate(
      botId: botId,
      text: message,
      snapshot: snapshot,
      signedInScope: signedInScope,
      defaults: defaults,
      now: now
    )
    guard let client else { throw AssistantIntentError.signedOut }
    let submission = PendingSubmission(
      requestId: UUID().uuidString.lowercased(),
      botId: botId,
      text: trimmed,
      attachments: [],
      reviewedInterruption: false,
      draftBaseRevision: 0
    )
    do {
      let receipt: Receipt = try await client.write("/bots/\(APIClient.component(botId))/messages", submission)
      if receipt.admitted {
        return "Sent to \(assistantName)."
      }
      throw AssistantIntentError.failed(receipt.message ?? "\(assistantName) did not accept the message.")
    } catch let error as AssistantIntentError {
      throw error
    } catch {
      throw AssistantIntentError.failed(error.localizedDescription)
    }
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
    AppShortcut(
      intent: TryOnceIntent(),
      phrases: [
        "Run \(\.$routine) in \(.applicationName)", "Run \(\.$routine) once in \(.applicationName)",
      ],
      shortTitle: "Run routine once", systemImageName: "play.circle")
  }
}

extension NotificationController {
  /// Opens a widget, notification, Quick Action, Spotlight or Shortcuts link, the one way every outside entry reaches a screen.
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
