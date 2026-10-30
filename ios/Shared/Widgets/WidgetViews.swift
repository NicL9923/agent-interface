import SwiftUI
import UIKit
import WidgetKit

/// Colors for system surfaces. Light variants are darker than the system colors so small
/// status text stays readable on the light Lock Screen.
enum WidgetPalette {
  static let brand = adaptive(0x246F59, 0x8BD2B2)
  static let surface = adaptive(0xFAF8F2, 0x1B211E)
  static func color(_ phase: ActivityPhase?) -> Color {
    switch phase {
    case .waiting: adaptive(0x9A5A00, 0xFFB340)
    case .blocked: adaptive(0x4B44C8, 0xA29DFF)
    case .failed, .interrupted: adaptive(0xC0352B, 0xFF7A6E)
    case .done: adaptive(0x1F7A3D, 0x5ED37E)
    case .starting, .thinking: adaptive(0x00739E, 0x64D2FF)
    case .working: adaptive(0x0B5CD5, 0x6AAEFF)
    case .unknown, nil: .secondary
    }
  }
  /// An avatar color from the server, such as `#1084FE`.
  static func hex(_ value: String?) -> Color? {
    guard let value, value.hasPrefix("#"), value.count == 7, let rgb = UInt32(value.dropFirst(), radix: 16) else { return nil }
    return Color(uiColor: uiColor(rgb))
  }
  private static func adaptive(_ light: UInt32, _ dark: UInt32) -> Color {
    Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? uiColor(dark) : uiColor(light) })
  }
  private static func uiColor(_ rgb: UInt32) -> UIColor {
    UIColor(red: CGFloat((rgb >> 16) & 0xFF) / 255, green: CGFloat((rgb >> 8) & 0xFF) / 255, blue: CGFloat(rgb & 0xFF) / 255, alpha: 1)
  }
}

/// Resolves colors for the current rendering. Accented and vibrant modes tint by luminance,
/// so meaning comes from the symbol and words and everything draws as primary.
struct WidgetTone {
  var mode: WidgetRenderingMode
  var reduced: Bool
  var fullColor: Bool { mode == .fullColor }
  func color(_ phase: ActivityPhase?) -> Color {
    guard fullColor else { return .primary }
    return reduced ? WidgetPalette.color(phase).opacity(0.8) : WidgetPalette.color(phase)
  }
  func identity(_ hex: String?) -> Color {
    guard fullColor else { return .primary }
    return WidgetPalette.hex(hex) ?? WidgetPalette.brand
  }
}

/// The app icon's companion: a soft body with two tall eyes cut out, so it also works as a
/// single-color template.
struct AssistantGlyph: Shape {
  func path(in rect: CGRect) -> Path {
    // The icon's 1024-point artwork, cropped to the body (150...870).
    let side = min(rect.width, rect.height)
    let scale = side / 720
    let origin = CGPoint(x: rect.midX - side / 2, y: rect.midY - side / 2)
    func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: origin.x + (x - 150) * scale, y: origin.y + (1024 - y - 150) * scale) }
    var path = Path()
    path.move(to: p(512, 180))
    path.addCurve(to: p(180, 512), control1: p(310, 155), control2: p(170, 305))
    path.addCurve(to: p(512, 845), control1: p(157, 723), control2: p(306, 862))
    path.addCurve(to: p(845, 512), control1: p(726, 864), control2: p(859, 726))
    path.addCurve(to: p(512, 180), control1: p(858, 302), control2: p(721, 155))
    path.closeSubpath()
    for x: CGFloat in [375, 585] {
      let top = p(x, 605)
      path.addRoundedRect(in: CGRect(x: top.x, y: top.y, width: 64 * scale, height: 155 * scale), cornerSize: CGSize(width: 32 * scale, height: 32 * scale))
    }
    return path
  }
}
struct AssistantGlyphView: View {
  var color: Color
  var body: some View {
    AssistantGlyph().fill(color, style: FillStyle(eoFill: true)).aspectRatio(1, contentMode: .fit)
      .widgetAccentable().accessibilityHidden(true)
  }
}

// MARK: Live Activity

