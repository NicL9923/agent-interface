import Foundation

/// Reuses parsing across ordinary SwiftUI updates without retaining unbounded reply prefixes.
/// Unchecked: its only state is an NSCache, which is thread-safe, of immutable entries.
final class MarkdownCache: @unchecked Sendable {
  static let shared = MarkdownCache()
  private final class Entry: NSObject {
    let blocks: [MarkdownBlock]
    init(_ blocks: [MarkdownBlock]) { self.blocks = blocks }
  }
  private let cache = NSCache<NSString, Entry>()
  init() { cache.countLimit = 64; cache.totalCostLimit = 4 * 1024 * 1024 }
  func blocks(_ text: String) -> [MarkdownBlock] {
    let key = text as NSString
    if let cached = cache.object(forKey: key) { return cached.blocks }
    let blocks = Markdown.parse(text)
    // Large content still renders, but cannot evict every ordinary answer from the cache.
    if text.utf16.count <= 100_000 { cache.setObject(Entry(blocks), forKey: key, cost: text.utf16.count * 4) }
    return blocks
  }
  func clear() { cache.removeAllObjects() }
}
