import CryptoKit
import SwiftUI

/// Whether Hermes is reachable, for rows that show "Last seen running".
private struct TranscriptConnectedKey: EnvironmentKey { static let defaultValue = true }
/// The open assistant's name, for agent exchanges. An environment value, so a roster change that
/// keeps the name renders no message again.
private struct TranscriptRecipientKey: EnvironmentKey { static let defaultValue = "Assistant" }
private struct FoundMessageKey: EnvironmentKey { static let defaultValue: String? = nil }
private struct TranscriptUserKey: EnvironmentKey { static let defaultValue: String? = nil }
private struct DraftRevisionsKey: EnvironmentKey { static let defaultValue: [String: DraftRevision] = [:] }
extension EnvironmentValues {
  /// The signed-in person, so only another member's message carries a name.
  var transcriptUserId: String? {
    get { self[TranscriptUserKey.self] }
    set { self[TranscriptUserKey.self] = newValue }
  }
  var foundMessage: String? {
    get { self[FoundMessageKey.self] }
    set { self[FoundMessageKey.self] = newValue }
  }
  /// The turn's revised email drafts, by `DraftDiff.key`.
  var draftRevisions: [String: DraftRevision] {
    get { self[DraftRevisionsKey.self] }
    set { self[DraftRevisionsKey.self] = newValue }
  }
  var transcriptConnected: Bool {
    get { self[TranscriptConnectedKey.self] }
    set { self[TranscriptConnectedKey.self] = newValue }
  }
  var transcriptRecipient: String {
    get { self[TranscriptRecipientKey.self] }
    set { self[TranscriptRecipientKey.self] = newValue }
  }
}
extension View {
  /// Provides the store to a screen or sheet. Views render again only for the properties they
  /// read, so transcript rows read none while rendering: they take the connection and the
  /// assistant's name from the environment and use the store only in actions.
  func appStore(_ store: AppStore) -> some View { environment(store) }
}

/// The loaded turns. Equatable, so the transcript renders again only when they change.
struct TranscriptTurns: View, Equatable {
  var turns: [ConversationTurn]
  var advanced: Bool
  /// The person's sent message still shown from this device, and how far it got.
  var delivery: SentEcho.Delivery?
  /// The turn the assistant is still working on, whose work reads as live.
  var liveTurn: String? = nil
  /// Routine runs before each turn and after the last; see `RoutineRunRules.place`.
  var runSlots: [[RoutineRun]] = []
  var botId = ""
  /// Each reply's file chips and each revised email draft, by message; see AppStore.replyFiles.
  var replyFiles: [String: [Artifact]] = [:]
  var revisions: [String: DraftRevision] = [:]
  /// One keyed list, so an opened run card stays open when a new turn lands after it.
  private enum Row: Identifiable {
    case run(RoutineRun), turn(ConversationTurn)
    var id: String { switch self { case .run(let run): run.key; case .turn(let turn): turn.id } }
  }
  private var rows: [Row] {
    guard !runSlots.isEmpty else { return turns.map(Row.turn) }
    var rows: [Row] = []
    for (index, turn) in turns.enumerated() {
      if index < runSlots.count { rows += runSlots[index].map(Row.run) }
      rows.append(.turn(turn))
    }
    if turns.count < runSlots.count { rows += runSlots[turns.count].map(Row.run) }
    return rows
  }
  var body: some View {
    // Only the turn holding the message on its way renders again as it goes.
    ForEach(rows) { row in
      switch row {
      case .turn(let turn):
        let ids = Set(turn.messages.map(\.id))
        ConversationTurnView(turn: turn, advanced: advanced,
          delivery: turn.messages.contains { $0.id == delivery?.id } ? delivery : nil, live: turn.id == liveTurn,
          files: replyFiles.filter { ids.contains($0.key) },
          revisions: revisions.filter { ids.contains(String($0.key.prefix { $0 != "\n" })) })
      case .run(let run):
        RoutineRunCard(run: run, botId: botId).id(run.key)
      }
    }.disclosureGroupStyle(TranscriptDisclosureStyle())
  }
}

