import Foundation
#if canImport(FoundationModels)
  import FoundationModels
#endif

/// Targeted, zero-latency on-device helpers backed by Apple's `FoundationModels` on iOS 26+.
/// Every helper is strictly optional: on older iOS versions, unsupported hardware, or any model
/// failure, it falls back cleanly with zero user-facing errors and never transmits data off-device.
enum OnDeviceIntelligence {
  /// Injectable text generator for offline unit tests: `(instructions, prompt) -> response`.
  typealias Generator = @Sendable (_ instructions: String, _ prompt: String) async -> String?

  /// Whether Apple's on-device language model is ready on this device right now.
  static var isAvailable: Bool {
    #if canImport(FoundationModels) && !os(watchOS)
      if #available(iOS 26.0, *) {
        return SystemLanguageModel.default.isAvailable
      }
    #endif
    return false
  }

  /// Default on-device generator using `LanguageModelSession` on iOS 26+.
  static let systemGenerator: Generator = { instructions, prompt in
    #if canImport(FoundationModels) && !os(watchOS)
      guard #available(iOS 26.0, *), SystemLanguageModel.default.isAvailable else { return nil }
      do {
        let session = LanguageModelSession(instructions: instructions)
        let response = try await session.respond(to: prompt)
        let cleaned = response.content.trimmingCharacters(in: .whitespacesAndNewlines)
        return cleaned.isEmpty ? nil : cleaned
      } catch {
        return nil
      }
    #else
      return nil
    #endif
  }

  /// Polishes punctuation and capitalization on an offline voice transcript while strictly
  /// preserving every spoken word (so a negation or key detail can never be silently altered).
  /// Falls back to `raw` whenever unavailable or whenever the word sequence changes.
  static func polishTranscript(_ raw: String, using generate: Generator = systemGenerator) async -> String {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, trimmed.count <= 4_000 else { return trimmed }
    let instructions =
      "Add punctuation and capitalization to this voice transcript without adding, removing, or changing any words. Return only the cleaned text."
    guard let result = await generate(instructions, trimmed) else { return trimmed }
    let cleaned = sanitizeSingleBlock(result)
    guard !cleaned.isEmpty,
      cleaned.count <= max(trimmed.count * 2, trimmed.count + 40),
      normalizedWordTokens(cleaned) == normalizedWordTokens(trimmed)
    else { return trimmed }
    return cleaned
  }

  /// Extracts lowercased alphanumeric word tokens so automatic dictation polish can only add
  /// punctuation, casing, or spacing and can never silently drop or replace spoken words.
  static func normalizedWordTokens(_ text: String) -> [String] {
    var tokens: [String] = []
    var current = ""
    for scalar in text.lowercased().unicodeScalars {
      if CharacterSet.alphanumerics.contains(scalar) {
        current.unicodeScalars.append(scalar)
      } else if !current.isEmpty {
        tokens.append(current)
        current = ""
      }
    }
    if !current.isEmpty { tokens.append(current) }
    return tokens
  }

  /// Suggests a concise title (at most 80 characters) when saving a reply or reference.
  static func suggestReferenceTitle(for text: String, using generate: Generator = systemGenerator) async -> String? {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed.count >= 24 else { return nil }
    let excerpt = String(trimmed.prefix(1_200))
    let instructions =
      "Write a concise 3 to 7 word title for this saved note. Return only the title with no quotes or trailing punctuation."
    guard let result = await generate(instructions, excerpt) else { return nil }
    let title = sanitizeTitle(result, limit: 80)
    return title.isEmpty ? nil : title
  }

  /// Suggests a natural short name for a new group chat based on its selected assistant names.
  static func suggestGroupTitle(members: [String], using generate: Generator = systemGenerator) async -> String? {
    let names = members.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
    guard names.count >= 2 else { return nil }
    let instructions =
      "Suggest a short 2 to 4 word group chat name for a room with these assistants. Return only the name with no quotes."
    let prompt = "Assistants: " + names.joined(separator: ", ")
    guard let result = await generate(instructions, prompt) else { return nil }
    let title = sanitizeTitle(result, limit: 100)
    return title.isEmpty ? nil : title
  }

  /// Summarizes a long shared text snippet in the Share Extension into a compact draft note.
  static func summarizeSharedSnippet(_ text: String, using generate: Generator = systemGenerator) async -> String? {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed.count >= 240 else { return nil }
    let excerpt = String(trimmed.prefix(6_000))
    let instructions =
      "Summarize this shared snippet in 2 to 3 concise sentences so the user can review it before sending to an assistant. Preserve URLs, dates, and key facts. Return only the summary."
    guard let result = await generate(instructions, excerpt) else { return nil }
    let summary = sanitizeSingleBlock(result)
    guard !summary.isEmpty, summary.count < trimmed.count else { return nil }
    return summary
  }

  private static func sanitizeSingleBlock(_ value: String) -> String {
    value.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private static func sanitizeTitle(_ value: String, limit: Int) -> String {
    let firstLine = value.components(separatedBy: .newlines).first ?? ""
    var cleaned = firstLine.trimmingCharacters(in: .whitespacesAndNewlines)
    let quotes: Set<Character> = ["\"", "'", "\u{201C}", "\u{201D}"]
    if cleaned.count >= 2, let first = cleaned.first, let last = cleaned.last, quotes.contains(first), quotes.contains(last) {
      cleaned = String(cleaned.dropFirst().dropLast()).trimmingCharacters(in: .whitespacesAndNewlines)
    }
    if cleaned.count > limit {
      cleaned = String(cleaned.prefix(limit)).trimmingCharacters(in: .whitespacesAndNewlines)
    }
    return cleaned
  }
}
