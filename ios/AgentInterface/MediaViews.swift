import QuickLook
import SwiftUI

struct AuthenticatedImage: View {
  let path: String
  @EnvironmentObject private var store: AppStore
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
    }.task(id: path + (store.scope ?? "")) {
      image = nil
      failed = false
      do {
        guard let api = store.api, !path.isEmpty else {
          failed = true
          return
        }
        // All images, including portraits, use the authenticated file API.
        guard path.hasPrefix("/api/files/") else {
          failed = true
          return
        }
        let data = try await api.data(path: path)
        guard !Task.isCancelled else { return }
        image = UIImage(data: data)
        failed = image == nil
      } catch is CancellationError {} catch { failed = true }
    }
  }
}
struct FileAttachmentView: View {
  var file: FileRef
  @EnvironmentObject private var store: AppStore
  var body: some View {
    Button {
      store.open(file)
    } label: {
      VStack(alignment: .leading, spacing: 8) {
        if file.mime.hasPrefix("image/") {
          AuthenticatedImage(path: "/api/files/\(APIClient.component(file.id))").scaledToFit()
            .frame(maxHeight: 260).clipShape(RoundedRectangle(cornerRadius: 12))
        }
        Label(
          file.name,
          systemImage: file.mime.hasPrefix("image/")
            ? "photo" : file.mime == "application/pdf" ? "doc.richtext" : "doc.text"
        ).lineLimit(2)
        if let size = file.size {
          Text(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file)).font(
            .caption
          ).foregroundStyle(.secondary)
        }
      }.frame(maxWidth: .infinity, alignment: .leading)
    }.buttonStyle(.plain).accessibilityHint(
      "Download and preview this file. Share or save it from the preview.")
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

/// Native block rendering preserves code, paragraphs, lists and GFM tables.
/// Links are handled by SwiftUI's attributed text, never an embedded web view.
struct MarkdownView: View {
  let text: String
  @Environment(\.colorScheme) private var scheme
  @EnvironmentObject private var store: AppStore
  struct Block: Identifiable {
    var id: Int
    var kind: String
    var text: String
  }
  static func blocks(_ source: String) -> [Block] {
    var result: [Block] = []
    var paragraph: [String] = []
    var code: [String] = []
    var inCode = false
    func flush() {
      if !paragraph.isEmpty {
        result.append(
          Block(id: result.count, kind: "text", text: paragraph.joined(separator: "\n")))
        paragraph = []
      }
    }
    let lines = source.components(separatedBy: "\n")
    var index = 0
    while index < lines.count {
      let line = lines[index]
      if line.hasPrefix("```") {
        if inCode {
          result.append(Block(id: result.count, kind: "code", text: code.joined(separator: "\n")))
          code = []
          inCode = false
        } else {
          flush()
          inCode = true
        }
      } else if inCode {
        code.append(line)
      } else if Self.listRow(line) != nil {
        flush()
        var rows = [line]
        while index + 1 < lines.count, Self.listRow(lines[index + 1]) != nil {
          index += 1
          rows.append(lines[index])
        }
        result.append(Block(id: result.count, kind: "list", text: rows.joined(separator: "\n")))
      } else if line.contains("|") && index + 1 < lines.count && lines[index + 1].contains("---") {
        flush()
        var rows = [line]
        index += 1
        while index + 1 < lines.count && lines[index + 1].contains("|") {
          index += 1
          rows.append(lines[index])
        }
        result.append(Block(id: result.count, kind: "table", text: rows.joined(separator: "\n")))
      } else if line.trimmingCharacters(in: .whitespaces).isEmpty {
        flush()
      } else if line.hasPrefix("#") {
        flush()
        result.append(
          Block(
            id: result.count, kind: "heading",
            text: line.trimmingCharacters(in: CharacterSet(charactersIn: "# "))))
      } else {
        paragraph.append(line)
      }
      index += 1
    }
    flush()
    if !code.isEmpty {
      result.append(Block(id: result.count, kind: "code", text: code.joined(separator: "\n")))
    }
    return result
  }
  struct ListRow {
    var marker: String
    var text: String
    var completed: Bool?
  }
  static func listRow(_ line: String) -> ListRow? {
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    guard let range = trimmed.range(of: #"^(?:[-*+]|[0-9]+\.)\s+"#, options: .regularExpression)
    else { return nil }
    let marker = String(trimmed[range]).trimmingCharacters(in: .whitespaces)
    let rest = String(trimmed[range.upperBound...])
    if let task = rest.range(of: #"^\[[ xX]\]\s+"#, options: .regularExpression) {
      return ListRow(
        marker: marker, text: String(rest[task.upperBound...]),
        completed: rest.lowercased().hasPrefix("[x]"))
    }
    return ListRow(marker: marker.last == "." ? marker : "•", text: rest, completed: nil)
  }
  static func tableCells(_ row: String) -> [String] {
    var cells: [String] = []
    var cell = ""
    var escaped = false
    for c in row {
      if escaped {
        if c != "|" { cell.append("\\") }
        cell.append(c)
        escaped = false
      } else if c == "\\" {
        escaped = true
      } else if c == "|" {
        cells.append(cell.trimmingCharacters(in: .whitespaces))
        cell = ""
      } else {
        cell.append(c)
      }
    }
    if escaped { cell.append("\\") }
    cells.append(cell.trimmingCharacters(in: .whitespaces))
    if row.trimmingCharacters(in: .whitespaces).hasPrefix("|") { cells.removeFirst() }
    if row.trimmingCharacters(in: .whitespaces).hasSuffix("|") { cells.removeLast() }
    return cells
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      ForEach(Self.blocks(text)) { block in
        switch block.kind {
        case "code":
          VStack(alignment: .trailing, spacing: 0) {
            Button("Copy code", systemImage: "doc.on.doc") {
              UIPasteboard.general.string = block.text
            }.font(.caption).padding(8)
            ScrollView(.horizontal) {
              Text(block.text).font(.system(.footnote, design: .monospaced)).textSelection(.enabled)
                .padding(12)
            }
          }.background(Palette.surface(scheme), in: RoundedRectangle(cornerRadius: 8))
        case "heading": Text(block.text).font(.headline).textSelection(.enabled)
        case "list":
          VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(block.text.components(separatedBy: "\n").enumerated()), id: \.offset) {
              _, line in
              if let row = Self.listRow(line) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                  if let done = row.completed {
                    Image(systemName: done ? "checkmark.square.fill" : "square").foregroundStyle(
                      done ? Palette.accent : .secondary
                    ).accessibilityHidden(true)
                  } else {
                    Text(row.marker).accessibilityHidden(true)
                  }
                  Text(attributed(row.text)).textSelection(.enabled).frame(
                    maxWidth: .infinity, alignment: .leading)
                }.accessibilityElement(children: .combine).accessibilityLabel(
                  row.completed.map { ($0 ? "Completed: " : "Incomplete: ") + row.text } ?? row.text
                )
              }
            }
          }
        case "table":
          ScrollView(.horizontal) {
            Grid(alignment: .leading, horizontalSpacing: 20, verticalSpacing: 10) {
              ForEach(Array(block.text.components(separatedBy: "\n").enumerated()), id: \.offset) {
                index, row in
                GridRow {
                  ForEach(Array(Self.tableCells(row).enumerated()), id: \.offset) { _, cell in
                    Text(attributed(cell)).font(index == 0 ? .headline : .body).textSelection(
                      .enabled)
                  }
                }
              }
            }.padding(8)
          }
        default: Text(attributed(block.text)).textSelection(.enabled).lineSpacing(4)
        }
      }
    }.frame(maxWidth: .infinity, alignment: .leading)
      .environment(
        \.openURL,
        OpenURLAction { url in
          if url.path.hasPrefix("/api/files/"), let origin = store.api?.baseURL,
            url.host == nil
              || url.host == origin.host && url.scheme == origin.scheme && url.port == origin.port
          {
            let id = String(url.path.dropFirst("/api/files/".count)).removingPercentEncoding ?? ""
            guard !id.isEmpty, !id.contains("/") else { return .discarded }
            store.open(
              store.conversation?.files.first { $0.id == id }
                ?? FileRef(id: id, name: "Download", mime: "application/octet-stream"))
            return .handled
          }
          return ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "")
            ? .systemAction : .discarded
        })
  }
  private func attributed(_ value: String) -> AttributedString {
    (try? AttributedString(
      markdown: value, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
      ?? AttributedString(value)
  }
}
