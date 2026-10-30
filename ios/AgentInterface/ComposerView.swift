import Combine
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
  @Environment(AppStore.self) private var store
  @Environment(\.colorScheme) private var scheme
  @Environment(\.scenePhase) private var scenePhase
  @Environment(\.verticalSizeClass) private var verticalSizeClass
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize
  @ScaledMetric(relativeTo: .headline) private var sendGlyphSize = 18.0
  @State private var voice = VoiceController()
  @State private var importFiles = false
  @State private var importPhotos = false
  @State private var takePhoto = false
  @State private var photos: [PhotosPickerItem] = []
  @State private var discardConfirm = false
  @State private var modelOpen = false
  @State private var stopping = false
  @State private var dropTargeted = false
  @State private var recall = PromptRecall()
  /// A short line after a long paste became an attachment.
  @State private var pasteNotice: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      StatusDock(botId: bot.id, discardConfirm: $discardConfirm)
      card.fixedSize(horizontal: false, vertical: true)
    }.padding(.horizontal, 12).padding(.top, 6).padding(.bottom, 8)
      .frame(maxWidth: 752).frame(maxWidth: .infinity).background(Palette.surface(scheme))
      .onDrop(of: [.item], isTargeted: $dropTargeted) { providers in
        drop(providers)
        return true
      }
      .overlay { if dropTargeted { ComposerDropOverlay(botName: bot.name, unavailable: store.attachUnavailable(bot.id)) } }
      .modifier(ComposerPickers(
        bot: bot, importFiles: $importFiles, importPhotos: $importPhotos, takePhoto: $takePhoto, photos: $photos,
        discardConfirm: $discardConfirm, modelOpen: $modelOpen))
      .onAppear { configureVoice() }
      #if DEBUG
      .onChange(of: store.draftReady, initial: true) { _, ready in
        guard ready else { return }
        if ["composer-focused", "composer-ax-focused"].contains(DebugFixtures.captureSurvival ?? "") { focused = true }
        if ["composer-multiline", "composer-ax-focused"].contains(DebugFixtures.captureSurvival ?? "") {
          store.editComposer { $0.text = "Check the north gate.\nReview the battery history.\nCompare the other sensors.\nKeep the existing reminders.\nTell me what needs attention." }
        }
      }
      #endif
      .onChange(of: store.listenRequest, initial: true) { startRequestedRecording() }
      .onChange(of: voiceDisabled) { startRequestedRecording() }
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
      // Audio session notifications can arrive on any thread; the voice controller lives on the main actor.
      .onReceive(NotificationCenter.default.publisher(for: AVAudioSession.interruptionNotification).receive(on: DispatchQueue.main)) { event in
        if event.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt == AVAudioSession.InterruptionType.began.rawValue {
          voice.preserveRecording()
        }
      }
  }
  private var inputLineHeight: CGFloat {
    let _ = dynamicTypeSize
    return max(44, UIFont.preferredFont(forTextStyle: .body).lineHeight + 22)
  }
  private var card: some View {
    VStack(alignment: .leading, spacing: 6) {
      if !store.uploads.notice.isEmpty {
        AttachNoticeView(problems: store.uploads.notice) { store.uploads.notice = [] }
      }
      AttachmentTrayView(botId: bot.id)
      ComposerRowLayout(singleLine: inputLineHeight,
        forceStack: dynamicTypeSize.isAccessibilitySize || store.composerDraft.text.contains("\n")) {
        HStack(spacing: 4) {
          attachMenu
          if store.bootstrap?.preferences.presentation == "advanced" { modelButton }
        }
        input
        HStack(spacing: 4) {
          VoiceButtons(voice: voice, bot: bot, reply: store.active || !store.composerDraft.text.isEmpty ? nil : store.latestReply, disabled: voiceDisabled)
          if focused { hideKeyboardButton }
          sendButton
        }
      }
      VoicePanel(voice: voice, disabled: voiceDisabled, bot: bot)
      footnotes
    }.padding(4).background(Palette.raised(scheme), in: RoundedRectangle(cornerRadius: 26, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: 26, style: .continuous).stroke(Palette.line, lineWidth: 1))
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
      onPasteImages: { images in Task { await store.uploads.attach(images: images, named: "Pasted image") } },
      onArrow: recallArrow, onPasteLongText: attachLongPaste, maximumLines: verticalSizeClass == .compact || dynamicTypeSize.isAccessibilitySize ? 3 : 6
    )
    .overlay(alignment: .topLeading) {
      if store.composerDraft.text.isEmpty {
        Text(placeholder).lineLimit(1).foregroundStyle(Palette.muted).allowsHitTesting(false).accessibilityHidden(true)
      }
    }
    .padding(.vertical, 11).padding(.horizontal, 6).frame(minHeight: 44)
    .opacity(store.draftReady ? 1 : 0.6)
  }
  private var placeholder: String {
    store.sendingDraft ? "Sending…" : store.active ? "Guide…" : "Message…"
  }
  /// Always there while typing, so the keyboard can be put away without finding a spot to drag.
  private var hideKeyboardButton: some View {
    Button { focused = false } label: {
      Image(systemName: "keyboard.chevron.compact.down").font(.system(size: 20)).frame(width: 44, height: 44)
    }.foregroundStyle(Palette.muted).accessibilityLabel("Hide keyboard").accessibilityIdentifier("hideKeyboard")
      .transition(.opacity)
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
      Image(systemName: "paperclip").font(.system(size: 20)).frame(width: 44, height: 44)
    }.accessibilityLabel("Attach images, PDFs, or text").accessibilityIdentifier("composerAttach")
      .accessibilityHint(unavailable ?? "You can also paste or drop them here.")
      .disabled(unavailable != nil)
  }
  /// Icon only, like the web at phone width; the label still names the model.
  private var modelButton: some View {
    Button { modelOpen = true } label: {
      RobotGlyph().frame(width: 20, height: 20).frame(width: 44, height: 44)
    }.accessibilityLabel("Model: \(bot.model)").accessibilityIdentifier("composerModel")
      .disabled(!store.supports(.botConfiguration) || !store.connected || store.sending)
  }
  private var sendButton: some View {
    let enabled = stopVisible ? !stopDisabled : store.canSend
    return Button {
      if stopVisible { stop() } else { send() }
    } label: {
      Group {
        if store.sending || store.pending != nil || (stopVisible && stopping) { ProgressView().tint(Palette.muted) }
        else { Image(systemName: stopVisible ? "stop.fill" : "arrow.up").font(.system(size: min(sendGlyphSize, 24), weight: .semibold)) }
      }.frame(width: 44, height: 44)
        .foregroundStyle(enabled ? Palette.raised(scheme) : Palette.muted)
        .background(enabled ? Palette.accent : Palette.line, in: Circle())
        .contentShape(Circle())
    }.buttonStyle(.plain).disabled(!enabled)
      .accessibilityLabel(stopVisible ? "Stop response" : store.active ? "Send guidance" : "Send message")
      .accessibilityIdentifier("sendMessage")
  }
  @ViewBuilder private var footnotes: some View {
    if let pasteNotice {
      Label(pasteNotice, systemImage: "doc.text").font(.caption).foregroundStyle(Palette.muted).accessibilityIdentifier("pasteNotice")
    }
    if store.uploads.uploading && !store.uploads.items.contains(where: { $0.botId == bot.id }) {
      ProgressView("Uploading…").font(.caption)
    } else if store.draft.text.utf16.count > AppStore.maxMessageLength {
      Text("Messages can contain up to 50,000 characters.").font(.caption).foregroundStyle(.red)
    }
    // A loading draft already shows as a dimmed message box, and a send as its spinning button.
    if let reason = store.attachUnavailable(bot.id), reason != "Your draft is still loading.", reason != AppStore.attachWhileSending {
      Text(reason).font(.caption).foregroundStyle(Palette.muted)
    }
    if !store.supports(.chat) {
      Text(store.reason(.chat)).font(.caption).foregroundStyle(Palette.muted)
    }
  }
  // An in-flight send keeps its spinning send button even if the draft is cleared meanwhile.
  private var stopVisible: Bool {
    store.active && !store.sending && store.draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      && store.draft.attachments.isEmpty
  }
  private var stopDisabled: Bool { stopping || !store.connected || !store.supports(.stop) }
  /// The web turns voice off while the draft loads, a message is on its way, or the connection is down.
  private var voiceDisabled: Bool {
    !store.draftReady || store.pending != nil || store.sending || !store.connected
  }
  /// The Talk to assistant control opened this chat to record. A kept recording waits for review
  /// instead, and a request that cannot start soon lapses.
  private func startRequestedRecording() {
    guard let request = store.listenRequest, request.botId == bot.id else { return }
    guard request.fresh(), request.scope == store.scope, voice.recording == nil, voice.state == .idle else { store.listenRequest = nil; return }
    guard !voiceDisabled else { return }
    store.listenRequest = nil
    Task { await voice.startRecording() }
  }
  /// Steps through earlier messages from an empty composer. Never while a message is on its way:
  /// until it settles, the draft is told apart from its send only by its text.
  private func recallArrow(_ up: Bool) -> Bool {
    guard store.draftReady, !store.sending, !store.sendingDraft, store.selectedBotId == bot.id else { recall.reset(); return false }
    let userId = store.bootstrap?.user.id
    let text = store.composerDraft.text
    // The conversation is read only when recall starts, so streamed replies never render the composer.
    guard let next = recall.arrow(up: up, text: text, messages: { PromptRecall.ownMessages(store.conversation?.messages ?? [], userId: userId) })
    else { return false }
    if next != text { store.editComposer { $0.text = next } }
    return true
  }
  /// A paste of 32 KiB or more goes through the upload queue as a text file, like any other file.
  private func attachLongPaste(_ text: String) {
    let botId = bot.id
    Task {
      guard store.selectedBotId == botId else { return }
      do {
        let url = try LargePaste.file(text)
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        await store.uploads.attach(urls: [url])
        guard store.uploads.notice.isEmpty else { return }
        pasteNotice = LargePaste.notice
        AccessibilityNotification.Announcement(LargePaste.notice).post()
      } catch { store.report(error) }
    }
  }
  private func send() {
    recall.reset()
    pasteNotice = nil
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
      if !dropped.images.isEmpty { await store.uploads.attach(images: dropped.images, named: "Pasted image") }
      if !dropped.files.isEmpty { await store.uploads.attach(urls: dropped.files) }
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
  @Environment(AppStore.self) private var store
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
        case .success(let urls): Task { await store.uploads.attach(urls: urls) }
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
      await store.uploads.attach(images: images, named: "Photo")
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

  /// On the main actor, where the drop delivered its providers; only their loaded values leave the callbacks.
  @MainActor static func load(_ providers: [NSItemProvider]) async -> DroppedItems {
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
  @MainActor private static func loadText(_ provider: NSItemProvider) async -> String? {
    await withCheckedContinuation { continuation in
      _ = provider.loadObject(ofClass: String.self) { value, _ in continuation.resume(returning: value) }
    }
  }
  @MainActor private static func loadData(_ provider: NSItemProvider, _ type: UTType) async -> Data? {
    await withCheckedContinuation { continuation in
      _ = provider.loadDataRepresentation(forTypeIdentifier: type.identifier) { data, _ in continuation.resume(returning: data) }
    }
  }
  /// The provided file lasts only for the callback, so it is copied, under the name it was dragged with.
  @MainActor private static func loadFile(_ provider: NSItemProvider, _ type: UTType) async -> URL? {
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

/// Keeps the same text-view identity while arranging its fixed controls beside or below it.
private struct ComposerRowLayout: Layout {
  var singleLine: CGFloat
  var forceStack: Bool
  private struct Sizes {
    var width: CGFloat
    var lead: CGSize
    var input: CGSize
    var trail: CGSize
    var stacked: Bool
    var height: CGFloat { stacked ? input.height + max(lead.height, trail.height) + 4 : max(input.height, lead.height, trail.height) }
  }
  private func sizes(_ proposal: ProposedViewSize, _ subviews: Subviews) -> Sizes {
    let width = max(0, proposal.width ?? 320)
    let lead = subviews[0].sizeThatFits(.unspecified)
    let trail = subviews[2].sizeThatFits(.unspecified)
    let slot = max(0, width - lead.width - trail.width - 8)
    let inline = subviews[1].sizeThatFits(ProposedViewSize(width: slot, height: nil))
    let stacked = forceStack || slot < 120 || inline.height > singleLine + 1
    let input = stacked ? subviews[1].sizeThatFits(ProposedViewSize(width: width, height: nil)) : inline
    return Sizes(width: width, lead: lead, input: input, trail: trail, stacked: stacked)
  }
  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let value = sizes(proposal, subviews)
    return CGSize(width: value.width, height: value.height)
  }
  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    let value = sizes(ProposedViewSize(width: bounds.width, height: nil), subviews)
    let controlsY = bounds.maxY - max(value.lead.height, value.trail.height) / 2
    subviews[0].place(at: CGPoint(x: bounds.minX, y: controlsY), anchor: .leading, proposal: ProposedViewSize(value.lead))
    subviews[2].place(at: CGPoint(x: bounds.maxX, y: controlsY), anchor: .trailing, proposal: ProposedViewSize(value.trail))
    if value.stacked {
      subviews[1].place(at: bounds.origin, proposal: ProposedViewSize(width: bounds.width, height: value.input.height))
    } else {
      subviews[1].place(at: CGPoint(x: bounds.minX + value.lead.width + 4, y: bounds.midY), anchor: .leading,
        proposal: ProposedViewSize(width: max(0, bounds.width - value.lead.width - value.trail.width - 8), height: value.input.height))
    }
  }
}
