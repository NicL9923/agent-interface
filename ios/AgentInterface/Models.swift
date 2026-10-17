import CryptoKit
import Foundation

enum ActivityState: String, Codable, CaseIterable {
  case idle, thinking, working, waiting, blocked, done, disconnected, failed, interrupted
  /// A state this app version does not know. A newer server's new state degrades to this
  /// instead of failing the whole response that carries it.
  case unknown
  /// The states the server defines. Pickers and specimens never offer `unknown`.
  static let allCases: [ActivityState] = [
    .idle, .thinking, .working, .waiting, .blocked, .done, .disconnected, .failed, .interrupted,
  ]
  init(from decoder: Decoder) throws {
    self = Self(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .unknown
  }
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
    case .unknown: return "Status unknown"
    }
  }
  var active: Bool { [.thinking, .working, .waiting, .blocked].contains(self) }
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
    "diamond", "sparkle", "clover", "heart", "cookie", "pentagon", "burst", "alien", "ghost",
    "flower", "sun",
  ]
  static let families: [(id: String, label: String)] = [
    ("bear", "Bear"), ("fox", "Fox"), ("sprout", "Sprout"),
    ("pumpkin", "Pumpkin"), ("santa", "Santa"), ("rudolph", "Rudolph"),
    ("turkey", "Turkey"), ("bunny", "Easter Bunny"),
  ]
  static let seasonalColors = [
    "pumpkin": "#FF9800", "santa": "#F2B08B", "rudolph": "#97683D",
    "turkey": "#97683D", "bunny": "#F5E9D8",
  ]
  var geometry: String {
    if mode == "geometric" { return shape ?? "blob" }
    if let family, Self.seasonalColors[family] != nil { return family }
    return "mascot"
  }
  func selectingFamily(_ family: String) -> AvatarConfig {
    var next = self
    next.family = family
    if let color = Self.seasonalColors[family] { next.color = color }
    return next
  }
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
struct AssistantGroup: Identifiable {
  var id: String
  var title: String
  var bots: [Bot]
}
struct NotificationPreferences: Codable, Equatable { var timezone: String; var quietStart: String?; var quietEnd: String?; var batchMinutes: Int }
struct Preferences: Codable, Equatable {
  var startPage: String?
  var notifications: NotificationPreferences?
  var presentation = "simple"
  var theme = "system"
  var favorites: [String] = []
  var modelFavorites: [ModelChoice]?
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
  var lastMessage: LastMessage?
}
/// The newest message in an assistant's canonical conversation, for list and widget previews.
struct LastMessage: Codable, Equatable {
  var text: String
  var at: String?
}
struct BotInput: Encodable, Equatable {
  var confirmModel = false
  var name = ""
  var description = ""
  var instructions = ""
  var model = ""
  var provider: String?
  var enabledMcpServers: [String] = []
  var shared = true
  /// Sent only after the person agrees that the assistant disappears for everyone else.
  var confirmPrivate: Bool?
  init(bot: Bot? = nil, fallback: Bot? = nil) {
    name = bot?.name ?? ""
    description = bot?.description ?? ""
    instructions = bot?.instructions ?? ""
    model = bot?.model ?? fallback?.model ?? ""
    provider = bot?.provider ?? fallback?.provider
    enabledMcpServers = bot?.enabledMcpServers ?? []
    shared = bot?.shared ?? true
  }
  /// Whether saving makes an assistant everyone could see this person's personal one.
  func hidesFromHousehold(_ bot: Bot?) -> Bool {
    guard let bot else { return false }
    return !shared && (bot.shared || bot.ownerId == nil)
  }
}
/// A file staged on this device until upload succeeds or the person removes it.
struct AttachmentUpload: Identifiable {
  var id = UUID()
  var botId: String
  var url: URL
  var name: String
  var mime: String
  var error: String?
  var uploading = false
}
struct FileRef: Codable, Identifiable, Equatable {
  var id: String
  var name: String
  var mime: String
  var size: Int?
  var url: String?
}
struct Sender: Codable, Equatable {
  var id: String
  var name: String
}
struct MessageOrigin: Codable, Equatable {
  var kind: String
  var visibility: String
  var title: String?
  var name: String?
  var handle: String?
}
struct Message: Codable, Identifiable, Equatable {
  var id: String
  var role: String
  var text: String
  var createdAt: String?
  var sender: Sender?
  var files: [FileRef]?
  var reasoning: String?
  var toolName: String?
  var toolCall: ToolCall?
  var origin: MessageOrigin?
  var presentationOrigin: MessageOrigin? {
    if role == "user", sender != nil { return nil }
    if let origin { return origin }
    if let envelope = agentEnvelope { return MessageOrigin(kind: "agent", visibility: "activity", name: envelope.name) }
    if role == "user" {
      if let kind = Self.originPatterns.first(where: { Self.matches($0.pattern, text) }) {
        return MessageOrigin(kind: kind.kind, visibility: kind.visibility)
      }
    }
    let names = displayToolName.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
    if role == "tool" || text.isEmpty {
      if names.contains("message_agent") { return MessageOrigin(kind: "agent", visibility: "activity") }
      if names.contains(where: { ["delegate_task", "spawn_agent", "subagent", "task"].contains($0) }) { return MessageOrigin(kind: "subagent", visibility: "activity") }
    }
    return nil
  }
  var isInternalActivity: Bool { presentationOrigin?.visibility == "activity" }
  var activityGroup: String {
    switch presentationOrigin?.kind {
    case "agent": return "Bot messages"
    case "scheduled": return "Scheduled jobs"
    case "subagent": return "Subagents"
    case "process": return "Background processes"
    case "diagnostic": return "Diagnostics"
    default: return "Tool calls"
    }
  }
  var isConversationVisible: Bool {
    !isInternalActivity && role != "tool" && (role != "assistant" || isAgentExchange || !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !(files?.isEmpty ?? true))
  }
  var agentEnvelope: (name: String, body: String)? {
    guard role == "user", sender == nil else { return nil }
    guard text.hasPrefix("Message from ") || text.hasPrefix("[Message from agent "),
      let match = Self.envelopePattern.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
      let bodyRange = Range(match.range(at: 4), in: text),
      let nameRange = Range(match.range(at: 1).location == NSNotFound ? match.range(at: 3) : match.range(at: 1), in: text)
    else { return nil }
    return (String(text[nameRange]).trimmingCharacters(in: .whitespaces), String(text[bodyRange]))
  }
  var isAgentExchange: Bool { agentEnvelope != nil || toolCall?.name == "message_agent" || toolName == "message_agent" }
  var isToolActivity: Bool { role == "tool" || (toolCall != nil && text.isEmpty) }
  var displayToolName: String { toolCall?.name ?? toolName ?? "Tool" }
  var toolResult: String {
    let canonical = role == "tool" || toolCall == nil ? text : ""
    return toolCall?.result ?? canonical
  }
  // Compiled once. Rows read a message's origin on every render, so per-call compilation added up.
  private static func regex(_ pattern: String) -> NSRegularExpression { try! NSRegularExpression(pattern: pattern) }
  private static func matches(_ regex: NSRegularExpression, _ text: String) -> Bool {
    regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
  }
  private static let originPatterns: [(pattern: NSRegularExpression, kind: String, visibility: String)] = [
    (regex(#"^\[Cronjob "[^\n]+" output [—-] scheduled job,? not the user\. Review it, act on anything that needs action, and summarize for the chat\.\]"#), "scheduled", "activity"),
    (regex(#"^\[Cron delivery: [^\n\]]+\]"#), "scheduled", "conversation"),
    (regex(#"^(Subagent Tasks? (Completed|Failed|Interrupted|Incomplete):|\[IMPORTANT: (Background )?[Ss]ubagent|\[ASYNC (DELEGATION )?(BATCH )?COMPLETE\b|A background (subagent|fan-out of \d+ subagent\(s\)) you dispatched earlier has finished\.)"#), "subagent", "activity"),
    (regex(#"^(Background Process (Completed|Failed|Output|Interrupted)|\[IMPORTANT: Background process |\[Background process \S+ heartbeat #)"#), "process", "activity"),
  ]
  private static let envelopePattern = regex(#"^(?:Message from (?:🤖\s*)?([^:\n(]{1,64}?)(?:\s*\(@([a-z0-9][a-z0-9_-]{0,63})(?:@[a-zA-Z0-9][a-zA-Z0-9_-]{0,63})?\))?:\s*|\[Message from agent '([^']{1,64})'\]\s*)([\s\S]*)$"#)
}
struct ToolCall: Codable, Identifiable, Equatable {
  var id: String
  var name: String
  var arguments: String?
  var status: String
  var result: String?
  var error: String?
  var startedAt: String?
  var completedAt: String?
}
struct Approval: Codable, Identifiable, Equatable {
  var id: String
  var title: String
  var detail: String
  var status: String
  var expiresAt: String?
}
struct Activity: Codable, Equatable {
  var state: ActivityState
  var detail: String?
  var runId: String?
  var updatedAt: String?
}
struct Question: Codable, Identifiable, Equatable {
  var id: String
  var prompt: String
  var options: [String]?
}
struct Attention: Codable, Identifiable, Equatable {
  var id: String
  var kind: String
  var title: String
  var detail: String
  var questions: [Question]?
  var secure: SecureRequest? = nil
}
struct ReadPosition: Codable, Equatable {
  var messageId: String?
  var scrollTop: Double? = nil
}
/// This device's copy of a draft, as cached on the device.
struct Draft: Codable, Equatable {
  var text = ""
  var attachments: [FileRef] = []
  var dirty: Bool? = nil
  /// The server revision this copy was loaded from or last saved as. Missing means 0.
  var baseRevision: Int? = nil
  /// Fingerprint of the content at `baseRevision`, to tell whether this copy changed since.
  var baseHash: String? = nil
  /// Increases with every local edit; a save records the one it carries.
  var seq: Int? = nil
  /// Fingerprint of the text this device sent from this copy, until the server shows the send.
  var sentHash: String? = nil
  /// The revision that send was written on; a `sentRevision` past it shows the send completed.
  var sentBase: Int? = nil

  /// A fingerprint of draft content, kept with a cached copy.
  static func contentHash(_ text: String, _ attachments: [FileRef]) -> String {
    struct Content: Encodable { var text: String; var attachments: [FileRef] }
    let encoder = JSONEncoder()
    encoder.outputFormatting = .sortedKeys
    let data = (try? encoder.encode(Content(text: text, attachments: attachments))) ?? Data(text.utf8)
    return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }

  /// Reconciles this copy with a server draft: a load, a save's acknowledgment, or the current
  /// draft from a 409. Every response goes through here and is applied to the copy as it is now,
  /// never as it was when the request went out. The web client's `mergeDraft` in
  /// src/app/draft-merge.ts applies the same rule.
  ///
  /// - A server read older than the copy is ignored, unless `authoritative`: the 409 answering
  ///   the copy's latest save, with no other save in flight, as after a database restore.
  /// - A clean copy adopts the server draft. While this device's sent text is still on the
  ///   server, not yet cleared, the copy keeps waiting for that clear.
  /// - A send cleared the server draft after this copy's base, and the copy still holds its base
  ///   content or the text this device sent: that text was sent, so adopt the server draft.
  /// - Matching content is clean, but only once no other save is in flight (`settled`): an older
  ///   save may still land and change the server copy.
  /// - Otherwise unsaved edits here are new work and win. `push` asks the caller to save them
  ///   on the new base.
  static func merge(_ local: Draft, with server: SavedDraft?, authoritative: Bool = false, settled: Bool = true)
    -> (draft: Draft, push: Bool)
  {
    let server = server ?? SavedDraft()
    let base = local.baseRevision ?? 0
    let revision = server.revision ?? 0
    if !authoritative && revision < base { return (local, false) }
    let hash = contentHash(server.text, server.attachments)
    let adopt = Draft(text: server.text, attachments: server.attachments, dirty: false, baseRevision: revision, baseHash: hash)
    // The guard for this device's send lasts until the server shows that send completed.
    let sendShown = local.sentHash != nil && (server.sentRevision ?? 0) > (local.sentBase ?? 0)
    if local.dirty != true {
      if local.sentHash == hash && !sendShown { return (local, false) }
      return (adopt, false)
    }
    let mine = contentHash(local.text, local.attachments)
    if (server.sentRevision ?? 0) > base && (mine == local.baseHash || sendShown && mine == local.sentHash) { return (adopt, false) }
    var current = local
    if sendShown {
      current.sentHash = nil
      current.sentBase = nil
    }
    var kept = current
    kept.baseRevision = revision
    kept.baseHash = hash
    if local.text == server.text && local.attachments == server.attachments {
      return settled ? (adopt, false) : (kept, false)
    }
    if revision == base { return (current, false) }
    return (kept, true)
  }
  /// This copy once its send was accepted: emptied if it still holds the sent text.
  func sent(_ submission: PendingSubmission) -> Draft {
    guard text == submission.text && attachments == submission.attachments else { return self }
    return Draft(dirty: false, baseRevision: baseRevision, baseHash: baseHash, seq: seq, sentHash: sentHash, sentBase: sentBase)
  }
}
/// The server's copy of a draft. Older servers omit the revision fields, which read as 0.
struct SavedDraft: Codable, Equatable {
  var text = ""
  var attachments: [FileRef] = []
  var revision: Int? = nil
  /// `edit`, or `sent` when the latest change was the clear after an accepted message.
  var reason: String? = nil
  /// The revision of the latest send clear, or 0.
  var sentRevision: Int? = nil
}
/// A draft save. Sending the base revision lets the server refuse an edit made on a stale copy.
struct DraftSave: Encodable {
  var text: String
  var attachments: [FileRef]
  var baseRevision: Int
  init(_ draft: Draft) {
    text = draft.text
    attachments = draft.attachments
    baseRevision = draft.baseRevision ?? 0
  }
}
/// The 409 body for a stale draft save, carrying the server's current copy.
struct DraftConflict: Decodable {
  static let code = "draft_conflict"
  var draft: SavedDraft
}
/// The files of the history before a window, from `GET /bots/:id/files?before=`.
struct EarlierFiles: Decodable {
  struct Entry: Decodable {
    var id: String
    var files: [FileRef]?
  }
  var messages: [Entry]
}
struct CoordinationGroup: Identifiable, Equatable {
  var id: String
  var messages: [Message]
}
struct ConversationTurn: Identifiable, Equatable {
  var id: String
  var messages: [Message]
  var visibleMessages: [Message] { messages.filter(\.isConversationVisible) }
  var reasoning: [String] { messages.filter { !$0.isInternalActivity && $0.role == "assistant" }.compactMap {
    let text = $0.reasoning?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return text.isEmpty ? nil : text
  } }
  var activityGroups: [CoordinationGroup] {
    var groups: [CoordinationGroup] = []
    for message in messages where message.isInternalActivity || message.isToolActivity || message.toolCall != nil {
      let label = message.isInternalActivity ? message.activityGroup : "Tool calls"
      if let index = groups.firstIndex(where: { $0.id == label }) { groups[index].messages.append(message) }
      else { groups.append(CoordinationGroup(id: label, messages: [message])) }
    }
    return groups
  }
  var coordinationGroups: [CoordinationGroup] {
    var groups: [CoordinationGroup] = []
    for message in messages where message.isInternalActivity {
      if let index = groups.firstIndex(where: { $0.id == message.activityGroup }) { groups[index].messages.append(message) }
      else { groups.append(CoordinationGroup(id: message.activityGroup, messages: [message])) }
    }
    return groups
  }
}
struct Conversation: Codable, Equatable {
  var attention: [Attention]?
  var botId: String
  var sessionId: String?
  var messages: [Message]
  /// Turns before the first loaded message, present when the server windowed the history.
  var earlier: Int?
  /// Files only the unloaded earlier turns carry, present when the server windowed the history.
  var earlierFiles: Int?
  var activity: Activity
  var approvals: [Approval]
  var files: [FileRef]
  var draft: SavedDraft?
  var readPosition: ReadPosition?
  var toolCalls: [ToolCall]?
  var activityMessages: [Message] {
    let canonical = messages.filter { $0.isInternalActivity || $0.isToolActivity || $0.toolCall != nil }
    let known = Set(canonical.compactMap { $0.toolCall?.id })
    return canonical + (toolCalls ?? []).filter { !known.contains($0.id) }.map {
      Message(id: "tool-call-" + $0.id, role: "tool", text: $0.result ?? "", toolCall: $0)
    }
  }
  var presentationTurns: [ConversationTurn] {
    var turns: [ConversationTurn] = []
    for message in messages {
      if turns.isEmpty || message.role == "user" { turns.append(ConversationTurn(id: message.id, messages: [])) }
      turns[turns.count - 1].messages.append(message)
    }
    for call in toolCalls ?? [] {
      let matches = turns.indices.flatMap { turn in
        turns[turn].messages.indices.filter { turns[turn].messages[$0].toolCall?.id == call.id }.map { (turn, $0) }
      }
      if matches.count == 1, let (turn, message) = matches.first {
        let previous = turns[turn].messages[message].toolCall!
        var merged = call
        merged.arguments = call.arguments ?? previous.arguments
        merged.result = call.result ?? previous.result
        merged.error = call.error ?? previous.error
        merged.startedAt = call.startedAt ?? previous.startedAt
        merged.completedAt = call.completedAt ?? previous.completedAt
        if call.status == "running" && previous.status != "running" { merged.status = previous.status }
        turns[turn].messages[message].toolCall = merged
      }
      else {
        if turns.isEmpty { turns.append(ConversationTurn(id: "live-activity", messages: [])) }
        turns[turns.count - 1].messages.append(Message(id: "live-" + call.id, role: "tool", text: "", toolCall: call))
      }
    }
    return turns
  }
  var visibleMessages: [Message] {
    messages.filter { $0.isConversationVisible }
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
  var canRetry: Bool?
  var canCancel: Bool?
  var canRestartService: Bool?
  var operationId: String?
  var error: String?
  var checkedAt: String?
  var updatedAt: String?
  var busyBots: [String]
  var inProgress: Bool { ["checking", "qualifying", "installing", "verifying", "recovering"].contains(phase) }
  var installing: Bool { ["installing", "verifying"].contains(phase) }
  var title: String {
    switch phase {
    case "checking": "Checking for an update"
    case "qualifying": "Checking compatibility"
    case "ready": "Update ready"
    case "installing": "Updating Hermes"
    case "verifying": "Verifying Hermes"
    case "recovering": "Restoring the connection"
    case "cancelled": "Update cancelled"
    case "succeeded": "Hermes is up to date"
    case "rolled_back": "Previous version restored"
    case "blocked": "Update needs attention"
    case "failed": "Update could not finish"
    default: available ? "Keep Hermes up to date" : "Updates aren't available"
    }
  }
}
struct UpgradeControlRequest: Encodable {
  var action: String
  var operationId: String
  var requestId: String
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
  /// Present when the host publishes the latest distributed iOS build.
  var nativeApp: NativeAppInfo?
}
struct NativeAppInfo: Codable, Equatable {
  var latestBuild: Int
  var updateUrl: String
}
struct CapabilityItem: Codable, Identifiable {
  var id: String
  var name: String
  var description: String
  var enabled: Bool
  var required: Bool?
}
extension Bot {
  /// Only its owner can receive a private assistant's routine results.
  func routineRecipients(_ household: [Member]) -> [Member] {
    !shared && ownerId != nil ? household.filter { $0.id == ownerId } : household
  }
}
struct Routine: Codable, Identifiable {
  var id: String
  var botId: String
  var name: String
  var prompt: String
  var schedule: String
  var enabled: Bool
  var recipientIds: [String]?
  var nextRunAt: String?
  var lastRunAt: String?
  var lastStatus: String?
  var lastError: String?
  var lastDeliveryError: String?
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
  /// The draft revision this message was written on, so the server clears a draft whose final
  /// edits were never saved.
  var draftBaseRevision: Int? = nil
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

extension Preferences {
  /// Pinned assistants appear once, in the person's saved pin order.
  func pinnedAssistants(_ bots: [Bot]) -> [Bot] {
    var seen: Set<String> = []
    return favorites.compactMap { id in
      guard seen.insert(id).inserted else { return nil }
      return bots.first { $0.id == id }
    }
  }
  /// The list below the pins follows the web's sections and original roster order.
  func assistantGroups(_ bots: [Bot]) -> [AssistantGroup] {
    let unpinned = bots.filter { !favorites.contains($0.id) }
    var seen: Set<String> = []
    var groups: [AssistantGroup] = []
    for section in sections {
      let rows = unpinned.filter { section.botIds.contains($0.id) && seen.insert($0.id).inserted }
      if !rows.isEmpty { groups.append(AssistantGroup(id: "section:" + section.id, title: section.name, bots: rows)) }
    }
    let remaining = unpinned.filter { !seen.contains($0.id) }
    if !remaining.isEmpty {
      groups.append(AssistantGroup(id: "remaining", title: sections.isEmpty ? "" : "More assistants", bots: remaining))
    }
    return groups
  }
}

/// Hermes's model catalog for one profile, as `/api/models` reports it.
struct ModelCatalog: Decodable { var providers: [ModelProviderInfo] }
struct ModelProviderInfo: Decodable, Identifiable {
  var id: String
  var name: String
  var aliases: [String]?
  var authenticated: Bool?
  var warning: String?
  var models: [ModelInfo]
  /// Saved assistants may name a provider by an alias Hermes still accepts.
  func matches(_ provider: String?) -> Bool { provider == id || (provider.map { aliases?.contains($0) == true } ?? false) }
}
struct ModelInfo: Decodable, Identifiable {
  var id: String
  var name: String
  var available: Bool
}
struct ModelChoice: Codable, Equatable, Hashable { var provider: String; var model: String }
struct ModelFavorites: Codable { var modelFavorites: [ModelChoice] }
struct InferenceSettings: Codable, Equatable {
  var reasoning: String
  var speed: String
  static let reasoningLevels = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]
  static let speeds = ["normal", "fast", "ultrafast"]
}
