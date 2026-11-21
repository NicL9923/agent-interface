// Lays the iOS connection-state screenshots side by side, each under its label, at half size.
//
//   swift docs/evidence/2026-11-19-connection-states/ios-collage.swift OUT.png "Label=path.png" ...
//
// Three to a row. Aspect ratios are kept; every shot shares the first one's size.
import AppKit

let arguments = Array(CommandLine.arguments.dropFirst())
guard arguments.count >= 2 else {
  FileHandle.standardError.write(Data("usage: ios-collage.swift OUT.png Label=path.png ...\n".utf8))
  exit(2)
}
let output = URL(fileURLWithPath: arguments[0])
let shots: [(label: String, image: NSImage)] = arguments.dropFirst().map { pair in
  let parts = pair.split(separator: "=", maxSplits: 1).map(String.init)
  guard parts.count == 2, let image = NSImage(contentsOfFile: parts[1]) else {
    FileHandle.standardError.write(Data("cannot read \(pair)\n".utf8))
    exit(1)
  }
  return (parts[0], image)
}
let pixels = { (image: NSImage) -> CGSize in
  let rep = image.representations.first!
  return CGSize(width: rep.pixelsWide, height: rep.pixelsHigh)
}
let scale = 0.5, columns = 3, gap = 24.0, labelHeight = 56.0
let shot = pixels(shots[0].image)
let cell = CGSize(width: shot.width * scale, height: shot.height * scale)
let rows = (shots.count + columns - 1) / columns
let size = CGSize(width: Double(columns) * cell.width + Double(columns + 1) * gap,
  height: Double(rows) * (cell.height + labelHeight) + Double(rows + 1) * gap)
let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size.width), pixelsHigh: Int(size.height),
  bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
NSColor(white: 0.93, alpha: 1).setFill()
NSRect(origin: .zero, size: size).fill()
let attributes: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 28, weight: .semibold), .foregroundColor: NSColor.black]
for (index, item) in shots.enumerated() {
  let column = index % columns, row = index / columns
  let x = gap + Double(column) * (cell.width + gap)
  // AppKit's origin is the bottom left, so rows count down from the top.
  let top = size.height - gap - Double(row) * (cell.height + labelHeight + gap)
  (item.label as NSString).draw(at: NSPoint(x: x, y: top - 40), withAttributes: attributes)
  item.image.draw(in: NSRect(x: x, y: top - labelHeight - cell.height, width: cell.width, height: cell.height))
}
NSGraphicsContext.restoreGraphicsState()
try! bitmap.representation(using: .png, properties: [:])!.write(to: output)
print("wrote \(output.path) \(Int(size.width))x\(Int(size.height))")
