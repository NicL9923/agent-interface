import Foundation

/// One run of a revised draft: kept, added or removed, as the web's src/shared/draft-diff.ts names it.
struct DiffPart: Codable, Equatable {
  enum Kind: String, Codable { case same, added, removed }
  var kind: Kind
  var text: String
}
/// One recipient and whether the revision kept, added or removed it.
struct AddressPart: Equatable { var kind: DiffPart.Kind; var address: String }
/// What changed from an earlier draft, field by field.
struct DraftChanges: Equatable {
  var to: [AddressPart]
  var cc: [AddressPart]
  var subject: [DiffPart]
  var body: [DiffPart]
  var changed: Bool
}
/// The draft an email card revises and what changed since it.
struct DraftRevision: Equatable {
  var previousTitle: String
  var changes: DraftChanges
}

/// Word changes between an email draft and the draft it revises. This mirrors the web's
/// src/shared/draft-diff.ts token for token; ios/AgentInterfaceTests/Vectors/draft-diff.json holds
/// both to the same output, so keep tokens, tie-breaks and grouping identical when changing either.
enum DraftDiff {
  /// Past this many compared token pairs, after the shared start and end, the middle shows as replaced whole.
  static let cellLimit = 1_000_000
  private static let spaces: Set<Unicode.Scalar> = [" ", "\t", "\r", "\n"]
  /// Runs of spaces, tabs and line breaks, and runs of everything else. Scalars, not Characters:
  /// Swift reads "\r\n" as one Character, and JavaScript splits it.
  static func tokens(_ text: String) -> [String] {
    var result: [String] = [], current = String.UnicodeScalarView(), blank = false
    for scalar in text.unicodeScalars {
      let space = spaces.contains(scalar)
      if !current.isEmpty && space != blank { result.append(String(current)); current = String.UnicodeScalarView() }
      blank = space
      current.append(scalar)
    }
    if !current.isEmpty { result.append(String(current)) }
    return result
  }
  private static func isBlank(_ text: String) -> Bool { !text.unicodeScalars.isEmpty && text.unicodeScalars.allSatisfy(spaces.contains) }
  /// Code-unit equality, as JavaScript compares. Swift's == would also match canonically equivalent text.
  private static func same(_ a: String, _ b: String) -> Bool { a.utf16.elementsEqual(b.utf16) }

