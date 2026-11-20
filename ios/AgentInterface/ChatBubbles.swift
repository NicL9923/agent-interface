import SwiftUI

// Chat bubbles: a person's chat style preference, the grouping that puts a reply's prose in
// bubbles while tables, code and cards stay full width, and the solid color for their own messages.
// The web's transcript follows the same rules.

/// How an assistant's replies read. Absent or unknown values read as `bubbles`.
enum ChatStyle: String, CaseIterable {
  case bubbles, classic
}
/// How the person's own messages are filled. Absent or unknown values read as `tint`.
enum OwnBubble: String, CaseIterable {
  case tint, solid
}
extension Preferences {
  /// The saved style, or the default. Setting it saves the raw value; an unknown value from a newer
  /// client stays as it was until the person picks one here.
  var chatStyleChoice: ChatStyle {
    get { chatStyle.flatMap(ChatStyle.init(rawValue:)) ?? .bubbles }
    set { chatStyle = newValue.rawValue }
  }
  var ownBubbleChoice: OwnBubble {
    get { ownBubble.flatMap(OwnBubble.init(rawValue:)) ?? .tint }
    set { ownBubble = newValue.rawValue }
  }
}

/// The fill for the person's own messages with `ownBubble: "solid"`.
enum SolidBubble {
  /// The color an assistant's chat is tinted with: its drawn avatar's color, as the web's `botTint`.
  /// A portrait, or a color that is not a hex value, has none.
  static func tint(_ avatar: AvatarConfig?) -> String? {
    guard let avatar, avatar.mode != .portrait, let color = avatar.color,
      color.range(of: "^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$", options: .regularExpression) != nil
    else { return nil }
    return color
  }
  /// The highest OKLCH lightness the fill may have, so white text on it keeps 4.5:1.
  static let lightnessCap = 0.52
  /// `color` with its OKLCH lightness capped, its hue kept, and its chroma reduced only as far as
  /// sRGB needs, as "#RRGGBB". White text on the result keeps at least 4.5:1: should rounding ever
  /// land a hair short, the lightness steps down until it does.
  static func fill(_ color: String) -> String? {
    guard let (r, g, b) = AvatarMotion.rgb(color) else { return nil }
    let lab = OKLab.from(red: Double(r) / 255, green: Double(g) / 255, blue: Double(b) / 255)
    let chroma = (lab.a * lab.a + lab.b * lab.b).squareRoot()
    let hue = atan2(lab.b, lab.a)
    var lightness = min(lab.l, lightnessCap)
    while true {
      let fitted = OKLab.largestChromaInGamut(lightness: lightness, hue: hue, upTo: chroma)
      let rgb = OKLab.rgb(lightness: lightness, a: fitted * cos(hue), b: fitted * sin(hue))
      let hex = String(format: "#%02X%02X%02X", rgb.0, rgb.1, rgb.2)
      if contrastWithWhite(hex) >= 4.5 || lightness <= 0 { return hex }
      lightness = max(0, lightness - 0.005)
    }
  }
  /// WCAG contrast of white text on `color`.
  static func contrastWithWhite(_ color: String) -> Double {
    guard let luminance = AvatarMotion.luminance(color) else { return 1 }
    return 1.05 / (luminance + 0.05)
  }
}

/// Björn Ottosson's OKLab, over sRGB.
enum OKLab {
  struct Value { var l: Double; var a: Double; var b: Double }
  private static func linear(_ c: Double) -> Double { c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4) }
  private static func encoded(_ c: Double) -> Double { c <= 0.0031308 ? 12.92 * c : 1.055 * pow(c, 1 / 2.4) - 0.055 }
  static func from(red: Double, green: Double, blue: Double) -> Value {
    let r = linear(red), g = linear(green), b = linear(blue)
    let l = cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
    let m = cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
    let s = cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
    return Value(
      l: 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
      a: 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
      b: 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s)
  }
  /// Linear sRGB channels, which fall outside 0...1 for a color sRGB cannot show.
  static func linearRGB(lightness: Double, a: Double, b: Double) -> (Double, Double, Double) {
    let l = pow(lightness + 0.3963377774 * a + 0.2158037573 * b, 3)
    let m = pow(lightness - 0.1055613458 * a - 0.0638541728 * b, 3)
    let s = pow(lightness - 0.0894841775 * a - 1.2914855480 * b, 3)
    return (
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s)
  }
  static func inGamut(lightness: Double, a: Double, b: Double) -> Bool {
    let (r, g, bl) = linearRGB(lightness: lightness, a: a, b: b)
    return [r, g, bl].allSatisfy { $0 >= -1e-6 && $0 <= 1 + 1e-6 }
  }
  /// The most chroma, at most `chroma`, that sRGB shows at this lightness and hue.
  static func largestChromaInGamut(lightness: Double, hue: Double, upTo chroma: Double) -> Double {
    if inGamut(lightness: lightness, a: chroma * cos(hue), b: chroma * sin(hue)) { return chroma }
    var low = 0.0, high = chroma
    for _ in 0..<40 {
      let middle = (low + high) / 2
      if inGamut(lightness: lightness, a: middle * cos(hue), b: middle * sin(hue)) { low = middle } else { high = middle }
    }
    return low
  }
  static func rgb(lightness: Double, a: Double, b: Double) -> (Int, Int, Int) {
    let (r, g, bl) = linearRGB(lightness: lightness, a: a, b: b)
    func byte(_ c: Double) -> Int { Int((encoded(min(max(c, 0), 1)) * 255).rounded()) }
    return (byte(r), byte(g), byte(bl))
  }
}

