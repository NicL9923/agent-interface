import PhotosUI
import SwiftUI
import UniformTypeIdentifiers
import AVFAudio

/// The message box below a conversation, the web's Composer. Files can be picked, photographed,
/// pasted or dropped onto it; with a hardware keyboard, Return sends and Shift-Return starts a line.
struct ComposerView: View {
  var bot: Bot
  @Binding var focused: Bool
  /// Called when Send is pressed, so the transcript can follow the new message.
  var onSent: () -> Void
  @EnvironmentObject private var store: AppStore
  @Environment(\.colorScheme) private var scheme
  @Environment(\.scenePhase) private var scenePhase
  @StateObject private var voice = VoiceController()
  @State private var importFiles = false
  @State private var importPhotos = false
  @State private var takePhoto = false
  @State private var photos: [PhotosPickerItem] = []
  @State private var discardConfirm = false
  @State private var modelOpen = false
  @State private var stopping = false
  @State private var dropTargeted = false

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      ComposerNotices(botId: bot.id, discardConfirm: $discardConfirm)
      card
    }.padding(12).frame(maxWidth: 850).frame(maxWidth: .infinity).background(Palette.surface(scheme))
      .overlay(alignment: .top) { Rectangle().fill(Palette.line).frame(height: 1) }
      .onDrop(of: [.item], isTargeted: $dropTargeted) { providers in
        drop(providers)
        return true
      }
      .overlay { if dropTargeted { ComposerDropOverlay(botName: bot.name, unavailable: store.attachUnavailable(bot.id)) } }
      .modifier(ComposerPickers(
        bot: bot, importFiles: $importFiles, importPhotos: $importPhotos, takePhoto: $takePhoto, photos: $photos,
        discardConfirm: $discardConfirm, modelOpen: $modelOpen))
      .onAppear { configureVoice() }
      .stopShortcut(bot: bot, canStop: stopVisible && !stopDisabled, stop: stop)
      // A recording belongs to one account's assistant; a new identity or server starts afresh.
      .onChange(of: store.voiceRecordingURL(botId: bot.id)) { _, _ in voice.cancel(); configureVoice() }
      .onChange(of: voiceDisabled) { _, disabled in
        if disabled && voice.state != .idle {
          if voice.recordingURL == store.voiceRecordingURL(botId: bot.id) { voice.preserveRecording(); voice.cancel() }
          else { voice.reset() }
        }
      }
      .onChange(of: scenePhase) { _, phase in
        // The microphone permission dialog is temporarily inactive too. Let its request finish.
        if phase == .background || phase == .inactive && voice.state == .recording { voice.preserveRecording() }
      }
      .onDisappear {
        if voice.recordingURL == store.voiceRecordingURL(botId: bot.id) { voice.preserveRecording(); voice.cancel() }
        else { voice.reset() }
      }
      .onReceive(NotificationCenter.default.publisher(for: AVAudioSession.interruptionNotification)) { event in
        if event.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt == AVAudioSession.InterruptionType.began.rawValue {
          voice.preserveRecording()
        }
      }
  }
  private var card: some View {
    VStack(alignment: .leading, spacing: 10) {
      if !store.attachNotice.isEmpty {
        AttachNoticeView(problems: store.attachNotice) { store.attachNotice = [] }
      }
      AttachmentTrayView(botId: bot.id)
      input
      tools
      VoicePanel(voice: voice, disabled: voiceDisabled)
      footnotes
    }.padding(12).background(Palette.raised(scheme), in: RoundedRectangle(cornerRadius: 20))
      .overlay(RoundedRectangle(cornerRadius: 20).stroke(Palette.line, lineWidth: 1))
  }
  private var input: some View {
    // While a message is on its way the transcript shows it, so the box reads empty and is
    // read-only until Hermes answers. It keeps focus, so the next message can start at once.
    ComposerTextView(
      text: Binding(
        get: { store.composerDraft.text },
        set: { text in store.editComposer { $0.text = text } }),
      label: "Message \(bot.name)", editable: store.draftReady, readOnly: store.sendingDraft, focused: $focused,
      onReturn: { if store.canSend { send() } },
      onPasteImages: { images in Task { await store.attach(images: images, named: "Pasted image") } }
    )
    .overlay(alignment: .topLeading) {
      if store.composerDraft.text.isEmpty {
        Text(placeholder).foregroundStyle(.tertiary).allowsHitTesting(false).accessibilityHidden(true)
      }
    }
    .padding(12).background(Palette.raised(scheme), in: RoundedRectangle(cornerRadius: 16))
    .opacity(store.draftReady ? 1 : 0.6)
  }
  private var placeholder: String {
    store.sendingDraft ? "Sending…" : store.active ? "Guide \(bot.name) while they work…" : "Message \(bot.name)…"
  }
  private var tools: some View {
    HStack(alignment: .center, spacing: 8) {
      attachMenu
      if store.bootstrap?.preferences.presentation == "advanced" { modelButton }
      VoiceButtons(voice: voice, bot: bot, reply: store.active ? nil : latestReply, disabled: voiceDisabled)
      Spacer(minLength: 0)
      sendButton
    }
  }
  private var attachMenu: some View {
    let unavailable = store.attachUnavailable(bot.id)
    return Menu {
      Button("Photo Library", systemImage: "photo.on.rectangle") { importPhotos = true }
      if UIImagePickerController.isSourceTypeAvailable(.camera) {
        Button("Take Photo", systemImage: "camera") { takePhoto = true }
      }
      Button("Choose Files", systemImage: "folder") { importFiles = true }
    } label: {
      Image(systemName: "paperclip").font(.body).frame(width: 44, height: 44)
    }.accessibilityLabel("Attach images, PDFs, or text").accessibilityIdentifier("composerAttach")
      .accessibilityHint(unavailable ?? "You can also paste or drop them here.")
      .disabled(unavailable != nil)
  }
  /// Icon only, like the web at phone width; the label still names the model.
  private var modelButton: some View {
    Button { modelOpen = true } label: {
      RobotGlyph().frame(width: 20, height: 20).frame(width: 44, height: 44)
    }.accessibilityLabel("Model: \(bot.model)").accessibilityIdentifier("composerModel")
      .disabled(!store.supports("botConfiguration") || !store.connected || store.sending)
  }
  private var sendButton: some View {
    let enabled = stopVisible ? !stopDisabled : store.canSend
    return Button {
      if stopVisible { stop() } else { send() }
    } label: {
      Group {
        if store.sending || store.pending != nil || (stopVisible && stopping) { ProgressView().tint(Palette.muted) }
        else { Image(systemName: stopVisible ? "stop.fill" : "arrow.up").font(.headline) }
      }.frame(width: 44, height: 44)
        .foregroundStyle(enabled ? Palette.raised(scheme) : Palette.muted)
        .background(enabled ? Palette.accent : Palette.line, in: Circle())
        .contentShape(Circle())
    }.buttonStyle(.plain).disabled(!enabled)
      .accessibilityLabel(stopVisible ? "Stop response" : store.active ? "Send guidance" : "Send message")
      .accessibilityIdentifier("sendMessage")
  }
  @ViewBuilder private var footnotes: some View {
    if store.uploading && !store.attachmentUploads.contains(where: { $0.botId == bot.id }) {
      ProgressView("Uploading…").font(.caption)
    } else if store.draft.text.utf16.count > AppStore.maxMessageLength {
      Text("Messages can contain up to 50,000 characters.").font(.caption).foregroundStyle(.red)
    }
    // A loading draft already shows as a dimmed message box, and a send as its spinning button.
    if let reason = store.attachUnavailable(bot.id), reason != "Your draft is still loading.", reason != AppStore.attachWhileSending {
      Text(reason).font(.caption).foregroundStyle(.secondary)
    }
    if !store.supports("chat") {
      Text(store.reason("chat")).font(.caption).foregroundStyle(.secondary)
    }
  }
  // An in-flight send keeps its spinning send button even if the draft is cleared meanwhile.
  private var stopVisible: Bool {
    store.active && !store.sending && store.draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      && store.draft.attachments.isEmpty
  }
  private var stopDisabled: Bool { stopping || !store.connected || !store.supports("stop") }
  /// The web turns voice off while the draft loads, a message is on its way, or the connection is down.
  private var voiceDisabled: Bool {
    !store.draftReady || store.pending != nil || store.sending || !store.connected
  }
  /// The newest reply in the conversation, the one the web's Listen to reply reads.
  private var latestReply: Message? {
    store.conversation?.messages.last {
      $0.role == "assistant" && !$0.isInternalActivity
        && (!$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !($0.files ?? []).isEmpty)
    }.flatMap { $0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 }
  }
  private func send() {
    // The message shows in the transcript at once, so the transcript follows it now. The box keeps
    // focus, as on the web, so the next message can start as soon as this one settles.
    onSent()
    Task { await store.send() }
  }
  private func stop() {
    guard !stopping else { return }
    stopping = true
    Task {
      defer { stopping = false }
      do {
        try await store.perform("/bots/\(APIClient.component(bot.id))/stop", [String: String]())
        await store.refreshConversation()
      } catch { store.buzz(.failed); store.report(error) }
    }
  }
  private func configureVoice() {
    voice.api = store.api
    voice.botId = bot.id
    voice.restoreRecording(from: store.voiceRecordingURL(botId: bot.id))
    let botId = bot.id
    let target = store
    voice.onTranscript = { [weak target] text in _ = target?.appendTranscript(text, botId: botId) }
  }
  private func drop(_ providers: [NSItemProvider]) {
    let scope = store.scope
    let botId = bot.id
    Task {
      let dropped = await DroppedItems.load(providers)
      defer { dropped.cleanUp() }
      guard scope == store.scope, store.selectedBotId == botId else { return }
      if !dropped.text.isEmpty, store.draftReady {
        store.editComposer { $0.text += ($0.text.isEmpty ? "" : "\n") + dropped.text.joined(separator: "\n") }
      }
      if !dropped.images.isEmpty { await store.attach(images: dropped.images, named: "Pasted image") }
      if !dropped.files.isEmpty { await store.attach(urls: dropped.files) }
    }
  }
}

