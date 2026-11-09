import SwiftUI

/// When the transcript docks the watch-only desktop view, apart from the view so it can be tested.
/// The web's `peeking`: an assistant is selected, the full computer view is not open, and the
/// running turn's tools use the computer. Dismissing hides it for that turn only.
enum ComputerPeekRules {
  static func shows(selected: Bool, computerOpen: Bool, active: Bool, toolNames: [String], turn: String?, dismissedTurn: String?) -> Bool {
    guard selected, !computerOpen, active else { return false }
    if let turn, turn == dismissedTurn { return false }
    return toolNames.contains { ComputerHandoff.usesComputer($0) }
  }
}

/// A small live view of the shared desktop, docked in the transcript's corner while an assistant
/// uses the computer. It watches only, with its own ticket that never takes control, and tapping
/// it opens the full computer view. A failed or dropped connection removes it; it exists only
/// while shown, so hidden or dismissed it holds no connection.
struct ComputerPeekView: View {
  var name: String
  var open: () -> Void
  var dismiss: () -> Void
  @Environment(AppStore.self) private var store
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.horizontalSizeClass) private var sizeClass
  enum Phase: Equatable { case connecting, live, gone }
  @State private var phase = Phase.connecting
  @State private var ticket: DesktopTicket?
  @State private var typing = DesktopTyping()
  private var width: CGFloat { sizeClass == .regular ? 240 : 168 }
  var body: some View {
    if phase != .gone {
      ZStack(alignment: .topTrailing) {
        Button(action: open) { screen }
          .buttonStyle(.plain)
          .accessibilityLabel("Watch \(name) on the computer").accessibilityHint("Opens the computer")
          .accessibilityIdentifier("computerPeek")
        Button(action: dismiss) {
          Image(systemName: "xmark").font(.caption2.weight(.bold)).foregroundStyle(.white)
            .frame(width: 24, height: 24).background(.black.opacity(0.6), in: Circle())
            .frame(width: 44, height: 44).contentShape(Rectangle())
        }.buttonStyle(.plain).padding(-10)
          .accessibilityLabel("Hide the computer preview").accessibilityIdentifier("computerPeekClose")
      }
      .frame(width: width, height: width * 0.625)
      .padding(12)
      .transition(reduceMotion ? .identity : .opacity)
      .task { await attach() }
    }
  }
  private var screen: some View {
    ZStack(alignment: .bottomLeading) {
      Color.black
      if let api = store.api, let ticket {
        DesktopWebView(base: api.baseURL, path: ticket.path, control: false, trackpad: false, typing: typing, event: received)
          .allowsHitTesting(false).accessibilityHidden(true)
      }
      if phase == .connecting {
        Group {
          if reduceMotion { Image(systemName: "desktopcomputer") } else { ProgressView().tint(.white) }
        }.frame(maxWidth: .infinity, maxHeight: .infinity).foregroundStyle(.white).accessibilityHidden(true)
      }
      Label("Live", systemImage: "desktopcomputer").font(.caption2.weight(.semibold)).foregroundStyle(.white)
        .padding(.horizontal, 6).padding(.vertical, 3).background(.black.opacity(0.6), in: Capsule()).padding(6)
        .accessibilityHidden(true)
    }
    .clipShape(RoundedRectangle(cornerRadius: 10))
    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Palette.line))
    .shadow(color: .black.opacity(0.25), radius: 6, y: 2)
  }
  /// Gets its own ticket, with no viewer identity, so it never holds or takes the desktop. A
  /// ticket the page has not used before it expires, or any failure, removes the peek.
  private func attach() async {
    switch await store.attempt({ context -> DesktopTicket in try await context.api.write("/computer/desktop", [String: String]()) }) {
    case .success(let value)?:
      ticket = value
      guard let wait = DesktopLink.connectWait(value, now: Date()) else { return }
      // Timer: waits out the ticket's 30-second life before checking it connected.
      try? await Task.sleep(for: wait)
      if !Task.isCancelled, phase == .connecting { phase = .gone }
    case .failure?: phase = .gone
    case nil: break
    }
  }
  private func received(_ event: DesktopWebView.Event) {
    switch event {
    case .connected: phase = .live
    case .disconnected, .failed: phase = .gone
    case .zoom: break
    }
  }
}