/// One piece of an assistant reply as the bubbles style lays it out: a run of prose in a bubble, or
/// a block that keeps the full column width.
struct ReplySegment: Identifiable {
  enum Kind {
    /// Consecutive paragraphs, lists, quotes and headings. Blocks from `settled` on may still change.
    case bubble([MarkdownBlock], settled: Int)
    /// A table, code block, rule or anything else Markdown that is not prose.
    case block(MarkdownBlock, settled: Bool)
    case inline(InlineDocument)
    case cards([ReplyCard])
  }
  var id: Int
  var kind: Kind
  var isBubble: Bool { if case .bubble = kind { true } else { false } }
}

enum ReplyBubbles {
  /// Prose sits in a bubble. Everything else, including any block a later parser adds, stays out.
  static func isProse(_ block: MarkdownBlock) -> Bool {
    switch block {
    case .paragraph, .heading, .list, .quote: true
    case .code, .rule, .table: false
    }
  }
  /// A reply's parts, as `ReplyCards.parse` splits them, laid out for bubbles. A reply still
  /// streaming parses its Markdown the way `MarkdownView` does while it streams, and groups the same
  /// blocks, so it reads the same once it settles.
  static func segments(_ parts: [ReplyContentPart], streaming: Bool) -> [ReplySegment] {
    var result: [ReplySegment] = []
    func add(_ kind: ReplySegment.Kind) { result.append(ReplySegment(id: result.count, kind: kind)) }
    for part in parts {
      if let markdown = part.markdown {
        let parsed = streaming
          ? MarkdownCache.shared.streamingBlocks(markdown) : (blocks: MarkdownCache.shared.blocks(markdown), settled: Int.max)
        var run: (start: Int, blocks: [MarkdownBlock])?
        func closeRun() {
          if let current = run { add(.bubble(current.blocks, settled: max(0, parsed.settled - current.start))) }
          run = nil
        }
        for (index, block) in parsed.blocks.enumerated() {
          if isProse(block) {
            if run == nil { run = (index, []) }
            run?.blocks.append(block)
          } else {
            closeRun()
            add(.block(block, settled: index < parsed.settled))
          }
        }
        closeRun()
      }
      if let inline = part.inline { add(.inline(inline)) }
      if let cards = part.cards { add(.cards(cards)) }
    }
    return result
  }
  /// A bubble's leading corners. Where it meets another piece of the reply the corner tightens, and
  /// the last bubble of a finished reply points at the assistant, mirroring the person's bubble.
  static func corners(at index: Int, in segments: [ReplySegment], endsReply: Bool) -> (top: CGFloat, bottom: CGFloat) {
    let last = segments.lastIndex { $0.isBubble }
    let top: CGFloat = index > 0 ? 8 : 18
    let bottom: CGFloat = index == last && endsReply ? 4 : index < segments.count - 1 ? 8 : 18
    return (top, bottom)
  }
}

private struct ChatBubblesKey: EnvironmentKey { static let defaultValue = false }
private struct OwnBubbleFillKey: EnvironmentKey { static let defaultValue: Color? = nil }
extension EnvironmentValues {
  /// Whether the open chat shows the assistant's prose in bubbles: the person's `chatStyle`.
  var chatBubbles: Bool {
    get { self[ChatBubblesKey.self] }
    set { self[ChatBubblesKey.self] = newValue }
  }
  /// The solid fill for the person's own messages, or nil for the tinted look.
  var ownBubbleFill: Color? {
    get { self[OwnBubbleFillKey.self] }
    set { self[OwnBubbleFillKey.self] = newValue }
  }
}