/// The pickers, camera and confirmation the composer presents.
private struct ComposerPickers: ViewModifier {
  var bot: Bot
  @Binding var importFiles: Bool
  @Binding var importPhotos: Bool
  @Binding var takePhoto: Bool
  @Binding var photos: [PhotosPickerItem]
  @Binding var discardConfirm: Bool
  @Binding var modelOpen: Bool
  @EnvironmentObject private var store: AppStore
  func body(content: Content) -> some View {
    content
      .sheet(isPresented: $modelOpen) { ComposerModelSheet(botId: bot.id).appStore(store) }
      .photosPicker(isPresented: $importPhotos, selection: $photos, maxSelectionCount: UploadRules.maxAttachments, matching: .images)
      .onChange(of: photos) { _, selection in pick(selection) }
      .fullScreenCover(isPresented: $takePhoto) {
        CameraPicker(isPresented: $takePhoto) { data in attach([data], from: store.scope) }.ignoresSafeArea()
      }
      .fileImporter(isPresented: $importFiles, allowedContentTypes: UploadRules.pickerTypes, allowsMultipleSelection: true) { result in
        switch result {
        case .success(let urls): Task { await store.attach(urls: urls) }
        case .failure(let error): store.report(error)
        }
      }
      .confirmationDialog(
        "The message may still arrive. Its text goes back into the draft, so sending it again could deliver it twice.",
        isPresented: $discardConfirm, titleVisibility: .visible
      ) {
        Button("Discard and keep my text in the draft", role: .destructive) {
          store.discardUnconfirmedSubmission()
        }
      }
  }
  private func pick(_ selection: [PhotosPickerItem]) {
    guard !selection.isEmpty else { return }
    let scope = store.scope
    Task {
      var images: [Data] = []
      for item in selection {
        if let data = try? await item.loadTransferable(type: Data.self) { images.append(data) }
      }
      photos = []
      attach(images, from: scope)
    }
  }
  /// New photos are named like the web's pasted images, for example "Photo 14.03.22.jpg".
  private func attach(_ images: [Data], from scope: String?) {
    let botId = bot.id
    Task {
      guard scope == store.scope, store.selectedBotId == botId else { return }
      await store.attach(images: images, named: "Photo")
    }
  }
}