/// One compact Live Activity row: who, what, how long, and the status in words and symbol.
struct ActivityRowView: View {
  var row: AssistantActivityState.Row
  var stale: Bool
  var tone: WidgetTone
  var font: Font = .footnote
  var body: some View {
    let outdated = stale && row.phase.isActive
    HStack(spacing: 6) {
      AssistantGlyphView(color: tone.identity(row.color)).frame(width: 13, height: 13)
      Text(row.name).fontWeight(.semibold).lineLimit(1).layoutPriority(2)
      if let detail = row.detail, !detail.isEmpty {
        // Truncates while a few words fit, and disappears instead of showing a lone ellipsis.
        ViewThatFits(in: .horizontal) {
          Text(detail).foregroundStyle(.secondary).lineLimit(1).frame(minWidth: 56, idealWidth: 56, alignment: .leading).privacySensitive()
          Color.clear.frame(width: 0, height: 0)
        }
      }
      Spacer(minLength: 4)
      if row.showsTimer(stale: stale), let since = row.sinceDate {
        // A timer Text takes all offered width; the frame keeps it to the digits.
        Text(since, style: .timer).monospacedDigit().foregroundStyle(.secondary).lineLimit(1)
          .minimumScaleFactor(0.8).multilineTextAlignment(.trailing).frame(width: 50, alignment: .trailing)
      }
      HStack(spacing: 3) {
        Image(systemName: outdated ? "clock.arrow.circlepath" : row.phase.symbol)
        Text(row.statusText(stale: stale)).lineLimit(1)
      }.fontWeight(.medium).foregroundStyle(tone.color(outdated ? nil : row.phase)).layoutPriority(3)
    }.font(font).accessibilityElement(children: .combine)
  }
}

struct ActivityLockScreenView: View {
  var state: AssistantActivityState
  var stale: Bool
  @Environment(\.widgetRenderingMode) private var mode
  @Environment(\.isLuminanceReduced) private var reduced
  var body: some View {
    let tone = WidgetTone(mode: mode, reduced: reduced)
    let header = state.header(stale: stale)
    VStack(alignment: .leading, spacing: 7) {
      HStack(spacing: 8) {
        let phase = stale ? nil : state.hero?.phase
        AssistantGlyphView(color: phase == nil || phase == .unknown ? tone.identity(nil) : tone.color(phase))
          .frame(width: 20, height: 20)
        (Text(header.text) + Text(header.attention ?? "").foregroundStyle(tone.color(.waiting)))
          .font(.subheadline.weight(.semibold)).lineLimit(1)
        Spacer(minLength: 0)
      }
      ForEach(state.rows.prefix(4)) { ActivityRowView(row: $0, stale: stale, tone: tone) }
    }.padding(.horizontal, 16).padding(.vertical, 13)
  }
}

/// Dynamic Island pieces. The island is always dark, so callers force the dark scheme.
struct IslandGlyph: View {
  var state: AssistantActivityState
  var stale: Bool
  var body: some View {
    let phase = stale ? nil : state.hero?.phase
    AssistantGlyphView(color: phase == nil || phase == .unknown ? WidgetPalette.brand : WidgetPalette.color(phase))
  }
}
struct IslandCompactTrailing: View {
  var state: AssistantActivityState
  var stale: Bool
  var body: some View {
    Text(state.compactLabel(stale: stale)).font(.caption.weight(.semibold)).lineLimit(1)
      .foregroundStyle(stale ? .secondary : WidgetPalette.color(state.hero?.phase))
  }
}
struct IslandMinimal: View {
  var state: AssistantActivityState
  var stale: Bool
  var body: some View {
    if let hero = state.hero, !stale, hero.phase.showsSymbolWhenMinimal {
      Image(systemName: hero.phase.symbol).foregroundStyle(WidgetPalette.color(hero.phase))
        .accessibilityLabel(hero.statusText(stale: stale))
    } else {
      IslandGlyph(state: state, stale: stale).frame(width: 18, height: 18)
    }
  }
}
struct IslandExpandedLeading: View {
  var state: AssistantActivityState
  var stale: Bool
  var body: some View {
    HStack(spacing: 7) {
      IslandGlyph(state: state, stale: stale).frame(width: 26, height: 26)
      VStack(alignment: .leading, spacing: 0) {
        Text("\(state.activeCount)").font(.title3.weight(.bold)).monospacedDigit()
        Text("active").font(.caption2).foregroundStyle(.secondary)
      }
    }.accessibilityElement(children: .combine)
  }
}
struct IslandExpandedTrailing: View {
  var state: AssistantActivityState
  var stale: Bool
  var body: some View {
    if state.attentionCount > 0 && !stale {
      VStack(alignment: .trailing, spacing: 0) {
        Label("\(state.attentionCount)", systemImage: ActivityPhase.waiting.symbol).font(.title3.weight(.bold))
          .foregroundStyle(WidgetPalette.color(.waiting))
        Text(state.attentionCount == 1 ? "needs you" : "need you").font(.caption2).foregroundStyle(.secondary)
      }.accessibilityElement(children: .combine)
    }
  }
}
struct IslandExpandedBottom: View {
  var state: AssistantActivityState
  var stale: Bool
  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      if stale { Text("Assistant status out of date").font(.caption.weight(.semibold)).foregroundStyle(.secondary) }
      ForEach(state.rows.prefix(3)) {
        ActivityRowView(row: $0, stale: stale, tone: WidgetTone(mode: .fullColor, reduced: false), font: .caption)
      }
    }
  }
}

