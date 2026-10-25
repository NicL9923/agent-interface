import SwiftUI

/// Whether Hermes is reachable, for rows that show "Last seen running".
private struct TranscriptConnectedKey: EnvironmentKey { static let defaultValue = true }
/// The open assistant's name, for agent exchanges. An environment value, so a roster change that
/// keeps the name renders no message again.
private struct TranscriptRecipientKey: EnvironmentKey { static let defaultValue = "Assistant" }
private struct FoundMessageKey: EnvironmentKey { static let defaultValue: String? = nil }
extension EnvironmentValues {
  var foundMessage: String? {
    get { self[FoundMessageKey.self] }
    set { self[FoundMessageKey.self] = newValue }
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
  var body: some View {
    // Only the turn holding the message on its way renders again as it goes.
    ForEach(turns) { turn in
      ConversationTurnView(turn: turn, advanced: advanced,
        delivery: turn.messages.contains { $0.id == delivery?.id } ? delivery : nil, live: turn.id == liveTurn)
    }.disclosureGroupStyle(TranscriptDisclosureStyle())
  }
}

struct ConversationTurnView: View, Equatable {
  var turn: ConversationTurn
  var advanced: Bool
  var delivery: SentEcho.Delivery? = nil
  var live = false
  @Environment(\.transcriptConnected) private var connected
  @Environment(\.transcriptRecipient) private var recipient
  nonisolated static func == (a: Self, b: Self) -> Bool {
    a.turn == b.turn && a.advanced == b.advanced && a.delivery == b.delivery && a.live == b.live
  }
  var body: some View {
    let visible = turn.visibleMessages
    VStack(alignment: .leading, spacing: 18) {
      ForEach(turn.transcriptRows(advanced: advanced)) { row in
        switch row {
        case .work: work
        case .message(let index, let message):
        MessageView(message: message,
          continued: message.role == "assistant" && index > 0 && visible[index - 1].role == "assistant" && message.id != turn.replyStart,
          delivery: delivery?.id == message.id ? delivery?.status : nil).id(message.id)
        }
      }
    }
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
        Text("\(group.messages.count)").font(.caption).foregroundStyle(.secondary)
        if group.messages.contains(where: { $0.toolCall?.status == "running" }) {
          Text(connected ? "Running" : "Last seen running").font(.caption).foregroundStyle(.secondary)
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
          .font(.system(.footnote, design: .monospaced))
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
          Text(part).font(.footnote).foregroundStyle(.secondary).textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
      }.padding(.top, 4)
    } label: {
      HStack(spacing: 8) {
        Text("Reasoning")
        if parts.count > 1 { Text("\(parts.count)").font(.caption).foregroundStyle(.secondary) }
      }
    }.disclosureIdentifier("Reasoning")
  }
}

struct ApprovalDecisionView: View {
  var approval: Approval
  var botId: String
  @Environment(AppStore.self) private var store
  @Environment(\.colorScheme) private var scheme
  @State private var decision: String?
  @State private var settled = false
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Your decision needed").font(.caption.weight(.semibold)).foregroundStyle(Palette.attention)
      Text(approval.title).font(.headline)
      Text(approval.detail).textSelection(.enabled)
      if let expiry = approval.expiresAt, !When.format(expiry).isEmpty { Text("Expires \(When.format(expiry, inline: true))").font(.caption).foregroundStyle(.secondary) }
      HStack {
        Button(decision == "approved" ? settled ? "Approved" : "Approving…" : "Approve") { decide("approved") }.buttonStyle(.borderedProminent)
        Button(decision == "denied" ? settled ? "Declined" : "Declining…" : "Decline") { decide("denied") }.buttonStyle(.bordered)
      }.disabled(decision != nil || !store.connected || !store.supports(.approvals))
    }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
      .background(Palette.raised(scheme), in: RoundedRectangle(cornerRadius: 14))
      .overlay(alignment: .leading) { UnevenRoundedRectangle(topLeadingRadius: 14, bottomLeadingRadius: 14).fill(Palette.attention).frame(width: 4) }
  }
  private func decide(_ value: String) {
    guard decision == nil else { return }
    decision = value
    let scope = store.scope
    Task {
      do {
        try await store.perform(ApprovalDecision.path(botId: botId, approvalId: approval.id), ["decision": value])
        guard scope == store.scope else { return }
        settled = true
        store.buzz(.decided)
        await store.refreshConversation()
      } catch { if scope == store.scope { decision = nil; store.buzz(.failed); store.report(error) } }
    }
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
    Text(value).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading)
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

/// Whether the latest turn offers Retry (contract C1): its run failed, and the person's latest
/// message has no reply text after it. Activity rows and empty assistant rows do not count as a reply.
enum RetryTurn {
  static func target(_ conversation: Conversation) -> Message? {
    guard conversation.activity.state == .failed,
      let index = conversation.messages.lastIndex(where: { $0.role == "user" && $0.presentationOrigin == nil })
    else { return nil }
    let replied = conversation.messages[(index + 1)...].contains {
      $0.role == "assistant" && !$0.isInternalActivity && !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
    let message = conversation.messages[index]
    guard !replied, !message.text.isEmpty || !(message.files ?? []).isEmpty else { return nil }
    return message
  }
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
