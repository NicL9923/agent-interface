import SwiftUI

/// A place the quick switcher can open.
enum QuickSwitchTarget: Hashable {
  case bot(String), today, groups, search
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
    Entry(target: .groups, title: "Group chats", symbol: "bubble.left.and.bubble.right"),
    Entry(target: .search, title: "Search & saved", symbol: "magnifyingglass"),
  ]
  static func entries(query: String, bots: [Bot], pinned: [String]) -> [Entry] {
    let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
    func matches(_ title: String) -> Bool { needle.isEmpty || title.localizedStandardContains(needle) }
    let ordered = bots.filter { pinned.contains($0.id) }.sorted { (pinned.firstIndex(of: $0.id) ?? 0) < (pinned.firstIndex(of: $1.id) ?? 0) }
      + bots.filter { !pinned.contains($0.id) }
    let assistants = ordered.filter { matches($0.name) }.map { Entry(target: .bot($0.id), title: $0.name, symbol: "person.crop.circle") }
    return assistants + places.filter { matches($0.title) }
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
    QuickSwitch.entries(query: query, bots: store.bootstrap?.bots ?? [], pinned: store.homePreferences?.favorites ?? [])
  }
  var body: some View {
    NavigationStack {
      List {
        Section {
          TextField("Go to an assistant or view", text: $query).focused($focused).submitLabel(.go)
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
    case .groups: "quickSwitch.groups"
    case .search: "quickSwitch.search"
    }
  }
}
