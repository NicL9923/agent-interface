import AppIntents
import Foundation
import os

/// An assistant as Siri, Shortcuts and the widget's settings see it. It exists only while the app's
/// App Group snapshot does, so it is per account and disappears on sign-out like the snapshot.
/// The snapshot never holds the sign-in token, so neither do these entities.
struct AssistantEntity: AppEntity, Identifiable, Hashable {
  static var typeDisplayRepresentation: TypeDisplayRepresentation { "Assistant" }
  static var defaultQuery: AssistantEntityQuery { AssistantEntityQuery() }
  var id: String
  var name: String
  var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }
  init(id: String, name: String) { self.id = id; self.name = name }
  init(_ assistant: WidgetSnapshot.Assistant) { self.init(id: assistant.id, name: assistant.name) }
  /// The snapshot's order: who needs you, who is working, pins, then the latest conversation.
  static func all(in snapshot: WidgetSnapshot?) -> [AssistantEntity] { snapshot?.ordered.map(AssistantEntity.init) ?? [] }
}

struct AssistantEntityQuery: EntityStringQuery {
  /// Where the snapshot lives. Tests point it at a temporary file.
  /// Locked because intents read it on their own tasks while tests change it.
  private static let snapshotLocation = OSAllocatedUnfairLock<URL?>(initialState: WidgetSnapshotStore.defaultURL)
  static var snapshotURL: URL? {
    get { snapshotLocation.withLock { $0 } }
    set { snapshotLocation.withLock { $0 = newValue } }
  }
  init() {}
  private var all: [AssistantEntity] { AssistantEntity.all(in: WidgetSnapshotStore.read(from: Self.snapshotURL)) }
  /// In the order asked for. An assistant that is gone is left out, which Shortcuts shows as missing.
  func entities(for identifiers: [String]) async throws -> [AssistantEntity] {
    let known = Dictionary(all.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
    return identifiers.compactMap { known[$0] }
  }
  func entities(matching string: String) async throws -> [AssistantEntity] {
    let words = string.trimmingCharacters(in: .whitespacesAndNewlines)
    return words.isEmpty ? all : all.filter { $0.name.localizedStandardContains(words) }
  }
  func suggestedEntities() async throws -> [AssistantEntity] { all }
}

/// The Assistants widget's settings. Choosing none keeps the original behavior: everyone, with
/// the people who need you first.
struct SelectAssistantsIntent: WidgetConfigurationIntent {
  static var title: LocalizedStringResource { "Choose assistants" }
  static var description: IntentDescription { IntentDescription("Pick the assistants this widget shows. With none picked, it shows who needs you first.") }
  @Parameter(title: "Assistants") var assistants: [AssistantEntity]?
  init() {}
  func shown(in snapshot: WidgetSnapshot?) -> WidgetSnapshot? { snapshot?.showing(only: assistants?.map(\.id) ?? []) }
}

extension WidgetSnapshot {
  /// Only the chosen assistants, so headers and counts describe what the widget shows. No choice,
  /// or a choice that has since left the household, shows everyone rather than an empty widget.
  func showing(only ids: [String]) -> WidgetSnapshot {
    let chosen = assistants.filter { ids.contains($0.id) }
    guard !chosen.isEmpty else { return self }
    var copy = self
    copy.assistants = chosen
    return copy
  }
}
