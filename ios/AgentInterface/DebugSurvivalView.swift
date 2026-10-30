#if DEBUG
import SwiftUI
import WidgetKit

/// Direct captures use the production views with explicit sample data, not a WidgetKit host.
struct DebugSurvivalView: View {
  var mode: String
  @State private var captureId = UUID().uuidString
  @Environment(AppStore.self) private var store
  private var snapshot: WidgetSnapshot {
    WidgetSnapshot(scope: "design-preview", generatedAt: Date().addingTimeInterval(mode == "widget-stale" ? -3600 : 0), assistants: mode == "widget-empty" ? [] : [
      .init(id: "ranch", name: "Ranch hand", activity: "waiting", lastMessage: "May I add the gate inspection to your calendar?", lastMessageAt: Date(), color: nil, pinned: true),
      .init(id: "kitchen", name: "Kitchen companion", activity: "working", lastMessage: "Planning dinner for the week", lastMessageAt: Date(), color: nil, pinned: false),
      .init(id: "garden", name: "Garden planner", activity: "idle", lastMessage: "Cover the peppers before tonight's frost.", lastMessageAt: Date(), color: nil, pinned: false),
    ])
  }
  var body: some View {
    if mode.hasPrefix("share") {
      ShareCaptureView(capture: SharedCapture(id: captureId, scope: store.scope ?? "", botId: "ranch", text: "Please summarize this article for our weekend plans.\nhttps://example.invalid/trail-guide", files: [], createdAt: Date()))
    } else {
      NavigationStack {
        ScrollView {
          VStack(alignment: .leading, spacing: 24) {
            Text("Production widget views with sample data. System placement and interactions are not shown.").font(.footnote).foregroundStyle(.secondary)
            AssistantsWidgetView(snapshot: snapshot, date: Date(), family: .systemMedium)
              .padding(16).frame(width: 345, height: 170).background(WidgetPalette.surface, in: RoundedRectangle(cornerRadius: 22))
            AssistantsWidgetView(snapshot: snapshot, date: Date(), family: .systemSmall)
              .padding(16).frame(width: 170, height: 170).background(WidgetPalette.surface, in: RoundedRectangle(cornerRadius: 22))
          }.padding()
        }.navigationTitle("Widget preview").background(Palette.surface(.light))
      }
    }
  }
}
#endif