struct ConversationTurnView: View, Equatable {
  var turn: ConversationTurn
  var advanced: Bool
  var delivery: SentEcho.Delivery? = nil
  var live = false
  /// File chips by reply, and revised email drafts, for this turn's messages only.
  var files: [String: [Artifact]] = [:]
  var revisions: [String: DraftRevision] = [:]
  @Environment(\.transcriptConnected) private var connected
  @Environment(\.transcriptRecipient) private var recipient
  nonisolated static func == (a: Self, b: Self) -> Bool {
    a.turn == b.turn && a.advanced == b.advanced && a.delivery == b.delivery && a.live == b.live && a.files == b.files && a.revisions == b.revisions
  }
  var body: some View {
    let visible = turn.visibleMessages
    VStack(alignment: .leading, spacing: 18) {
      ForEach(turn.transcriptRows(advanced: advanced)) { row in
        switch row {
        case .work:
          work
          // A T3 Code thread the work started stays in view, so Open is one tap away.
          ForEach(turn.t3Threads) { T3ThreadCardView(thread: $0) }
        case .message(let index, let message):
        let run = turn.replyRun(at: index, in: visible)
        MessageView(message: message, continued: run.continued, endsRun: run.endsRun, when: run.when,
          delivery: delivery?.id == message.id ? delivery?.status : nil, replyFiles: files[message.id]).id(message.id)
        }
      }
    }.environment(\.draftRevisions, revisions)
  }
  /// All of a turn's intermediate work behind one row, so the conversation reads as messages.
  /// Expanded, it shows the grouped views as they were: reasoning, tool calls and each activity group.
  private var work: some View {
    DisclosureGroup {
      VStack(alignment: .leading, spacing: 12) {
        if advanced && !turn.reasoning.isEmpty { reasoning }
        ForEach(turn.activityGroups) { activityGroup($0) }
      }
    } label: {
      WorkLabel(summary: WorkSummary(turn), live: live, connected: connected)
    }.font(.subheadline).disclosureIdentifier("turnWork")
  }
  private func activityGroup(_ group: CoordinationGroup) -> some View {
    DisclosureGroup {
      ForEach(group.messages) { message in
        activityRow(message)
        ForEach(message.files ?? []) { FileAttachmentView(file: $0) }
      }
    } label: {
      HStack(spacing: 8) {
        Text(group.id)
        Text("\(group.messages.count)").font(.caption).foregroundStyle(Palette.muted)
        if group.messages.contains(where: { $0.toolCall?.status == "running" }) {
          Text(connected ? "Running" : "Last seen running").font(.caption).foregroundStyle(Palette.muted)
        }
      }
    }.disclosureIdentifier(group.id)
  }
  /// As the web's ToolCalls: an agent exchange first, then a tool call, then other activity.
  @ViewBuilder private func activityRow(_ message: Message) -> some View {
    if message.isAgentExchange {
      AgentExchangeView(message: message, recipient: recipient)
    } else if let call = message.toolCall {
      if advanced { ToolActivityView(message: message) } else { ActionReceiptView(call: call) }
    } else {
      DisclosureGroup(activityTitle(message)) {
        ToolOutputView(text: message.text.isEmpty ? "No result was exposed by Hermes." : message.text)
          .font(.footnote)
      }
    }
  }
  private func activityTitle(_ message: Message) -> String {
    let title = message.presentationOrigin?.title ?? message.toolName ?? message.activityGroup
    let time = message.createdAt.map { When.format($0, inline: true) } ?? ""
    return time.isEmpty ? title : "\(title) · \(time)"
  }
  private var reasoning: some View {
    ReasoningDisclosure(parts: turn.reasoning)
  }
}
/// A turn's reasoning parts in one disclosure, as plain paragraphs, counted when there are several.
struct ReasoningDisclosure: View {
  var parts: [String]
  var body: some View {
    DisclosureGroup {
      VStack(alignment: .leading, spacing: 10) {
        ForEach(Array(parts.enumerated()), id: \.offset) { _, part in
          Text(part).font(.footnote).foregroundStyle(Palette.muted).textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
      }.padding(.top, 4)
    } label: {
      HStack(spacing: 8) {
        Text("Reasoning")
        if parts.count > 1 { Text("\(parts.count)").font(.caption).foregroundStyle(Palette.muted) }
      }
    }.disclosureIdentifier("Reasoning")
  }
}

struct ApprovalDecisionView: View {
  var approval: Approval
  var botId: String
  var botName = "The assistant"
  var sendStarted: () -> Void = {}
  /// Runs after a decline is sent, so the conversation can put the person in the message box.
  var declined: () -> Void = {}
  @Environment(AppStore.self) private var store
  @Environment(\.colorScheme) private var scheme
  @Environment(\.dynamicTypeSize) private var typeSize
  @State private var decision: String?
  /// How far an approval reaches: nil is one command.
  @State private var scope: String?
  @State private var settled = false
  @State private var confirmingAlways = false
  /// Hermes listed the choices it allows. An older Hermes lists none and keeps Approve and Decline.
  private var scoped: Bool { approval.choices != nil }
  private var patterns: [String] { approval.patterns ?? [] }
  var body: some View {
    if settled && decision == "denied" {
      DeclinedStepView(botName: botName)
    } else {
      card
    }
  }
  private var card: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Your decision needed").font(.caption.weight(.semibold)).foregroundStyle(Palette.attention)
      Text(approval.title).font(.headline)
      Text(approval.detail).textSelection(.enabled)
      if let command = approval.command {
        Text(command).font(.footnote.monospaced()).textSelection(.enabled).padding(10)
          .frame(maxWidth: .infinity, alignment: .leading)
          .background(Palette.surface(scheme), in: RoundedRectangle(cornerRadius: 8))
          .accessibilityLabel("Command: \(command)").accessibilityIdentifier("approvalCommand")
      }
      if let expiry = approval.expiresAt, !When.format(expiry).isEmpty { Text("Expires \(When.format(expiry, inline: true))").font(.caption).foregroundStyle(Palette.muted) }
      let layout = typeSize.isAccessibilitySize || (scoped && approval.offers("session"))
        ? AnyLayout(VStackLayout(alignment: .leading, spacing: 10)) : AnyLayout(HStackLayout(spacing: 10))
      layout {
        Button(label("approved", nil, scoped ? "Allow once" : "Approve", scoped ? "Allowing…" : "Approving…")) { decide("approved") }
          .buttonStyle(.accentProminent).accessibilityIdentifier("approvalAllowOnce")
        if scoped && approval.offers("session") {
          Button(label("approved", "session", "Allow for this conversation", "Allowing…")) { decide("approved", scope: "session") }
            .buttonStyle(.bordered).accessibilityIdentifier("approvalAllowSession")
        }
        HStack(spacing: 10) {
          Button(label("denied", nil, "Decline", "Declining…")) { decide("denied") }.buttonStyle(.bordered)
            .accessibilityIdentifier("approvalDecline")
          if scoped && approval.offers("always") {
            Menu {
              Button("Always allow…") { confirmingAlways = true }
            } label: {
              Image(systemName: "ellipsis").frame(width: 44, height: 44)
            }.accessibilityLabel("More choices").accessibilityIdentifier("approvalMore")
          }
        }
      }.controlSize(.large).disabled(decision != nil || !store.connected || !store.supports(.approvals))
      if scoped, !patterns.isEmpty, approval.offers("session") || approval.offers("always"), decision == nil {
        Text("Allowing for longer than once covers every command Hermes flags as \(quoted), not only this one.")
          .font(.footnote).foregroundStyle(Palette.muted)
      }
      if settled { Text(confirmation).font(.footnote).foregroundStyle(Palette.muted).accessibilityIdentifier("approvalConfirmation") }
      if !store.supports(.approvals) { Text(store.reason(.approvals)).font(.footnote).foregroundStyle(Palette.muted) }
    }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
      .background(Palette.raised(scheme), in: RoundedRectangle(cornerRadius: 14))
      .overlay(alignment: .leading) { UnevenRoundedRectangle(topLeadingRadius: 14, bottomLeadingRadius: 14).fill(Palette.attention).frame(width: 4) }
      .alert("Always allow this for \(botName)?", isPresented: $confirmingAlways) {
        Button("Cancel", role: .cancel) {}
        Button("Always allow") { decide("approved", scope: "always") }
      } message: { Text(alwaysDetail) }
  }
  private var quoted: String { patterns.map { "“\($0)”" }.joined(separator: ", ") }
  /// Names exactly what "Always allow" saves: Hermes's pattern, for this assistant, in every conversation.
  var alwaysDetail: String {
    let command = approval.command ?? approval.detail
    let reach = patterns.isEmpty
      ? "From now on, \(botName) can run this command without asking, in every conversation:"
      : "From now on, \(botName) can run any command Hermes flags as \(quoted) without asking, in every conversation. That includes commands other than this one:"
    return "\(reach)\n\n\(command)\n\nRemove it anytime in \(botName)'s settings, under Always-allowed commands."
  }
  private func label(_ value: String, _ reach: String?, _ idle: String, _ busy: String) -> String {
    guard decision == value, scope == reach else { return idle }
    if !settled { return busy }
    if value == "denied" { return "Declined" }
    return scoped ? String(confirmation.dropLast()) : "Approved"
  }
  private var confirmation: String {
    if decision == "denied" { return "Decline sent." }
    if !scoped { return "Approval sent." }
    switch scope {
    case "session": return "Allowed for this conversation."
    case "always": return "Always allowed for \(botName)."
    default: return "Allowed once."
    }
  }
  private func decide(_ value: String, scope reach: String? = nil) {
    guard decision == nil else { return }
    sendStarted()
    store.dismissError()
    decision = value
    scope = value == "approved" ? reach : nil
    let session = store.scope
    var body = ["decision": value]
    if let reach = scope { body["scope"] = reach }
    Task {
      do {
        try await store.perform(ApprovalDecision.path(botId: botId, approvalId: approval.id), body)
        guard session == store.scope else { return }
        settled = true
        if value == "denied" {
          store.declinedApprovals[botId] = approval.id
          AccessibilityNotification.Announcement("Declined. \(botName) stopped that step.").post()
          declined()
        } else {
          AccessibilityNotification.Announcement(confirmation).post()
        }
        store.buzz(.decided)
        await store.refreshConversation()
      } catch { if session == store.scope { decision = nil; scope = nil; store.buzz(.failed); store.report(error) } }
    }
  }
}

