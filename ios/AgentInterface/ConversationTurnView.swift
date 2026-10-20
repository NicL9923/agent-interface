import SwiftUI

/// The store as transcript rows read it: without observing it, so a keystroke or poll elsewhere
/// does not render every message again. The web memoizes its turns for the same reason.
private struct UnobservedStoreKey: EnvironmentKey { static let defaultValue: AppStore? = nil }
/// Whether Hermes is reachable, for rows that show "Last seen running".
private struct TranscriptConnectedKey: EnvironmentKey { static let defaultValue = true }
extension EnvironmentValues {
  var unobservedStore: AppStore? {
    get { self[UnobservedStoreKey.self] }
    set { self[UnobservedStoreKey.self] = newValue }
  }
  var transcriptConnected: Bool {
    get { self[TranscriptConnectedKey.self] }
    set { self[TranscriptConnectedKey.self] = newValue }
  }
}
extension View {
  /// Provides the store to screens, which observe it, and to transcript rows, which do not.
  func appStore(_ store: AppStore) -> some View {
    environmentObject(store).environment(\.unobservedStore, store)
  }
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

private enum TurnRow: Identifiable {
  case message(Int, Message)
  case activity(CoordinationGroup)
  var id: String {
    switch self {
    case .message(_, let message): return "message-" + message.id
    case .activity(let group): return "activity-" + group.id
    }
  }
}
struct ConversationTurnView: View, Equatable {
  var turn: ConversationTurn
  var advanced: Bool
  var delivery: SentEcho.Delivery? = nil
  @Environment(\.transcriptConnected) private var connected
  @Environment(\.unobservedStore) private var store
  static func == (a: Self, b: Self) -> Bool { a.turn == b.turn && a.advanced == b.advanced && a.delivery == b.delivery }
  var body: some View {
    let visible = turn.visibleMessages
    // Keep activity in one identity scope when it moves above the completed reply.
    let rows: [TurnRow] = visible.enumerated().flatMap { index, message in
      (message.id == turn.replyStart ? turn.activityGroups.map(TurnRow.activity) : []) + [.message(index, message)]
    } + (turn.replyStart == nil ? turn.activityGroups.map(TurnRow.activity) : [])
    VStack(alignment: .leading, spacing: 18) {
      ForEach(rows) { row in
        switch row {
        case .activity(let group): activityGroup(group)
        case .message(let index, let message):
        if advanced && !turn.reasoning.isEmpty && message.role != "user" && visible.prefix(index).allSatisfy({ $0.role == "user" }) {
          reasoning
        }
        MessageView(message: message,
          continued: message.role == "assistant" && index > 0 && visible[index - 1].role == "assistant" && message.id != turn.replyStart,
          delivery: delivery?.id == message.id ? delivery?.status : nil).id(message.id)
        }
      }
      if advanced && !turn.reasoning.isEmpty && visible.allSatisfy({ $0.role == "user" }) { reasoning }
    }
  }
  private var recipient: String { store?.bot?.name ?? "Assistant" }
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
  @EnvironmentObject private var store: AppStore
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
        try await store.perform("/bots/\(APIClient.component(botId))/approvals/\(APIClient.component(approval.id))", ["decision": value])
        guard scope == store.scope else { return }
        settled = true
        await store.refreshConversation()
      } catch { if scope == store.scope { decision = nil; store.report(error) } }
    }
  }
}
