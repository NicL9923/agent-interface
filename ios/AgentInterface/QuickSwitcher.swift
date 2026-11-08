import SwiftUI

/// A place the quick switcher can open.
enum QuickSwitchTarget: Hashable {
  case bot(String), room(String), today, search, usage, settings
  /// The typed words go into this assistant's draft, the main assistant's.
  case ask(String, String)
}

/// What the quick switcher lists for a query: matching assistants, pinned first, then the
/// household views whose names match. Return opens the first.
enum QuickSwitch {
  struct Entry: Identifiable, Equatable {
    var target: QuickSwitchTarget
    var title: String
    var symbol: String
    var id: QuickSwitchTarget { target }
  }
  static let places: [Entry] = [
    Entry(target: .today, title: "Today", symbol: "calendar"),
    Entry(target: .search, title: "Search & saved", symbol: "magnifyingglass"),
    Entry(target: .usage, title: "Usage", symbol: "gauge.with.dots.needle.50percent"),
    Entry(target: .settings, title: "Settings", symbol: "gearshape"),
  ]
  static func entries(query: String, bots: [Bot], pinned: [String], rooms: [GroupRoom] = [], main: String? = nil) -> [Entry] {
    let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
    func matches(_ title: String) -> Bool { needle.isEmpty || title.localizedStandardContains(needle) }
    let mainBot = main.flatMap { id in bots.first { $0.id == id } }
    let rest = bots.filter { $0.id != mainBot?.id }
    let ordered = (mainBot.map { [$0] } ?? []) + rest.filter { pinned.contains($0.id) }.sorted { (pinned.firstIndex(of: $0.id) ?? 0) < (pinned.firstIndex(of: $1.id) ?? 0) }
      + rest.filter { !pinned.contains($0.id) }
    let assistants = ordered.filter { matches($0.name) }.map { Entry(target: .bot($0.id), title: $0.name, symbol: "person.crop.circle") }
    let chats = GroupRows.ordered(rooms).filter { matches($0.name) }.map { Entry(target: .room($0.id), title: $0.name, symbol: "bubble.left.and.bubble.right") }
    // With a main assistant, typed words can go straight to it, after everything they name.
    let ask = mainBot.flatMap { bot in needle.isEmpty ? nil : Entry(target: .ask(bot.id, needle), title: "Ask \(bot.name): \u{201C}\(needle)\u{201D}", symbol: "sparkles") }
    return assistants + chats + places.filter { matches($0.title) } + (ask.map { [$0] } ?? [])
  }
}

/// Cmd+K on a hardware keyboard: type to filter assistants and household views, Return opens the
/// first, Escape closes.
struct QuickSwitcher: View {
  var choose: (QuickSwitchTarget) -> Void
  @Environment(AppStore.self) private var store
  @Environment(\.dismiss) private var dismiss
  @State private var query = ""
  @FocusState private var focused: Bool
  private var entries: [QuickSwitch.Entry] {
    QuickSwitch.entries(query: query, bots: store.bootstrap?.bots ?? [], pinned: store.homePreferences?.favorites ?? [], rooms: store.groupCatalog?.rooms ?? [],
      main: store.bootstrap?.preferences.mainBotId)
  }
  var body: some View {
    NavigationStack {
      List {
        Section {
          TextField("Go to an assistant, group chat or view", text: $query).focused($focused).submitLabel(.go)
            .autocorrectionDisabled().textInputAutocapitalization(.never)
            .onSubmit { if let first = entries.first { choose(first.target) } }
            .accessibilityIdentifier("quickSwitcherField")
        }
        Section {
          ForEach(Array(entries.enumerated()), id: \.element.id) { index, entry in
            Button { choose(entry.target) } label: { row(entry, first: index == 0) }
              .accessibilityIdentifier(identifier(entry.target))
          }
          if entries.isEmpty { Text("Nothing matches \u{201C}\(query)\u{201D}.").foregroundStyle(.secondary) }
        } footer: { Text("Return opens the first result.") }
      }.householdListBackground().navigationTitle("Go to").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
        .onAppear { Task { @MainActor in focused = true } }
    }.presentationDetents([.medium, .large])
  }
  @ViewBuilder private func row(_ entry: QuickSwitch.Entry, first: Bool) -> some View {
    HStack(spacing: 12) {
      if case .bot(let id) = entry.target, let bot = store.bootstrap?.bots.first(where: { $0.id == id }) {
        AvatarView(avatar: bot.avatar ?? AvatarConfig(), size: 32, name: bot.name, forceReducedMotion: true)
      } else {
        Image(systemName: entry.symbol).foregroundStyle(Palette.accent).frame(width: 32)
      }
      Text(entry.title).foregroundStyle(.primary).frame(maxWidth: .infinity, alignment: .leading)
      if first { Image(systemName: "return").font(.caption).foregroundStyle(.secondary).accessibilityHidden(true) }
    }.frame(minHeight: 44).contentShape(Rectangle())
  }
  private func identifier(_ target: QuickSwitchTarget) -> String {
    switch target {
    case .bot(let id): "quickSwitch.\(id)"
    case .today: "quickSwitch.today"
    case .room(let id): "quickSwitch.room.\(id)"
    case .search: "quickSwitch.search"
    case .usage: "quickSwitch.usage"
    case .settings: "quickSwitch.settings"
    case .ask: "quickSwitch.ask"
    }
  }
}