  static func words(_ before: String, _ after: String, limit: Int = cellLimit) -> [DiffPart] {
    let a = tokens(before), b = tokens(after)
    var start = 0
    while start < a.count && start < b.count && same(a[start], b[start]) { start += 1 }
    var endA = a.count, endB = b.count
    while endA > start && endB > start && same(a[endA - 1], b[endB - 1]) { endA -= 1; endB -= 1 }
    var raw = a[0..<start].map { DiffPart(kind: .same, text: $0) }
    let n = endA - start, m = endB - start
    if n * m > limit {
      raw += a[start..<endA].map { DiffPart(kind: .removed, text: $0) } + b[start..<endB].map { DiffPart(kind: .added, text: $0) }
    } else {
      // lengths[i * (m + 1) + j]: the longest common run of a[start + i...] and b[start + j...].
      var lengths = [Int32](repeating: 0, count: (n + 1) * (m + 1))
      if n > 0 && m > 0 {
        for i in stride(from: n - 1, through: 0, by: -1) {
          for j in stride(from: m - 1, through: 0, by: -1) {
            lengths[i * (m + 1) + j] = same(a[start + i], b[start + j]) ? lengths[(i + 1) * (m + 1) + j + 1] + 1
              : max(lengths[(i + 1) * (m + 1) + j], lengths[i * (m + 1) + j + 1])
          }
        }
      }
      var i = 0, j = 0
      while i < n && j < m {
        if same(a[start + i], b[start + j]) { raw.append(DiffPart(kind: .same, text: a[start + i])); i += 1; j += 1 }
        // On a tie, removal goes first.
        else if lengths[(i + 1) * (m + 1) + j] >= lengths[i * (m + 1) + j + 1] { raw.append(DiffPart(kind: .removed, text: a[start + i])); i += 1 }
        else { raw.append(DiffPart(kind: .added, text: b[start + j])); j += 1 }
      }
      while i < n { raw.append(DiffPart(kind: .removed, text: a[start + i])); i += 1 }
      while j < m { raw.append(DiffPart(kind: .added, text: b[start + j])); j += 1 }
    }
    raw += a[endA...].map { DiffPart(kind: .same, text: $0) }
    return group(raw)
  }
  /// Joins runs, folds a lone space between two changes into them, and puts each change's removals before its additions.
  private static func group(_ raw: [DiffPart]) -> [DiffPart] {
    var merged: [DiffPart] = []
    for part in raw {
      if let last = merged.last, last.kind == part.kind { merged[merged.count - 1].text += part.text } else { merged.append(part) }
    }
    var parts: [DiffPart] = [], removed = "", added = ""
    func flush() {
      if !removed.isEmpty { parts.append(DiffPart(kind: .removed, text: removed)) }
      if !added.isEmpty { parts.append(DiffPart(kind: .added, text: added)) }
      removed = ""; added = ""
    }
    for (index, part) in merged.enumerated() {
      let between = part.kind == .same && isBlank(part.text) && index > 0 && index < merged.count - 1
      if part.kind == .removed || between { removed += part.text }
      if part.kind == .added || between { added += part.text }
      if part.kind == .same && !between { flush(); parts.append(part) }
    }
    flush()
    return parts
  }
  /// Recipient lists compare address by address: an address holds no spaces, so each is one token.
  static func addresses(_ before: [String]?, _ after: [String]?) -> [AddressPart] {
    words((before ?? []).joined(separator: " "), (after ?? []).joined(separator: " ")).flatMap { part in
      part.text.split(separator: " ").map { AddressPart(kind: part.kind, address: String($0)) }
    }
  }
  static func changes(from previous: ReplyCard, to current: ReplyCard) -> DraftChanges {
    let to = addresses(previous.to, current.to), cc = addresses(previous.cc, current.cc)
    let subject = words(previous.subject ?? "", current.subject ?? ""), body = words(previous.body ?? "", current.body ?? "")
    let changed = to.contains { $0.kind != .same } || cc.contains { $0.kind != .same } || (subject + body).contains { $0.kind != .same }
    return DraftChanges(to: to, cc: cc, subject: subject, body: body, changed: changed)
  }
  /// Where an email card sits: the reply's message ID and the card's ID.
  static func key(_ messageId: String, _ cardId: String) -> String { messageId + "\n" + cardId }
  /// The earlier draft each email card revises, by `key`. Only explicit lineage counts: a card's
  /// `revises` names the `draftId` of a card earlier in this conversation, and the latest such card
  /// wins. Subjects and recipients are never matched. A card naming itself or a later card revises nothing.
  static func previousDrafts(_ messages: [Message]) -> [String: ReplyCard] {
    var drafts: [String: ReplyCard] = [:], revisions: [String: ReplyCard] = [:]
    for message in messages where message.role == "assistant" {
      for card in ReplyCards.parse(message.text).flatMap({ $0.cards ?? [] }) where card.type == "email" {
        if let revises = card.lineage.revises, let previous = drafts[revises] { revisions[key(message.id, card.id)] = previous }
        if let draftId = card.lineage.draftId { drafts[draftId] = card }
      }
    }
    return revisions
  }
  static func revisions(_ messages: [Message]) -> [String: DraftRevision] {
    var result: [String: DraftRevision] = [:]
    let previous = previousDrafts(messages)
    guard !previous.isEmpty else { return result }
    for message in messages where message.role == "assistant" {
      for card in ReplyCards.parse(message.text).flatMap({ $0.cards ?? [] }) {
        if let earlier = previous[key(message.id, card.id)] {
          result[key(message.id, card.id)] = DraftRevision(previousTitle: earlier.title, changes: changes(from: earlier, to: card))
        }
      }
    }
    return result
  }
}

/// A lineage field read leniently: anything but a string, including null, reads as absent, so a
/// malformed ID drops the lineage and never the draft, as on the web.
struct LenientId: Decodable, Equatable {
  var value: String?
  init(_ value: String?) { self.value = value }
  init(from decoder: Decoder) throws { value = try? decoder.singleValueContainer().decode(String.self) }
}
extension ReplyCard {
  /// The card's valid draft ID and the ID it revises. A card cannot revise itself.
  var lineage: (draftId: String?, revises: String?) {
    let draftId = (self.draftId?.value).flatMap { ReplyCards.validId($0) ? $0 : nil }
    let revises = (self.revises?.value).flatMap { ReplyCards.validId($0) && $0 != draftId ? $0 : nil }
    return (draftId, revises)
  }
}
