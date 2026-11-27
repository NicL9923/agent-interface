import CoreSpotlight
import Foundation
import UniformTypeIdentifiers

/// One item as Spotlight lists it: title only, since Spotlight results can show on a locked
/// device and message previews stay strictly inside the app.
struct SpotlightRecord: Equatable {
  enum Kind: String, Codable, Equatable {
    case assistant
    case group
    case routine
    case saved
  }
  var id: String
  var title: String
  var kind: Kind = .assistant

  var description: String {
    switch kind {
    case .assistant: "WildBots assistant"
    case .group: "WildBots group chat"
    case .routine: "WildBots routine"
    case .saved: "WildBots saved item"
    }
  }
}

/// The part of Core Spotlight this app uses, so tests can watch what is indexed and removed.
protocol SpotlightIndexing {
  func index(_ records: [SpotlightRecord])
  func delete(ids: [String])
  func deleteAll()
}

struct SystemSpotlightIndex: SpotlightIndexing {
  static let domain = "dev.agentinterface.assistants"
  func index(_ records: [SpotlightRecord]) {
    guard !records.isEmpty else { return }
    let items = records.map { record -> CSSearchableItem in
      let attributes = CSSearchableItemAttributeSet(contentType: .content)
      attributes.title = record.title
      attributes.contentDescription = record.description
      return CSSearchableItem(uniqueIdentifier: record.id, domainIdentifier: Self.domain, attributeSet: attributes)
    }
    CSSearchableIndex.default().indexSearchableItems(items)
  }
  func delete(ids: [String]) {
    guard !ids.isEmpty else { return }
    CSSearchableIndex.default().deleteSearchableItems(withIdentifiers: ids)
  }
  func deleteAll() { CSSearchableIndex.default().deleteSearchableItems(withDomainIdentifiers: [Self.domain]) }
}

/// Keeps Spotlight listing exactly the signed-in account's assistants, group chats, routines
/// (by name), and saved references (title-only for privacy). Signing out or switching accounts
/// clears the entire domain immediately.
struct AssistantSpotlight {
  var index: SpotlightIndexing
  var defaults: UserDefaults = .standard
  @MainActor static let system = AssistantSpotlight(index: SystemSpotlightIndex())

  private struct Indexed: Codable, Equatable { var scope: String; var records: [String: String] }
  private static let assistantsKey = "spotlight.assistants"
  private static let groupsKey = "spotlight.groups"
  private static let routinesKey = "spotlight.routines"
  private static let savedKey = "spotlight.saved"
  private static let allKeys = [assistantsKey, groupsKey, routinesKey, savedKey]

  static let groupPrefix = "group:"
  static let routinePrefix = "routine:"
  static let savedPrefix = "saved:"

  /// Maps a Core Spotlight unique identifier back to its in-app `DeepLink`.
  /// Bare identifiers remain assistant IDs for backwards compatibility.
  static func deepLink(for identifier: String) -> URL? {
    if identifier.hasPrefix(groupPrefix) {
      let roomId = String(identifier.dropFirst(groupPrefix.count))
      return roomId.isEmpty ? nil : DeepLink.group(roomId)
    }
    if identifier.hasPrefix(routinePrefix) {
      let rest = String(identifier.dropFirst(routinePrefix.count))
      let parts = rest.split(separator: ":", maxSplits: 1).map(String.init)
      guard parts.count == 2, !parts[0].isEmpty, !parts[1].isEmpty else { return nil }
      return DeepLink.routine(botId: parts[0], routineId: parts[1])
    }
    if identifier.hasPrefix(savedPrefix) {
      return DeepLink.saved
    }
    return identifier.isEmpty ? nil : DeepLink.bot(identifier)
  }

  /// Syncs assistants from the widget snapshot. Returns whether anything changed, so callers can
  /// refresh Siri's list of assistant names. Signing out (`nil`) clears every Spotlight category.
  @discardableResult func sync(_ snapshot: WidgetSnapshot?) -> Bool {
    guard let snapshot else {
      let hadAny = Self.allKeys.contains { defaults.data(forKey: $0) != nil }
      guard hadAny else { return false }
      index.deleteAll()
      for key in Self.allKeys { defaults.removeObject(forKey: key) }
      return true
    }
    let records = Dictionary(snapshot.assistants.map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first })
    return syncCategory(key: Self.assistantsKey, kind: .assistant, scope: snapshot.scope, records: records)
  }

  /// Syncs group chat room names (title-only) for the active account scope.
  @discardableResult func syncGroups(_ rooms: [GroupRoom], scope: String?) -> Bool {
    guard let scope else { return false }
    let records = Dictionary(
      rooms.compactMap { room -> (String, String)? in
        let name = room.name.trimmingCharacters(in: .whitespacesAndNewlines)
        return name.isEmpty ? nil : (Self.groupPrefix + room.id, name)
      },
      uniquingKeysWith: { first, _ in first }
    )
    return syncCategory(key: Self.groupsKey, kind: .group, scope: scope, records: records)
  }

  /// Syncs routine names (name-only) for the active account scope.
  @discardableResult func syncRoutines(_ routines: [Routine], scope: String?) -> Bool {
    guard let scope else { return false }
    let records = Dictionary(
      routines.compactMap { routine -> (String, String)? in
        let name = routine.name.trimmingCharacters(in: .whitespacesAndNewlines)
        return name.isEmpty ? nil : ("\(Self.routinePrefix)\(routine.botId):\(routine.id)", name)
      },
      uniquingKeysWith: { first, _ in first }
    )
    return syncCategory(key: Self.routinesKey, kind: .routine, scope: scope, records: records)
  }

  /// Syncs saved reference titles (title-only, never message bodies) for the active account scope.
  @discardableResult func syncSaved(_ items: [SavedItem], scope: String?) -> Bool {
    guard let scope else { return false }
    let records = Dictionary(
      items.compactMap { item -> (String, String)? in
        let title = item.title.trimmingCharacters(in: .whitespacesAndNewlines)
        return title.isEmpty ? nil : (Self.savedPrefix + item.id, title)
      },
      uniquingKeysWith: { first, _ in first }
    )
    return syncCategory(key: Self.savedKey, kind: .saved, scope: scope, records: records)
  }

  private func syncCategory(key: String, kind: SpotlightRecord.Kind, scope: String, records: [String: String]) -> Bool {
    let stored = defaults.data(forKey: key).flatMap { try? JSONDecoder().decode(Indexed.self, from: $0) }
    let next = Indexed(scope: scope, records: records)
    if next == stored { return false }
    // A different account clears the entire domain and every category's stored state.
    if let stored, stored.scope != next.scope {
      index.deleteAll()
      for otherKey in Self.allKeys where otherKey != key { defaults.removeObject(forKey: otherKey) }
    } else if let stored {
      let gone = stored.records.keys.filter { next.records[$0] == nil }
      if !gone.isEmpty { index.delete(ids: gone.sorted()) }
    }
    let changed = next.records.filter { stored?.scope == next.scope ? stored?.records[$0.key] != $0.value : true }
    let toIndex = changed.map { SpotlightRecord(id: $0.key, title: $0.value, kind: kind) }.sorted { $0.id < $1.id }
    // Keep existing behavior: assistants index call runs even when empty for backwards compatibility with callers/tests.
    if !toIndex.isEmpty || kind == .assistant {
      index.index(toIndex)
    }
    if let data = try? JSONEncoder().encode(next) { defaults.set(data, forKey: key) }
    return true
  }
}
