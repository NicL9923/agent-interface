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
        ShareLink(item: message.text) { Label("Share answer", systemImage: "square.and.arrow.up") }
        Button(saved ? "Reply saved" : saving ? "Saving…" : "Save reply", systemImage: "bookmark", action: save)
          .disabled(saving || saved || !connected)
      }
      .accessibilityAction(named: "Copy answer", copy)
      .accessibilityAction(named: "Save reply", save)
    } else { content }
  }
  private func copy() {
    UIPasteboard.general.string = message.text
    AccessibilityNotification.Announcement("Answer copied.").post()
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
