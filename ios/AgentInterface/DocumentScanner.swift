import PDFKit
import SwiftUI
import UIKit
import VisionKit

/// Pure PDF builder for multi-page VisionKit document scans. Processes pages one at a time inside
/// `autoreleasepool` with a bounded page/memory cap so long scans never exhaust memory or stall the
/// main actor before hitting `UploadRules.maxBytes`.
enum ScannedDocumentPDF {
  static let maxPages = 40

  enum BuildError: Error, LocalizedError, Equatable {
    case empty
    case tooLarge
    var errorDescription: String? {
      switch self {
      case .empty: "No scanned pages were captured."
      case .tooLarge: "The scanned document is larger than \(UploadRules.formatBytes(UploadRules.maxBytes)). Scan fewer pages at a time."
      }
    }
  }

  /// Generates a clean filename like `"Scan 14.03.22.pdf"`.
  static func filename(at date: Date = Date()) -> String {
    UploadRules.imageName("Scan", at: date, index: 0, ext: "pdf")
  }

  /// Builds a multi-page PDF from scanned images, processing one page at a time under a bounded
  /// memory budget and stepping down JPEG quality/scale only if needed to fit under `maxBytes`.
  nonisolated static func build(images: [UIImage], maxBytes: Int = UploadRules.maxBytes) throws -> Data {
    guard !images.isEmpty else { throw BuildError.empty }
    guard images.count <= maxPages else { throw BuildError.tooLarge }
    return try build(pageCount: images.count, maxBytes: maxBytes) { images[$0] }
  }

  /// Streaming page-by-page builder: invokes `pageAt` one index at a time inside an `autoreleasepool`
  /// so full-resolution VisionKit camera scans are never all resident in memory at once.
  nonisolated static func build(
    pageCount: Int,
    maxBytes: Int = UploadRules.maxBytes,
    pageAt: (Int) -> UIImage
  ) throws -> Data {
    guard pageCount > 0 else { throw BuildError.empty }
    guard pageCount <= maxPages else { throw BuildError.tooLarge }
    let attempts: [(maxDimension: CGFloat, quality: CGFloat)] = [
      (2200, 0.82),
      (1600, 0.72),
      (1200, 0.6),
    ]
    for attempt in attempts {
      if let data = render(pageCount: pageCount, maxBytes: maxBytes, maxDimension: attempt.maxDimension, quality: attempt.quality, pageAt: pageAt),
        !data.isEmpty, data.count <= maxBytes
      {
        return data
      }
    }
    throw BuildError.tooLarge
  }

  private nonisolated static func render(
    pageCount: Int,
    maxBytes: Int,
    maxDimension: CGFloat,
    quality: CGFloat,
    pageAt: (Int) -> UIImage
  ) -> Data? {
    let document = PDFDocument()
    var estimatedBytes = 0
    for index in 0..<pageCount {
      var pageAdded = false
      var pageBytes = 0
      autoreleasepool {
        let raw = pageAt(index)
        let (prepared, jpegBytes) = normalize(raw, maxDimension: maxDimension, quality: quality)
        pageBytes = jpegBytes
        if let page = PDFPage(image: prepared) {
          document.insert(page, at: index)
          pageAdded = true
        }
      }
      guard pageAdded else { continue }
      estimatedBytes += pageBytes
      // Stop early once compressed page payloads alone already exceed the upload limit.
      if estimatedBytes > maxBytes + 256 * 1024 { return nil }
    }
    return document.dataRepresentation()
  }

  private nonisolated static func normalize(_ image: UIImage, maxDimension: CGFloat, quality: CGFloat) -> (UIImage, Int) {
    let size = image.size
    let longest = max(size.width, size.height)
    let scale = longest > maxDimension ? maxDimension / longest : 1
    let target = CGSize(width: max(1, (size.width * scale).rounded()), height: max(1, (size.height * scale).rounded()))
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    let drawn = UIGraphicsImageRenderer(size: target, format: format).image { _ in
      image.draw(in: CGRect(origin: .zero, size: target))
    }
    if let jpeg = drawn.jpegData(compressionQuality: quality), let compressed = UIImage(data: jpeg) {
      return (compressed, jpeg.count)
    }
    return (drawn, Int(target.width * target.height))
  }
}

/// VisionKit multi-page document camera wrapped for SwiftUI's `fullScreenCover`.
/// Downsamples and builds the PDF off the main actor one page at a time so large scans stay smooth
/// and bounded in memory.
struct DocumentScannerPicker: UIViewControllerRepresentable {
  @Binding var isPresented: Bool
  var onPDF: @MainActor (Result<Data, Error>) -> Void

  static var isSupported: Bool { VNDocumentCameraViewController.isSupported }

  func makeUIViewController(context: Context) -> VNDocumentCameraViewController {
    let controller = VNDocumentCameraViewController()
    controller.delegate = context.coordinator
    return controller
  }

  func updateUIViewController(_ uiViewController: VNDocumentCameraViewController, context: Context) {}

  func makeCoordinator() -> Coordinator { Coordinator(self) }

  @MainActor final class Coordinator: NSObject, @preconcurrency VNDocumentCameraViewControllerDelegate {
    let parent: DocumentScannerPicker
    init(_ parent: DocumentScannerPicker) { self.parent = parent }

    func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFinishWith scan: VNDocumentCameraScan) {
      let pageCount = scan.pageCount
      let onPDF = parent.onPDF
      parent.isPresented = false
      guard pageCount > 0 else { return }
      let box = SentScan(scan)
      Task { @MainActor in
        let result = await Task.detached(priority: .userInitiated) {
          Result {
            try ScannedDocumentPDF.build(pageCount: pageCount) { index in
              box.scan.imageOfPage(at: index)
            }
          }
        }.value
        onPDF(result)
      }
    }

    func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) {
      parent.isPresented = false
    }

    func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFailWithError error: Error) {
      parent.isPresented = false
      parent.onPDF(.failure(error))
    }
  }
}

private final class SentScan: @unchecked Sendable {
  let scan: VNDocumentCameraScan
  init(_ scan: VNDocumentCameraScan) { self.scan = scan }
}