/// The unconfirmed send, rejection and interruption notices above the message box.
private struct ComposerNotices: View {
  var botId: String
  @Binding var discardConfirm: Bool
  @EnvironmentObject private var store: AppStore
  @Environment(\.colorScheme) private var scheme
  var body: some View {
    if store.activity == .interrupted {
      Toggle("I reviewed the interrupted task and its last actions before continuing.", isOn: $store.interruptionReviewed)
        .toggleStyle(CheckboxStyle()).font(.footnote)
    }
    // A normal send only spins the send button. This appears once the request ended without a receipt.
    if store.pending != nil, !store.sending {
      VStack(alignment: .leading, spacing: 8) {
        Text("Checking whether your last message arrived…").font(.footnote)
        Button("Retry this saved message") { Task { await store.send(reviewedUncertain: true) } }
          .font(.footnote).disabled(store.sending || !store.supports("idempotency") || !store.connected)
        // A send that never resolves would otherwise block this assistant on this device.
        Button("Discard and keep my text in the draft", role: .destructive) {
          discardConfirm = true
        }.font(.caption).accessibilityIdentifier("discardUnconfirmedSend")
      }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
        .background(Palette.raised(scheme), in: RoundedRectangle(cornerRadius: 10))
        .accessibilityElement(children: .contain)
    }
    if let receipt = store.receipt, receipt.status == "rejected" {
      Text(receipt.message?.isEmpty == false ? receipt.message! : "Hermes did not accept this message. Your draft is saved.")
        .font(.footnote).foregroundStyle(Palette.attention)
    }
    if store.receipt?.status == "interrupted" {
      Text("This submission was interrupted. Review its last actions before trying again.")
        .font(.footnote).foregroundStyle(Palette.attention)
    }
  }
}

