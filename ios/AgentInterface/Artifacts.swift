import SwiftUI

/// Where a file opens from, as the web decides it (Artifacts.tsx `managedFileUrl` and `sourceUrl`).
enum FileLocation: Equatable {
  /// The app's authenticated file route, fetched and previewed in the app.
  case managed
  /// A file hosted elsewhere, opened in the browser.
  case external(URL)
  /// A reference with no address the app can open.
  case unsupported
}
extension FileRef {
  @MainActor var managedPath: String { "/api/files/\(APIClient.component(id))" }
  /// A missing URL or one naming this file's route on the app's own server is managed; any
  /// other http or https address without credentials is external.
  func location(origin: URL?) -> FileLocation {
    guard let raw = url, !raw.isEmpty else { return .managed }
    let resolved = origin.flatMap { URL(string: raw, relativeTo: $0)?.absoluteURL } ?? URL(string: raw)
    guard let resolved, let components = URLComponents(url: resolved, resolvingAgainstBaseURL: true) else { return .unsupported }
    let credentials = components.user != nil || components.password != nil
    if let origin, resolved.scheme == origin.scheme, resolved.host == origin.host, resolved.port == origin.port,
      components.path == "/api/files/" + id, components.query == nil, components.fragment == nil, !credentials
    { return .managed }
    guard ["http", "https"].contains(resolved.scheme?.lowercased() ?? ""), resolved.host?.isEmpty == false, !credentials
    else { return .unsupported }
    return .external(resolved)
  }
}

/// A file in the conversation and how it got there, as the web's Artifacts panel lists it.
struct Artifact: Identifiable, Equatable {
  enum Source: String { case generated = "Generated", shared = "Shared", artifact = "Artifact" }
  var file: FileRef
  var source: Source
  var id: String { file.id }
}
enum ArtifactKind: String, CaseIterable, Identifiable {
  case all, image, text, document, audio, video, other
  var id: String { rawValue }
  var label: String {
    switch self {
    case .all: "All types"
    case .image: "Images"
    case .text: "Text"
    case .document: "Documents"
    case .audio: "Audio"
    case .video: "Video"
    case .other: "Other files"
    }
  }
  var typeName: String {
    switch self {
    case .all, .other: "File"
    case .image: "Image"
    case .text: "Text"
    case .document: "PDF"
    case .audio: "Audio"
    case .video: "Video"
    }
  }
  private static let rasterTypes: Set<String> = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif", "image/bmp"]
  private static let textTypes: Set<String> = ["text/plain", "text/markdown", "text/csv", "application/json"]
  private static let audioTypes: Set<String> = ["audio/mpeg", "audio/mp4", "audio/ogg", "audio/wav", "audio/x-wav", "audio/webm", "audio/flac"]
  private static let videoTypes: Set<String> = ["video/mp4", "video/webm", "video/ogg"]
  /// Exact types only: HTML is not text and SVG is not an image, so neither previews as one.
  static func of(_ file: FileRef) -> ArtifactKind {
    let mime = file.mime.split(separator: ";", maxSplits: 1).first.map { $0.trimmingCharacters(in: .whitespaces).lowercased() } ?? ""
    if rasterTypes.contains(mime) { return .image }
    if textTypes.contains(mime) { return .text }
    if mime == "application/pdf" { return .document }
    if audioTypes.contains(mime) { return .audio }
    if videoTypes.contains(mime) { return .video }
    return .other
  }
}
enum Artifacts {
  /// Earlier files first, then the conversation's, keeping the list in conversation order. A
  /// file a person sent is Shared; one the assistant or a tool produced is Generated.
  static func list(_ conversation: Conversation?, earlier: [EarlierFiles.Entry] = []) -> [Artifact] {
    guard let conversation else { return [] }
    var order: [String] = []
    var byId: [String: Artifact] = [:]
    func set(_ artifact: Artifact) {
      if byId[artifact.id] == nil { order.append(artifact.id) }
      byId[artifact.id] = artifact
    }
    for message in earlier { for file in message.files ?? [] { set(Artifact(file: file, source: .artifact)) } }
    for file in conversation.files where byId[file.id] == nil { set(Artifact(file: file, source: .artifact)) }
    let messages = earlier.map { (role: $0.role, files: $0.files) } + conversation.messages.map { (role: Optional($0.role), files: $0.files) }
    for message in messages {
      for file in message.files ?? [] {
        let previous = byId[file.id]
        let source: Artifact.Source = message.role == "user" || previous?.source == .shared ? .shared
          : message.role == "assistant" || message.role == "tool" ? .generated : previous?.source ?? .artifact
        // What the list already knew about a file wins over a later mention of it.
        var merged = file
        if let known = previous?.file {
          merged = FileRef(id: known.id, name: known.name, mime: known.mime, size: known.size ?? file.size, url: known.url ?? file.url)
        }
        set(Artifact(file: merged, source: source))
      }
    }
    return order.compactMap { byId[$0] }
  }
  /// The web's size label: bytes, then KB and MB with one decimal.
  static func size(_ bytes: Int?) -> String {
    guard let bytes, bytes >= 0 else { return "" }
    if bytes < 1024 { return "\(bytes) B" }
    if bytes < 1024 * 1024 { return String(format: "%.1f KB", Double(bytes) / 1024) }
    return String(format: "%.1f MB", Double(bytes) / (1024 * 1024))
  }
  static func filter(_ artifacts: [Artifact], query: String, kind: ArtifactKind) -> [Artifact] {
    let query = query.trimmingCharacters(in: .whitespaces).lowercased()
    return artifacts.filter {
      (query.isEmpty || $0.file.name.lowercased().contains(query)) && (kind == .all || ArtifactKind.of($0.file) == kind)
    }
  }
}

