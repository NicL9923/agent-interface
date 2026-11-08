import AppIntents
import Foundation

/// A button on the Live Activity: stop an assistant's work, or decline the approval it waits on.
struct ActivityAction: Equatable, Sendable {
  enum Kind: Equatable, Sendable {
    case stop
    case decline(approvalId: String)
  }
  var kind: Kind
  var botId: String
  /// The account the activity belongs to, from its attributes. Another sign-in never acts on it.
  var scope: String
  var name: String
}

/// How the buttons reach the app. iOS runs a `LiveActivityIntent` in the app's process even when the
/// widget extension draws the button, so the app sets this at launch and acts with its own sign-in.
/// The widget extension never holds a token and never sets it.
@MainActor enum ActivityActions {
  static var handler: ((ActivityAction) async -> Void)?
  static func perform(_ action: ActivityAction) async { await handler?(action) }
}

/// Stops an assistant's current run from the Lock Screen or Dynamic Island. The phone must be unlocked,
/// as for a notification's Decline.
struct StopAssistantActivityIntent: LiveActivityIntent {
  static var title: LocalizedStringResource { "Stop assistant" }
  static var isDiscoverable: Bool { false }
  static var authenticationPolicy: IntentAuthenticationPolicy { .requiresAuthentication }
  @Parameter(title: "Assistant") var botId: String
  @Parameter(title: "Name") var name: String
  @Parameter(title: "Account") var scope: String
  init() {}
  init(botId: String, name: String, scope: String) { self.botId = botId; self.name = name; self.scope = scope }
  @MainActor func perform() async throws -> some IntentResult {
    await ActivityActions.perform(ActivityAction(kind: .stop, botId: botId, scope: scope, name: name))
    return .result()
  }
}

/// Declines the approval an assistant is waiting on, like a notification's Decline.
struct DeclineApprovalActivityIntent: LiveActivityIntent {
  static var title: LocalizedStringResource { "Decline request" }
  static var isDiscoverable: Bool { false }
  static var authenticationPolicy: IntentAuthenticationPolicy { .requiresAuthentication }
  @Parameter(title: "Assistant") var botId: String
  @Parameter(title: "Name") var name: String
  @Parameter(title: "Approval") var approvalId: String
  @Parameter(title: "Account") var scope: String
  init() {}
  init(botId: String, name: String, approvalId: String, scope: String) {
    self.botId = botId; self.name = name; self.approvalId = approvalId; self.scope = scope
  }
  @MainActor func perform() async throws -> some IntentResult {
    await ActivityActions.perform(ActivityAction(kind: .decline(approvalId: approvalId), botId: botId, scope: scope, name: name))
    return .result()
  }
}
