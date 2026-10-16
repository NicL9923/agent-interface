import SwiftUI
import WidgetKit
import XCTest

@testable import AgentInterface

/// Renders the widget, Live Activity and update banner views to PNGs for visual review.
/// Skipped unless the runner sets AGENT_INTERFACE_EVIDENCE_DIR, which xcodebuild forwards from
/// TEST_RUNNER_AGENT_INTERFACE_EVIDENCE_DIR. System chrome (Lock Screen, island shape, widget
/// corners) is approximated here; the content views are the shipped ones.
@MainActor final class SystemSurfaceEvidenceTests: XCTestCase {
  private var directory: URL!
  override func setUpWithError() throws {
    let path = ProcessInfo.processInfo.environment["AGENT_INTERFACE_EVIDENCE_DIR"] ?? ""
    try XCTSkipUnless(!path.isEmpty, "Set AGENT_INTERFACE_EVIDENCE_DIR to render evidence.")
    directory = URL(fileURLWithPath: path, isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  }
  private let now = Date()
  private var state: AssistantActivityState {
    let t = now.timeIntervalSince1970
    return AssistantActivityState(title: "Kitchen needs you", activeCount: 3, attentionCount: 1, updatedAt: t, rows: [
      .init(botId: "kitchen", name: "Kitchen companion", phase: .waiting, status: "Needs approval", detail: "Order groceries for the week", since: t - 95, color: "#FF9800"),
      .init(botId: "ranch", name: "Ranch hand", phase: .working, status: "Working", detail: "Checking the hay delivery schedule", since: t - 312, color: "#1084FE"),
      .init(botId: "garden", name: "Garden", phase: .starting, status: "Starting", since: t - 4, color: "#00BCA6"),
      .init(botId: "school", name: "School helper", phase: .done, status: "Done", detail: "Permission slip summary", color: "#9159FE"),
    ])
  }
  private var snapshot: WidgetSnapshot {
    WidgetSnapshot(scope: "evidence", generatedAt: now.addingTimeInterval(-120), assistants: [
      .init(id: "ranch", name: "Ranch hand", activity: "working", lastMessage: "Checking whether the hay delivery can move to Thursday.", lastMessageAt: now.addingTimeInterval(-600), color: "#1084FE", pinned: true),
      .init(id: "kitchen", name: "Kitchen companion", activity: "waiting", lastMessage: "I drafted the grocery order. Approve it and I'll place it.", lastMessageAt: now.addingTimeInterval(-60), color: "#FF9800", pinned: false),
      .init(id: "garden", name: "Garden", activity: "idle", lastMessage: "Tomatoes need water tomorrow morning.", lastMessageAt: now.addingTimeInterval(-7200), color: "#00BCA6", pinned: false),
      .init(id: "school", name: "School helper", activity: "done", lastMessage: "The permission slip is due Friday.", lastMessageAt: now.addingTimeInterval(-3600), color: "#9159FE", pinned: false),
      .init(id: "money", name: "Budget", activity: "idle", lastMessage: "October spending is on track.", lastMessageAt: now.addingTimeInterval(-86400), color: "#FF309B", pinned: true),
      .init(id: "vet", name: "Vet reminders", activity: "failed", lastMessage: "Could not reach the clinic calendar.", lastMessageAt: now.addingTimeInterval(-9000), color: "#FF263C", pinned: false),
      .init(id: "trips", name: "Trip planner", activity: "idle", lastMessage: nil, lastMessageAt: nil, color: nil, pinned: false),
      .init(id: "extra", name: "Eighth assistant", activity: "idle", lastMessage: "Not shown in large", lastMessageAt: nil, color: nil, pinned: false),
    ])
  }
  private func render<V: View>(_ name: String, _ view: V, dark: Bool) throws {
    let renderer = ImageRenderer(content: view.environment(\.colorScheme, dark ? .dark : .light).fontDesign(.default))
    renderer.scale = 3
    let image = try XCTUnwrap(renderer.uiImage, name)
    try XCTUnwrap(image.pngData()).write(to: directory.appendingPathComponent(name + (dark ? "-dark" : "-light") + ".png"))
  }
  private func lockScreen<V: View>(_ content: V, dark: Bool) -> some View {
    content.frame(width: 370).background(dark ? Color(white: 0.12).opacity(0.92) : Color(white: 0.97).opacity(0.92), in: RoundedRectangle(cornerRadius: 22))
      .padding(14).background(LinearGradient(colors: dark ? [.indigo, .black] : [.teal, .mint], startPoint: .top, endPoint: .bottom))
  }
  private func widget<V: View>(_ content: V, width: CGFloat, height: CGFloat) -> some View {
    content.padding(16).frame(width: width, height: height).background(WidgetPalette.surface, in: RoundedRectangle(cornerRadius: 22))
      .padding(12).background(Color.gray.opacity(0.35))
  }

  func testRenderEvidence() throws {
    for dark in [false, true] {
      try render("live-activity-lock", lockScreen(ActivityLockScreenView(state: state, stale: false), dark: dark), dark: dark)
      try render("live-activity-lock-stale", lockScreen(ActivityLockScreenView(state: state, stale: true), dark: dark), dark: dark)
      for (family, name, width, height) in [(WidgetFamily.systemSmall, "small", 170.0, 170.0), (.systemMedium, "medium", 364.0, 170.0), (.systemLarge, "large", 364.0, 382.0)] {
        try render("widget-\(name)", widget(AssistantsWidgetView(snapshot: snapshot, date: now, family: family), width: width, height: height), dark: dark)
      }
      try render("widget-medium-stale", widget(AssistantsWidgetView(snapshot: snapshot, date: now.addingTimeInterval(3600), family: .systemMedium), width: 364, height: 170), dark: dark)
      try render("widget-small-signed-out", widget(AssistantsWidgetView(snapshot: nil, date: now, family: .systemSmall), width: 170, height: 170), dark: dark)
      try render("update-banner", AppUpdateBanner(url: URL(string: "https://testflight.apple.com/join/CODE")!).frame(width: 393).background(Palette.surface(dark ? .dark : .light)), dark: dark)
    }
    // The island is always dark.
    let island = VStack(spacing: 18) {
      HStack(spacing: 0) {
        IslandGlyph(state: state, stale: false).frame(width: 18, height: 18)
        Spacer(minLength: 120)
        IslandCompactTrailing(state: state, stale: false)
      }.padding(.horizontal, 14).frame(height: 37).background(.black, in: Capsule())
      HStack(spacing: 24) {
        IslandMinimal(state: state, stale: false).frame(width: 37, height: 37).background(.black, in: Circle())
        IslandMinimal(state: { var s = state; s.rows.removeFirst(); return s }(), stale: false).frame(width: 37, height: 37).background(.black, in: Circle())
        IslandCompactTrailing(state: state, stale: true).padding(.horizontal, 14).frame(height: 37).background(.black, in: Capsule())
      }
      VStack(spacing: 10) {
        HStack(alignment: .top) {
          IslandExpandedLeading(state: state, stale: false)
          Spacer()
          IslandExpandedTrailing(state: state, stale: false)
        }
        IslandExpandedBottom(state: state, stale: false)
      }.padding(18).frame(width: 370).background(.black, in: RoundedRectangle(cornerRadius: 44))
    }.padding(20).background(Color(white: 0.2))
    try render("dynamic-island", island, dark: true)
    // Lock Screen accessories render vibrant: monochrome over the wallpaper.
    let accessories = HStack(spacing: 14) {
      AssistantsWidgetView(snapshot: snapshot, date: now, family: .accessoryCircular).frame(width: 72, height: 72)
      AssistantsWidgetView(snapshot: snapshot, date: now, family: .accessoryRectangular).frame(width: 170, height: 72)
      AssistantsWidgetView(snapshot: snapshot, date: now, family: .accessoryInline).frame(width: 220)
    }.environment(\.widgetRenderingMode, .vibrant).foregroundStyle(.white).padding(16).background(LinearGradient(colors: [.indigo, .black], startPoint: .top, endPoint: .bottom))
    try render("widget-accessories", accessories, dark: true)
  }
}
