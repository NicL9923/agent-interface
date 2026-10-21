import CoreSpotlight
import Foundation
import UniformTypeIdentifiers

/// One assistant as Spotlight lists it: a name only, since Spotlight results can show on a locked
/// device and message previews stay in the app.
struct SpotlightRecord: Equatable {
  var id: String
  var title: String
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
    let items = records.map { record -> CSSearchableItem in
      let attributes = CSSearchableItemAttributeSet(contentType: .content)
      attributes.title = record.title
      attributes.contentDescription = "WildBots assistant"
      return CSSearchableItem(uniqueIdentifier: record.id, domainIdentifier: Self.domain, attributeSet: attributes)
    }
    CSSearchableIndex.default().indexSearchableItems(items)
  }
  func delete(ids: [String]) { CSSearchableIndex.default().deleteSearchableItems(withIdentifiers: ids) }
  func deleteAll() { CSSearchableIndex.default().deleteSearchableItems(withDomainIdentifiers: [Self.domain]) }
}

/// Keeps Spotlight listing exactly the signed-in account's assistants. Core Spotlight can only
/// delete what it is told to, so the last indexed set is remembered: an assistant that leaves is
/// removed by name, and signing out or switching accounts clears the whole domain.
struct AssistantSpotlight {
  var index: SpotlightIndexing
  var defaults: UserDefaults = .standard
  @MainActor static let system = AssistantSpotlight(index: SystemSpotlightIndex())
  private struct Indexed: Codable, Equatable { var scope: String; var records: [String: String] }
  private static let key = "spotlight.assistants"

  /// Returns whether anything changed, so callers can refresh Siri's list of assistant names.
  @discardableResult func sync(_ snapshot: WidgetSnapshot?) -> Bool {
    let stored = defaults.data(forKey: Self.key).flatMap { try? JSONDecoder().decode(Indexed.self, from: $0) }
    guard let snapshot else {
      guard stored != nil else { return false }
      index.deleteAll()
      defaults.removeObject(forKey: Self.key)
      return true
    }
    let next = Indexed(scope: snapshot.scope, records: Dictionary(snapshot.assistants.map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first }))
    if next == stored { return false }
    if let stored, stored.scope != next.scope {
      index.deleteAll()
    } else if let stored {
      let gone = stored.records.keys.filter { next.records[$0] == nil }
      if !gone.isEmpty { index.delete(ids: gone.sorted()) }
    }
    let changed = next.records.filter { stored?.scope == next.scope ? stored?.records[$0.key] != $0.value : true }
    index.index(changed.map { SpotlightRecord(id: $0.key, title: $0.value) }.sorted { $0.id < $1.id })
    if let data = try? JSONEncoder().encode(next) { defaults.set(data, forKey: Self.key) }
    return true
  }
}
