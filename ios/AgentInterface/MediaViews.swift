import ImageIO
import QuickLook
import SwiftUI

struct AuthenticatedImage: View {
  let path: String
  @Environment(AppStore.self) private var store: AppStore?
  @State private var image: UIImage?
  @State private var failed = false
  var body: some View {
    Group {
      if let image {
        Image(uiImage: image).resizable()
      } else if failed {
        Image(systemName: "photo.badge.exclamationmark").resizable().scaledToFit().padding(10)
          .foregroundStyle(.secondary)
      } else {
        ProgressView()
      }
    }.task(id: path + (store?.scope ?? "")) {
      let key = Self.cacheKey(path, store)
      // An image shown before returns at once instead of downloading again on every scroll.
      if let cached = Self.cache.object(forKey: key) { image = cached; failed = false; return }
      image = nil
      failed = false
      do {
        guard let api = store?.api, !path.isEmpty else {
          failed = true
          return
        }
        // All images, including portraits, use the authenticated file API.
        guard path.hasPrefix("/api/files/") else {
          failed = true
          return
        }
        let path = path
        let loaded = try await Self.loads.image(key) { try await api.data(path: path) }
        guard !Task.isCancelled else { return }
        image = loaded
        failed = loaded == nil
      } catch is CancellationError {} catch { failed = true }
    }
  }
  /// One download and decode per image at a time: the same picture in a reply and the file
  /// list, or a row scrolled back in, waits for the load already running.
  private static let loads = ImageLoads()
  @MainActor final class ImageLoads {
    private struct Load { var task: Task<UIImage?, Error>; var waiters = 1; var abandoned = 0 }
    /// Keyed by the cache key's text: a String crosses into the cancellation handler, an NSString does not.
    private var running: [String: Load] = [:]
    func image(_ cacheKey: NSString, fetch: @escaping @MainActor () async throws -> Data) async throws -> UIImage? {
      let key = cacheKey as String
      // A load every view abandoned is ending; a new view starts its own.
      if let load = running[key], !load.task.isCancelled {
        running[key]?.waiters += 1
        return try await wait(key, load.task)
      }
      let task = Task {
        let data = try await fetch()
        try Task.checkCancellation()
        // Decoding a camera photo takes tens of milliseconds, so it stays off the main actor.
        let image = await Task.detached(priority: .userInitiated) { AuthenticatedImage.downsampled(data) }.value
        if let image, let cgImage = image.cgImage {
          AuthenticatedImage.cache.setObject(image, forKey: key as NSString, cost: cgImage.bytesPerRow * cgImage.height)
        }
        return image
      }
      running[key] = Load(task: task)
      return try await wait(key, task)
    }
    private func wait(_ key: String, _ task: Task<UIImage?, Error>) async throws -> UIImage? {
      defer { leave(key, task) }
      return try await withTaskCancellationHandler { try await task.value } onCancel: {
        Task { @MainActor in self.abandon(key, task) }
      }
    }
    private func leave(_ key: String, _ task: Task<UIImage?, Error>) {
      guard let load = running[key], load.task == task else { return }
      if load.waiters > 1 { running[key]?.waiters -= 1 } else { running[key] = nil }
    }
    /// Views that scrolled away stop the download, unless another view still waits for it.
    private func abandon(_ key: String, _ task: Task<UIImage?, Error>) {
      guard running[key]?.task == task else { return }
      running[key]?.abandoned += 1
      if let load = running[key], load.abandoned >= load.waiters { task.cancel() }
    }
  }
  /// Decoded images by server, identity and path, bounded like a browser's memory cache.
  private static let cache: NSCache<NSString, UIImage> = {
    let cache = NSCache<NSString, UIImage>()
    cache.totalCostLimit = 64 * 1024 * 1024
    return cache
  }()
  /// Wide enough for a full-width transcript image on any iPhone or iPad. A camera photo decoded
  /// at full size would hold about 46 MB; Quick Look still opens the original.
  nonisolated static let maxPixelSize = 1600
  nonisolated static func downsampled(_ data: Data) -> UIImage? {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
    let options: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceShouldCacheImmediately: true, kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
    ]
    guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
    return UIImage(cgImage: image)
  }
  private static func cacheKey(_ path: String, _ store: AppStore?) -> NSString {
    "\(store?.scope ?? ""):\(path)" as NSString
  }
}
/// A file on a message, as the web's FileLink: an app file opens in Quick Look and a file hosted
/// elsewhere opens at its own address.
struct FileAttachmentView: View {
  var file: FileRef
  @Environment(AppStore.self) private var store: AppStore?
  @Environment(\.openURL) private var openURL
  var body: some View {
    let location = file.location(origin: store?.api?.baseURL)
    Button {
      switch location {
      case .managed: store?.open(file)
      case .external(let url): openURL(url)
      case .unsupported: break
      }
    } label: {
      VStack(alignment: .leading, spacing: 8) {
        if file.mime.hasPrefix("image/") { thumbnail(location) }
        Label(file.name, systemImage: icon(location)).lineLimit(2)
        if let size = file.size {
          Text(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file)).font(.caption)
            .foregroundStyle(.secondary)
        }
      }.frame(maxWidth: .infinity, alignment: .leading)
    }.buttonStyle(.plain).disabled(location == .unsupported)
      .accessibilityHint(location == .managed ? "Download and preview this file. Share or save it from the preview."
        : "Opens the file's source in your browser.")
  }
  @ViewBuilder private func thumbnail(_ location: FileLocation) -> some View {
    switch location {
    case .managed:
      AuthenticatedImage(path: file.managedPath).scaledToFit()
        .frame(maxHeight: 260).clipShape(RoundedRectangle(cornerRadius: 12))
    case .external(let url):
      AsyncImage(url: url) { image in image.resizable().scaledToFit() } placeholder: { ProgressView() }
        .frame(maxHeight: 260).clipShape(RoundedRectangle(cornerRadius: 12))
    case .unsupported: EmptyView()
    }
  }
  private func icon(_ location: FileLocation) -> String {
    if case .external = location { return "arrow.up.right.square" }
    return file.mime.hasPrefix("image/") ? "photo" : file.mime == "application/pdf" ? "doc.richtext" : "doc.text"
  }
}
struct FilePreview: UIViewControllerRepresentable {
  var file: PreviewFile
  func makeCoordinator() -> Coordinator { Coordinator(url: file.url) }
  func makeUIViewController(context: Context) -> QLPreviewController {
    let controller = QLPreviewController()
    controller.dataSource = context.coordinator
    return controller
  }
  func updateUIViewController(_ uiViewController: QLPreviewController, context: Context) {}
  static func dismantleUIViewController(
    _ uiViewController: QLPreviewController, coordinator: Coordinator
  ) { try? FileManager.default.removeItem(at: coordinator.url.deletingLastPathComponent()) }
  class Coordinator: NSObject, QLPreviewControllerDataSource {
    var url: URL
    init(url: URL) { self.url = url }
    func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
    func previewController(_ controller: QLPreviewController, previewItemAt index: Int)
      -> QLPreviewItem
    { url as NSURL }
  }
}

