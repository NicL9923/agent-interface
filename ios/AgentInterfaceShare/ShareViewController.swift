import UIKit
import UniformTypeIdentifiers

final class ShareViewController: UIViewController {
  private let status = UILabel()
  private let picker = UIButton(type:.system)
  private let save = UIButton(type:.system)
  private var selectedBotId: String?
  private var context: ShareContext?
  private var text = ""
  private var files: [String] = []
  private let captureId = UUID().uuidString.lowercased()
  private var loading = true
  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemBackground
    status.numberOfLines = 0
    status.text = "Preparing a draft…"
    let title = UILabel(); title.text = "Share with an assistant"; title.font = .preferredFont(forTextStyle: .title2)
    save.isEnabled = false
    save.setTitle("Save draft", for: .normal); save.addTarget(self, action: #selector(saveDraft), for: .touchUpInside)
    let cancel = UIButton(type: .system); cancel.setTitle("Cancel", for: .normal); cancel.addTarget(self, action: #selector(cancelShare), for: .touchUpInside)
    let stack = UIStackView(arrangedSubviews: [title, status, picker, save, cancel]); stack.axis = .vertical; stack.spacing = 20; stack.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(stack)
    NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo:view.safeAreaLayoutGuide.leadingAnchor,constant:24), stack.trailingAnchor.constraint(equalTo:view.safeAreaLayoutGuide.trailingAnchor,constant:-24),stack.topAnchor.constraint(equalTo:view.safeAreaLayoutGuide.topAnchor,constant:24)])
    context = ShareInbox.context()
    picker.setTitle("Choose an assistant",for:.normal)
    picker.showsMenuAsPrimaryAction = true
    picker.menu = UIMenu(children:(context?.bots ?? []).map { bot in UIAction(title:bot.name) { [weak self] _ in self?.selectedBotId=bot.id;self?.picker.setTitle(bot.name,for:.normal) } })
    Task { await prepare() }
  }
  private func prepare() async {
    do {
      guard context != nil, let root = ShareInbox.root else { throw CocoaError(.fileNoSuchFile) }
      let directory = root.appendingPathComponent(captureId,isDirectory:true)
      try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true)
      let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? []).flatMap { $0.attachments ?? [] }
      guard !providers.isEmpty, providers.count <= 10 else { throw CocoaError(.fileReadTooLarge) }
      for provider in providers {
        if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
          case .url(let url) = try await load(provider,UTType.url.identifier), !url.isFileURL {
          text += (text.isEmpty ? "" : "\n") + url.absoluteString; continue
        }
        let fileType = [UTType.pdf, UTType.image, UTType.plainText].first { provider.hasItemConformingToTypeIdentifier($0.identifier) }
        guard let fileType else { throw CocoaError(.fileReadUnsupportedScheme) }
        var data: Data
        var ext: String
        switch try await load(provider,fileType.identifier) {
        case .text(let string): text += (text.isEmpty ? "" : "\n") + string; continue
        case .url(let url):
          let scoped = url.startAccessingSecurityScopedResource(); defer { if scoped { url.stopAccessingSecurityScopedResource() } }
          guard (try url.resourceValues(forKeys:[.fileSizeKey])).fileSize ?? 0 <= 20 * 1024 * 1024 else { throw CocoaError(.fileReadTooLarge) }
          data = try Data(contentsOf:url); ext = url.pathExtension.isEmpty ? fileType.preferredFilenameExtension ?? "bin" : url.pathExtension
        case .png(let png): data = png; ext = "png"
        case .data(let bytes): data = bytes; ext = fileType.preferredFilenameExtension ?? "bin"
        }
        guard data.count <= 20 * 1024 * 1024 else { throw CocoaError(.fileReadTooLarge) }
        if fileType.conforms(to:.image) { let prepared=try ShareImage.prepare(data);data=prepared.data;ext=prepared.ext }
        let name = "shared-\(files.count + 1).\(ext)"
        try data.write(to:directory.appendingPathComponent(name),options:.atomic); files.append(name)
      }
      guard text.count <= 50000 else { throw CocoaError(.fileReadTooLarge) }
      loading = false
      save.isEnabled = true
      let ready = files.isEmpty ? "Ready to save." : "\(files.count) \(files.count == 1 ? "attachment" : "attachments") ready."
      status.text = "\(ready) Save, then open WildBots to review your draft. Nothing is sent automatically."
    } catch {
      if let root = ShareInbox.root { try? FileManager.default.removeItem(at: root.appendingPathComponent(captureId, isDirectory: true)) }
      save.isEnabled = false
      status.text = context == nil ? "Open WildBots and sign in before sharing." : "Could not prepare this share. Use a webpage, photo, PDF, or text, up to 10 items and 20 MB per file." }
  }
  /// A shared item as plain values, read where the provider delivers it: the item itself cannot cross to the main actor.
  private enum Loaded: Sendable { case url(URL), text(String), png(Data), data(Data) }
  private func load(_ provider: NSItemProvider, _ type: String) async throws -> Loaded {
    try await withCheckedThrowingContinuation { continuation in provider.loadItem(forTypeIdentifier:type, options:nil) { item,error in
      if let error { continuation.resume(throwing:error); return }
      switch item {
      case let url as URL: continuation.resume(returning:.url(url))
      case let string as String: continuation.resume(returning:.text(string))
      case let image as UIImage:
        if let png = image.pngData() { continuation.resume(returning:.png(png)) } else { continuation.resume(throwing:CocoaError(.fileReadUnknown)) }
      case let bytes as Data: continuation.resume(returning:.data(bytes))
      default: continuation.resume(throwing:CocoaError(.fileReadUnknown))
      }
    } }
  }
  @objc private func saveDraft() {
    guard !loading, let context, ShareInbox.context()?.scope == context.scope, let root = ShareInbox.root else {
      status.text = "Open WildBots and sign in again before saving this share."
      save.isEnabled = false
      return
    }
    let capture = SharedCapture(id:captureId,scope:context.scope,botId:selectedBotId,text:text,files:files,createdAt:Date())
    do { try JSONEncoder().encode(capture).write(to:root.appendingPathComponent(captureId + ".json"),options:.atomic);extensionContext?.completeRequest(returningItems:nil) }
    catch { status.text = "Could not save this draft. Try again." }
  }
  @objc private func cancelShare() {
    if let root = ShareInbox.root { try? FileManager.default.removeItem(at:root.appendingPathComponent(captureId)) }
    extensionContext?.cancelRequest(withError:CocoaError(.userCancelled))
  }
}
