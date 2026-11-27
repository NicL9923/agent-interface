import AppIntents
import Foundation
import SwiftUI

/// Opens an assistant's chat and starts live Talk, or a voice message where Hermes offers no live
/// Talk: the action behind the Talk to assistant control in Control Center, on the Lock Screen and
/// on the Action button. It is built into both the app and the widget extension, as controls that
/// open the app must be.
struct TalkToAssistantIntent: OpenIntent {
  static var title: LocalizedStringResource { "Talk to assistant" }
  static var description: IntentDescription { IntentDescription("Opens a conversation with one of your assistants and starts talking with it out loud.") }
  @Parameter(title: "Assistant") var target: AssistantEntity
  init() {}
  init(target: AssistantEntity) { self.target = target }
  @MainActor func perform() async throws -> some IntentResult {
    await IntentLinks.open(DeepLink.bot(target.id, listen: true))
    return .result()
  }
}

/// Opens the Today view from Shortcuts, Siri, or the Control Center "Open Today" control.
struct OpenTodayIntent: AppIntent {
  static var title: LocalizedStringResource { "Open Today" }
  static var description: IntentDescription { IntentDescription("Opens what is new, waiting and in progress across your assistants.") }
  static var openAppWhenRun: Bool { true }
  init() {}
  var destination: URL { DeepLink.today }
  @MainActor func perform() async throws -> some IntentResult {
    await IntentLinks.open(destination)
    return .result()
  }
}

/// Hook set by the main app at launch so `CheckAssistantsIntent` can refresh the snapshot with
/// the app's own sign-in when run in the app process, while still compiling in the widget extension
/// (which never holds a sign-in token).
@MainActor enum CheckAssistantsRefresh {
  static var handler: ((Duration) async -> Void)?
}

enum CheckAssistantsError: Error, CustomLocalizedStringResourceConvertible {
  case signedOut
  var localizedStringResource: LocalizedStringResource {
    "Open WildBots and sign in first."
  }
}

/// Who needs the person and who is working, said and shown without opening the app. Built into both
/// the app and widget extension so the Control Center "Check on assistants" control runs it directly.
struct CheckAssistantsIntent: AppIntent {
  static var title: LocalizedStringResource { "Check on assistants" }
  static var description: IntentDescription {
    IntentDescription("Tells you which assistants need you and which are working, without opening WildBots.")
  }
  static var openAppWhenRun: Bool { false }
  init() {}
  /// Siri gives up after a few seconds; a slow server leaves the snapshot as it was.
  static let refreshPatience: Duration = .seconds(4)
  @MainActor func perform() async throws -> some IntentResult & ProvidesDialog & ShowsSnippetView {
    let url = AssistantEntityQuery.snapshotURL
    if WidgetSnapshotStore.read(from: url).map({ Date().timeIntervalSince($0.generatedAt) > 60 }) ?? true {
      await CheckAssistantsRefresh.handler?(Self.refreshPatience)
    }
    guard let snapshot = WidgetSnapshotStore.read(from: url) else { throw CheckAssistantsError.signedOut }
    let now = Date()
    return .result(dialog: IntentDialog(stringLiteral: snapshot.spokenSummary(at: now)), view: AssistantStatusSnippet(snapshot: snapshot))
  }
}

extension WidgetSnapshot {
  /// What Siri says: each assistant that needs the person, then who is working, and how old the news is
  /// when the snapshot is stale.
  func spokenSummary(at now: Date) -> String {
    func names(_ list: [Assistant]) -> String { ListFormatter.localizedString(byJoining: list.map(\.name)) }
    let ordered = self.ordered
    let attention = ordered.filter(\.needsAttention), working = ordered.filter(\.isWorking)
    var parts = attention.map { "\($0.name) \($0.activity == "waiting" ? "needs your approval" : "needs your input")." }
    if !working.isEmpty { parts.append("\(names(working)) \(working.count == 1 ? "is" : "are") working.") }
    if parts.isEmpty { parts = ["All caught up. Nobody needs you and nothing is running."] }
    if isStale(at: now) {
      let age = RelativeDateTimeFormatter().localizedString(for: generatedAt, relativeTo: now)
      parts.insert("WildBots last checked \(age), so this may be out of date.", at: 0)
    }
    return parts.joined(separator: " ")
  }
}

/// The card Siri, Shortcuts, and Control Center show under the answer: the same rows as the widget, at most five.
struct AssistantStatusSnippet: View {
  var snapshot: WidgetSnapshot
  var body: some View {
    let rows = snapshot.ordered.filter { $0.needsAttention || $0.isWorking }.prefix(5)
    VStack(alignment: .leading, spacing: 8) {
      if rows.isEmpty {
        Label("All caught up", systemImage: "checkmark.circle.fill").foregroundStyle(WidgetPalette.color(.done))
      }
      ForEach(Array(rows)) { assistant in
        HStack(spacing: 8) {
          AssistantGlyphView(color: WidgetPalette.hex(assistant.color) ?? WidgetPalette.brand).frame(width: 18, height: 18)
          Text(assistant.name).fontWeight(.semibold).lineLimit(1)
          Spacer(minLength: 4)
          Text(assistant.status ?? "").foregroundStyle(WidgetPalette.color(assistant.phase)).lineLimit(1)
        }.font(.subheadline).accessibilityElement(children: .combine)
      }
      Text("Updated \(snapshot.generatedAt, style: .relative) ago").font(.caption2).foregroundStyle(.secondary)
    }.padding()
  }
}

/// The control's setting: which assistant it talks to.
@available(iOS 18.0, *)
struct ChooseTalkAssistantIntent: ControlConfigurationIntent {
  static var title: LocalizedStringResource { "Choose assistant" }
  @Parameter(title: "Assistant") var assistant: AssistantEntity?
  init() {}
}

/// How an intent reaches the app's navigation. In the app the handler opens the link at once.
/// iOS may run the intent in the widget extension instead, which cannot navigate the app, so the
/// link waits in the App Group for the app to open it as it becomes active.
@MainActor enum IntentLinks {
  static var handler: ((URL) async -> Void)?
  static var pendingURL: URL? {
    FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: ShareInbox.group)?
      .appendingPathComponent("Widgets", isDirectory: true).appendingPathComponent("pending-link.json")
  }
  /// A link older than this was not meant for the app's next activation.
  static let patience: TimeInterval = 60
  /// A link and when it was asked for, so the wait does not refresh its deadline.
  struct Pending: Codable, Equatable { var url: URL; var at: Date }

  static func open(_ url: URL, store location: URL? = pendingURL) async {
    if let handler { return await handler(url) }
    guard let location, let data = try? JSONEncoder().encode(Pending(url: url, at: Date())) else { return }
    try? FileManager.default.createDirectory(at: location.deletingLastPathComponent(), withIntermediateDirectories: true)
    try? data.write(to: location, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
  }
  /// The waiting link, once, if it is still fresh.
  static func takePending(from location: URL? = pendingURL, now: Date = Date()) -> Pending? {
    guard let location, let data = try? Data(contentsOf: location) else { return nil }
    try? FileManager.default.removeItem(at: location)
    guard let pending = try? JSONDecoder().decode(Pending.self, from: data), abs(now.timeIntervalSince(pending.at)) < patience else { return nil }
    return pending
  }
}
