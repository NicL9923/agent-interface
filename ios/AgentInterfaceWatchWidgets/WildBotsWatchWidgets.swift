import SwiftUI
import WidgetKit

@main struct WildBotsWatchWidgets: WidgetBundle {
  var body: some Widget {
    WatchAssistantsWidget()
  }
}

struct WatchAssistantsEntry: TimelineEntry {
  var date: Date
  var snapshot: WidgetSnapshot?
}

struct WatchAssistantsProvider: TimelineProvider {
  func placeholder(in context: Context) -> WatchAssistantsEntry {
    WatchAssistantsEntry(date: Date(), snapshot: WidgetSnapshot(scope: "", generatedAt: Date(), assistants: [
      .init(id: "placeholder", name: "Assistant", activity: "working", lastMessage: "Working on your request", lastMessageAt: nil, color: nil, pinned: true),
    ]))
  }

  func getSnapshot(in context: Context, completion: @escaping (WatchAssistantsEntry) -> Void) {
    completion(WatchAssistantsEntry(date: Date(), snapshot: WidgetSnapshotStore.read() ?? placeholder(in: context).snapshot))
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<WatchAssistantsEntry>) -> Void) {
    let now = Date()
    guard let snapshot = WidgetSnapshotStore.read() else {
      completion(Timeline(entries: [WatchAssistantsEntry(date: now, snapshot: nil)], policy: .never))
      return
    }
    let entries = snapshot.timelineDates(now: now).map { WatchAssistantsEntry(date: $0, snapshot: snapshot) }
    completion(Timeline(entries: entries, policy: .never))
  }
}

/// Smart Stack and watch face complication showing who is working or waiting on you.
struct WatchAssistantsWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "WatchAssistants", provider: WatchAssistantsProvider()) { entry in
      WatchAssistantsWidgetView(entry: entry)
        .containerBackground(.fill.tertiary, for: .widget)
    }
    .configurationDisplayName("WildBots")
    .description("See which assistants are working or waiting on you.")
    .supportedFamilies([.accessoryCircular, .accessoryRectangular, .accessoryInline, .accessoryCorner])
  }
}

struct WatchAssistantsWidgetView: View {
  var entry: WatchAssistantsEntry
  @Environment(\.widgetFamily) private var family

  private var stale: Bool { entry.snapshot?.isStale(at: entry.date) ?? false }

  var body: some View {
    if let snapshot = entry.snapshot, !snapshot.assistants.isEmpty {
      let ordered = snapshot.ordered
      let count = snapshot.attentionCount > 0 ? snapshot.attentionCount : snapshot.workingCount
      let symbol = snapshot.attentionCount > 0 ? ActivityPhase.waiting.symbol
        : snapshot.workingCount > 0 ? ActivityPhase.working.symbol : "checkmark.circle"
      switch family {
      case .accessoryCircular:
        ZStack {
          AccessoryWidgetBackground()
          VStack(spacing: 1) {
            Image(systemName: symbol).font(.caption)
            Text(count > 0 ? "\(count)" : "OK").font(.headline.bold()).monospacedDigit()
          }
        }
      case .accessoryCorner:
        Image(systemName: symbol)
          .font(.title3)
          .widgetLabel(stale ? "Out of date" : snapshot.shortSummary)
      case .accessoryInline:
        Label(stale ? "Open WildBots" : snapshot.shortSummary, systemImage: symbol)
      default:
        VStack(alignment: .leading, spacing: 2) {
          Label(stale ? "Out of date" : snapshot.summary, systemImage: symbol)
            .font(.headline)
            .lineLimit(1)
          if !stale {
            ForEach(ordered.prefix(2)) { assistant in
              Text("\(assistant.name) · \(assistant.status ?? "Ready")")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            }
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      }
    } else {
      switch family {
      case .accessoryInline:
        Text("WildBots")
      case .accessoryCircular, .accessoryCorner:
        Image(systemName: "bubble.left.and.bubble.right")
      default:
        VStack(alignment: .leading, spacing: 2) {
          Text("WildBots").font(.headline)
          Text("Sign in on iPhone").font(.caption2).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
  }
}
