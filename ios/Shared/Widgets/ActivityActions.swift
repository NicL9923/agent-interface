import AppIntents
import Foundation
import WidgetKit

/// A button on the Live Activity or interactive widget: stop an assistant's work, or decline the
/// approval it waits on.
struct ActivityAction: Equatable, Sendable {
  enum Kind: Equatable, Sendable {
    case stop
    case decline(approvalId: String)
  }
  var kind: Kind
  var botId: String
  /// The account the activity or snapshot belongs to. Another sign-in never acts on it.
  var scope: String
  var name: String
}

/// How interactive widget and Live Activity buttons reach the app. iOS runs a `LiveActivityIntent`
/// in the app's process even when the widget extension draws the button, so the app sets these
/// handlers at launch and acts with its own sign-in. The widget extension never holds a token.
@MainActor enum ActivityActions {
  static var handler: ((ActivityAction) async -> Void)?
  static var refreshHandler: (() async -> Void)?
  static func perform(_ action: ActivityAction) async { await handler?(action) }
  static func refresh() async {
    await refreshHandler?()
    WidgetCenter.shared.reloadAllTimelines()
  }
}

/// Refreshes the Assistants widget snapshot on demand from Medium/Large interactive widgets.
struct RefreshWidgetsIntent: LiveActivityIntent {
  static var title: LocalizedStringResource { "Refresh assistants" }
  static var isDiscoverable: Bool { false }
  init() {}
  @MainActor func perform() async throws -> some IntentResult {
    await ActivityActions.refresh()
    return .result()
  }
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
