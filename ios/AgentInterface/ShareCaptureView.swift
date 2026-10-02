import SwiftUI
import UniformTypeIdentifiers

struct ShareCaptureView: View {
  @EnvironmentObject private var store: AppStore
  @Environment(\.dismiss) private var dismiss
  @State var capture: SharedCapture
  @State private var botId = ""
  @State private var busy = false
  @State private var error: String?
  var body: some View {
    NavigationStack {
      Form {
        Section("Shared draft") {
          Picker("Assistant",selection:$botId) { Text("Choose an assistant").tag("");ForEach(store.bootstrap?.bots ?? []) { bot in Text(bot.name).tag(bot.id) } }
          TextEditor(text:$capture.text).frame(minHeight:120)
          ForEach(capture.files,id:\.self) { Text($0) }
          Text("Add this to the assistant’s editable draft. Existing draft text and attachments are kept. Review before sending.").font(.footnote).foregroundStyle(.secondary)
        }
        if let error { ErrorBanner(message:error) }
        Button("Add to draft") { Task { await importDraft() } }.disabled(botId.isEmpty || busy || !store.connected || !store.supports("uploads") && !capture.files.isEmpty)
        Button("Discard shared draft",role:.destructive) { ShareInbox.remove(capture);dismiss() }.disabled(busy)
        if busy { ProgressView("Adding to draft…") }
      }.navigationTitle("Review shared content").toolbar { ToolbarItem(placement:.cancellationAction) { Button("Later") { dismiss() }.disabled(busy) } }
    }.onAppear { botId = store.bootstrap?.bots.contains(where:{$0.id==capture.botId}) == true ? capture.botId! : "" }
  }
  private func persist() throws { guard let root=ShareInbox.root else { throw CocoaError(.fileNoSuchFile) };try JSONEncoder().encode(capture).write(to:root.appendingPathComponent(capture.id + ".json"),options:.atomic) }
  private func importDraft() async {
    guard let api=store.api,let scope=store.scope,scope==capture.scope,ShareInbox.valid(capture),store.bootstrap?.bots.contains(where:{$0.id==botId})==true else { error="Sign in to the account that saved this draft.";return }
    busy=true;defer { busy=false }
    await store.select(botId)
    guard scope==store.scope,store.selectedBotId==botId,store.draftReady else { error="Reconnect before importing this draft.";return }
    guard store.draft.attachments.count + capture.files.count <= 10,store.draft.text.count + capture.text.count + 2 <= 50000 else { error="The combined draft is too large. Keep up to 10 attachments and 50,000 characters.";return }
    do {
      if !capture.text.isEmpty { var next=store.draft;next.text += (next.text.isEmpty ? "" : "\n\n") + capture.text;store.updateDraft(next);capture.text="";try persist() }
      while let name=capture.files.first {
        guard scope==store.scope,store.selectedBotId==botId else { throw APIError(message:"Return to this assistant to finish importing.",status:409) }
        guard let url=ShareInbox.fileURLs(capture).first,(try url.resourceValues(forKeys:[.fileSizeKey])).fileSize ?? 0 <= 20 * 1024 * 1024 else { throw CocoaError(.fileReadTooLarge) }
        let mime = UTType(filenameExtension:url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        let file=try await api.upload(botId:botId,name:name,mime:mime,data:Data(contentsOf:url))
        guard scope==store.scope,store.selectedBotId==botId else { throw APIError(message:"The selected account or assistant changed. Review this draft again.",status:409) }
        var next=store.draft;next.attachments.append(file);store.updateDraft(next)
        capture.files.removeFirst();try persist()
      }
      ShareInbox.remove(capture);dismiss()
    } catch { self.error=error.localizedDescription }
  }
}
