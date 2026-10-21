import ActivityKit
import AppIntents
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
/// marks it out of date if the app is not opened again. The widget's settings only narrow it.
struct AssistantsProvider: AppIntentTimelineProvider {
  func placeholder(in context: Context) -> AssistantsEntry {
    AssistantsEntry(date: Date(), snapshot: WidgetSnapshot(scope: "", generatedAt: Date(), assistants: [
      .init(id: "placeholder", name: "Assistant", activity: "idle", lastMessage: "Ready when you are", lastMessageAt: nil, color: nil, pinned: false),
    ]))
  }
  func snapshot(for configuration: SelectAssistantsIntent, in context: Context) async -> AssistantsEntry {
    AssistantsEntry(date: Date(), snapshot: configuration.shown(in: WidgetSnapshotStore.read()) ?? placeholder(in: context).snapshot)
  }
  func timeline(for configuration: SelectAssistantsIntent, in context: Context) async -> Timeline<AssistantsEntry> {
    let now = Date()
    guard let snapshot = configuration.shown(in: WidgetSnapshotStore.read()) else {
      return Timeline(entries: [AssistantsEntry(date: now, snapshot: nil)], policy: .never)
    }
    return Timeline(entries: snapshot.timelineDates(now: now).map { AssistantsEntry(date: $0, snapshot: snapshot) }, policy: .never)
  }
}

struct AssistantsWidget: Widget {
  var body: some WidgetConfiguration {
    AppIntentConfiguration(kind: "Assistants", intent: SelectAssistantsIntent.self, provider: AssistantsProvider()) { entry in
      AssistantsWidgetEntryView(entry: entry)
    }
    .configurationDisplayName("Assistants")
    .description("Who needs you, who is working, and your latest conversations. Edit the widget to choose assistants.")
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
