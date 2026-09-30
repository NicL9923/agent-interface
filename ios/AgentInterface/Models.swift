import Foundation

enum ActivityState: String, Codable, CaseIterable {
  case idle, thinking, working, waiting, blocked, done, disconnected, failed, interrupted
  var label: String {
    switch self {
    case .idle: return "Ready"
    case .thinking: return "Thinking"
    case .working: return "Working"
    case .waiting: return "Waiting"
    case .blocked: return "Needs your help"
    case .done: return "Done"
    case .disconnected: return "Connection lost"
    case .failed: return "Failed"
    case .interrupted: return "Interrupted"
    }
  }
  var active: Bool { [.thinking, .working, .waiting, .blocked].contains(self) }
  var animates: Bool { ![.disconnected, .failed, .interrupted].contains(self) }
}
struct AvatarConfig: Codable, Equatable {
  var mode = "geometric"
  var shape: String? = "blob"
  var family: String? = nil
  var color: String? = "#1084FE"
  var eyes: String? = "oval"
  var accessory: String? = "none"
  var eyeWidth: Double? = 1
  var eyeHeight: Double? = 1
  var eyeSpacing: Double? = 1
  var src: String? = nil
  var origin: String? = nil
  static let shapes = [
    "blob", "pebble", "squircle", "capsule", "triangle", "hex", "cloud", "drop", "circle",
  ]
  static let colors = [
    "#1084FE", "#FF6700", "#00BCA6", "#FF263C", "#FF309B", "#9159FE", "#FF9800", "#97683D",
    "#292929",
  ]
}
struct Member: Codable, Identifiable, Equatable {
  var id: String
  var name: String
  var email: String
  var picture: String?
}
struct BotSection: Codable, Identifiable, Equatable {
  var id: String
  var name: String
  var botIds: [String]
}
struct Preferences: Codable, Equatable {
  var presentation = "simple"
  var theme = "system"
  var favorites: [String] = []
  var defaultBotId: String?
  var sections: [BotSection] = []
  var followBots: [String] = []
}
struct Capability: Codable {
  var supported: Bool
  var reason: String?
}
struct RuntimeStatus: Codable {
  var connected: Bool
  var code: String?
  var version: String?
  var detail: String?
  var address: String?
  var retryAt: String?
  var lastConnectedAt: String?
}
struct Bot: Codable, Identifiable {
  var id: String
  var name: String
  var description: String?
  var instructions: String?
  var model: String
  var provider: String?
  var enabledMcpServers: [String]?
  var shared: Bool
  var ownerId: String?
  var avatar: AvatarConfig?
  var enabledTools: [String]?
  var enabledSkills: [String]?
  var sessionId: String?
  var activity: ActivityState
}
struct BotInput: Encodable {
  var confirmModel = false
  var name = ""
  var description = ""
  var instructions = ""
  var model = ""
  var provider: String?
  var enabledMcpServers: [String] = []
  var shared = true
  init(bot: Bot? = nil, fallback: Bot? = nil) {
    name = bot?.name ?? ""
    description = bot?.description ?? ""
    instructions = bot?.instructions ?? ""
    model = bot?.model ?? fallback?.model ?? ""
    provider = bot?.provider ?? fallback?.provider
    enabledMcpServers = bot?.enabledMcpServers ?? []
    shared = bot?.shared ?? true
  }
}
struct FileRef: Codable, Identifiable, Equatable {
  var id: String
  var name: String
  var mime: String
  var size: Int?
  var url: String?
}
struct Sender: Codable {
  var id: String
  var name: String
}
struct Message: Codable, Identifiable {
  var id: String
  var role: String
  var text: String
  var createdAt: String?
  var sender: Sender?
  var files: [FileRef]?
  var reasoning: String?
  var toolName: String?
  var toolCall: ToolCall?
  var isToolActivity: Bool { role == "tool" || (toolCall != nil && text.isEmpty) }
  var displayToolName: String { toolCall?.name ?? toolName ?? "Tool" }
  var toolResult: String {
    let canonical = role == "tool" || toolCall == nil ? text : ""
    return toolCall?.result ?? canonical
  }
}
struct ToolCall: Codable, Identifiable {
  var id: String
  var name: String
  var arguments: String?
  var status: String
  var result: String?
  var error: String?
  var startedAt: String?
  var completedAt: String?
}
struct Approval: Codable, Identifiable {
  var id: String
  var title: String
  var detail: String
  var status: String
  var expiresAt: String?
}
struct Activity: Codable {
  var state: ActivityState
  var detail: String?
  var runId: String?
  var updatedAt: String?
}
struct Question: Codable, Identifiable {
  var id: String
  var prompt: String
  var options: [String]?
}
struct Attention: Codable, Identifiable {
  var id: String
  var kind: String
  var title: String
  var detail: String
  var questions: [Question]?
}
struct ReadPosition: Codable {
  var messageId: String?
  var scrollTop: Double? = nil
}
struct Draft: Codable, Equatable {
  var text = ""
  var attachments: [FileRef] = []
  var dirty: Bool? = nil
}
struct Conversation: Codable {
  var attention: [Attention]?
  var botId: String
  var sessionId: String?
  var messages: [Message]
  var activity: Activity
  var approvals: [Approval]
  var files: [FileRef]
  var draft: Draft?
  var readPosition: ReadPosition?
  var toolCalls: [ToolCall]?
  var activityMessages: [Message] {
    let canonical = messages.filter { $0.isToolActivity || $0.toolCall != nil }
    let known = Set(canonical.compactMap { $0.toolCall?.id })
    return canonical + (toolCalls ?? []).filter { !known.contains($0.id) }.map {
      Message(id: "tool-call-" + $0.id, role: "tool", text: $0.result ?? "", toolCall: $0)
    }
  }
  var visibleMessages: [Message] {
    messages.filter { !$0.isToolActivity || !($0.files?.isEmpty ?? true) }
  }
  func restorableReadAnchor(_ saved: String?) -> String? {
    guard let saved else { return nil }
    if visibleMessages.contains(where: { $0.id == saved }) { return saved }
    guard let index = messages.firstIndex(where: { $0.id == saved }) else { return nil }
    return messages.dropFirst(index + 1).first {
      !$0.isToolActivity || !($0.files?.isEmpty ?? true)
    }?.id
  }
}
struct UpgradeRevision: Codable {
  var revision: String
  var version: String?
  var notesUrl: String?
  var displayVersion: String { version ?? String(revision.prefix(12)) }
}
struct UpgradeCheck: Codable, Identifiable {
  var id: String
  var label: String
  var status: String
  var detail: String?
}
struct UpgradeStatus: Codable {
  var available: Bool
  var phase: String
  var current: UpgradeRevision?
  var candidate: UpgradeRevision?
  var message: String
  var checks: [UpgradeCheck]
  var canCheck: Bool
  var canInstall: Bool
  var operationId: String?
  var error: String?
  var checkedAt: String?
  var updatedAt: String?
  var busyBots: [String]
  var inProgress: Bool { ["checking", "qualifying", "installing", "verifying"].contains(phase) }
  var installing: Bool { ["installing", "verifying"].contains(phase) }
  var title: String {
    switch phase {
    case "checking": "Checking for an update"
    case "qualifying": "Checking compatibility"
    case "ready": "Update ready"
    case "installing": "Updating Hermes"
    case "verifying": "Verifying Hermes"
    case "succeeded": "Hermes is up to date"
    case "rolled_back": "Previous version restored"
    case "blocked": "Update needs attention"
    case "failed": "Update could not finish"
    default: available ? "Keep Hermes up to date" : "Updates aren't available"
    }
  }
}
struct UpgradeInstallRequest: Encodable {
  var candidateRevision: String
  var requestId: String
}
struct Bootstrap: Codable {
  var user: Member
  var household: [Member]
  var preferences: Preferences
  var bots: [Bot]
  var capabilities: [String: Capability]
  var connection: RuntimeStatus
  var csrfToken: String?
}
struct CapabilityItem: Codable, Identifiable {
  var id: String
  var name: String
  var description: String
  var enabled: Bool
  var required: Bool?
}
struct Routine: Codable, Identifiable {
  var id: String
  var botId: String
  var name: String
  var prompt: String
  var schedule: String
  var enabled: Bool
  var recipientIds: [String]?
  static func empty(botId: String) -> Routine {
    Routine(
      id: "", botId: botId, name: "", prompt: "", schedule: "", enabled: true, recipientIds: [])
  }
}
struct Receipt: Codable {
  var requestId: String
  var status: String
  var runId: String?
  var messageId: String?
  var message: String?
}
struct PendingSubmission: Codable, Equatable {
  var requestId: String
  var botId: String
  var text: String
  var attachments: [FileRef]
  var reviewedInterruption: Bool
  var reviewedUncertain = false
  var draft: Draft { Draft(text: text, attachments: attachments) }
}
struct AuthConfig: Codable {
  var googleClientId: String?
  var localDevAuth: Bool
  var nativeAuthVersion: Int?
}
struct TokenExchange: Codable {
  var token: String
  var expiresAt: String?
  var user: Member
}
struct EmptyResponse: Codable { var ok: Bool? }
struct PushConfig: Codable {
  var available: Bool
  var environment: String?
}
struct PushDevice: Encodable {
  var deviceId: String
  var token: String
}
enum ServerDate {
  static func parse(_ value: String) -> Date? {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
  }
}

enum ConnectionAddress {
  static func parse(_ raw: String) throws -> URL {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let url = URL(string: trimmed.contains("://") ? trimmed : "https://" + trimmed),
      let host = url.host?.lowercased(), !host.isEmpty, url.user == nil, url.password == nil,
      url.query == nil, url.fragment == nil, ["", "/"].contains(url.path),
      url.scheme == "https"
        || (url.scheme == "http" && ["localhost", "127.0.0.1", "[::1]", "::1"].contains(host))
    else {
      throw APIError(
        message:
          "Enter the app server HTTPS address. HTTP is supported only for localhost development.",
        status: 0)
    }
    let normalizedHost = host.contains(":") && !host.hasPrefix("[") ? "[\(host)]" : host
    let port = url.port.flatMap {
      ($0 == 443 && url.scheme == "https") || ($0 == 80 && url.scheme == "http") ? nil : $0
    }
    return URL(string: "\(url.scheme!)://\(normalizedHost)\(port.map { ":\($0)" } ?? "")")!
  }
}