/// Every file from the last attempt that could not be attached, in one dismissible notice.
private struct AttachNoticeView: View {
  var problems: [String]
  var dismiss: () -> Void
  var body: some View {
    HStack(alignment: .top, spacing: 8) {
      Image(systemName: "exclamationmark.circle").accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 4) {
        ForEach(problems, id: \.self) { Text($0) }
      }.frame(maxWidth: .infinity, alignment: .leading)
      Button(action: dismiss) { Image(systemName: "xmark").frame(width: 32, height: 32) }
        .accessibilityLabel("Dismiss")
    }.font(.footnote).foregroundStyle(Palette.danger).padding(10)
      .background(Palette.danger.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
      .accessibilityElement(children: .contain).accessibilityIdentifier("attachNotice")
  }
}

/// Covers the composer while files are dragged over it, so it is obvious where to drop them.
private struct ComposerDropOverlay: View {
  var botName: String
  var unavailable: String?
  @Environment(\.colorScheme) private var scheme
  var body: some View {
    VStack(spacing: 6) {
      Image(systemName: unavailable == nil ? "paperclip" : "exclamationmark.circle").font(.title2)
      Text(unavailable == nil ? "Drop to attach for \(botName)" : "Attachments are unavailable").font(.headline)
      Text(unavailable ?? "Images, PDFs, or text · up to \(UploadRules.formatBytes(UploadRules.maxBytes)) each")
        .font(.footnote).foregroundStyle(.secondary)
    }.multilineTextAlignment(.center).padding().frame(maxWidth: .infinity, maxHeight: .infinity)
      .background(Palette.surface(scheme).opacity(0.94))
      .overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(unavailable == nil ? Palette.accent : Palette.danger, style: StrokeStyle(lineWidth: 2, dash: [6])))
      .accessibilityHidden(true)
  }
}

