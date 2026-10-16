import ActivityKit
import SwiftUI
import WidgetKit

@main struct AgentInterfaceWidgets: WidgetBundle {
  var body: some Widget {
    AssistantsWidget()
    AssistantsLiveActivity()
  }
}

struct AssistantsEntry: TimelineEntry {
  var date: Date
  var snapshot: WidgetSnapshot?
}

/// Reads only the app's snapshot. The app reloads timelines when it changes; the second entry
/// marks it out of date if the app is not opened again.
struct AssistantsProvider: TimelineProvider {
  func placeholder(in context: Context) -> AssistantsEntry {
    AssistantsEntry(date: Date(), snapshot: WidgetSnapshot(scope: "", generatedAt: Date(), assistants: [
      .init(id: "placeholder", name: "Assistant", activity: "idle", lastMessage: "Ready when you are", lastMessageAt: nil, color: nil, pinned: false),
    ]))
  }
  func getSnapshot(in context: Context, completion: @escaping (AssistantsEntry) -> Void) {
    completion(AssistantsEntry(date: Date(), snapshot: WidgetSnapshotStore.read() ?? placeholder(in: context).snapshot))
  }
  func getTimeline(in context: Context, completion: @escaping (Timeline<AssistantsEntry>) -> Void) {
    let now = Date()
    guard let snapshot = WidgetSnapshotStore.read() else {
      completion(Timeline(entries: [AssistantsEntry(date: now, snapshot: nil)], policy: .never))
      return
    }
    completion(Timeline(entries: snapshot.timelineDates(now: now).map { AssistantsEntry(date: $0, snapshot: snapshot) }, policy: .never))
  }
}

struct AssistantsWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "Assistants", provider: AssistantsProvider()) { entry in
      AssistantsWidgetEntryView(entry: entry)
    }
    .configurationDisplayName("Assistants")
    .description("Who needs you, who is working, and your latest conversations.")
    .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryRectangular, .accessoryCircular, .accessoryInline])
  }
}
struct AssistantsWidgetEntryView: View {
  var entry: AssistantsEntry
  @Environment(\.widgetFamily) private var family
  var body: some View {
    AssistantsWidgetView(snapshot: entry.snapshot, date: entry.date, family: family)
      .containerBackground(for: .widget) {
        if [.systemSmall, .systemMedium, .systemLarge].contains(family) { WidgetPalette.surface } else { Color.clear }
      }
  }
}

struct AssistantsLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: AssistantsActivityAttributes.self) { context in
      ActivityLockScreenView(state: context.state, stale: context.isStale)
        .widgetURL(link(context.state))
    } dynamicIsland: { context in
      let state = context.state
      let stale = context.isStale
      return DynamicIsland {
        DynamicIslandExpandedRegion(.leading) { IslandExpandedLeading(state: state, stale: stale).padding(.leading, 4) }
        DynamicIslandExpandedRegion(.trailing) { IslandExpandedTrailing(state: state, stale: stale).padding(.trailing, 4) }
        DynamicIslandExpandedRegion(.bottom) { IslandExpandedBottom(state: state, stale: stale).padding(.horizontal, 4) }
      } compactLeading: {
        IslandGlyph(state: state, stale: stale).frame(width: 18, height: 18)
      } compactTrailing: {
        IslandCompactTrailing(state: state, stale: stale)
      } minimal: {
        IslandMinimal(state: state, stale: stale)
      }
      .widgetURL(link(state))
      .keylineTint(stale ? nil : WidgetPalette.color(state.hero?.phase))
    }
  }
  private func link(_ state: AssistantActivityState) -> URL { state.hero.map { DeepLink.bot($0.botId) } ?? DeepLink.today }
}
