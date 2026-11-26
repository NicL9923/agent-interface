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
  /// Whether home captions an assistant with this state. A lost connection is said once, in the
  /// header; the assistants only dim, as on the web.
  var captioned: Bool { ![.idle, .done, .disconnected].contains(self) }
}
struct AvatarConfig: Codable, Equatable {
  var mode = AvatarMode.geometric
  var shape: AvatarShape? = .blob
  var color: String? = "#1084FE"
  var eyes: AvatarEyes? = .oval
  var accessory: AvatarAccessory? = .plain
  var eyeWidth: Double? = 1
  var eyeHeight: Double? = 1
  var eyeSpacing: Double? = 1
  var src: String? = nil
  var origin: String? = nil
  static let shapes = AvatarShape.all
  /// The outline this avatar draws and morphs to. A shape this build does not know, and a mode it
  /// does not know, draw as the blob.
  var drawnShape: AvatarShape { mode == .geometric ? shape ?? .blob : .blob }
  /// This avatar as `shape`'s picker tile shows it: a seasonal shape in its own color, every
  /// other shape in the color already chosen.
  func showingShape(_ shape: AvatarShape) -> AvatarConfig {
    var next = self
    next.shape = shape
    if let color = AvatarCatalog.seasonalColors[shape] { next.color = color }
    return next
  }
  /// This avatar with `shape` picked. Picking the shape it already has changes nothing, as a second
  /// click on a checked radio does on the web, so a recolored pumpkin stays recolored.
  func selectingShape(_ shape: AvatarShape) -> AvatarConfig {
    shape == self.shape ? self : showingShape(shape)
  }
  static let colors = [
    "#1084FE", "#FF6700", "#00BCA6", "#FF263C", "#FF309B", "#9159FE", "#FF9800", "#97683D",
    "#292929",
  ]
}
extension AvatarConfig {
  private enum CodingKeys: String, CodingKey {
    case mode, shape, color, eyes, accessory, eyeWidth, eyeHeight, eyeSpacing, src, origin
    /// Only a retired mascot carries it, and only decoding reads it.
    case family
  }
  /// Decodes an avatar as this build draws it. Mascots were retired in November 2026, but an older
  /// server, the offline cache and saved rosters still hold them. Like `currentAvatar` in
  /// src/shared/avatar-legacy.ts, a mascot becomes the shape that took its place and keeps its
  /// color, eyes, accessory and eye tuning; a seasonal mascot's fixed face color becomes its
  /// shape's. Its family is dropped, so the rest of the app only sees characters and portraits.
  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    mode = try values.decode(AvatarMode.self, forKey: .mode)
    let mascot = mode.rawValue == "mascot"
    // A mascot's shape is its family's, so whatever an older build stored there is never read: a
    // malformed one must not fail the bot, the roster and the offline library that carry it.
    shape = try mascot ? nil : values.decodeIfPresent(AvatarShape.self, forKey: .shape)
    color = try values.decodeIfPresent(String.self, forKey: .color)
    eyes = try values.decodeIfPresent(AvatarEyes.self, forKey: .eyes)
    accessory = try values.decodeIfPresent(AvatarAccessory.self, forKey: .accessory)
    eyeWidth = try values.decodeIfPresent(Double.self, forKey: .eyeWidth)
    eyeHeight = try values.decodeIfPresent(Double.self, forKey: .eyeHeight)
    eyeSpacing = try values.decodeIfPresent(Double.self, forKey: .eyeSpacing)
    src = try values.decodeIfPresent(String.self, forKey: .src)
    origin = try values.decodeIfPresent(String.self, forKey: .origin)
    guard mascot else { return }
    let family = (try? values.decodeIfPresent(String.self, forKey: .family)) ?? nil
    // A family no build ever had drew as the plain mascot head; the plain shape is the blob.
    let known = family.flatMap { AvatarCatalog.legacyMascots[$0] } ?? (shape: AvatarShape.blob, was: nil, now: nil)
    mode = .geometric
    shape = known.shape
    if let color, let was = known.was, color.lowercased() == was.lowercased() { self.color = known.now }
  }
  func encode(to encoder: Encoder) throws {
    var values = encoder.container(keyedBy: CodingKeys.self)
    try values.encode(mode, forKey: .mode)
    try values.encodeIfPresent(shape, forKey: .shape)
    try values.encodeIfPresent(color, forKey: .color)
    try values.encodeIfPresent(eyes, forKey: .eyes)
    try values.encodeIfPresent(accessory, forKey: .accessory)
    try values.encodeIfPresent(eyeWidth, forKey: .eyeWidth)
    try values.encodeIfPresent(eyeHeight, forKey: .eyeHeight)
    try values.encodeIfPresent(eyeSpacing, forKey: .eyeSpacing)
    try values.encodeIfPresent(src, forKey: .src)
    try values.encodeIfPresent(origin, forKey: .origin)
  }
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
  /// Routines whose runs this person keeps out of their assistant's chat. Older servers omit it.
  var hiddenRoutineRuns: [HiddenRoutineRun]?
  // --- Main assistant (MainAssistant.swift). Older servers omit all three. ---
  /// Server-owned: a preferences save never changes it, only PUT /preferences/main.
  var mainBotId: String?
  /// Server-owned like mainBotId: PUT /preferences/check-ins.
  var checkIns: CheckInSettings?
  var mainSuggestionDismissed: Bool?
  // --- End main assistant ---
  /// "bubbles" or "classic", and "tint" or "solid". Servers before them omit both, and an absent or
  /// unknown value reads as the default; see `ChatStyle` and `OwnBubble` in ChatBubbles.swift.
  var chatStyle: String?
  var ownBubble: String?
}
struct Capability: Codable, Equatable {
  var supported: Bool
  var reason: String?
}
/// The capability names the server reports, mirroring `CapabilityKey` in src/shared/types.ts.
/// Bootstrap keeps its capabilities keyed by raw name, so a name a newer server adds still
/// decodes and survives an offline-cache round trip; code asks by case, so a typo cannot compile.
/// ContractFixtureTests checks `allCases` against the server's own bootstrap fixture.
enum CapabilityKey: String, CaseIterable {
  case chat, steering, approvals, uploads, generatedFiles, botConfiguration, tools, skills
  case routines, durableEvents, idempotency, imageGeneration, stop, portraitGeneration
  case avatarMetadata
  /// Live Talk: a spoken conversation through OpenAI's Realtime voice, on the web and in the app.
  case liveVoice
  /// Messages sent during a turn wait in a queue the person can see, reorder and cancel.
  case queueManagement
}
/// The bot settings tabs that load a catalog from the server; each is named for its capability.
enum CatalogKind: String, CaseIterable {
  case tools, skills
  var capability: CapabilityKey { self == .tools ? .tools : .skills }
}
struct RuntimeStatus: Codable, Equatable {
  var connected: Bool
  var code: String?
  var version: String?
  var detail: String?
  var address: String?
  var retryAt: String?
  var lastConnectedAt: String?
  /// When the running Hermes revision was committed (ISO 8601). Older servers omit it.
  var revisionDate: String?
}
struct Bot: Codable, Identifiable, Equatable {
  var id: String
  var name: String
  var description: String?
  var instructions: String?
  var model: String
  /// A readable name for the model that the server fills. Older servers omit it, so show `model` then.
  var modelName: String? = nil
  var provider: String?
  var enabledMcpServers: [String]?
  /// Every MCP server configured for the profile, enabled or not. Only the detail read sends it; older servers omit it.
  var availableMcpServers: [String]? = nil
  var shared: Bool
  var ownerId: String?
  var avatar: AvatarConfig?
  var enabledTools: [String]?
  var enabledSkills: [String]?
  var sessionId: String?
  var activity: ActivityState
  var lastMessage: LastMessage?
  /// Whether this person has read the chat before and `lastMessage` is newer than that read.
  /// Older servers omit it. `AppStore.unread(_:)` applies the chats read on this device since.
  var unread: Bool? = nil
  /// The Realtime voice it speaks with in live Talk. Unset means the default, marin. Older servers omit it.
  var voice: String? = nil
  /// The agent harness it runs on, such as "codex" or "hermes". A server from before harnesses omits it,
  /// and every bot there runs on Hermes; see `Harness.of`.
  var harness: String? = nil
  /// Capabilities that differ from the bootstrap's for this bot's harness, keyed by raw name like
  /// `Bootstrap.capabilities`. Absent means the bootstrap's apply.
  var capabilities: [String: Capability]? = nil
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
  /// Sent only after the person agrees that sharing their main assistant ends it being main.
  var confirmMainCleared: Bool?
  /// The harness to run on. `init(bot:)` leaves it unset, so a save that does not choose one never
  /// sends it; on a new server, sending it starts a fresh session. An older server ignores it.
  var harness: String?
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
  var size = 0
  var status = UploadStatus.queued
  /// The share of the file sent so far, from 0 to 1.
  var progress = 0.0
  var error: String?
  var uploading: Bool { status == .uploading || status == .processing }
  /// Records how much was sent. Once all of it is, the server is still storing the file.
  mutating func record(sent fraction: Double) {
    guard uploading else { return }
    if fraction >= 1 { progress = 1; status = .processing } else { progress = max(0, fraction) }
  }
  /// The web's chip caption for a file still on its way.
  var caption: String {
    switch status {
    case .failed: return "Didn't upload"
    case .queued: return "Waiting…"
    case .processing: return "Finishing…"
    case .uploading: return "Uploading \(Int((progress * 100).rounded()))%"
    }
  }
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
  /// The add-on admitted this person's message into the task already running. Nil when unknown.
  var steered: Bool? = nil
  /// A progress line the assistant wrote before using tools, such as "I'll check the forecast first". It is the
  /// assistant talking but never the answer, as the web's `interim`. Nil on every other message.
  var interim: Bool? = nil
  /// As the web's `isProgressLine`: it is not read aloud, copied, counted as new, or taken for the reply.
  var isProgressLine: Bool {
    role == "assistant" && interim == true && !isInternalActivity && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }
  var presentationOrigin: MessageOrigin? {
    if role == "user", sender != nil { return nil }
    if let origin { return origin }
    if let envelope = agentEnvelope { return MessageOrigin(kind: "agent", visibility: "activity", name: envelope.name, handle: envelope.handle) }
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
  var agentEnvelope: (name: String, body: String, handle: String?)? {
    guard role == "user", sender == nil else { return nil }
    guard text.hasPrefix("Message from ") || text.hasPrefix("[Message from agent "),
      let match = Self.envelopePattern.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
      let bodyRange = Range(match.range(at: 4), in: text),
      let nameRange = Range(match.range(at: 1).location == NSNotFound ? match.range(at: 3) : match.range(at: 1), in: text)
    else { return nil }
    let handle = Range(match.range(at: 2), in: text).map { String(text[$0]) }
    return (String(text[nameRange]).trimmingCharacters(in: .whitespaces), String(text[bodyRange]), handle)
  }
  /// As the web's `isAgentExchange`: any message whose origin is another assistant, including an
  /// incoming "Message from" envelope and an outgoing `message_agent` call.
  var isAgentExchange: Bool { presentationOrigin?.kind == "agent" }
  /// A reply renders as Markdown: the assistant's, and a scheduled delivery.
  var isReply: Bool { role == "assistant" || presentationOrigin?.kind == "scheduled" }
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
  /// The choices Hermes offered for this request, in its order (once, session, always, deny).
  /// Nil from an older Hermes, which keeps Approve and Decline.
  var choices: [String]? = nil
  /// The command patterns a session or always grant covers, such as "recursive delete".
  var patterns: [String]? = nil
  /// The command as Hermes shows it, already redacted, when the description is not the command itself.
  var command: String? = nil
  func offers(_ choice: String) -> Bool { (choices ?? ["once", "deny"]).contains(choice) }
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
  /// The shared `multiple` field (src/shared/types.ts): several options may be chosen. Absent means one.
  var multiple: Bool? = nil
  /// The one option Hermes marked " (Recommended)", by index (src/shared/recommended.ts). Nil when none or several.
  var recommended: Int? = nil
  /// What option `index` reads as. The recommended one drops its suffix, which a tag shows instead;
  /// its answer stays the raw option, which Hermes strips itself.
  func label(_ index: Int) -> String {
    guard let options, options.indices.contains(index) else { return "" }
    guard index == recommended else { return options[index] }
    let trimmed = options[index].trimmingCharacters(in: .whitespacesAndNewlines)
    let suffix = "(recommended)"
    guard trimmed.lowercased().hasSuffix(suffix) else { return options[index] }
    let label = String(trimmed.dropLast(suffix.count)).trimmingCharacters(in: .whitespacesAndNewlines)
    return label.isEmpty ? options[index] : label
  }
}
struct Attention: Codable, Identifiable, Equatable {
  var id: String
  var kind: String
  var title: String
  var detail: String
  var questions: [Question]?
  var secure: SecureRequest? = nil
  var computer: ComputerHandoff? = nil
  var connection: ConnectionRequest? = nil
  var terminal: TerminalRequest? = nil
}
/// What this device reports about the chat on screen: reading it, or gone after reading it.
struct ChatPresenceReport: Codable, Equatable {
  var client: String
  var state: String
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
  /// The edit sequence of the copy this device last sent. A copy whose `seq` still matches, while
  /// `sentHash` marks the send as open, is that copy. Anything typed since, or the server's copy
  /// adopted since, is new work even in the same words. Kept after the send completes.
  var sentSeq: Int? = nil