/// What a declined approval folds to, and what stays once Hermes stops listing it, until the next message.
struct DeclinedStepView: View {
  var botName: String
  @Environment(\.colorScheme) private var scheme
  var body: some View {
    Text("Declined. \(botName) stopped that step.").font(.subheadline).foregroundStyle(Palette.muted)
      .padding(.vertical, 12).padding(.horizontal, 16).frame(maxWidth: .infinity, alignment: .leading)
      .background(Palette.raised(scheme), in: RoundedRectangle(cornerRadius: 14))
      .accessibilityIdentifier("declinedStep")
  }
}

/// A turn's rows as the transcript shows them: its messages, with all intermediate work folded into
/// one `work` row where the first of it would have been.
enum TranscriptRow: Identifiable {
  case message(Int, Message)
  case work
  var id: String {
    switch self {
    case .message(_, let message): "message-" + message.id
    case .work: "work"
    }
  }
}
extension ConversationTurn {
  func transcriptRows(advanced: Bool) -> [TranscriptRow] {
    var result: [TranscriptRow] = []
    for row in rows(advanced: advanced) {
      switch row {
      case .message(let index, let message): result.append(.message(index, message))
      case .activity, .reasoning: if !result.contains(where: { $0.id == "work" }) { result.append(.work) }
      }
    }
    return result
  }
}