/// Sizes a bubble to its content, up to a share of the column and a cap, and puts it at the
/// leading or trailing edge. It takes the column's whole width, so the bubble can sit at either.
struct BubbleWidth: Layout {
  var fraction: CGFloat = 1
  var cap: CGFloat = .infinity
  var trailing = false
  private func limit(_ width: CGFloat?) -> CGFloat? { width.map { min($0 * fraction, cap) } }
  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    guard let child = subviews.first else { return .zero }
    let size = child.sizeThatFits(ProposedViewSize(width: limit(proposal.width), height: proposal.height))
    guard let width = proposal.width, width.isFinite else { return size }
    return CGSize(width: width, height: size.height)
  }
  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    guard let child = subviews.first else { return }
    let offer = ProposedViewSize(width: limit(bounds.width), height: proposal.height)
    let size = child.sizeThatFits(offer)
    child.place(at: CGPoint(x: trailing ? bounds.maxX - size.width : bounds.minX, y: bounds.minY), proposal: offer)
  }
}

/// A reply in the bubbles style. Each run of prose is a bubble that hugs its text; tables, code,
/// inline UI and cards render as they do in the classic style, at the full column width.
struct BubbledReplyView: View {
  var segments: [ReplySegment]
  var messageId: String
  /// Whether this message ends the assistant's reply, so its last bubble carries the tail.
  var endsReply: Bool
  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      ForEach(segments) { segment in
        switch segment.kind {
        case .bubble(let blocks, let settled):
          let corners = ReplyBubbles.corners(at: segment.id, in: segments, endsReply: endsReply)
          ReplyBubble(blocks: blocks, settled: settled, top: corners.top, bottom: corners.bottom)
        case .block(let block, let settled):
          MarkdownBlockView(block: block, listDepth: 0).environment(\.markdownSettled, settled)
            .frame(maxWidth: .infinity, alignment: .leading).markdownLinks()
        case .inline(let inline): InlineUiView(document: inline)
        case .cards(let cards): ForEach(cards) { card in InteractiveReplyCard(card: card, messageId: messageId) }
        }
      }
    }.frame(maxWidth: .infinity, alignment: .leading)
  }
}

private struct ReplyBubble: View {
  var blocks: [MarkdownBlock]
  var settled: Int
  var top: CGFloat
  var bottom: CGFloat
  @Environment(\.horizontalSizeClass) private var sizeClass
  @Environment(\.colorSchemeContrast) private var contrast
  var body: some View {
    let shape = UnevenRoundedRectangle(
      topLeadingRadius: top, bottomLeadingRadius: bottom, bottomTrailingRadius: 18, topTrailingRadius: 18, style: .continuous)
    BubbleWidth(cap: sizeClass == .regular ? 600 : .infinity) {
      MarkdownBlocksView(blocks: blocks, settled: settled).markdownLinks()
        .padding(.vertical, 10).padding(.horizontal, 14)
        .background(Palette.replyBubble, in: shape)
        .overlay { if contrast == .increased { shape.strokeBorder(Palette.bubbleBorder) } }
    }
  }
}

/// The person's message bubble, in both chat styles: it hugs its text up to 86% of the column at the
/// trailing edge, with its tail at the bottom trailing corner. `solid` fills it with the assistant's
/// color and white text.
struct PersonBubble<Content: View>: View {
  var solid: Color?
  var found: Bool
  @ViewBuilder var content: () -> Content
  @Environment(\.colorScheme) private var scheme
  @Environment(\.colorSchemeContrast) private var contrast
  static var shape: UnevenRoundedRectangle {
    UnevenRoundedRectangle(topLeadingRadius: 18, bottomLeadingRadius: 18, bottomTrailingRadius: 4, topTrailingRadius: 18, style: .continuous)
  }
  var body: some View {
    BubbleWidth(fraction: 0.86, trailing: true) {
      Group {
        if let solid {
          content().foregroundStyle(.white, .white).tint(.white).background(solid, in: Self.shape)
        } else {
          content().background(Palette.user(scheme), in: Self.shape)
            .overlay { if contrast == .increased { Self.shape.strokeBorder(Palette.bubbleBorder) } }
        }
      }
      // The find outline hugs the bubble.
      .overlay { if found { Self.shape.stroke(Palette.accent, lineWidth: 2) } }
    }
  }
}
