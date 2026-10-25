import Foundation

/// Reuses parsing across ordinary SwiftUI updates without retaining unbounded reply prefixes.
/// Unchecked: its caches are NSCaches, which are thread-safe, of immutable entries, and its
/// streamed replies are guarded by a lock.
final class MarkdownCache: @unchecked Sendable {
  static let shared = MarkdownCache()
  private final class Entry: NSObject {
    let blocks: [MarkdownBlock]
    init(_ blocks: [MarkdownBlock]) { self.blocks = blocks }
  }
  private final class Inline: NSObject {
    let value: AttributedString
    init(_ value: AttributedString) { self.value = value }
  }
  /// A reply still streaming: its text up to the last block no later text can change, that
  /// text's blocks, and the latest full parse.
  private struct Stream {
    var settled = ""
    var settledBlocks: [MarkdownBlock] = []
    var text = ""
    var blocks: [MarkdownBlock] = []
  }
  private let cache = NSCache<NSString, Entry>()
  private let inline = NSCache<NSString, Inline>()
  private let code = NSCache<NSString, Inline>()
  private let lock = NSLock()
  private var streams: [Stream] = []
  /// Replies streaming at once, counting each Markdown part of a reply with cards.
  static let streamLimit = 4
  init() {
    cache.countLimit = 64; cache.totalCostLimit = 4 * 1024 * 1024
    inline.countLimit = 512; inline.totalCostLimit = 2 * 1024 * 1024
    code.countLimit = 64; code.totalCostLimit = 2 * 1024 * 1024
  }
  func blocks(_ text: String) -> [MarkdownBlock] {
    let key = text as NSString
    if let cached = cache.object(forKey: key) { return cached.blocks }
    let blocks = Markdown.parse(text)
    // Large content still renders, but cannot evict every ordinary answer from the cache.
    if text.utf16.count <= 100_000 { cache.setObject(Entry(blocks), forKey: key, cost: text.utf16.count * 4) }
    return blocks
  }
  /// A reply still streaming. Each patch is a longer copy of the last, so instead of caching every
  /// prefix, which would evict finished replies, this parses only from the last settled block
  /// and keeps a few streams of its own. `settled` counts the blocks that can no longer change.
  func streamingBlocks(_ text: String) -> (blocks: [MarkdownBlock], settled: Int) {
    let source = Markdown.unifiedNewlines(text)
    let base: Stream = lock.withLock {
      if let index = streams.firstIndex(where: { $0.text == source }) { return streams[index] }
      return streams.filter { source.utf8.starts(with: $0.settled.utf8) }
        .max { $0.settled.utf8.count < $1.settled.utf8.count } ?? Stream()
    }
    if base.text == source { return (base.blocks, base.settledBlocks.count) }
    let tail = String(source[source.utf8.index(source.startIndex, offsetBy: base.settled.utf8.count)...])
    let parsed = Markdown.parseTail(tail)
    var next = base
    next.text = source
    next.blocks = base.settledBlocks + parsed.blocks
    if parsed.settledBytes > 0 {
      next.settled += String(tail[..<tail.utf8.index(tail.startIndex, offsetBy: parsed.settledBytes)])
      next.settledBlocks += parsed.blocks[..<parsed.settledBlocks]
    }
    lock.withLock {
      // The stream this one grew from is replaced; the oldest goes when there are too many.
      streams.removeAll { $0.settled == base.settled && $0.text == base.text }
      streams.insert(next, at: 0)
      if streams.count > Self.streamLimit { streams.removeLast(streams.count - Self.streamLimit) }
    }
    return (next.blocks, next.settledBlocks.count)
  }
  /// Inline Markdown as attributed text, converted once per paragraph instead of on every render.
  /// `keep` is false for a streamed reply's unsettled blocks, which change with every patch.
  func attributed(_ text: String, keep: Bool = true) -> AttributedString {
    let key = text as NSString
    if let cached = inline.object(forKey: key) { return cached.value }
    let value = Markdown.attributed(text)
    if keep, text.utf16.count <= 100_000 { inline.setObject(Inline(value), forKey: key, cost: text.utf16.count * 8) }
    return value
  }
  /// A fenced code block colored by `SyntaxHighlighter`, or nil for a language it does not know.
  /// Only settled blocks are colored: a block still streaming changes with every patch, and its
  /// fence may not be closed yet. `style` is the app's one theme, so it is not part of the key.
  func highlighted(_ text: String, language: String?, settled: Bool,
    style: (SyntaxToken.Kind) -> AttributeContainer) -> AttributedString?
  {
    guard settled, let language else { return nil }
    let key = "\(SyntaxHighlighter.normalized(language))\u{0}\(text)" as NSString
    if let cached = code.object(forKey: key) { return cached.value }
    guard let tokens = SyntaxHighlighter.tokens(text, language: language) else { return nil }
    let value = SyntaxHighlighter.attributed(tokens, style: style)
    code.setObject(Inline(value), forKey: key, cost: text.utf16.count * 8)
    return value
  }
  func clear() {
    cache.removeAllObjects()
    inline.removeAllObjects()
    code.removeAllObjects()
    lock.withLock { streams.removeAll() }
  }
}
