import Foundation
import UniformTypeIdentifiers

/// What a message attachment may be, the same rules as the web's `src/shared/uploads.ts`.
enum UploadRules {
  static let mimeTypes = ["image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf", "text/plain"]
  static let maxBytes = 20 * 1024 * 1024
  static let maxAttachments = 10
  static let kinds = "PNG, JPEG, WebP or GIF images, PDFs, or plain text"
  /// Common text formats the picker offers, sent as plain text.
  static let textExtensions = ["txt", "md", "markdown", "csv", "log"]
  /// What the file picker offers. Any text type is accepted and sent as plain text.
  static let pickerTypes: [UTType] = [.png, .jpeg, .webP, .gif, .pdf, .text, .log]

  static func formatBytes(_ bytes: Int) -> String {
    if bytes < 1024 { return "\(bytes) B" }
    if bytes < 1024 * 1024 { return "\(Int((Double(bytes) / 1024).rounded())) KB" }
    let megabytes = Double(bytes) / 1024 / 1024
    return String(format: bytes < 10 * 1024 * 1024 ? "%.1f MB" : "%.0f MB", megabytes)
  }

  /// The MIME type to upload a file as, or why it cannot be attached.
  static func prepare(name: String, mime: String?, size: Int) -> Result<String, Problem> {
    let name = name.isEmpty ? "Untitled file" : name
    let type = (mime ?? "").split(separator: ";", maxSplits: 1).first.map { $0.trimmingCharacters(in: .whitespaces).lowercased() } ?? ""
    let ext = name.contains(".") ? (name.split(separator: ".").last.map { String($0).lowercased() } ?? "") : ""
    var prepared = type
    if !mimeTypes.contains(type) {
      guard type.hasPrefix("text/") || (type.isEmpty && textExtensions.contains(ext)) else {
        return .failure(Problem(message: "\(name) can't be attached. Use \(kinds)."))
      }
      prepared = "text/plain"
    }
    if size > maxBytes {
      return .failure(Problem(message: "\(name) is \(formatBytes(size)). Each attachment can be up to \(formatBytes(maxBytes))."))
    }
    return .success(prepared)
  }
  /// The MIME type iOS knows for a file, empty when it has none, as a browser reports it.
  static func mime(of url: URL, contentType: UTType?) -> String {
    (contentType ?? UTType(filenameExtension: url.pathExtension))?.preferredMIMEType ?? ""
  }
  struct Problem: Error, Equatable { var message: String }

  /// Pasted images and new photos get a name worth reading in the chat, like the web's
  /// "Pasted image 14.03.22.png". A second image from the same moment gets " (2)".
  static func imageName(_ prefix: String, at date: Date, index: Int, ext: String) -> String {
    let parts = Calendar.current.dateComponents([.hour, .minute, .second], from: date)
    let time = [parts.hour, parts.minute, parts.second].map { String(format: "%02d", $0 ?? 0) }.joined(separator: ".")
    return "\(prefix) \(time)\(index > 0 ? " (\(index + 1))" : "").\(ext)"
  }
  /// The web's attachment chip label: PDF, Image, or the file's extension.
  static func kindLabel(name: String, mime: String) -> String {
    if mime == "application/pdf" { return "PDF" }
    if mime.hasPrefix("image/") { return "Image" }
    guard name.contains("."), let ext = name.split(separator: ".").last else { return "Text" }
    return String(ext.uppercased().prefix(4))
  }
}

enum UploadStatus: Equatable { case queued, uploading, processing, failed }
