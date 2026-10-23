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
  var mode = AvatarMode.geometric
  var shape: AvatarShape? = .blob
  var family: AvatarFamily? = nil
  var color: String? = "#1084FE"
  var eyes: AvatarEyes? = .oval
  var accessory: AvatarAccessory? = .plain
  var eyeWidth: Double? = 1
  var eyeHeight: Double? = 1
  var eyeSpacing: Double? = 1
  var src: String? = nil
  var origin: String? = nil
  static let shapes = AvatarShape.all
  static let everydayFamilies: [(id: AvatarFamily, label: String)] = [
    (.bear, "Bear"), (.fox, "Fox"), (.sprout, "Sprout"), (.panda, "Panda"),
    (.raccoon, "Raccoon"), (.owl, "Owl"), (.cactus, "Cactus"), (.dinosaur, "Dinosaur"),
  ]
  /// Listed under their own "Seasonal" heading, in calendar order from spring, like the web editor.
  static let seasonalFamilies: [(id: AvatarFamily, label: String)] = [
    (.leprechaun, "Leprechaun"), (.bunny, "Easter Bunny"), (.eagle, "Bald Eagle"),
    (.pumpkin, "Pumpkin"), (.bat, "Bat"), (.ghost, "Ghost"), (.turkey, "Turkey"),
    (.santa, "Santa"), (.rudolph, "Rudolph"), (.snowman, "Snowman"),
  ]
  static var families: [(id: AvatarFamily, label: String)] { everydayFamilies + seasonalFamilies }
  static let seasonalColors: [AvatarFamily: String] = [
    .leprechaun: "#F2B08B", .bunny: "#F5E9D8", .eagle: "#F7F3EA", .pumpkin: "#FF9800",
    .bat: "#5E4B8B", .ghost: "#F2EEF8", .turkey: "#97683D", .santa: "#F2B08B",
    .rudolph: "#97683D", .snowman: "#F4F8FB",
  ]
  /// Bear, fox and sprout are drawn by AvatarArtwork itself; every later mascot is a character.
  static let characterFamilies: [AvatarFamily] = families.map(\.id).filter {
    ![.bear, .fox, .sprout].contains($0)
  }
  /// The character a mascot avatar draws, if its family is one.
  var character: AvatarFamily? {
    guard mode == .mascot, let family, Self.characterFamilies.contains(family) else { return nil }
    return family
  }
  /// The outline this avatar morphs to. An unknown shape draws as the blob, an unknown or
  /// plain mascot as the shared mascot head.
  var body: AvatarBody {
    if mode == .geometric { return .shape(shape ?? .blob) }
    return character.map(AvatarBody.character) ?? .mascot
  }
  func selectingFamily(_ family: AvatarFamily) -> AvatarConfig {
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
struct Inflight: Codable {
  var botId: String
  var message: Message
  var activity: Activity
  var toolCalls: [ToolCall]
  func applying(to conversation: Conversation) -> Conversation {
    guard conversation.botId == botId,
      [.thinking, .working, .waiting, .blocked].contains(conversation.activity.state),
      conversation.activity.runId == activity.runId
    else { return conversation }
    var value = conversation
    value.messages.removeAll { $0.id.hasSuffix("-inflight") }
    if !message.text.isEmpty || !(message.reasoning ?? "").isEmpty { value.messages.append(message) }
    value.activity = activity
    value.toolCalls = toolCalls
    return value
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
    var sawActivity = false
    for message in messages {
      if turns.isEmpty || message.role == "user" {
        turns.append(ConversationTurn(id: message.id, messages: []))
        sawActivity = false
      }
      if message.isConversationVisible && message.role != "user" && sawActivity && turns[turns.count - 1].replyStart == nil {
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
  var reason: String?
  var control: Control
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
  enum CodingKeys: String, CodingKey {
    case id, botId, name, prompt, schedule, enabled, recipientIds, skills, model, provider
    case enabledToolsets, script, noAgent, contextFrom, nextRunAt, lastRunAt, lastStatus, lastError, lastDeliveryError
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
      id: "", botId: botId, name: "", prompt: "", schedule: "", enabled: true, recipientIds: [], contextFrom: ["self"])
  }
}
struct Receipt: Codable, Equatable {
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
  /// The message drawn from an echo and how far it got.
  struct Delivery: Equatable {
    var id: String
    var status: Status
  }
  /// Accepted, it reads as any other message until Hermes's own copy takes its place.
  var delivery: Delivery? { status == .accepted ? nil : Delivery(id: request.requestId, status: status) }

  /// Whether Hermes's own copy of the message is in the conversation.
  func shown(in conversation: Conversation) -> Bool {
    let messages = conversation.messages
    if messages.contains(where: { $0.id == request.requestId || $0.id == messageId }) { return true }
    // Hermes names a staged prompt by its request ID. Other rows, such as image-only prompts, are
    // matched by their words once it accepted them, after the message that was last when it was sent.
    let text = Self.trimmed(request.text)
    guard status == .accepted, !text.isEmpty else { return false }
    var start = 0
    if let after {
      // Without its anchor, an older message with the same words could pass for this one.
      guard let anchor = messages.firstIndex(where: { $0.id == after }) else { return false }
      start = anchor + 1
    }
    return messages[start...].contains {
      $0.role == "user" && Self.trimmed($0.text) == text && ($0.sender == nil || $0.sender?.id == sender.id)
    }
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
      // A refused, interrupted or abandoned send leaves only the draft it came from.
      guard let receipt, receipt.requestId == next.request.requestId, receipt.status == "accepted" else { return nil }
      next.status = .accepted
      next.messageId = receipt.messageId
      next.acceptedAt = now
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
        sender: echo.sender, files: echo.request.attachments.isEmpty ? nil : echo.request.attachments))
    }
    return conversation
  }
  /// Every echo after a change. A message Hermes accepted stays until its own copy arrives, even
  /// when another is sent meanwhile, such as guidance after a photo whose row is saved only when
  /// its run ends.
  static func nextEchoes(_ echoes: [SentEcho], pending: PendingSubmission?, receipt: Receipt?, sending: Bool,
    conversation: Conversation?, sender: Sender?, now: Date) -> [SentEcho]
  {
    var next = echoes.compactMap { echo in
      Self.next(echo, pending: pending?.requestId == echo.request.requestId ? pending : nil, receipt: receipt,
        sending: sending, conversation: conversation, sender: sender, now: now)
    }
    // A send gets one echo; once it leaves, the same pending submission never brings it back.
    if let pending, !echoes.contains(where: { $0.request.requestId == pending.requestId }),
      let created = Self.next(nil, pending: pending, receipt: receipt, sending: sending, conversation: conversation, sender: sender, now: now)
    {
      next.append(created)
    }
    return next
  }
  /// Whether the composer is showing a draft that is on its way. The echo carries it in the
  /// transcript, so the composer reads empty, and read-only: the draft must stay the sent copy,
  /// because a draft and its send are told apart by content until Hermes answers.
  static func sendingDraft(_ draft: Draft, pending: PendingSubmission?, sending: Bool) -> Bool {
    guard sending, let pending, draft.isSentCopy else { return false }
    return draft.text == pending.text && draft.attachments == pending.attachments
  }
  private static func trimmed(_ text: String) -> String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
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
  static let speeds = ["normal", "fast", "ultrafast"]
}
