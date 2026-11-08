import ImageIO
import SwiftUI
import UniformTypeIdentifiers

/// Files on their way into a draft: staged on this device, uploaded one at a time in the order
/// they were added, then handed to the store, which owns the draft they join.
@MainActor @Observable
final class AttachmentUploads {
  @ObservationIgnored weak var store: AppStore?
  var items: [AttachmentUpload] = []
  /// Files from the last attempt to attach that could not be added, each with its reason.
  var notice: [String] = []
  /// An upload is in flight, from this queue or an Apple snapshot.
  var uploading = false
  @ObservationIgnored private var tasks: [UUID: Task<Void, Never>] = [:]

  /// Adds files to the open assistant's draft as the web composer does: every file that can't be
  /// attached is named in one notice, with its size and the limit, and the rest upload in order.
  func attach(urls: [URL], problems earlier: [String] = []) async {
    guard let store, !urls.isEmpty || !earlier.isEmpty, let id = store.selectedBotId else { return }
    if let reason = store.attachUnavailable(id) { notice = [reason]; return }
    let slots = store.attachmentSlots(id)
    var problems = earlier
    var accepted = 0
    var staged = false
    for url in urls {
      let accessed = url.startAccessingSecurityScopedResource()
      defer { if accessed { url.stopAccessingSecurityScopedResource() } }
      let name = url.lastPathComponent
      do {
        let resource = try url.resourceValues(forKeys: [.fileSizeKey, .contentTypeKey])
        let size = resource.fileSize ?? 0
        let mime: String
        switch UploadRules.prepare(name: name, mime: UploadRules.mime(of: url, contentType: resource.contentType), size: size) {
        case .failure(let problem): problems.append(problem.message); continue
        case .success(let value): mime = value
        }
        accepted += 1
        guard accepted <= slots else { continue }
        // The picked file may be gone once the picker closes, so upload a private copy.
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("upload-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let copy = directory.appendingPathComponent(name)
        do { try FileManager.default.copyItem(at: url, to: copy) }
        catch { try? FileManager.default.removeItem(at: directory); throw error }
        items.append(AttachmentUpload(botId: id, url: copy, name: name, mime: mime, size: size))
        staged = true
      } catch {
        problems.append("\(name) can't be attached. \(error.localizedDescription)")
      }
    }
    if accepted > slots {
      let left = accepted - slots
      problems.append("A message can carry up to \(UploadRules.maxAttachments) attachments, so \(left) of these \(left == 1 ? "wasn't" : "weren't") added.")
    }
    notice = problems
    if staged { await drain() }
  }
  /// Attaches images that exist only in memory: a paste, a new photo or a library pick. Each gets
  /// a readable name, such as "Pasted image 14.03.22.png", and formats the server cannot take,
  /// such as HEIC, are converted.
  func attach(images: [Data], named prefix: String) async {
    guard !images.isEmpty else { return }
    let now = Date()
    var urls: [URL] = []
    var problems: [String] = []
    for (index, data) in images.enumerated() {
      do {
        let image = try Self.uploadableImage(data)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("image-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent(UploadRules.imageName(prefix, at: now, index: index, ext: image.ext))
        try image.data.write(to: url, options: .atomic)
        urls.append(url)
      } catch {
        let name = UploadRules.imageName(prefix, at: now, index: index, ext: "png")
        problems.append(data.count > UploadRules.maxBytes
          ? "\(name) is \(UploadRules.formatBytes(data.count)). Each attachment can be up to \(UploadRules.formatBytes(UploadRules.maxBytes))."
          : "\(name) can't be attached. Use \(UploadRules.kinds).")
      }
    }
    await attach(urls: urls, problems: problems)
    for url in urls { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
  }
  /// GIFs keep their animation; other images go through the share extension's conversion.
  private static func uploadableImage(_ data: Data) throws -> (data: Data, ext: String) {
    if let source = CGImageSourceCreateWithData(data as CFData, nil),
      let type = CGImageSourceGetType(source).flatMap({ UTType($0 as String) }), type == .gif,
      data.count <= UploadRules.maxBytes
    { return (data, "gif") }
    return try ShareImage.prepare(data)
  }
  /// Cancels a file still uploading, or removes one that failed.
  func remove(_ id: UUID) {
    tasks.removeValue(forKey: id)?.cancel()
    forget(id)
  }
  /// Drops a file's entry and private copy without touching its upload, which may be the caller.
  private func forget(_ id: UUID) {
    guard let upload = items.first(where: { $0.id == id }) else { return }
    try? FileManager.default.removeItem(at: upload.url.deletingLastPathComponent())
    items.removeAll { $0.id == id }
  }
  /// Another account or a sign-out: nothing of the old one keeps uploading.
  func reset() {
    uploading = false
    for id in items.map(\.id) { remove(id) }
  }
  func retry(_ uploadId: UUID) async {
    guard let index = items.firstIndex(where: { $0.id == uploadId }), items[index].status == .failed else { return }
    items[index].status = .queued
    items[index].progress = 0
    items[index].error = nil
    await drain()
  }
  /// Uploads queued files one at a time, in the order they were added. A failed attempt always
  /// waits for explicit Retry; a file queued while disconnected starts once the connection returns.
  func drain() async {
    guard let store, !uploading, store.connected, store.api != nil, items.contains(where: { $0.status == .queued }) else { return }
    let currentGeneration = store.generation
    uploading = true
    defer { if currentGeneration == store.generation { uploading = false } }
    while currentGeneration == store.generation, store.connected, let next = items.first(where: { $0.status == .queued }) {
      let task = Task { await self.upload(next.id) }
      tasks[next.id] = task
      await task.value
      tasks[next.id] = nil
    }
  }
  private func upload(_ uploadId: UUID) async {
    guard let store, let api = store.api, let index = items.firstIndex(where: { $0.id == uploadId }) else { return }
    let upload = items[index]
    items[index].status = .uploading
    items[index].progress = 0
    items[index].error = nil
    let currentGeneration = store.generation
    do {
      let data = try Data(contentsOf: upload.url)
      var file = try await api.upload(botId: upload.botId, name: upload.name, mime: upload.mime, data: data) { [weak self] sent in
        guard let self, currentGeneration == self.store?.generation, let index = self.items.firstIndex(where: { $0.id == uploadId })
        else { return }
        self.items[index].record(sent: sent)
      }
      guard currentGeneration == store.generation, items.contains(where: { $0.id == uploadId }) else { return }
      if file.size == nil { file.size = upload.size }
      // No network replay: Retry uploads only this file and never sends the message.
      try await store.attachUploaded(file, botId: upload.botId) { self.forget(uploadId) }
    } catch is CancellationError {
    } catch {
      guard currentGeneration == store.generation else { return }
      if let index = items.firstIndex(where: { $0.id == uploadId }) {
        items[index].status = .failed
        items[index].error = error.localizedDescription
      } else { store.report(error) }
    }
  }
}