/// Where a message sits among consecutive reply parts. Parts read as one reply, so the time goes under
/// the last, taken from an earlier part when the last has none, as on the web.
struct ReplyRun: Equatable {
  var continued: Bool
  var endsRun: Bool
  var when: String?
}
extension ConversationTurn {
  func replyRun(at index: Int, in visible: [Message]) -> ReplyRun {
    func joins(_ earlier: Int, _ later: Int) -> Bool {
      visible.indices.contains(earlier) && visible.indices.contains(later)
        && visible[earlier].role == "assistant" && visible[later].role == "assistant" && visible[later].id != replyStart
    }
    var when = visible[index].createdAt
    var at = index
    while when == nil, joins(at - 1, at) { at -= 1; when = visible[at].createdAt }
    return ReplyRun(continued: joins(index - 1, index), endsRun: !joins(index, index + 1), when: when)
  }
}

/// What the work row says: how long the turn worked, when its messages carry times, and what it did.
struct WorkSummary: Equatable {
  struct Count: Equatable { var group: String; var count: Int }
  var counts: [Count]
  var reasoning: Bool
  var started: Date?
  var ended: Date?
  init(_ turn: ConversationTurn) {
    counts = turn.activityGroups.map { Count(group: $0.id, count: $0.messages.count) }
    reasoning = !turn.reasoning.isEmpty
    let times = turn.messages.flatMap { message in
      [message.createdAt, message.toolCall?.startedAt, message.toolCall?.completedAt].compactMap { $0.flatMap(ServerDate.parse) }
    }
    // The turn starts with the person's message when it carries a time.
    started = turn.messages.first?.createdAt.flatMap(ServerDate.parse) ?? times.min()
    ended = times.max()
  }
  /// The groups in words, such as "3 tool calls, 1 subagent".
  var detail: String {
    counts.map { "\($0.count) \(Self.noun($0.group, $0.count))" }.joined(separator: ", ")
  }
  static func noun(_ group: String, _ count: Int) -> String {
    let one = count == 1
    switch group {
    case "Subagents": return one ? "subagent" : "subagents"
    case "Bot messages": return one ? "bot message" : "bot messages"
    case "Scheduled jobs": return one ? "scheduled handoff" : "scheduled handoffs"
    case "Background processes": return one ? "background process" : "background processes"
    case "Diagnostics": return one ? "diagnostic" : "diagnostics"
    default: return one ? "tool call" : "tool calls"
    }
  }
  /// "Worked for 2m 14s · 3 tool calls, 1 subagent"; while working, the time so far.
  func label(live: Bool, now: Date = Date()) -> String {
    let end = live ? now : ended
    let seconds = started.flatMap { start in end.map { $0.timeIntervalSince(start) } }.flatMap { $0 >= 1 ? $0 : nil }
    let lead = seconds.map { "\(live ? "Working" : "Worked") for \(Self.duration($0))" } ?? (live ? "Working" : nil)
    let what = detail.isEmpty ? (reasoning && lead == nil ? "Reasoning" : nil) : detail
    return [lead, what].compactMap { $0 }.joined(separator: " · ")
  }
  static func duration(_ seconds: TimeInterval) -> String {
    let total = Int(seconds.rounded(.down))
    if total < 60 { return "\(total)s" }
    if total < 3600 { return total % 60 == 0 ? "\(total / 60)m" : "\(total / 60)m \(total % 60)s" }
    let minutes = total / 60 % 60
    return minutes == 0 ? "\(total / 3600)h" : "\(total / 3600)h \(minutes)m"
  }
}
/// The work row's label. While the turn works, its time ticks each second.
private struct WorkLabel: View {
  var summary: WorkSummary
  var live: Bool
  var connected: Bool
  var body: some View {
    if live && summary.started != nil && connected {
      TimelineView(.periodic(from: .now, by: 1)) { context in text(summary.label(live: true, now: context.date)) }
    } else {
      text(summary.label(live: live && connected))
    }
  }
  private func text(_ value: String) -> some View {
    Text(value).foregroundStyle(Palette.muted).frame(maxWidth: .infinity, alignment: .leading)
  }
}

