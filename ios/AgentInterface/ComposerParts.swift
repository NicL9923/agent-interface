import ImageIO
import SwiftUI
import UniformTypeIdentifiers

/// The message text view. A UIKit text view, because SwiftUI's text field can neither take a
/// pasted image nor tell a hardware Return from the on-screen keyboard's.
struct ComposerTextView: UIViewRepresentable {
  @Binding var text: String
  var label: String
  var editable: Bool
  @Binding var focused: Bool
  /// Return on a hardware keyboard. Shift-Return and the on-screen Return start a new line.
  var onReturn: () -> Void
  var onPasteImages: ([Data]) -> Void

  func makeUIView(context: Context) -> ComposerUITextView {
    let view = ComposerUITextView()
    view.delegate = context.coordinator
    view.font = .preferredFont(forTextStyle: .body)
    view.adjustsFontForContentSizeCategory = true
    view.backgroundColor = .clear
    view.textContainerInset = .zero
    view.textContainer.lineFragmentPadding = 0
    view.accessibilityIdentifier = "messageComposer"
    view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    return view
  }
  func updateUIView(_ view: ComposerUITextView, context: Context) {
    context.coordinator.parent = self
    // Replacing the text mid-composition would drop the characters being composed.
    if view.text != text && view.markedTextRange == nil { view.text = text }
    view.isEditable = editable
    view.accessibilityLabel = label
    view.onReturn = onReturn
    view.onPasteImages = onPasteImages
    // Only a change asked for here moves focus. An update still carrying the value from before
    // a tap must not take the keyboard away again.
    guard focused != context.coordinator.focused else { return }
    context.coordinator.focused = focused
    if focused && editable && !view.isFirstResponder {
      DispatchQueue.main.async { view.becomeFirstResponder() }
    } else if !focused && view.isFirstResponder {
      DispatchQueue.main.async { view.resignFirstResponder() }
    }
  }
  /// Two to six lines, like the web's growing text area; longer drafts scroll.
  func sizeThatFits(_ proposal: ProposedViewSize, uiView: ComposerUITextView, context: Context) -> CGSize? {
    guard let width = proposal.width, width > 0 else { return nil }
    let line = uiView.font?.lineHeight ?? 22
    let fitted = uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
    return CGSize(width: width, height: min(max(fitted, line * 2), line * 6).rounded(.up))
  }
  func makeCoordinator() -> Coordinator { Coordinator(self) }
  final class Coordinator: NSObject, UITextViewDelegate {
    var parent: ComposerTextView
    /// The focus last applied or reported.
    var focused = false
    init(_ parent: ComposerTextView) { self.parent = parent }
    func textViewDidChange(_ view: UITextView) { parent.text = view.text }
    func textViewDidBeginEditing(_ view: UITextView) {
      focused = true
      if !parent.focused { parent.focused = true }
    }
    func textViewDidEndEditing(_ view: UITextView) {
      focused = false
      if parent.focused { parent.focused = false }
    }
  }
}

final class ComposerUITextView: UITextView {
  var onReturn: (() -> Void)?
  var onPasteImages: (([Data]) -> Void)?
  /// Presses come only from hardware keyboards, so the on-screen Return still starts a line.
  override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
    guard presses.count == 1, let key = presses.first?.key,
      Self.sends(key.keyCode, key.modifierFlags, composing: markedTextRange != nil)
    else { return super.pressesBegan(presses, with: event) }
    onReturn?()
  }
  override func pressesEnded(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
    // The release of a Return that sent, so the text view never sees half a press.
    if presses.count == 1, let key = presses.first?.key, Self.sends(key.keyCode, key.modifierFlags, composing: markedTextRange != nil) { return }
    super.pressesEnded(presses, with: event)
  }
  /// Return sends, as Enter does on the web. Shift-Return starts a line, and Return while text is
  /// still being composed, such as Japanese input, confirms it.
  static func sends(_ key: UIKeyboardHIDUsage, _ modifiers: UIKeyModifierFlags, composing: Bool) -> Bool {
    (key == .keyboardReturnOrEnter || key == .keypadEnter) && !composing
      && modifiers.intersection([.shift, .alternate, .command, .control]).isEmpty
  }
  override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
    if action == #selector(paste(_:)), Self.pastedImagesOnly { return isEditable }
    return super.canPerformAction(action, withSender: sender)
  }
  override func paste(_ sender: Any?) {
    guard Self.pastedImagesOnly else { return super.paste(sender) }
    let images = UIPasteboard.general.items.compactMap(Self.imageData)
    if !images.isEmpty { onPasteImages?(images) }
  }
  /// Copied spreadsheet cells also carry a picture of them; that stays a text paste, as on the web.
  private static var pastedImagesOnly: Bool {
    UIPasteboard.general.hasImages && !UIPasteboard.general.hasStrings && !UIPasteboard.general.hasURLs
  }
  private static func imageData(_ item: [String: Any]) -> Data? {
    for type in [UTType.png, .jpeg, .gif, .webP, .heic, .tiff] {
      if let data = item[type.identifier] as? Data { return data }
      if let image = item[type.identifier] as? UIImage { return image.pngData() }
    }
    return item.values.lazy.compactMap { ($0 as? UIImage)?.pngData() }.first
  }
}