/// What a drop carried: files to attach, images that exist only in memory, and dragged text.
struct DroppedItems {
  var files: [URL] = []
  var images: [Data] = []
  var text: [String] = []
  func cleanUp() { for url in files { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) } }

  static func load(_ providers: [NSItemProvider]) async -> DroppedItems {
    var result = DroppedItems()
    for provider in providers {
      // A text selection has no file name; it goes into the message, as in a browser.
      if provider.suggestedName == nil, provider.canLoadObject(ofClass: String.self),
        !provider.hasItemConformingToTypeIdentifier(UTType.image.identifier)
      {
        if let text = await loadText(provider) { result.text.append(text) }
        continue
      }
      guard let type = provider.registeredTypeIdentifiers.compactMap({ UTType($0) }).first(where: { $0.conforms(to: .data) })
      else { continue }
      // Photos arrive as HEIC and are converted, like a pasted image.
      if type.conforms(to: .image), ![UTType.png, .jpeg, .webP, .gif].contains(type) {
        if let data = await loadData(provider, type) { result.images.append(data) }
      } else if let url = await loadFile(provider, type) {
        result.files.append(url)
      }
    }
    return result
  }
  private static func loadText(_ provider: NSItemProvider) async -> String? {
    await withCheckedContinuation { continuation in
      _ = provider.loadObject(ofClass: String.self) { value, _ in continuation.resume(returning: value) }
    }
  }
  private static func loadData(_ provider: NSItemProvider, _ type: UTType) async -> Data? {
    await withCheckedContinuation { continuation in
      _ = provider.loadDataRepresentation(forTypeIdentifier: type.identifier) { data, _ in continuation.resume(returning: data) }
    }
  }
  /// The provided file lasts only for the callback, so it is copied, under the name it was dragged with.
  private static func loadFile(_ provider: NSItemProvider, _ type: UTType) async -> URL? {
    let suggested = provider.suggestedName
    return await withCheckedContinuation { continuation in
      _ = provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, _ in
        guard let url else { return continuation.resume(returning: nil) }
        var name = suggested ?? url.deletingPathExtension().lastPathComponent
        let ext = type.preferredFilenameExtension ?? url.pathExtension
        if URL(fileURLWithPath: name).pathExtension.isEmpty, !ext.isEmpty { name += "." + ext }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("drop-" + UUID().uuidString, isDirectory: true)
        let copy = directory.appendingPathComponent(name)
        do {
          try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
          try FileManager.default.copyItem(at: url, to: copy)
          continuation.resume(returning: copy)
        } catch {
          continuation.resume(returning: nil)
        }
      }
    }
  }
}

/// The system camera, for Take Photo.
struct CameraPicker: UIViewControllerRepresentable {
  @Binding var isPresented: Bool
  var onCapture: (Data) -> Void
  func makeUIViewController(context: Context) -> UIImagePickerController {
    let picker = UIImagePickerController()
    picker.sourceType = .camera
    picker.delegate = context.coordinator
    return picker
  }
  func updateUIViewController(_ picker: UIImagePickerController, context: Context) {}
  func makeCoordinator() -> Coordinator { Coordinator(self) }
  final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
    let parent: CameraPicker
    init(_ parent: CameraPicker) { self.parent = parent }
    func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
      if let image = info[.originalImage] as? UIImage, let data = image.jpegData(compressionQuality: 0.9) {
        parent.onCapture(data)
      }
      parent.isPresented = false
    }
    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { parent.isPresented = false }
  }
}