/// The transcript's disclosures: a small chevron before the label that turns as it opens, a plain
/// label in the row's own color, and the content indented under it.
struct TranscriptDisclosureStyle: DisclosureGroupStyle {
  func makeBody(configuration: Configuration) -> some View { Disclosure(configuration: configuration) }
  private struct Disclosure: View {
    let configuration: DisclosureGroupStyleConfiguration
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.disclosureIdentifier) private var identifier
    var body: some View {
      VStack(alignment: .leading, spacing: 8) {
        Button {
          withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) { configuration.isExpanded.toggle() }
        } label: {
          HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "chevron.right").font(.caption2.weight(.bold)).foregroundStyle(.secondary)
              .rotationEffect(.degrees(configuration.isExpanded ? 90 : 0)).accessibilityHidden(true)
            configuration.label.frame(maxWidth: .infinity, alignment: .leading)
          }.padding(.vertical, 4).contentShape(Rectangle())
        }.buttonStyle(.plain)
          .accessibilityIdentifier(identifier ?? "")
          .accessibilityValue(configuration.isExpanded ? "Expanded" : "Collapsed")
          .accessibilityHint(configuration.isExpanded ? "Hides the details" : "Shows the details")
        if configuration.isExpanded {
          // A disclosure's content starts again from the system style, so nested ones are styled here.
          configuration.content.padding(.leading, 18).frame(maxWidth: .infinity, alignment: .leading)
            .environment(\.disclosureIdentifier, nil).disclosureGroupStyle(TranscriptDisclosureStyle())
        }
      }
    }
  }
}

