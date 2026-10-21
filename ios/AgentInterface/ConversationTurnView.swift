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
  var body: some View {
    // Only the turn holding the message on its way renders again as it goes.
    ForEach(turns) { turn in
      ConversationTurnView(turn: turn, advanced: advanced,
        delivery: turn.messages.contains { $0.id == delivery?.id } ? delivery : nil)
    }
  }
}

struct ConversationTurnView: View, Equatable {
  var turn: ConversationTurn
  var advanced: Bool
  var delivery: SentEcho.Delivery? = nil
  @Environment(\.transcriptConnected) private var connected
  @Environment(\.transcriptRecipient) private var recipient
  static func == (a: Self, b: Self) -> Bool { a.turn == b.turn && a.advanced == b.advanced && a.delivery == b.delivery }
  var body: some View {
    let visible = turn.visibleMessages
    VStack(alignment: .leading, spacing: 18) {
      ForEach(turn.rows(advanced: advanced)) { row in
        switch row {
        case .reasoning: reasoning
        case .activity(let group): activityGroup(group)
        case .message(let index, let message):
        MessageView(message: message,
          continued: message.role == "assistant" && index > 0 && visible[index - 1].role == "assistant" && message.id != turn.replyStart,
          delivery: delivery?.id == message.id ? delivery?.status : nil).id(message.id)
        }
      }
    }
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
    }.font(.subheadline).accessibilityIdentifier(group.id)
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
    }.accessibilityIdentifier("Reasoning")
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
      }.disabled(decision != nil || !store.connected || !store.supports("approvals"))
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