/// Uploaded attachments first, then files still on their way, in the order they were added.
struct AttachmentTrayView: View {
  var botId: String
  @EnvironmentObject private var store: AppStore
  var body: some View {
    let uploads = store.attachmentUploads.filter { $0.botId == botId }
    let files = store.selectedBotId == botId ? store.draft.attachments : []
    if !uploads.isEmpty || !files.isEmpty {
      VStack(alignment: .leading, spacing: 6) {
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 8) {
            ForEach(files) { DraftAttachmentChip(file: $0) }
            ForEach(uploads) { UploadChip(upload: $0) }
          }
        }.accessibilityLabel("Attachments")
        ForEach(uploads.filter { $0.status == .failed }) { item in
          Label {
            Text("\(Text(item.name).bold()) didn't upload. \(item.error ?? "") Retry or remove it to send.")
          } icon: { Image(systemName: "exclamationmark.circle") }
            .font(.caption).foregroundStyle(Palette.danger)
        }
      }
    }
  }
}

/// The web's chip caption for an uploaded file: its kind and size.
private func attachmentMeta(name: String, mime: String, size: Int?) -> String {
  [UploadRules.kindLabel(name: name, mime: mime), size.map(UploadRules.formatBytes)].compactMap { $0 }.joined(separator: " · ")
}

private struct DraftAttachmentChip: View {
  var file: FileRef
  @EnvironmentObject private var store: AppStore
  @Environment(\.colorScheme) private var scheme
  var body: some View {
    HStack(spacing: 8) {
      Button { store.open(file) } label: {
        if file.mime.hasPrefix("image/") {
          AuthenticatedImage(path: "/api/files/\(APIClient.component(file.id))").scaledToFill()
            .frame(width: 40, height: 40).clipped().clipShape(RoundedRectangle(cornerRadius: 6))
        } else {
          AttachmentBadge(name: file.name, mime: file.mime)
        }
      }.accessibilityLabel("Preview \(file.name)")
      VStack(alignment: .leading, spacing: 2) {
        Text(file.name).lineLimit(1)
        Text(attachmentMeta(name: file.name, mime: file.mime, size: file.size)).font(.caption2).foregroundStyle(.secondary)
      }.frame(maxWidth: 160, alignment: .leading)
      Button {
        var next = store.draft
        next.attachments.removeAll { $0.id == file.id }
        store.updateDraft(next)
      } label: {
        Image(systemName: "xmark.circle.fill").frame(width: 32, height: 32)
      }.accessibilityLabel("Remove \(file.name)")
    }.font(.caption).padding(6).background(Palette.user(scheme), in: RoundedRectangle(cornerRadius: 12))
  }
}

private struct UploadChip: View {
  var upload: AttachmentUpload
  @EnvironmentObject private var store: AppStore
  @Environment(\.colorScheme) private var scheme
  var body: some View {
    let failed = upload.status == .failed
    HStack(spacing: 8) {
      thumbnail.frame(width: 40, height: 40)
      VStack(alignment: .leading, spacing: 2) {
        Text(upload.name).lineLimit(1)
        Text(upload.caption).font(.caption2).foregroundStyle(failed ? Palette.danger : .secondary)
      }.frame(maxWidth: 160, alignment: .leading)
      if failed {
        Button { Task { await store.retryUpload(upload.id) } } label: {
          Label("Retry", systemImage: "arrow.clockwise")
        }.accessibilityLabel("Retry uploading \(upload.name)")
      }
      Button { store.removeUpload(upload.id) } label: {
        Image(systemName: "xmark.circle.fill").frame(width: 32, height: 32)
      }.accessibilityLabel(failed ? "Remove \(upload.name)" : "Cancel uploading \(upload.name)")
    }.font(.caption).padding(6).background(Palette.user(scheme), in: RoundedRectangle(cornerRadius: 12))
      .accessibilityElement(children: .contain)
  }
  private var thumbnail: some View {
    ZStack {
      if upload.mime.hasPrefix("image/") {
        LocalThumbnail(url: upload.url).frame(width: 40, height: 40).clipShape(RoundedRectangle(cornerRadius: 6))
      } else {
        AttachmentBadge(name: upload.name, mime: upload.mime)
      }
      switch upload.status {
      case .failed:
        Image(systemName: "exclamationmark.circle.fill").foregroundStyle(Palette.danger)
      case .processing:
        ProgressView().controlSize(.small)
      case .queued, .uploading:
        UploadRing(progress: upload.progress)
      }
    }.accessibilityHidden(true)
  }
}

/// The web's progress ring, never quite empty so a starting upload still shows.
private struct UploadRing: View {
  var progress: Double
  var body: some View {
    ZStack {
      Circle().stroke(Palette.line, lineWidth: 3)
      Circle().trim(from: 0, to: max(progress, 0.02)).stroke(Palette.accent, style: StrokeStyle(lineWidth: 3, lineCap: .round))
        .rotationEffect(.degrees(-90))
    }.frame(width: 26, height: 26).background(Circle().fill(.background.opacity(0.7)))
  }
}

private struct AttachmentBadge: View {
  var name: String
  var mime: String
  var body: some View {
    VStack(spacing: 1) {
      Image(systemName: "doc").font(.body)
      Text(UploadRules.kindLabel(name: name, mime: mime)).font(.system(size: 9, weight: .semibold))
    }.frame(width: 40, height: 40).foregroundStyle(Palette.muted)
  }
}

/// A small picture of an image still on this device, decoded once.
private struct LocalThumbnail: View {
  var url: URL
  @State private var image: UIImage?
  var body: some View {
    Group {
      if let image { Image(uiImage: image).resizable().scaledToFill() } else { Color.secondary.opacity(0.15) }
    }.task(id: url) {
      let url = url
      image = await Task.detached {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
          let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, [
            kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: 160,
            kCGImageSourceCreateThumbnailWithTransform: true,
          ] as CFDictionary)
        else { return nil }
        return UIImage(cgImage: thumbnail)
      }.value
    }
  }
}
