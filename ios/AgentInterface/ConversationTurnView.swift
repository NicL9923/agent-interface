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
  var body: some View {
    ForEach(turns) { ConversationTurnView(turn: $0, advanced: advanced) }
  }
}

struct ConversationTurnView: View, Equatable {
  var turn: ConversationTurn
  var advanced: Bool
  @Environment(\.transcriptConnected) private var connected
  static func == (a: Self, b: Self) -> Bool { a.turn == b.turn && a.advanced == b.advanced }
  var body: some View {
    let visible = turn.visibleMessages
    VStack(alignment: .leading, spacing: 18) {
      ForEach(Array(visible.enumerated()), id: \.element.id) { index, message in
        if advanced && !turn.reasoning.isEmpty && message.role != "user" && visible.prefix(index).allSatisfy({ $0.role == "user" }) {
          reasoning
        }
        MessageView(message: message, advanced: advanced,
          continued: message.role == "assistant" && index > 0 && visible[index - 1].role == "assistant", groupedReasoning: true, groupedActivity: true).id(message.id)
      }
      if advanced && !turn.reasoning.isEmpty && visible.allSatisfy({ $0.role == "user" }) { reasoning }
      ForEach(turn.activityGroups) { group in
        DisclosureGroup {
          ForEach(group.messages) { message in
            if let call = message.toolCall {
              if message.isAgentExchange { MessageView(message: message, advanced: advanced, groupedReasoning: true) }
              else if advanced { ToolActivityView(message: message) }
              else { ActionReceiptView(call: call) }
            } else {
              DisclosureGroup((message.presentationOrigin?.title ?? message.activityGroup) + (message.createdAt.map { When.format($0, inline: true) }.flatMap { $0.isEmpty ? nil : " · \($0)" } ?? "")) {
                Text(message.text.isEmpty ? "No result was exposed by Hermes." : message.text).font(.footnote).textSelection(.enabled)
              }
            }
            if !message.isAgentExchange { ForEach(message.files ?? []) { FileAttachmentView(file: $0) } }
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
    }
  }
  private var reasoning: some View {
    DisclosureGroup("Reasoning") {
      ForEach(Array(turn.reasoning.enumerated()), id: \.offset) { _, part in
        MarkdownView(text: part).font(.footnote).foregroundStyle(.secondary)
      }
    }
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
      MarkdownView(text: approval.detail)
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
