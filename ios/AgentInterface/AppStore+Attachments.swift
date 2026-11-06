import SwiftUI

// Attaching files to drafts and opening files for preview.
extension AppStore {
  /// Why files cannot be attached to this assistant's draft right now, in the web's words.
  static let attachWhileSending = "Wait a moment for your message to send."
  func attachUnavailable(_ botId: String) -> String? {
    if !supports(.uploads) {
      let reason = bootstrap?[capability: .uploads]?.reason ?? ""
      return reason.isEmpty ? "Hermes can't receive files right now." : reason
    }
    if !draftReady || selectedBotId != botId { return "Your draft is still loading." }
    if sending { return Self.attachWhileSending }
    if attachmentSlots(botId) <= 0 { return "A message can carry up to \(UploadRules.maxAttachments) attachments." }
    return nil
  }
  func attachmentSlots(_ botId: String) -> Int {
    UploadRules.maxAttachments - draft.attachments.count - uploads.items.filter { $0.botId == botId }.count
  }
  /// An uploaded file joins its assistant's draft. `uploaded` drops its staged entry once the
  /// draft holds it.
  func attachUploaded(_ file: FileRef, botId: String, uploaded: () -> Void) async throws {
    if selectedBotId == botId && draftReady {
      var next = draft; next.attachments.append(file); updateDraft(next)
      uploaded()
    } else {
      let localKey = key(.draft, botId)
      var target: Draft = read(localKey) ?? Draft()
      target.attachments.append(file); target.dirty = true; target.seq = (target.seq ?? 0) + 1
      save(target, localKey)
      // A draft read already in flight must merge this cached attachment, not replace it.
      if selectedBotId == botId { draft = target }
      uploaded()
      try await saveDraft(target, botId: botId)
    }
  }
  func attachAppleSnapshot(_ data: Data, botId: String) async throws {
    guard let api, connected, supports(.uploads), !uploads.uploading, !sending, pendings[botId] == nil, bootstrap?.bots.contains(where: { $0.id == botId }) == true else {
      throw APIError(message: "Reconnect to this assistant before sharing a snapshot.", status: 409)
    }
    let currentGeneration = generation
    let localKey = key(.draft, botId)
    var target: Draft
    if selectedBotId == botId {
      guard draftReady else { throw APIError(message: "Wait for this assistant's draft to finish loading.", status: 409) }
      target = draft
    } else {
      let remote: SavedDraft? = try await api.get("/bots/\(APIClient.component(botId))/draft")
      let cached: Draft? = read(localKey)
      target = Draft.merge(cached ?? Draft(), with: remote).draft
    }
    guard target.attachments.count < 10 else { throw APIError(message: "This draft already has 10 attachments. Send or remove one first.", status: 400) }
    uploads.uploading = true
    defer { if currentGeneration == generation { uploads.uploading = false; Task { await self.uploads.drain() } } }
    let file = try await api.upload(botId: botId, name: "apple-selected-snapshot.txt", mime: "text/plain", data: data)
    guard currentGeneration == generation else { throw CancellationError() }
    // Draft editing remains possible during uploads. Read it again before appending.
    if selectedBotId == botId { target = draft }
    else if let cached: Draft = read(localKey), cached.dirty == true { target = cached }
    guard target.attachments.count < 10 else { throw APIError(message: "This draft filled up while uploading. Remove an attachment before sharing again.", status: 409) }
    target.attachments.append(file)
    if target.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { target.text = "Use this selected Calendar and Reminders snapshot. It was shared from my iPhone and is current only as of its capture time." }
    target.dirty = true
    if selectedBotId == botId { updateDraft(target) }
    else {
      save(target, localKey)
      try await saveDraft(target, botId: botId)
    }
  }
  func open(_ file: FileRef) {
    open(file, present: { self.openedFile = $0 })
  }
  /// A sheet owns its preview presentation and may cancel its own download when dismissed.
  @discardableResult
  func open(_ file: FileRef, present: @escaping @MainActor (PreviewFile) -> Void,
    onError: (@MainActor (Error) -> Void)? = nil) -> Task<Void, Never> {
    fileTask?.cancel()
    let currentGeneration = generation
    let task = Task {
      do {
        guard let api else { return }
        let data = try await api.data(path: "/api/files/\(APIClient.component(file.id))")
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
          "AgentInterface-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent(URL(fileURLWithPath: file.name).lastPathComponent)
        try data.write(to: url, options: [.atomic, .completeFileProtection])
        guard !Task.isCancelled, currentGeneration == generation else {
          try? FileManager.default.removeItem(at: directory)
          return
        }
        present(PreviewFile(url: url))
      } catch {
        guard !Task.isCancelled, !(error is CancellationError), currentGeneration == generation else { return }
        if let onError {
          onError(error)
          if (error as? APIError)?.isSessionExpired == true { report(error) }
        } else { report(error) }
      }
    }
    fileTask = task
    return task
  }
}
