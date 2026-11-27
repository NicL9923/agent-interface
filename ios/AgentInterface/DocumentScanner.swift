import PDFKit
import SwiftUI
import UIKit
import VisionKit

/// Pure PDF builder for multi-page VisionKit document scans. Downsamples and compresses pages so
/// multi-page paper scans stay crisp while fitting within `UploadRules.maxBytes`.
enum ScannedDocumentPDF {
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

  /// Builds a multi-page PDF from scanned images, stepping down JPEG quality / scale only if needed
  /// to fit under `maxBytes`.
  static func build(images: [UIImage], maxBytes: Int = UploadRules.maxBytes) throws -> Data {
    guard !images.isEmpty else { throw BuildError.empty }
    let attempts: [(maxDimension: CGFloat, quality: CGFloat)] = [
      (2200, 0.82),
      (1600, 0.72),
      (1200, 0.6),
    ]
    for attempt in attempts {
      let data = render(images: images, maxDimension: attempt.maxDimension, quality: attempt.quality)
      if !data.isEmpty, data.count <= maxBytes { return data }
    }
    throw BuildError.tooLarge
  }

  private static func render(images: [UIImage], maxDimension: CGFloat, quality: CGFloat) -> Data {
    let document = PDFDocument()
    for (index, raw) in images.enumerated() {
      let prepared = normalize(raw, maxDimension: maxDimension, quality: quality)
      if let page = PDFPage(image: prepared) {
        document.insert(page, at: index)
      }
    }
    return document.dataRepresentation() ?? Data()
  }

  private static func normalize(_ image: UIImage, maxDimension: CGFloat, quality: CGFloat) -> UIImage {
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
      return compressed
    }
    return drawn
  }
}

/// VisionKit multi-page document camera wrapped for SwiftUI's `fullScreenCover`.
struct DocumentScannerPicker: UIViewControllerRepresentable {
  @Binding var isPresented: Bool
  var onScan: ([UIImage]) -> Void
  var onError: (Error) -> Void

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
      let pages = (0..<scan.pageCount).map { scan.imageOfPage(at: $0) }
      parent.isPresented = false
      if !pages.isEmpty { parent.onScan(pages) }
    }

    func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) {
      parent.isPresented = false
    }

    func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFailWithError error: Error) {
      parent.isPresented = false
      parent.onError(error)
    }
  }
}