struct ConversationFilesView: View {
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State private var kind = ArtifactKind.all
  @State private var search = ""
  @State private var searchPresented = false
  @State private var preview: PreviewFile?
  @State private var previewTask: Task<Void, Never>?
  @State private var openingFile: FileRef?
  @State private var previewError: String?
  var body: some View {
    let artifacts = store.conversationArtifacts
    let filtered = Artifacts.filter(artifacts, query: search, kind: kind)
    NavigationStack {
      List {
        Section {
          Picker("File type", selection: $kind) { ForEach(ArtifactKind.allCases) { Text($0.label).tag($0) } }
          notices(artifacts)
          if let openingFile { ProgressView("Opening \(openingFile.name)…").font(.subheadline).foregroundStyle(Palette.muted) }
        }
        content(artifacts, filtered)
      }.householdListBackground().accessibilityIdentifier("artifactsList").searchable(text: $search, isPresented: $searchPresented, prompt: "Find a filename")
        .navigationTitle("Artifacts").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
        .task { await store.loadEarlierFiles() }
    }.sheet(item: $preview) { FilePreview(file: $0).ignoresSafeArea().coveringChat(store) }
      .alert("Couldn't open file", isPresented: Binding(get: { previewError != nil }, set: { if !$0 { previewError = nil } })) {
        Button("OK", role: .cancel) { previewError = nil }
      } message: { Text(previewError ?? "") }
      .onDisappear { previewTask?.cancel() }
  }
  private func openPreview(_ file: FileRef) {
    previewError = nil; openingFile = file
    previewTask = store.open(file, present: { value in preview = value; openingFile = nil },
      onError: { error in previewError = error.localizedDescription; openingFile = nil })
  }
  @ViewBuilder private func notices(_ artifacts: [Artifact]) -> some View {
    if !store.connected {
      Text(artifacts.isEmpty ? "Files are unavailable until your assistant reconnects."
        : "The connection is unavailable. These are the last reported files; opening one may need a reconnect.")
        .font(.footnote).foregroundStyle(Palette.muted)
    }
    if store.loadingEarlierFiles {
      ProgressView("Loading files from earlier in the conversation…")
    } else if store.earlierFilesFailed {
      Text("Files from earlier in the conversation could not be loaded. Close and reopen this list to try again.")
        .font(.footnote).foregroundStyle(Palette.muted).accessibilityIdentifier("earlierFilesFailed")
    }
  }
  @ViewBuilder private func content(_ artifacts: [Artifact], _ filtered: [Artifact]) -> some View {
    if store.conversation == nil && store.connected {
      ProgressView("Loading your conversation’s files…").frame(maxWidth: .infinity)
    } else if artifacts.isEmpty {
      if !store.loadingEarlierFiles {
        ContentUnavailableView { Label("No artifacts yet", systemImage: "doc") } description: {
          Text("Generated outputs and files shared in this conversation will appear here.").foregroundStyle(Palette.muted)
        }
      }
    } else if filtered.isEmpty {
      ContentUnavailableView {
        Text("No matching files")
      } description: {
        Text("Try another filename or file type.").foregroundStyle(Palette.muted)
      } actions: {
        Button("Clear filters") { search = ""; kind = .all; searchPresented = false }.buttonStyle(.accentProminent).controlSize(.large)
      }
    } else {
      ForEach(filtered) { ArtifactRow(artifact: $0, openManaged: openPreview, opening: openingFile?.id == $0.id) }
    }
  }
}
/// One file: its name, then source, type and size as the web's list and detail show them.
struct ArtifactRow: View {
  var artifact: Artifact
  var openManaged: (FileRef) -> Void
  var opening = false
  @Environment(\.dynamicTypeSize) private var typeSize
  @Environment(AppStore.self) private var store
  @Environment(\.openURL) private var openURL
  var body: some View {
    let location = artifact.file.location(origin: store.api?.baseURL)
    Button { open(location) } label: {
      HStack(alignment: .top, spacing: 12) {
        if opening { ProgressView().controlSize(.small).frame(width: 24, height: 24).accessibilityHidden(true) }
        else { Image(systemName: icon(location)).font(.system(size: 20)).frame(width: 24, height: 24).foregroundStyle(Palette.muted).accessibilityHidden(true) }
        VStack(alignment: .leading, spacing: 3) {
          Text(artifact.file.name).lineLimit(typeSize.isAccessibilitySize ? nil : 2).foregroundStyle(Color.primary)
          Text(detail).font(.footnote).foregroundStyle(Palette.muted)
          if let note = note(location) { Text(note).font(.footnote).foregroundStyle(Palette.muted) }
        }.frame(maxWidth: .infinity, alignment: .leading)
      }.frame(minHeight: 44).contentShape(Rectangle())
    }.disabled(location == .unsupported).accessibilityIdentifier("artifact-" + artifact.file.id)
      .accessibilityHint(hint(location)).accessibilityValue(opening ? "Opening file" : "")
  }
  private var detail: String {
    let size = Artifacts.size(artifact.file.size)
    return "\(artifact.source.rawValue) · \(ArtifactKind.of(artifact.file).typeName)" + (size.isEmpty ? "" : " · \(size)")
  }
  private func open(_ location: FileLocation) {
    switch location {
    case .managed: openManaged(artifact.file)
    case .external(let url): openURL(url)
    case .unsupported: break
    }
  }
  private func icon(_ location: FileLocation) -> String {
    if case .external = location { return "arrow.up.right.square" }
    return ArtifactKind.of(artifact.file) == .image ? "photo" : "doc"
  }
  private func note(_ location: FileLocation) -> String? {
    switch location {
    case .managed: nil
    case .external: "This file is hosted outside the app. Open its source to view it."
    case .unsupported: "This file has no supported download address."
    }
  }
  private func hint(_ location: FileLocation) -> String {
    if case .external = location { return "Opens the file's source in your browser." }
    return "Download and preview this file. Share or save it from the preview."
  }
}
