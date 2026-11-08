import SwiftUI

/// A trailing swipe action for a row in a scroll view, which has no `swipeActions`: drag left past
/// the threshold and let go. The same action stays in the context menu and, for VoiceOver, in the
/// row's action list. Mostly vertical drags are left to scrolling.
struct SwipeAction: ViewModifier {
  var title: String
  var symbol: String
  var enabled = true
  var action: () -> Void
  @State private var drag: CGFloat = 0
  @ScaledMetric(relativeTo: .footnote) private var threshold: CGFloat = 96
  static func shouldTrack(_ translation: CGSize) -> Bool { translation.width < 0 && abs(translation.width) > abs(translation.height) }
  func body(content: Content) -> some View {
    let armed = drag <= -threshold
    content.offset(x: drag)
      .background(alignment: .trailing) {
        if drag < 0 {
          Label(title, systemImage: symbol).labelStyle(.titleAndIcon).font(.footnote.weight(.semibold)).lineLimit(1)
            .foregroundStyle(.white).frame(width: -drag, height: nil, alignment: .center).frame(maxHeight: .infinity)
            .background(armed ? Palette.accent : Palette.accent.opacity(0.7), in: RoundedRectangle(cornerRadius: 16))
            .clipped().accessibilityHidden(true)
        }
      }
      .simultaneousGesture(
        DragGesture(minimumDistance: 24)
          .onChanged { value in
            guard enabled, Self.shouldTrack(value.translation) else { if drag != 0 { drag = 0 }; return }
            // Resistance past the threshold, so the commit point is felt.
            let past = max(0, -value.translation.width - threshold)
            drag = -(min(-value.translation.width, threshold) + past * 0.25)
          }
          .onEnded { value in
            let commit = enabled && Self.shouldTrack(value.translation) && -value.translation.width >= threshold
            withAnimation(.snappy(duration: 0.2)) { drag = 0 }
            if commit { action() }
          }
      )
      .sensoryFeedback(.selection, trigger: armed) { _, now in now }
      .accessibilityAction(named: title) { if enabled { action() } }
  }
}
extension View {
  func swipeAction(_ title: String, symbol: String, enabled: Bool = true, perform: @escaping () -> Void) -> some View {
    modifier(SwipeAction(title: title, symbol: symbol, enabled: enabled, action: perform))
  }
}
