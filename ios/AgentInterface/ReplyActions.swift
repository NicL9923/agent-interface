import SwiftUI

/// Whole-answer actions also appear as named VoiceOver actions.
struct ReplyActions: ViewModifier {
  var message: Message
  @Environment(AppStore.self) private var store: AppStore?
  @Environment(\.transcriptConnected) private var connected
  @State private var saving = false
  @State private var saved = false
  private var eligible: Bool {
    message.role == "assistant" && !message.isInternalActivity && !message.isToolActivity
      && !message.id.hasSuffix("-inflight") && !message.text.isEmpty
  }
  func body(content: Content) -> some View {
    if eligible {
      content.contextMenu {
        Button("Copy answer", systemImage: "doc.on.doc", action: copy)
        Button("Quote in reply", systemImage: "text.quote", action: quote)
        ShareLink(item: message.text) { Label("Share answer", systemImage: "square.and.arrow.up") }
        Button(saved ? "Reply saved" : saving ? "Saving…" : "Save reply", systemImage: "bookmark", action: save)
          .disabled(saving || saved || !connected)
      }
      .accessibilityAction(named: "Copy answer", copy)
      .accessibilityAction(named: "Quote in reply", quote)
      .accessibilityAction(named: "Save reply", save)
    } else { content }
  }
  private func copy() {
    UIPasteboard.general.string = message.text
    AccessibilityNotification.Announcement("Answer copied.").post()
  }
  private func quote() {
    guard let store, let botId = store.selectedBotId else { return }
    switch store.quoteInReply(message.text, botId: botId) {
    case .added: AccessibilityNotification.Announcement("Quote added to your draft.").post()
    case .waiting: store.notice = ReplyQuote.waitingNotice; AccessibilityNotification.Announcement(ReplyQuote.waitingNotice).post()
    case .refused: break
    }
  }
  private func save() {
    guard connected && store?.connected == true else {
      AccessibilityNotification.Announcement("Reconnect to save this reply.").post()
      return
    }
    guard !saving, !saved, let store, let botId = store.selectedBotId,
      let session = store.conversation?.sessionId, let api = store.api, store.connected else { return }
    let scope = store.scope
    saving = true
    Task {
      defer { saving = false }
      do {
        let _: SavedItem = try await api.write("/saved", SavedPointer(botId: botId, kind: "session", sessionId: session,
          messageId: message.id, title: DiscoveryView.replyTitle(message.text)))
        guard store.scope == scope else { return }
        saved = true
        store.notice = "Saved. Find it in Search > Saved items."
        AccessibilityNotification.Announcement("Reply saved.").post()
      } catch { if store.scope == scope { store.report(error) } }
    }
  }
}

/// A reply quoted into the draft as a Markdown block quote, with a blank line below for the answer.
enum ReplyQuote {
  enum Outcome { case added, waiting, refused }
  static let waitingNotice = "The quote joins your draft once your message is sent."
  static func block(_ text: String) -> String {
    let lines = text.trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: .newlines)
    return lines.map { $0.isEmpty ? ">" : "> " + $0 }.joined(separator: "\n") + "\n\n"
  }
}
extension AppStore {
  /// Quotes a reply into this assistant's draft through the path Share and Siri text take: it joins
  /// the draft at once when the draft can take it, and otherwise waits, as while a send to this
  /// assistant is unsettled, because a draft and its send are told apart by content.
  @discardableResult func quoteInReply(_ text: String, botId: String) -> ReplyQuote.Outcome {
    guard let scope, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return .refused }
    let waits = holdsAdditions(botId) || selectedBotId != botId || !draftReady
    guard hold(DraftAddition(source: .share, botId: botId, text: ReplyQuote.block(text), scope: scope)) else { return .refused }
    return waits ? .waiting : .added
  }
}
