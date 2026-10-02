import UIKit
import UniformTypeIdentifiers

final class ShareViewController: UIViewController {
  private let status = UILabel()
  private let picker = UIButton(type:.system)
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
    let save = UIButton(type: .system); save.setTitle("Save draft", for: .normal); save.addTarget(self, action: #selector(saveDraft), for: .touchUpInside)
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
        if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
          let item = try await load(provider,UTType.url.identifier)
          if let url = item as? URL, !url.isFileURL { text += (text.isEmpty ? "" : "\n") + url.absoluteString; continue }
        }
        let fileType = [UTType.pdf, UTType.image, UTType.plainText].first { provider.hasItemConformingToTypeIdentifier($0.identifier) }
        guard let fileType else { throw CocoaError(.fileReadUnsupportedScheme) }
        let item = try await load(provider,fileType.identifier)
        if let string = item as? String { text += (text.isEmpty ? "" : "\n") + string; continue }
        var data: Data
        var ext: String
        if let url = item as? URL {
          let scoped = url.startAccessingSecurityScopedResource(); defer { if scoped { url.stopAccessingSecurityScopedResource() } }
          guard (try url.resourceValues(forKeys:[.fileSizeKey])).fileSize ?? 0 <= 20 * 1024 * 1024 else { throw CocoaError(.fileReadTooLarge) }
          data = try Data(contentsOf:url); ext = url.pathExtension.isEmpty ? fileType.preferredFilenameExtension ?? "bin" : url.pathExtension
        } else if let image = item as? UIImage, let png = image.pngData() { data = png; ext = "png" }
        else if let bytes = item as? Data { data = bytes; ext = fileType.preferredFilenameExtension ?? "bin" }
        else { throw CocoaError(.fileReadUnknown) }
        guard data.count <= 20 * 1024 * 1024 else { throw CocoaError(.fileReadTooLarge) }
        if fileType.conforms(to:.image) { let prepared=try ShareImage.prepare(data);data=prepared.data;ext=prepared.ext }
        let name = "shared-\(files.count + 1).\(ext)"
        try data.write(to:directory.appendingPathComponent(name),options:.atomic); files.append(name)
      }
      guard text.count <= 50000 else { throw CocoaError(.fileReadTooLarge) }
      loading = false
      status.text = "\(files.count) attachment(s) ready. Save, then open Agent Interface to review your draft. Nothing is sent automatically."
    } catch { status.text = context == nil ? "Open Agent Interface and sign in before sharing." : "Could not prepare this share. Use a webpage, photo, PDF, or text, up to 10 items and 20 MB per file." }
  }
  private func load(_ provider: NSItemProvider, _ type: String) async throws -> NSSecureCoding {
    try await withCheckedThrowingContinuation { continuation in provider.loadItem(forTypeIdentifier:type, options:nil) { item,error in
      if let error { continuation.resume(throwing:error) } else if let item { continuation.resume(returning:item) } else { continuation.resume(throwing:CocoaError(.fileReadUnknown)) }
    } }
  }
  @objc private func saveDraft() {
    guard !loading, let context, ShareInbox.context()?.scope == context.scope, let root = ShareInbox.root else { return }
    let capture = SharedCapture(id:captureId,scope:context.scope,botId:selectedBotId,text:text,files:files,createdAt:Date())
    do { try JSONEncoder().encode(capture).write(to:root.appendingPathComponent(captureId + ".json"),options:.atomic);extensionContext?.completeRequest(returningItems:nil) }
    catch { status.text = "Could not save this draft. Try again." }
  }
  @objc private func cancelShare() {
    if let root = ShareInbox.root { try? FileManager.default.removeItem(at:root.appendingPathComponent(captureId)) }
    extensionContext?.cancelRequest(withError:CocoaError(.userCancelled))
  }
}
