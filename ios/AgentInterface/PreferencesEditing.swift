import Foundation

/// Home sections and followed assistants, edited the same way from Settings and an assistant's
/// profile. Each edit returns a new value for the caller to save through the preferences queue.
/// An assistant belongs to at most one section, and every move keeps it that way.
extension Preferences {
  static let sectionLimit = 30
  static let sectionNameLimit = 100

  /// The section an assistant appears under on home. Older data can list it twice; home uses the first.
  func section(of botId: String) -> BotSection? { sections.first { $0.botIds.contains(botId) } }

  /// Puts an assistant in one section, or in none with a nil id, removing it from every other.
  func moving(bot botId: String, toSection sectionId: String?) -> Preferences {
    var next = self
    for index in next.sections.indices { next.sections[index].botIds.removeAll { $0 == botId } }
    if let sectionId, let index = next.sections.firstIndex(where: { $0.id == sectionId }) {
      next.sections[index].botIds.append(botId)
    }
    return next
  }

  func isFollowing(_ botId: String) -> Bool { followBots.contains(botId) }

  func settingFollow(_ botId: String, _ following: Bool) -> Preferences {
    var next = self
    next.followBots.removeAll { $0 == botId }
    if following { next.followBots.append(botId) }
    return next
  }

  var canAddSection: Bool { sections.count < Self.sectionLimit }

  /// Appends an empty section, or returns nil for a blank name or when the limit is reached.
  func addingSection(named name: String, id: String = UUID().uuidString) -> Preferences? {
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, canAddSection else { return nil }
    var next = self
    next.sections.append(BotSection(id: id, name: String(trimmed.prefix(Self.sectionNameLimit)), botIds: []))
    return next
  }

  /// Keeps the name as typed, up to the server's limit, so editing can pass through a blank name.
  func renamingSection(_ id: String, to name: String) -> Preferences {
    var next = self
    if let index = next.sections.firstIndex(where: { $0.id == id }) {
      next.sections[index].name = String(name.prefix(Self.sectionNameLimit))
    }
    return next
  }

  func removingSection(_ id: String) -> Preferences {
    var next = self
    next.sections.removeAll { $0.id == id }
    return next
  }

  /// List reordering: the sections at `offsets` move, in order, to land before `destination`.
  func movingSections(fromOffsets offsets: IndexSet, toOffset destination: Int) -> Preferences {
    var next = self
    let moved = offsets.filter { next.sections.indices.contains($0) }.map { next.sections[$0] }
    let insertAt = destination - offsets.filter { $0 < destination }.count
    next.sections = next.sections.enumerated().filter { !offsets.contains($0.offset) }.map(\.element)
    next.sections.insert(contentsOf: moved, at: min(max(insertAt, 0), next.sections.count))
    return next
  }
}

extension BotSection {
  /// A section renamed to nothing still needs a readable title.
  var displayName: String {
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? "Untitled section" : trimmed
  }
}
