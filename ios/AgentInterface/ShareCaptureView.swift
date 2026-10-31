import SwiftUI
import UniformTypeIdentifiers

struct ShareCaptureView: View {
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State var capture: SharedCapture
  @State private var botId = ""
  @State private var busy = false
  @State private var error: String?
  /// Add was pressed while a message to this assistant was still unsettled; it continues then.
  @State private var waitingForSend = false
  @State private var confirmDiscard = false
  @State private var savedText = ""
  @State private var savedBotId = ""
  @State private var needsCaptureSave = false
  @State private var notice: String?
  @Environment(\.colorScheme) private var scheme
  private var held: Bool { !botId.isEmpty && store.holdsAdditions(botId) }
  var body: some View {
    NavigationStack {
      Form {
        Section("Shared draft") {
          Picker("Assistant",selection:$botId) { Text("Choose an assistant").tag("");ForEach(store.bootstrap?.bots ?? []) { bot in Text(bot.name).tag(bot.id) } }.disabled(needsCaptureSave)
          TextEditor(text:$capture.text).frame(minHeight:120).accessibilityLabel("Shared text").disabled(busy || waitingForSend || needsCaptureSave)
          ForEach(capture.files,id:\.self) { Text($0) }
          Text("Add this to the assistant’s editable draft. Existing draft text and attachments are kept. Review before sending.").font(.footnote).foregroundStyle(.secondary)
        }
        if let error { ErrorBanner(message:error) }
        if let notice { Text(notice).font(.footnote).foregroundStyle(.secondary) }
        if waitingForSend { Text("Your last message to this assistant is still on its way. This is added to the draft once it settles.").font(.footnote).foregroundStyle(.secondary) }
        Section {
        Button("Add to draft") { Task { await importDraft() } }.disabled(botId.isEmpty || busy || waitingForSend || !store.connected || !store.supports(.uploads) && !capture.files.isEmpty)
        if !store.connected { Text("Connect to add this. It stays saved here.").font(.footnote).foregroundStyle(.secondary) }
        else if !store.supports(.uploads) && !capture.files.isEmpty { Text("This assistant can't receive files.").font(.footnote).foregroundStyle(.secondary) }
        }
        Section { Button("Discard shared draft",role:.destructive) { confirmDiscard = true }.disabled(busy) }
        if busy { ProgressView("Adding to draft…") }
      }.scrollContentBackground(.hidden).background(Palette.surface(scheme))
      .navigationTitle("Review shared content").toolbar { ToolbarItem(placement:.cancellationAction) { Button("Later") { saveForLater() }.disabled(busy) } }
    }.interactiveDismissDisabled(busy || needsCaptureSave || capture.text != savedText || botId != savedBotId)
    .alert("Discard this shared draft?", isPresented: $confirmDiscard) {
      Button("Discard shared draft", role: .destructive) { ShareInbox.remove(capture); dismiss() }
      Button("Keep draft", role: .cancel) { }
    } message: { Text("The text and files you shared are deleted from this device.") }
    .onAppear {
      savedText = capture.text
      botId = store.bootstrap?.bots.contains(where:{$0.id==capture.botId}) == true ? capture.botId! : ""
      savedBotId = botId
      // The app stopped after taking this text but before saving the emptied share: finish that save,
      // or, with no files left to add, remove the share. Its text is in the draft or waiting for it.
      if store.sharedTextAdded(capture) {
        capture.text = ""
        if capture.files.isEmpty { ShareInbox.remove(capture); Task { dismiss() }; return }
        needsCaptureSave = true; notice = "Its text was already added to the draft."
        do { try persist() } catch { self.error = "Could not update this shared draft. Keep this screen open and try again." }
      }
      #if DEBUG
      confirmDiscard = DebugFixtures.captureSurvival == "share-discard"
      #endif
    }
      .onChange(of: held) { _, held in if !held && waitingForSend { waitingForSend = false; Task { await importDraft() } } }
      .onChange(of: botId) { _, _ in waitingForSend = false }
  }
  private func persist() throws {
    guard store.scope == capture.scope else { throw APIError(message: "Sign in to the account that saved this draft.", status: 409) }
    try ShareInbox.save(capture)
    savedText = capture.text
    savedBotId = botId
    needsCaptureSave = false
  }
  private func saveForLater() {
    capture.botId = botId.isEmpty ? nil : botId
    do { try persist(); dismiss() }
    catch { self.error = capture.text.count > 50_000 ? "Shared text can contain up to 50,000 characters. Shorten it before saving." : "Could not save your edits. Keep this screen open and try Later again." }
  }
  private func importDraft() async {
    guard capture.text.count <= 50_000 else { error="Shared text can contain up to 50,000 characters. Shorten it before adding.";return }
    guard let api=store.api,let scope=store.scope,scope==capture.scope,ShareInbox.valid(capture),store.bootstrap?.bots.contains(where:{$0.id==botId})==true else { error="Sign in to the account that saved this draft.";return }
    busy=true;defer { busy=false }
    if needsCaptureSave {
      do { try persist() } catch { self.error="Could not save the imported text update. Keep this screen open and try again."; return }
    }
    await store.select(botId)
    guard scope==store.scope,store.selectedBotId==botId,store.draftReady else { error="Reconnect before importing this draft.";return }
    guard store.draft.attachments.count + capture.files.count <= 10,store.draft.text.utf16.count + capture.text.utf16.count + 2 <= AppStore.maxMessageLength else { error="The combined draft is too large. Keep up to 10 attachments and 50,000 characters.";return }
    do {
      if !capture.text.isEmpty {
        // Held with Siri's and notification text: it joins once a send on its way settles.
        capture.botId = botId
        needsCaptureSave = true
        let accepted = try ShareInbox.transferText(&capture, hold: { store.holdShared($0, botId: botId) }, save: { value in
          guard store.scope == value.scope else { throw APIError(message: "Sign in to the account that saved this draft.", status: 409) }
          try ShareInbox.save(value)
        })
        if !accepted { needsCaptureSave = false; error="Sign in to the account that saved this draft.";return }
        savedText = capture.text; savedBotId = botId; needsCaptureSave = false
      }
      // Files upload here, and wait in the inbox while a message is still on its way.
      while let name=capture.files.first {
        guard scope==store.scope,store.selectedBotId==botId else { throw APIError(message:"Return to this assistant to finish importing.",status:409) }
        if store.holdsAdditions(botId) { waitingForSend = true; return }
        guard let url=ShareInbox.fileURLs(capture).first,(try url.resourceValues(forKeys:[.fileSizeKey])).fileSize ?? 0 <= 20 * 1024 * 1024 else { throw CocoaError(.fileReadTooLarge) }
        let data=try Data(contentsOf:url)
        // The same rules as the composer: any text format goes as plain text.
        let mime=try UploadRules.prepare(name:name,mime:UploadRules.mime(of:url,contentType:nil),size:data.count).mapError { APIError(message:$0.message,status:400) }.get()
        let file=try await api.upload(botId:botId,name:name,mime:mime,data:data)
        guard scope==store.scope,store.selectedBotId==botId else { throw APIError(message:"The selected account or assistant changed. Review this draft again.",status:409) }
        // A send that began during the upload holds the file; it uploads again once that settles.
        guard store.addShared(file:file,botId:botId) else { waitingForSend = store.holdsAdditions(botId);return }
        capture.files.removeFirst();try persist()
      }
      ShareInbox.remove(capture);dismiss()
    } catch { self.error = needsCaptureSave ? "Could not save the imported text update. Keep this screen open and try again." : error.localizedDescription }
  }
}