extension Message {
  /// A person's message, as the web's `isHumanMessage` reads it: a user row whose origin is absent
  /// or explicitly `human`, never activity. Retry and prompt recall both use it.
  var isHumanMessage: Bool {
    guard role == "user", !isInternalActivity else { return false }
    let kind = presentationOrigin?.kind
    return kind == nil || kind == "human"
  }
}

/// Whether the latest turn offers Retry (contract C1): its run failed, and the person's latest
/// message has no reply text after it. Activity rows and empty assistant rows do not count as a reply.
enum RetryTurn {
  static func target(_ conversation: Conversation) -> Message? {
    guard conversation.activity.state == .failed, let index = conversation.messages.lastIndex(where: \.isHumanMessage) else { return nil }
    let replied = conversation.messages[(index + 1)...].contains {
      $0.role == "assistant" && !$0.isInternalActivity && !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
    let message = conversation.messages[index]
    // Only a saved message can be retried; a live row never counts.
    guard !replied, !message.id.hasSuffix("-inflight"), !message.text.isEmpty || !(message.files ?? []).isEmpty else { return nil }
    return message
  }
  /// The request ID for retrying one failed turn, the same on every device as the web's
  /// `src/shared/retry-id.ts` derives it: a version 8 UUID from SHA-256 over `wildbots-retry`, the
  /// assistant, the retried message and the failed run (empty without one), joined with NUL.
  static func requestId(botId: String, retryOf: String, runId: String) -> String {
    var bytes = Array(SHA256.hash(data: Data(["wildbots-retry", botId, retryOf, runId].joined(separator: "\u{0}").utf8)).prefix(16))
    bytes[6] = (bytes[6] & 0x0F) | 0x80
    bytes[8] = (bytes[8] & 0x3F) | 0x80
    let hex = bytes.map { String(format: "%02x", $0) }.joined()
    return [hex.prefix(8), hex.dropFirst(8).prefix(4), hex.dropFirst(12).prefix(4), hex.dropFirst(16).prefix(4), hex.dropFirst(20)]
      .map(String.init).joined(separator: "-")
  }
  static let refusedNotice = "Hermes didn't take the retry."
  static let checkingNotice = "Checking whether the retry arrived…"
  static let unconfirmedNotice = "Hermes hasn't confirmed the retry yet. It's being checked and won't be sent again. If it never arrives, send the message again from the message box."
}

private struct DisclosureIdentifierKey: EnvironmentKey { static let defaultValue: String? = nil }
extension EnvironmentValues {
  /// The identifier a transcript disclosure gives its toggle, and not the rows inside it.
  var disclosureIdentifier: String? {
    get { self[DisclosureIdentifierKey.self] }
    set { self[DisclosureIdentifierKey.self] = newValue }
  }
}
extension View {
  func disclosureIdentifier(_ identifier: String) -> some View { environment(\.disclosureIdentifier, identifier) }
}