  /// Whether this copy may be the one this device sent, untouched since. Drafts are compared by
  /// content on the server, so only the edit sequence can tell the sent copy from the same words
  /// typed again. A copy from an older version has no sequence and keeps the content-only check.
  /// The web client's `isSentCopy` in src/app/storage.ts applies the same rule.
  var isSentCopy: Bool { sentSeq == nil || sentHash != nil && (seq ?? 0) == sentSeq }

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
    // The server's copy is never this device's sent copy, so the send's sequence comes along to say so.
    let adopt = Draft(text: server.text, attachments: server.attachments, dirty: false, baseRevision: revision, baseHash: hash,
      sentSeq: local.sentSeq)
    // The guard for this device's send lasts until the server shows that send completed.
    let sendShown = local.sentHash != nil && (server.sentRevision ?? 0) > (local.sentBase ?? 0)
    if local.dirty != true {
      if local.sentHash == hash && !sendShown { return (local, false) }
      return (adopt, false)
    }
    let mine = contentHash(local.text, local.attachments)
    // Typed since this device's send, the copy is new work whatever words it shares with the send.
    let untouched = local.sentHash == nil || local.isSentCopy
    if untouched && (server.sentRevision ?? 0) > base && (mine == local.baseHash || sendShown && mine == local.sentHash) {
      return (adopt, false)
    }
    var current = local
    if sendShown {
      current.sentHash = nil
      current.sentBase = nil
    }
    var kept = current
    kept.baseRevision = revision
    kept.baseHash = hash
    if local.text == server.text && local.attachments == server.attachments {
      guard settled else { return (kept, false) }
      // Saved as it is: the copy stays this device's sent copy until the server shows the send.
      if sendShown || local.sentHash == nil { return (adopt, false) }
      var saved = adopt
      saved.seq = local.seq
      saved.sentHash = local.sentHash
      saved.sentBase = local.sentBase
      return (saved, false)
    }
    if revision == base { return (current, false) }
    return (kept, true)
  }
  /// This copy once its send was accepted: emptied if it is still the sent copy.
  func sent(_ submission: PendingSubmission) -> Draft {
    guard isSentCopy && text == submission.text && attachments == submission.attachments else { return self }
    return Draft(dirty: false, baseRevision: baseRevision, baseHash: baseHash, seq: seq, sentHash: sentHash, sentBase: sentBase,
      sentSeq: sentSeq)
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
    var role: String?
    var files: [FileRef]?
  }
  var messages: [Entry]
}
struct CoordinationGroup: Identifiable, Equatable {
  var id: String
  var messages: [Message]
}
enum ConversationTurnRow: Identifiable {
  case message(Int, Message)
  case activity(CoordinationGroup)
  case reasoning
  var id: String {
    switch self {
    case .message(_, let message): return "message-" + message.id
    case .activity(let group): return "activity-" + group.id
    case .reasoning: return "reasoning"
    }
  }
}
struct ConversationTurn: Identifiable, Equatable {
  var id: String
  var messages: [Message]
  var replyStart: String? = nil
  var visibleMessages: [Message] { messages.filter(\.isConversationVisible) }
  var reasoning: [String] { messages.filter { !$0.isInternalActivity && $0.role == "assistant" }.compactMap {
    let text = $0.reasoning?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return text.isEmpty ? nil : text
  } }
  /// One identity scope preserves disclosure state when activity moves above the final reply.
  func rows(advanced: Bool) -> [ConversationTurnRow] {
    var rows: [ConversationTurnRow] = []
    var needsReasoning = advanced && !reasoning.isEmpty
    let groups = activityGroups.map(ConversationTurnRow.activity)
    for (index, message) in visibleMessages.enumerated() {
      if needsReasoning && message.role != "user" {
        rows.append(.reasoning); needsReasoning = false
      }
      if message.id == replyStart { rows += groups }
      rows.append(.message(index, message))
    }
    if needsReasoning { rows.append(.reasoning) }
    if replyStart == nil { rows += groups }
    return rows
  }
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
/// Structural conversation version (`boot:epoch:generation`), mirroring `versionBoot` and
/// `compareVersions` in src/shared/inflight.ts.
enum ConversationVersion {
  struct Parsed: Equatable {
    var boot: String
    var epoch: Int
    var generation: Int
  }
  static func parse(_ value: String?) -> Parsed? {
    guard let value else { return nil }
    let parts = value.split(separator: ":", omittingEmptySubsequences: false)
    guard parts.count == 3, !parts[0].isEmpty,
      let epoch = Int(parts[1]),
      let generation = Int(parts[2])
    else { return nil }
    return Parsed(boot: String(parts[0]), epoch: epoch, generation: generation)
  }
  /// The server process a structural version came from, or nil for a missing or malformed version.
  static func boot(_ version: String?) -> String? { parse(version)?.boot }
  /// Orders two structural versions: negative when `lhs` is older, zero when equal, positive when
  /// newer. Nil when either is missing, malformed, or from another server process.
  static func compare(_ lhs: String?, _ rhs: String?) -> Int? {
    guard let left = parse(lhs), let right = parse(rhs), left.boot == right.boot else { return nil }
    let epochs = left.epoch - right.epoch
    return epochs != 0 ? epochs : left.generation - right.generation
  }
}
/// Where a turn sits when its first message is not held yet, matching `TurnRows.after` in
/// src/shared/types.ts: `.after(id)` for a string ID, `.start` for an explicit JSON `null`
/// (the turn starts the conversation), and `nil` when the key is absent from JSON.
enum TurnAnchor: Equatable {
  case after(String)
  case start
}
/// The running turn's saved messages and anchor, matching `TurnRows` in src/shared/types.ts.
struct TurnRows: Codable, Equatable {
  var messages: [Message]
  var after: TurnAnchor? = nil
  init(messages: [Message], after: TurnAnchor? = nil) {
    self.messages = messages
    self.after = after
  }
  private enum CodingKeys: String, CodingKey { case messages, after }
  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    messages = try values.decode([Message].self, forKey: .messages)
    if values.contains(.after) {
      if try values.decodeNil(forKey: .after) {
        after = .start
      } else {
        after = .after(try values.decode(String.self, forKey: .after))
      }
    } else {
      after = nil
    }
  }
  func encode(to encoder: Encoder) throws {
    var values = encoder.container(keyedBy: CodingKeys.self)
    try values.encode(messages, forKey: .messages)
    switch after {
    case .after(let id): try values.encode(id, forKey: .after)
    case .start: try values.encodeNil(forKey: .after)
    case nil: break
    }
  }
}
/// What `event: turn` carries on a stream opened with `?inflight=3` (src/shared/types.ts
/// `TurnEvent`): the running turn whole, its saved messages and its live reply, both from one read
/// at `version`. Growth after it arrives as `inflight-delta` events based on `message`.
struct TurnEvent: Codable, Equatable {
  var botId: String
  var version: String
  var messages: [Message]
  var after: TurnAnchor? = nil
  var message: Message
  var activity: Activity
  var toolCalls: [ToolCall]
  init(
    botId: String,
    version: String,
    messages: [Message],
    after: TurnAnchor? = nil,
    message: Message,
    activity: Activity,
    toolCalls: [ToolCall]
  ) {
    self.botId = botId
    self.version = version
    self.messages = messages
    self.after = after
    self.message = message
    self.activity = activity
    self.toolCalls = toolCalls
  }
  private enum CodingKeys: String, CodingKey {
    case botId, version, messages, after, message, activity, toolCalls
  }
  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    botId = try values.decode(String.self, forKey: .botId)
    version = try values.decode(String.self, forKey: .version)
    messages = try values.decode([Message].self, forKey: .messages)
    if values.contains(.after) {
      if try values.decodeNil(forKey: .after) {
        after = .start
      } else {
        after = .after(try values.decode(String.self, forKey: .after))
      }
    } else {
      after = nil
    }
    message = try values.decode(Message.self, forKey: .message)
    activity = try values.decode(Activity.self, forKey: .activity)
    toolCalls = try values.decode([ToolCall].self, forKey: .toolCalls)
  }
  func encode(to encoder: Encoder) throws {
    var values = encoder.container(keyedBy: CodingKeys.self)
    try values.encode(botId, forKey: .botId)
    try values.encode(version, forKey: .version)
    try values.encode(messages, forKey: .messages)
    switch after {
    case .after(let id): try values.encode(id, forKey: .after)
    case .start: try values.encodeNil(forKey: .after)
    case nil: break
    }
    try values.encode(message, forKey: .message)
    try values.encode(activity, forKey: .activity)
    try values.encode(toolCalls, forKey: .toolCalls)
  }
  var rows: TurnRows { TurnRows(messages: messages, after: after) }
  /// The live reply carried by this turn event, stamped with its structural version.
  var inflight: Inflight {
    Inflight(botId: botId, message: message, activity: activity, toolCalls: toolCalls, version: version)
  }
  /// Continues this turn's live reply when `before` was its live reply, matching `grown` in
  /// src/app/use-conversation.ts.
  func growing(from before: Inflight, to after: Inflight) -> TurnEvent {
    guard botId == before.botId, version == before.version, message == before.message else { return self }
    var next = self
    next.message = after.message
    next.activity = after.activity
    next.toolCalls = after.toolCalls
    return next
  }
}
/// A turn event from another server process, waiting for a read asked after it to settle which
/// process the view shows.
struct PendingTurn: Equatable {
  var turn: TurnEvent
  var ask: Int
}
struct Inflight: Codable, Equatable {
  var botId: String
  var message: Message
  var activity: Activity
  var toolCalls: [ToolCall]
  /// The structural version of the read this live reply leaves saved text to, from a `turn` event.
  /// Nil on `?inflight=1` and `?inflight=2` events from older servers.
  var version: String? = nil
  /// This reply grown by a notice from a stream opened with `?inflight=2` or `?inflight=3`, as the
  /// web's `applyInflightDelta` (src/shared/inflight.ts) grows it. Nil when the notice does not
  /// continue exactly this reply, so the caller reloads instead of guessing. The server counts
  /// lengths in UTF-16 code units, as JavaScript's `String.length` does; `count` counts characters,
  /// which differs for emoji and combining marks.
  func extended(by delta: InflightDelta) -> Inflight? {
    guard botId == delta.botId, message.id == delta.messageId,
      message.text.utf16.count == delta.baseTextLength,
      (message.reasoning ?? "").utf16.count == delta.baseReasoningLength
    else { return nil }
    var value = self
    value.message.text = message.text + (delta.appendText ?? "")
    let reasoning = (message.reasoning ?? "") + (delta.appendReasoning ?? "")
    if !reasoning.isEmpty { value.message.reasoning = reasoning }
    value.activity = delta.activity
    // Absent means the tool calls did not change.
    if let toolCalls = delta.toolCalls { value.toolCalls = toolCalls }
    return value
  }
  func applying(to conversation: Conversation) -> Conversation {
    guard conversation.botId == botId,
      [.thinking, .working, .waiting, .blocked].contains(conversation.activity.state),
      conversation.activity.runId == activity.runId,
      // A versioned live reply leaves out exactly what its own read saved, so it shows only beside
      // that read's messages.
      version == nil || ConversationVersion.compare(version, conversation.version) == 0
    else { return conversation }
    var value = conversation
    value.messages.removeAll { $0.id.hasSuffix("-inflight") }
    if !message.text.isEmpty || !(message.reasoning ?? "").isEmpty { value.messages.append(message) }
    value.activity = activity
    value.toolCalls = toolCalls
    return value
  }
}
/// What `event: inflight-delta` carries (src/shared/types.ts `InflightDelta`): growth of the reply
/// the stream last sent whole. The base lengths are UTF-16 code units of the text and reasoning the
/// sender had already sent; `toolCalls` is present only when they changed.
struct InflightDelta: Codable, Equatable {
  var botId: String
  var messageId: String
  var baseTextLength: Int
  var baseReasoningLength: Int
  var appendText: String?
  var appendReasoning: String?
  var activity: Activity
  var toolCalls: [ToolCall]?
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
  /// The message an earlier page was read before, present only when the server answered `?before=` for it
  /// (src/shared/api.ts). A message the history lost answers the latest page without it.
  var before: String?
  var activity: Activity
  var approvals: [Approval]
  var files: [FileRef]
  var draft: SavedDraft?
  var readPosition: ReadPosition?
  var toolCalls: [ToolCall]?
  /// After a failed turn: anyone's retry of it, as the server claimed it, with its current receipt.
  /// Older servers omit it.
  var retry: RetryClaim?
  /// The structural version this read reflects, at the least: the runtime's version when the read
  /// began. Compare with `ConversationVersion.compare`. Absent from an older server or a runtime
  /// that does not track one.
  var version: String? = nil
  /// The messages with a turn's saved messages in place of everything from the turn on, and no live
  /// reply. Matches `placeTurn` in src/shared/inflight.ts.
  static func placeTurn(_ messages: [Message], turn: TurnRows) -> [Message]? {
    let saved = messages.filter { !$0.id.hasSuffix("-inflight") }
    var end: Int? = turn.messages.first.flatMap { first in
      saved.firstIndex { $0.id == first.id }
    }
    if end == nil, let after = turn.after {
      switch after {
      case .after(let anchor):
        if let index = saved.firstIndex(where: { $0.id == anchor }) {
          end = index + 1
        }
      case .start:
        end = 0
      }
    }
    guard let end else { return nil }
    let kept = saved.prefix(end)
    let ids = Set(turn.messages.map(\.id))
    if kept.contains(where: { ids.contains($0.id) }) { return nil }
    return Array(kept) + turn.messages
  }
  /// This conversation with a turn event's saved messages, version, activity and tools, without its
  /// live reply (which `Inflight.applying(to:)` adds). Returns `self` unchanged when this
  /// conversation is newer than the event, or nil when the turn cannot be placed. Matches `withTurn`
  /// in src/shared/inflight.ts.
  func applying(turn: TurnEvent) -> Conversation? {
    if let order = ConversationVersion.compare(turn.version, version), order < 0 {
      return self
    }
    guard let placed = Self.placeTurn(messages, turn: turn.rows) else { return nil }
    var value = self
    value.messages = placed
    value.version = turn.version
    value.activity = turn.activity
    value.toolCalls = turn.toolCalls
    var known = Set(files.map(\.id))
    for message in turn.messages {
      for file in message.files ?? [] where known.insert(file.id).inserted {
        value.files.append(file)
      }
    }
    return value
  }
  /// The view with an earlier page in front of the message it was read `before`, or nil when the view no longer
  /// holds that message. Only the page's messages, files and earlier counts are taken: live state, the draft and
  /// the rest stay as the view's own reads left them. Files keep conversation order, each once.
  func prepending(_ page: Conversation, before id: String) -> Conversation? {
    guard let at = messages.firstIndex(where: { $0.id == id }) else { return nil }
    let known = Set(files.map(\.id))
    var value = self
    value.messages = page.messages + messages[at...]
    value.files = page.files.filter { !known.contains($0.id) } + files
    value.earlier = page.earlier
    value.earlierFiles = page.earlierFiles
    return value
  }
  var activityMessages: [Message] {
    let canonical = messages.filter { $0.isInternalActivity || $0.isToolActivity || $0.toolCall != nil }
    let known = Set(canonical.compactMap { $0.toolCall?.id })
    return canonical + (toolCalls ?? []).filter { !known.contains($0.id) }.map {
      Message(id: "tool-call-" + $0.id, role: "tool", text: $0.result ?? "", toolCall: $0)
    }
  }
  var presentationTurns: [ConversationTurn] {
    var turns: [ConversationTurn] = []
    var sawActivity = false
    for message in messages {
      if turns.isEmpty || message.role == "user" && !message.isAgentExchange {
        turns.append(ConversationTurn(id: message.id, messages: []))
        sawActivity = false
      }
      // A progress line says what the assistant is about to do, so the work still ahead is not folded above it.
      if message.isConversationVisible && message.role != "user" && !message.isProgressLine && sawActivity && turns[turns.count - 1].replyStart == nil {
        turns[turns.count - 1].replyStart = message.id
      }
      if message.isInternalActivity || message.isToolActivity || message.toolCall != nil {
        sawActivity = true
        turns[turns.count - 1].replyStart = nil
      }
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
    // Appended live calls must not become a new history position for the reply.
    for index in turns.indices where turns[index].activityGroups.contains(where: { $0.messages.contains(where: { $0.toolCall?.status == "running" }) }) {
      turns[index].replyStart = nil
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
  /// When this revision was committed (ISO 8601). Older servers omit it.
  var committedAt: String?
}
struct UpgradeCheck: Codable, Identifiable {
  var id: String
  var label: String
  var status: String
  var detail: String?
  /// "Passed · detail", as the web's test details read.
  var summary: String {
    let word = status == "passed" ? "Passed" : status == "failed" ? "Failed" : status == "running" ? "Running" : "Waiting"
    return detail.map { "\(word) · \($0)" } ?? word
  }
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
  /// "check" only finds and tests an update in a copy; "install" changes Hermes. Older servers omit it.
  var operation: String?
  var error: String?
  var checkedAt: String?
  var updatedAt: String?
  var busyBots: [String]
  var inProgress: Bool { ["checking", "qualifying", "installing", "verifying", "recovering"].contains(phase) }
  var installing: Bool { ["installing", "verifying"].contains(phase) }
}
/// How the Hermes updates screen reads a status, ported from the web panel so both clients agree.
extension UpgradeStatus {
  enum StepState: String { case waiting, active, done, failed }
  private static let installPhases: Set = ["installing", "verifying", "recovering", "rolled_back"]
  /// A status without `operation` is an install only once it reaches an install phase.
  var isInstall: Bool { (operation ?? (Self.installPhases.contains(phase) ? "install" : "check")) == "install" }
  var stopped: Bool { ["blocked", "failed", "cancelled"].contains(phase) }
  var upToDate: Bool { phase == "idle" && !(checkedAt ?? "").isEmpty && candidate == nil }
  var title: String {
    switch phase {
    case "idle": upToDate ? "Hermes is up to date" : "Hermes updates"
    case "checking": "Looking for an update"
    case "qualifying": "Testing the update"
    case "ready": "Update tested and ready"
    case "installing": "Installing the update"
    case "verifying": "Making sure everything works"
    case "succeeded": isInstall ? "Hermes is up to date" : "Hermes is ready"
    case "blocked": isInstall ? "The update was stopped safely" : "This update needs a look"
    case "failed": isInstall ? "The update couldn't finish" : "The check didn't finish"
    case "rolled_back": "The previous version is restored"
    case "recovering": "Restoring the connection"
    case "cancelled": isInstall ? "The update was cancelled" : "Check stopped"
    default: "Hermes updates"
    }
  }
  /// The sentence under the title: the server's message unless a check just found nothing to install.
  func description(loading: Bool) -> String {
    if upToDate { return "You're running the newest Hermes." }
    if !message.isEmpty { return message }
    return loading ? "Getting the current version and update status…" : "Find the newest Hermes and test it before installing it."
  }
  /// Find, test in a copy, then install. Only the last changes Hermes.
  var steps: [(name: String, state: StepState)] {
    let install = isInstall
    let find: StepState = phase == "checking" && candidate == nil ? .active
      : candidate != nil ? .done : stopped && !install ? .failed : .waiting
    let tested = ["ready", "installing", "verifying", "recovering", "rolled_back"].contains(phase)
    let test: StepState = phase == "qualifying" || phase == "checking" && candidate != nil ? .active
      : tested || install ? .done : stopped && candidate != nil ? .failed : .waiting
    let last: StepState = ["installing", "verifying", "recovering"].contains(phase) ? .active
      : phase == "succeeded" && install ? .done
      : install && (stopped || phase == "rolled_back") ? .failed : .waiting
    return [("Find", find), ("Test in a copy", test), ("Install", last)]
  }
  /// A check's own retry is just "Check again", so retry and cancel belong to installs.
  var showsRecovery: Bool { isInstall && (canRetry == true || canCancel == true) || canRestartService == true }
  /// Stopping a check needs no confirmation because nothing has changed yet.
  var canStopCheck: Bool { inProgress && !isInstall && canCancel == true }
  var checksPassed: Int { checks.filter { $0.status == "passed" }.count }
  /// The primary button reads Install once a tested update is waiting, otherwise it runs a check.
  var installsNext: Bool { canInstall && candidate != nil }
  func actionLabel(submitting: Bool, uncertain: Bool) -> String {
    if submitting { return installsNext ? "Starting the install…" : "Starting the check…" }
    if uncertain { return "Checking update status…" }
    if phase == "recovering" { return "Restoring…" }
    if phase == "verifying" { return "Checking Hermes…" }
    if inProgress { return isInstall ? "Installing…" : "Testing…" }
    return installsNext ? "Install update" : stopped && !isInstall ? "Check again" : "Check for an update"
  }
  func actionHint(uncertain: Bool) -> String {
    if inProgress || uncertain { return "You can close this. Progress continues on the server." }
    return installsNext ? "Installing briefly reconnects Hermes. Conversations and drafts stay saved."
      : "A check finds the newest Hermes and tests it in a separate copy. Nothing is installed until you choose Install."
  }
}
/// The shared desktop's availability and who is driving it, from GET /api/computer.
struct ComputerStatus: Decodable, Equatable {
  struct Control: Decodable, Equatable {
    var kind: String
    var name: String?
    var mine: Bool?
  }
  var available: Bool
  /// Absent from older servers; false means the desktop is installed but not running.
  var running: Bool? = nil
  var reason: String?
  var control: Control
  /// Absent from older servers. The system terminal, for terminal administrators.
  var terminal: Terminal? = nil
  struct Terminal: Decodable, Equatable {
    var available: Bool
    /// Blank when this person may not use the shell.
    var target: String = ""
    var reason: String? = nil
    /// The server wants a sign-in confirmed in the last 2 hours before it opens a shell.
    var confirmationRequired: Bool? = nil
    init(from decoder: Decoder) throws {
      let values = try decoder.container(keyedBy: CodingKeys.self)
      available = try values.decode(Bool.self, forKey: .available)
      target = try values.decodeIfPresent(String.self, forKey: .target) ?? ""
      reason = try values.decodeIfPresent(String.self, forKey: .reason)
      confirmationRequired = try values.decodeIfPresent(Bool.self, forKey: .confirmationRequired)
    }
    init(available: Bool, target: String = "", reason: String? = nil, confirmationRequired: Bool? = nil) {
      self.available = available; self.target = target; self.reason = reason; self.confirmationRequired = confirmationRequired
    }
    private enum CodingKeys: String, CodingKey { case available, target, reason, confirmationRequired }
  }
  /// What the Settings row says under "Computer", worded like the web panel.
  var detail: String {
    guard available else { return reason?.isEmpty == false ? reason! : "Desktop unavailable" }
    switch control.kind {
    case "human":
      return control.mine == true ? "Watching. Take over to control the desktop."
        : "\(control.name ?? "A household member") has control"
    case "bot": return "\(control.name ?? "An assistant") is using the computer"
    default: return "Watching. Assistants can use this computer."
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
/// Equatable so an unchanged poll leaves the published value, and every view reading it, alone.
struct Bootstrap: Codable, Equatable {
  var user: Member
  var household: [Member]
  var preferences: Preferences
  var bots: [Bot]
  var capabilities: [String: Capability]
  subscript(capability key: CapabilityKey) -> Capability? { capabilities[key.rawValue] }
  var connection: RuntimeStatus
  /// True when the server has no roster from its current Hermes connection, so `bots`, empty or the last
  /// connection's rows, says nothing about who is on it. An older server omits it and lists no one while
  /// Hermes is down instead.
  var rosterUnknown: Bool?
  var csrfToken: String?
  /// This person's private key for deriving form request IDs. A server from before form cards omits it.
  var formKey: String?
  /// Present when the host publishes the latest distributed iOS build.
  var nativeApp: NativeAppInfo?
  /// The native harnesses new bots can use. A server that runs only Hermes omits it.
  var harnesses: [HarnessOption]? = nil
}
extension Bootstrap {
  /// Whether `bots` is not a roster Hermes just gave: rows marked `disconnected` are the server's cache,
  /// which can be stale in either direction, and an unknown roster says nothing at all. An
  /// assistant such a roster leaves out has not been shown to leave. Read on the lean roster only: a full
  /// roster's detail rows are not marked.
  var servedFromCache: Bool {
    rosterUnknown == true || !connection.connected || bots.contains { $0.activity == .disconnected }
  }
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
  /// Group chats this routine also posts its results in. Nil when the server could not say, and then never sent.
  var roomIds: [String]?
  var skills: [String]?
  var model: String?
  var provider: String?
  var enabledToolsets: [String]?
  var script: String?
  var noAgent: Bool?
  var contextFrom: [String]?
  var nextRunAt: String?
  var lastRunAt: String?
  var lastStatus: String?
  var lastError: String?
  var lastDeliveryError: String?
  /// A run is in flight now, which Stop run can end. Read only.
  var running: Bool?
  /// "check-in": a member's main-assistant check-ins, changed only from its details. Read only; older servers omit it.
  var managed: String? = nil
  var isCheckIn: Bool { managed == "check-in" }
  enum CodingKeys: String, CodingKey {
    case id, botId, name, prompt, schedule, enabled, recipientIds, roomIds, skills, model, provider
    case enabledToolsets, script, noAgent, contextFrom, nextRunAt, lastRunAt, lastStatus, lastError, lastDeliveryError, running, managed
  }
  // Explicit null releases an override; synthesized encodeIfPresent would omit it
  // and native PUT would retain the old value. Unknown native fields stay server-side.
  func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(id, forKey: .id)
    try c.encode(botId, forKey: .botId)
    try c.encode(name, forKey: .name)
    try c.encode(prompt, forKey: .prompt)
    try c.encode(schedule, forKey: .schedule)
    try c.encode(enabled, forKey: .enabled)
    try c.encodeIfPresent(recipientIds, forKey: .recipientIds)
    try c.encodeIfPresent(roomIds, forKey: .roomIds)
    try c.encodeIfPresent(skills, forKey: .skills)
    try c.encode(model, forKey: .model)
    try c.encode(provider, forKey: .provider)
    try c.encode(enabledToolsets, forKey: .enabledToolsets)
    try c.encode(script, forKey: .script)
    try c.encodeIfPresent(noAgent, forKey: .noAgent)
    try c.encode(contextFrom, forKey: .contextFrom)
    try c.encodeIfPresent(nextRunAt, forKey: .nextRunAt)
    try c.encodeIfPresent(lastRunAt, forKey: .lastRunAt)
    try c.encodeIfPresent(lastStatus, forKey: .lastStatus)
    try c.encodeIfPresent(lastError, forKey: .lastError)
    try c.encodeIfPresent(lastDeliveryError, forKey: .lastDeliveryError)
  }
  static func empty(botId: String) -> Routine {
    Routine(
      id: "", botId: botId, name: "", prompt: "", schedule: "", enabled: true, recipientIds: [], roomIds: [], contextFrom: ["self"])
  }
}
/// An assistant's always-allowed command patterns and Hermes's own review of routine commands
/// (src/shared/types.ts ApprovalSettings). `mode` is Hermes's approvals.mode: manual, smart or off.
struct ApprovalSettings: Codable, Equatable {
  var supported: Bool
  var reason: String? = nil
  var allowlist: [String]
  var mode: String
  var canManageAutoReview: Bool
}
struct Receipt: Codable, Equatable {
  var requestId: String
  var status: String
  var runId: String?
  var messageId: String?
  var message: String?
  /// The text the server recorded under this request ID, sent only to its sender by `GET /submissions/:id`.
  var text: String? = nil
  /// Whether the message joined the running task. Nil from an older add-on.
  var steered: Bool? = nil
  /// What Hermes did with an accepted new task's turn (src/shared/types.ts AdmissionTurn): `started`,
  /// `queued` (its busy queue, no separate later turn promised), `joined` (put into the running turn),
  /// `none` (a typed stop phrase ended Hermes's voice chat and nothing was admitted) or `unknown`.
  /// Nil when nobody can say: an older add-on, a receipt recovered by lookup, a steer, or a receipt
  /// that is not accepted.
  var turn: String? = nil
  /// The server's structural version when Hermes's admission answer reached it. This client has no early
  /// "thinking" row to end with it, so it is only decoded, as the web's `SubmissionReceipt` carries it.
  var admittedVersion: String? = nil

  /// A typed stop phrase ended Hermes's voice chat: accepted, but nothing reached the assistant, so no
  /// copy of the message is coming and its words belong back in the draft.
  var admittedNothing: Bool { status == "accepted" && turn == "none" }
  /// Hermes took the message into the assistant's turn: accepted and not a stop phrase.
  var admitted: Bool { status == "accepted" && turn != "none" }
  /// The message went into work already running, by the add-on's steer or by Hermes into the running turn.
  var joinedRunningWork: Bool { steered == true || turn == "joined" }
}
/// A failed turn's retry as the server records it: the receipt of the request that claimed the turn.
struct RetryClaim: Codable, Equatable {
  var requestId: String
  var status: String
  var runId: String?
  var messageId: String?
  var message: String?
  /// As `Receipt.turn`: a retry whose words were a typed stop phrase is accepted with `none`.
  var turn: String? = nil
  var retryOf: String
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
/// A sent message shown in the transcript at once, until Hermes's own copy arrives. It never
/// changes what was sent or saved: it is drawn only from the pending submission and its receipt.
/// Ported from the web's src/app/sent-echo.ts.
struct SentEcho: Equatable {
  /// Sending: the request is in flight. Unconfirmed: it ended without a receipt.
  enum Status: Equatable { case sending, unconfirmed, accepted }
  /// How long an accepted message may stay missing from a conversation that never shows its run.
  static let patience: TimeInterval = 30
  var request: PendingSubmission
  var sender: Sender
  var sentAt: String
  /// The last message shown when it was sent. A copy of the same words counts only after it.
  var after: String?
  var status: Status
  var messageId: String?
  var acceptedAt: Date?
  /// The conversation has shown activity since Hermes accepted it.
  var ran = false
  /// Hermes admitted it into the task that was already running.
  var steered = false
  /// The message drawn from an echo and how far it got.
  struct Delivery: Equatable {
    var id: String
    var status: Status
  }
  /// Accepted, it reads as any other message until Hermes's own copy takes its place.
  var delivery: Delivery? { status == .accepted ? nil : Delivery(id: request.requestId, status: status) }

  /// Whether Hermes's own copy of the message is in the conversation. Only a message Hermes accepted is
  /// matched by its words; see `copyIndex`.
  func shown(in conversation: Conversation) -> Bool {
    Self.copyIndex(requestId: request.requestId, messageId: messageId, text: status == .accepted ? request.text : "", after: after,
      senderId: sender.id, in: conversation.messages) != nil
  }
  /// The echo after the submission, its receipt or the conversation changed. Nil removes it.
  static func next(_ echo: SentEcho?, pending: PendingSubmission?, receipt: Receipt?, sending: Bool,
    conversation: Conversation?, sender: Sender?, now: Date) -> SentEcho?
  {
    // Another person signed in, or nobody is: nothing of the last one's stays on screen.
    var next = echo?.sender.id == sender?.id ? echo : nil
    if let pending, pending.requestId != next?.request.requestId {
      guard let sender else { return nil }
      // A live reply's row is replaced as it is saved, so it cannot anchor anything.
      let anchor: String? = conversation?.botId == pending.botId
        ? conversation?.messages.last(where: { !$0.id.hasSuffix("-inflight") })?.id : nil
      next = SentEcho(request: pending, sender: sender, sentAt: Self.timestamp(now), after: anchor, status: .sending)
    }
    guard var next else { return nil }
    if pending?.requestId == next.request.requestId {
      next.status = sending ? .sending : .unconfirmed
    } else if next.status != .accepted {
      // A refused, interrupted or abandoned send leaves only the draft it came from. So does a typed stop
      // phrase that ended Hermes's voice chat: it admitted nothing, so no copy is coming.
      guard let receipt, receipt.requestId == next.request.requestId, receipt.admitted else { return nil }
      next.status = .accepted
      next.messageId = receipt.messageId
      next.acceptedAt = now
      next.steered = receipt.joinedRunningWork
    }
    guard let conversation, conversation.botId == next.request.botId else { return next }
    if next.shown(in: conversation) { return nil }
    if next.status != .accepted { return next }
    // Some prompts are saved only when their run finishes, so the echo stands in until then.
    if conversation.activity.state.active {
      next.ran = true
      return next
    }
    return next.ran || now.timeIntervalSince(next.acceptedAt ?? now) > patience ? nil : next
  }
  /// The conversation with the echo at its end, as the person's own message. Its ID is the
  /// request ID, so Hermes's copy, which carries the same ID, takes its place without a flicker.
  static func transcript(_ conversation: Conversation?, _ echoes: [SentEcho]) -> Conversation? {
    guard let saved = conversation else { return nil }
    var conversation = saved
    // Checked against Hermes's messages only, so one echo never passes for another's copy.
    for echo in echoes where echo.request.botId == saved.botId && !echo.shown(in: saved) {
      conversation.messages.append(Message(
        id: echo.request.requestId, role: "user", text: echo.request.text, createdAt: echo.sentAt,
        sender: echo.sender, files: echo.request.attachments.isEmpty ? nil : echo.request.attachments,
        steered: echo.steered ? true : nil))
    }
    return conversation
  }
  /// Every echo of one chat after a change. A message Hermes accepted stays until its own copy arrives,
  /// even when another is sent meanwhile, such as guidance after a photo whose row is saved only when
  /// its run ends. `advance` steps the echoes of every chat, each with its own send.
  static func nextEchoes(_ echoes: [SentEcho], pending: PendingSubmission?, receipt: Receipt?, sending: Bool,
    conversation: Conversation?, sender: Sender?, now: Date) -> [SentEcho]
  {
    advance(echoes, [], chat: { _ in ChatSend(pending: pending, receipt: receipt, sending: sending) }, open: pending?.botId,
      conversation: conversation, sender: sender, now: now).echoes
  }
  /// Whether the composer is showing a draft that is on its way. The echo carries it in the
  /// transcript, so the composer reads empty, and read-only: the draft must stay the sent copy,
  /// because a draft and its send are told apart by content until Hermes answers.
  static func sendingDraft(_ draft: Draft, pending: PendingSubmission?, sending: Bool) -> Bool {
    guard sending, let pending, draft.isSentCopy else { return false }
    return draft.text == pending.text && draft.attachments == pending.attachments
  }
  static func trimmed(_ text: String) -> String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
  private static func timestamp(_ date: Date) -> String { ServerDate.string(date) }
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
/// `POST /api/auth/native/renew`: the same token, valid until this new expiry.
struct TokenRenewal: Codable {
  var expiresAt: String
}
/// When to ask the server to extend this device's sign-in. The server renews the same token in
/// place, because push registrations hang off it, and stops at 90 days after the Google sign-in.
enum SignInRenewal {
  /// Renewal starts once fewer than two days of the seven-day sign-in remain.
  static let window: TimeInterval = 2 * 24 * 3600
  /// A failed or capped renewal is asked again at most this often.
  static let retry: TimeInterval = 3600
  static func due(expiresAt: Date?, lastAttempt: Date?, now: Date) -> Bool {
    guard let expiresAt, expiresAt > now, expiresAt.timeIntervalSince(now) < window else { return false }
    // A clock set back past the last attempt counts as time passed, so renewal cannot stall.
    return lastAttempt.map { now.timeIntervalSince($0) >= retry || now < $0 } ?? true
  }
}
struct EmptyResponse: Codable { var ok: Bool? }
/// `POST /routines/:id/stop`: whether a run was in flight to stop.
struct StopRunResponse: Decodable { var stopped: Bool }
struct PushConfig: Codable {
  var available: Bool
  var environment: String?
}
struct PushDevice: Encodable {
  var deviceId: String
  var token: String
}
enum ServerDate {
  /// ISO8601DateFormatter is thread-safe, so one of each serves every parse instead of one per call.
  nonisolated(unsafe) private static let fractional: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
  }()
  nonisolated(unsafe) private static let whole = ISO8601DateFormatter()
  static func parse(_ value: String) -> Date? { fractional.date(from: value) ?? whole.date(from: value) }
  static func string(_ date: Date) -> String { fractional.string(from: date) }
}

/// UserDefaults keys for this device rather than a household scope. `AppStore.StorageKind` holds
/// the scoped ones. Changing a value here forgets what installed apps saved under the old name.
enum DeviceDefaults {
  static let host = "connection.host"
  static let pushDeviceId = "push.deviceId"
  /// The account last signed in here, kept until sign-out, so a background launch can tell whose a
  /// pushed Live Activity is before the account loads.
  static let signedInScope = "connection.signedInScope"
  /// When the sign-in to `server` expires.
  static func expiry(_ server: URL) -> String { "connection.expiry.\(server.absoluteString)" }
  /// The LAN and tailnet routes `server` advertised last. Not secret: addresses and certificate pins.
  static func directRoutes(_ server: URL) -> String { "connection.directRoutes.\(server.absoluteString)" }
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
  /// Pinned assistants appear once, in the person's saved pin order. The main assistant leads
  /// home on its own, so it is never among them.
  func pinnedAssistants(_ bots: [Bot]) -> [Bot] {
    var seen: Set<String> = []
    return favorites.compactMap { id in
      guard id != mainBotId, seen.insert(id).inserted else { return nil }
      return bots.first { $0.id == id }
    }
  }
  /// The list below the pins follows the web's sections and original roster order.
  func assistantGroups(_ bots: [Bot]) -> [AssistantGroup] {
    let unpinned = bots.filter { !favorites.contains($0.id) && $0.id != mainBotId }
    var seen: Set<String> = []
    var groups: [AssistantGroup] = []
    for section in sections {
      let rows = unpinned.filter { section.botIds.contains($0.id) && seen.insert($0.id).inserted }
      if !rows.isEmpty { groups.append(AssistantGroup(id: "section:" + section.id, title: section.displayName, bots: rows)) }
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
  static let speeds = ["normal", "auto", "fast", "ultrafast"]
}