/// Native block rendering of the web's Markdown (MessageMarkdown.tsx): paragraphs, headings,
/// nested lists, quotes, rules, code and GFM tables. Links are handled by SwiftUI's attributed
/// text, never an embedded web view.
struct MarkdownView: View {
  let text: String
  /// A reply still arriving: parsed from its last settled block and kept out of the shared caches.
  var streaming = false
  @Environment(AppStore.self) private var store: AppStore?
  var body: some View {
    let parsed = streaming
      ? MarkdownCache.shared.streamingBlocks(text) : (blocks: MarkdownCache.shared.blocks(text), settled: Int.max)
    MarkdownBlocksView(blocks: parsed.blocks, settled: parsed.settled)
      .frame(maxWidth: .infinity, alignment: .leading)
      .environment(\.openURL, OpenURLAction(handler: open))
  }
  private func open(_ url: URL) -> OpenURLAction.Result {
    if url.path.hasPrefix("/api/files/"), let store, let origin = store.api?.baseURL,
      url.host == nil || url.host == origin.host && url.scheme == origin.scheme && url.port == origin.port
    {
      let id = String(url.path.dropFirst("/api/files/".count)).removingPercentEncoding ?? ""
      guard !id.isEmpty, !id.contains("/") else { return .discarded }
      store.open(
        store.conversation?.files.first { $0.id == id }
          ?? FileRef(id: id, name: "Download", mime: "application/octet-stream"))
      return .handled
    }
    return ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") ? .systemAction : .discarded
  }
}
/// A run of blocks. Quotes and list items nest it, so it is type-erased where it recurses.
struct MarkdownBlocksView: View {
  var blocks: [MarkdownBlock]
  var listDepth = 0
  var spacing: CGFloat = 12
  /// Blocks from this index on may still change, as at the end of a streamed reply.
  var settled = Int.max
  @Environment(\.markdownSettled) private var inheritedSettled
  var body: some View {
    VStack(alignment: .leading, spacing: spacing) {
      ForEach(Array(blocks.enumerated()), id: \.offset) { index, block in
        MarkdownBlockView(block: block, listDepth: listDepth)
          .environment(\.markdownSettled, inheritedSettled && index < settled)
      }
    }
  }
}
private struct MarkdownSettledKey: EnvironmentKey { static let defaultValue = true }
extension EnvironmentValues {
  /// Whether the Markdown below can no longer change, so its converted text is worth caching.
  var markdownSettled: Bool {
    get { self[MarkdownSettledKey.self] }
    set { self[MarkdownSettledKey.self] = newValue }
  }
}
struct MarkdownBlockView: View {
  var block: MarkdownBlock
  var listDepth: Int
  @Environment(\.markdownSettled) private var settled
  var body: some View {
    switch block {
    case .paragraph(let text):
      Text(MarkdownCache.shared.attributed(text, keep: settled)).textSelection(.enabled).lineSpacing(4)
    case .heading(let level, let text):
      Text(MarkdownCache.shared.attributed(text, keep: settled)).font(Self.headingFont(level)).textSelection(.enabled)
        .padding(.top, 4).accessibilityAddTraits(.isHeader)
    case .code(let language, let text):
      MarkdownCodeBlock(code: text, language: language)
    case .quote(let blocks):
      AnyView(MarkdownBlocksView(blocks: blocks, listDepth: listDepth)).foregroundStyle(Palette.muted)
        .padding(.leading, 14)
        .overlay(alignment: .leading) { Rectangle().fill(Palette.line).frame(width: 3) }
    case .list(let list):
      MarkdownListView(list: list, depth: listDepth)
    case .rule:
      Rectangle().fill(Palette.line).frame(height: 1).padding(.vertical, 4).accessibilityHidden(true)
    case .table(let table):
      MarkdownTableView(table: table)
    }
  }
  /// The web's sizes: h1 1.4em, h2 1.2em, and h3 to h6 1.05em, all semibold.
  static func headingFont(_ level: Int) -> Font {
    switch level {
    case 1: .title2.weight(.semibold)
    case 2: .title3.weight(.semibold)
    default: .headline
    }
  }
}
struct MarkdownListView: View {
  var list: MarkdownList
  var depth: Int
  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      ForEach(Array(list.items.enumerated()), id: \.offset) { index, item in
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          marker(index, item)
          AnyView(MarkdownBlocksView(blocks: item.blocks, listDepth: depth + 1, spacing: 6))
            .frame(maxWidth: .infinity, alignment: .leading)
        }.accessibilityElement(children: .combine)
          .accessibilityValue(item.task.map { $0 ? "Completed" : "Incomplete" } ?? "")
      }
    }.padding(.leading, depth == 0 ? 2 : 0)
  }
  @ViewBuilder private func marker(_ index: Int, _ item: MarkdownListItem) -> some View {
    if let done = item.task {
      Image(systemName: done ? "checkmark.square.fill" : "square")
        .foregroundStyle(done ? Palette.accent : .secondary).accessibilityHidden(true)
    } else {
      Text(Self.marker(list, index: index, depth: depth)).monospacedDigit().accessibilityHidden(true)
    }
  }
  /// Ordered items count up from the list's first number; bullets change with nesting.
  static func marker(_ list: MarkdownList, index: Int, depth: Int) -> String {
    if let start = list.start { return "\(start + index)." }
    return ["•", "◦", "▪"][min(depth, 2)]
  }
}
struct MarkdownTableView: View {
  var table: MarkdownTable
  @Environment(\.markdownSettled) private var settled
  var body: some View {
    ScrollView(.horizontal) {
      Grid(alignment: .leading, horizontalSpacing: 20, verticalSpacing: 10) {
        GridRow {
          ForEach(Array(table.header.enumerated()), id: \.offset) { column, cell in
            Text(MarkdownCache.shared.attributed(cell, keep: settled)).font(.headline).textSelection(.enabled)
              .gridColumnAlignment(Self.alignment(table.alignments[column]))
          }
        }
        ForEach(Array(table.rows.enumerated()), id: \.offset) { _, row in
          GridRow {
            ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
              Text(MarkdownCache.shared.attributed(cell, keep: settled)).textSelection(.enabled)
            }
          }
        }
      }.padding(8)
    }.accessibilityLabel("Table")
  }
  static func alignment(_ value: MarkdownTable.Alignment) -> HorizontalAlignment {
    switch value {
    case .leading: .leading
    case .center: .center
    case .trailing: .trailing
    }
  }
}
/// A code block with the web's header: the language or "Code", and a copy button with a status.
struct MarkdownCodeBlock: View {
  var code: String
  var language: String?
  @Environment(\.colorScheme) private var scheme
  @State private var copied = false
  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 12) {
        Text(language ?? "Code").font(.caption).foregroundStyle(.secondary).lineLimit(1)
        Spacer()
        Button("Copy code", systemImage: "doc.on.doc", action: copy).font(.caption)
      }.padding(.horizontal, 12).padding(.vertical, 8)
      Rectangle().fill(Palette.line).frame(height: 1)
      ScrollView(.horizontal) {
        Text(code).font(.system(.footnote, design: .monospaced)).textSelection(.enabled).padding(14)
      }.accessibilityLabel(language.map { "\($0) code block" } ?? "Code block")
      if copied {
        Text("Code copied.").font(.caption).foregroundStyle(.secondary).padding([.horizontal, .bottom], 14)
      }
    }.background(Palette.raised(scheme), in: RoundedRectangle(cornerRadius: 12))
      .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Palette.line))
  }
  private func copy() {
    UIPasteboard.general.string = code
    copied = true
    AccessibilityNotification.Announcement("Code copied.").post()
  }
}