// MARK: Home and Lock Screen widgets

struct AssistantsWidgetView: View {
  var snapshot: WidgetSnapshot?
  var date: Date
  var family: WidgetFamily
  @Environment(\.widgetRenderingMode) private var mode
  @Environment(\.isLuminanceReduced) private var reduced
  @ScaledMetric(relativeTo: .caption2) private var pinSize: CGFloat = 8
  private var tone: WidgetTone { WidgetTone(mode: mode, reduced: reduced) }
  private var stale: Bool { snapshot?.isStale(at: date) ?? false }
  var body: some View {
    if let snapshot, !snapshot.assistants.isEmpty {
      content(snapshot, snapshot.ordered)
    } else {
      empty(snapshot == nil ? "Sign in to WildBots" : "No assistants yet")
    }
  }
  @ViewBuilder private func content(_ snapshot: WidgetSnapshot, _ ordered: [WidgetSnapshot.Assistant]) -> some View {
    switch family {
    case .systemSmall: small(ordered[0], snapshot)
    case .systemLarge: list(ordered, snapshot, limit: 7, header: true)
    case .accessoryCircular: circular(snapshot, hero: ordered[0])
    case .accessoryRectangular: rectangular(snapshot, ordered)
    case .accessoryInline: Label(stale ? "Open WildBots to refresh" : snapshot.summary, systemImage: summarySymbol(snapshot))
    default: list(ordered, snapshot, limit: 3, header: false)
    }
  }
  private func footer(_ snapshot: WidgetSnapshot) -> some View {
    Group {
      if stale {
        if family == .systemSmall {
          Label { Text(snapshot.generatedAt, style: .relative) + Text(" ago") } icon: { Image(systemName: "clock.arrow.circlepath") }
        } else {
          (Text(snapshot.generatedAt, style: .relative) + Text(" ago · Open to refresh"))
        }
      } else { Text("As of \(snapshot.generatedAt, style: .time)") }
    }.font(.caption2).foregroundStyle(.secondary).lineLimit(1)
  }
  /// Like the Live Activity, an old snapshot does not claim work is still running.
  private func status(_ assistant: WidgetSnapshot.Assistant) -> some View {
    let outdated = stale && (assistant.isWorking || assistant.needsAttention)
    return HStack(spacing: 3) {
      if let phase = assistant.phase { Image(systemName: outdated ? "clock.arrow.circlepath" : phase.symbol) }
      Text(outdated ? "Out of date" : assistant.status ?? "")
    }.font(.caption.weight(.semibold)).foregroundStyle(tone.color(outdated ? nil : assistant.phase)).lineLimit(1)
  }
  private func preview(_ assistant: WidgetSnapshot.Assistant, lines: Int) -> some View {
    Text(assistant.lastMessage ?? (assistant.status == nil ? "Ready" : ""))
      .font(.caption).foregroundStyle(.secondary).lineLimit(lines).privacySensitive()
  }
  private func small(_ hero: WidgetSnapshot.Assistant, _ snapshot: WidgetSnapshot) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack(alignment: .top) {
        AssistantGlyphView(color: tone.identity(hero.color)).frame(width: 30, height: 30)
        Spacer(minLength: 0)
        if hero.pinned { Image(systemName: "star.fill").font(.caption2).foregroundStyle(.secondary).accessibilityLabel("Pinned") }
      }
      Text(hero.name).font(.headline).lineLimit(1).padding(.top, 2)
      if hero.status != nil { status(hero) }
      preview(hero, lines: hero.status == nil ? 3 : 2)
      Spacer(minLength: 0)
      footer(snapshot)
    }.frame(maxWidth: .infinity, alignment: .leading).widgetURL(DeepLink.bot(hero.id))
  }
  private func row(_ assistant: WidgetSnapshot.Assistant) -> some View {
    Link(destination: DeepLink.bot(assistant.id)) {
      HStack(spacing: 10) {
        AssistantGlyphView(color: tone.identity(assistant.color)).frame(width: 24, height: 24)
        VStack(alignment: .leading, spacing: 1) {
          HStack(spacing: 6) {
            Text(assistant.name).font(.subheadline.weight(.semibold)).lineLimit(1)
            if assistant.pinned { Image(systemName: "star.fill").font(.system(size: pinSize)).foregroundStyle(.secondary).accessibilityLabel("Pinned") }
            Spacer(minLength: 4)
            if assistant.status != nil { status(assistant) }
          }
          preview(assistant, lines: 1)
        }
      }.foregroundStyle(Color.primary)
    }
  }
  private func list(_ ordered: [WidgetSnapshot.Assistant], _ snapshot: WidgetSnapshot, limit: Int, header: Bool) -> some View {
    VStack(alignment: .leading, spacing: header ? 9 : 7) {
      if header {
        HStack(spacing: 8) {
          AssistantGlyphView(color: tone.identity(nil)).frame(width: 20, height: 20)
          Text(snapshot.summary).font(.headline).lineLimit(1)
        }
      }
      ForEach(ordered.prefix(limit)) { row($0) }
      Spacer(minLength: 0)
      footer(snapshot)
    }.frame(maxWidth: .infinity, alignment: .leading).widgetURL(DeepLink.today)
  }
  private func summarySymbol(_ snapshot: WidgetSnapshot) -> String {
    snapshot.attentionCount > 0 ? ActivityPhase.waiting.symbol : snapshot.workingCount > 0 ? ActivityPhase.working.symbol : "checkmark.circle"
  }
  private func circular(_ snapshot: WidgetSnapshot, hero: WidgetSnapshot.Assistant) -> some View {
    let count = snapshot.attentionCount > 0 ? snapshot.attentionCount : snapshot.workingCount
    return ZStack {
      AccessoryWidgetBackground()
      VStack(spacing: 0) {
        if count > 0 {
          Image(systemName: summarySymbol(snapshot)).font(.caption)
          Text("\(count)").font(.title3.weight(.bold)).monospacedDigit()
        } else {
          AssistantGlyphView(color: .primary).frame(width: 26, height: 26)
        }
      }
    }.widgetURL(snapshot.attentionCount > 0 || snapshot.workingCount > 0 ? DeepLink.bot(hero.id) : DeepLink.today)
      .accessibilityElement(children: .ignore).accessibilityLabel(stale ? "Open WildBots to refresh" : snapshot.summary)
  }
  private func rectangular(_ snapshot: WidgetSnapshot, _ ordered: [WidgetSnapshot.Assistant]) -> some View {
    VStack(alignment: .leading, spacing: 1) {
      ViewThatFits(in: .horizontal) {
        Label(snapshot.summary, systemImage: summarySymbol(snapshot))
        Label(snapshot.shortSummary, systemImage: summarySymbol(snapshot))
      }.font(.headline).lineLimit(1)
      if stale {
        Text("Open WildBots to refresh").font(.caption).lineLimit(2)
      } else {
        ForEach(ordered.prefix(2)) { assistant in
          Text("\(assistant.name) · \(assistant.status ?? "Ready")").font(.caption).lineLimit(1)
        }
      }
    }.frame(maxWidth: .infinity, alignment: .leading).widgetURL(DeepLink.bot(ordered[0].id))
  }
  private func empty(_ message: String) -> some View {
    Group {
      switch family {
      case .accessoryInline: Text(message)
      case .accessoryCircular:
        ZStack { AccessoryWidgetBackground(); AssistantGlyphView(color: .primary).frame(width: 26, height: 26) }
          .accessibilityLabel(message)
      default:
        VStack(alignment: .leading, spacing: 8) {
          AssistantGlyphView(color: tone.identity(nil)).frame(width: 30, height: 30)
          Text(message).font(.headline).lineLimit(2).fixedSize(horizontal: false, vertical: true)
          if family != .accessoryRectangular && family != .systemSmall {
            Spacer(minLength: 0)
            Text(snapshot == nil ? "Your assistants appear here after you open the app." : "Create one in WildBots.").font(.caption).foregroundStyle(.secondary)
          }
        }.frame(maxWidth: .infinity, alignment: .leading)
      }
    }.widgetURL(DeepLink.home)
  }
}
