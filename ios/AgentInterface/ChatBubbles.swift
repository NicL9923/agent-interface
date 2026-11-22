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
    /// Consecutive paragraphs, headings, and lists and quotes of prose. Blocks from `settled` on may
    /// still change.
    case bubble([MarkdownBlock], settled: Int)
    /// A table, code block, rule, a list or quote holding one, or anything else that is not prose.
    case block(MarkdownBlock, settled: Bool)
    case inline(InlineDocument)
    case cards([ReplyCard])
  }
  var id: Int
  var kind: Kind
  var isBubble: Bool { if case .bubble = kind { true } else { false } }
}

enum ReplyBubbles {
  /// Prose sits in a bubble. Everything else, including any block a later parser adds, stays out. A
  /// list or quote is prose only when everything inside it is, so one holding a code block, table or
  /// rule renders full width as in the classic style, its structure intact. Images are inline links
  /// in this parser, so they stay prose.
  static func isProse(_ block: MarkdownBlock) -> Bool {
    switch block {
    case .paragraph, .heading: true
    case .list(let list): list.items.allSatisfy { $0.blocks.allSatisfy(isProse) }
    case .quote(let blocks): blocks.allSatisfy(isProse)
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
  /// The leading corners of the bubble at `index` among a reply's `count` segments. Where it meets
  /// another piece of the reply the corner tightens. Only a bubble that is the final segment of a finished
  /// reply points at the assistant, mirroring the person's bubble; one a table or code block follows
  /// joins it instead, as on the web.
  static func corners(at index: Int, count: Int, endsReply: Bool) -> (top: CGFloat, bottom: CGFloat) {
    let top: CGFloat = index > 0 ? 8 : 18
    let bottom: CGFloat = index < count - 1 ? 8 : endsReply ? 4 : 18
    return (top, bottom)
  }
}

private struct ChatBubblesKey: EnvironmentKey { static let defaultValue = false }
private struct MarkdownOnSolidKey: EnvironmentKey { static let defaultValue = false }
private struct OwnBubbleFillKey: EnvironmentKey { static let defaultValue: Color? = nil }
extension EnvironmentValues {
  /// Whether the open chat shows the assistant's prose in bubbles: the person's `chatStyle`.
  var chatBubbles: Bool {
    get { self[ChatBubblesKey.self] }
    set { self[ChatBubblesKey.self] = newValue }
  }
  /// Whether Markdown sits on a solid bubble's fill under white text, so a quote's text and bar and a checked box,
  /// which have colors of their own elsewhere, take white to keep their contrast.
  var markdownOnSolid: Bool {
    get { self[MarkdownOnSolidKey.self] }
    set { self[MarkdownOnSolidKey.self] = newValue }
  }
  /// The solid fill for the person's own messages, or nil for the tinted look.
  var ownBubbleFill: Color? {
    get { self[OwnBubbleFillKey.self] }
    set { self[OwnBubbleFillKey.self] = newValue }
  }
}

/// Sizes a bubble to its content, up to a share of the column and a cap, and puts it at the
/// leading or trailing edge. It takes the column's whole width, so the bubble can sit at either. Its height is
/// always its content's: the content is offered no height, since a list row's height offer held a nested list item
/// to one truncated line at large text sizes.
struct BubbleWidth: Layout {
  var fraction: CGFloat = 1
  var cap: CGFloat = .infinity
  var trailing = false
  /// A width the fraction may not take the bubble under, though the column and the cap still can.
  var minimum: CGFloat = 0
  /// The widest the bubble may be in a column this wide.
  func width(for column: CGFloat) -> CGFloat { min(column, max(column * fraction, minimum), cap) }
  private func limit(_ width: CGFloat?) -> CGFloat? { width.map(self.width(for:)) }
  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    guard let child = subviews.first else { return .zero }
    let size = child.sizeThatFits(ProposedViewSize(width: limit(proposal.width), height: nil))
    guard let width = proposal.width, width.isFinite else { return size }
    return CGSize(width: width, height: size.height)
  }
  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    guard let child = subviews.first else { return }
    let offer = ProposedViewSize(width: limit(bounds.width), height: nil)
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
  /// The person's own message in a group chat: its prose sits in the person's bubbles at the trailing edge, with the
  /// corners mirrored, in `ownBubbleFill` when it is set.
  var own = false
  @Environment(\.ownBubbleFill) private var ownBubbleFill
  /// The body text's size, which the person's bubble in a group needs room for; see `PersonBubbles.groupLayout`.
  @ScaledMetric(relativeTo: .body) private var em: CGFloat = 17
  var body: some View {
    VStack(alignment: own ? .trailing : .leading, spacing: 6) {
      ForEach(segments) { segment in
        switch segment.kind {
        case .bubble(let blocks, let settled):
          let corners = ReplyBubbles.corners(at: segment.id, count: segments.count, endsReply: endsReply)
          if own {
            PersonBubble(solid: ownBubbleFill, found: false, top: corners.top, bottom: corners.bottom, layout: PersonBubbles.groupLayout(em: em)) {
              MarkdownBlocksView(blocks: blocks, settled: settled).markdownLinks().padding(.vertical, 10).padding(.horizontal, 14)
            }
          } else {
            ReplyBubble(blocks: blocks, settled: settled, top: corners.top, bottom: corners.bottom)
          }
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
        .foregroundStyle(Color.primary, Palette.bubbleSecondary)
        .padding(.vertical, 10).padding(.horizontal, 14)
        .background(Palette.replyBubble, in: shape)
        .overlay { if contrast == .increased { shape.strokeBorder(Palette.bubbleBorder) } }
    }
  }
}

/// The rules the person's bubble follows, apart from its content.
enum PersonBubbles {
  /// 86% of the column, and no wider than 560 points, as the web's min(86%, 560px).
  static let layout = BubbleWidth(fraction: 0.86, cap: 560, trailing: true)
  /// The person's bubble in a group, where it holds Markdown: as `layout`, but never under 16 times the body text's
  /// size `em` while the column allows, as the web's min(100%, max(86%, 16em), 560px). A quote holding nested lists
  /// indents with the text size, and at an accessibility size on a small phone 86% left its innermost line no room.
  static func groupLayout(em: CGFloat) -> BubbleWidth { BubbleWidth(fraction: 0.86, cap: 560, trailing: true, minimum: 16 * em) }
  /// The edge drawn around the bubble: with Increase Contrast on, tinted or solid, since a dark solid fill
  /// can sit as close as 1.13:1 to the dark transcript.
  static func border(solid: Bool, increasedContrast: Bool) -> Color? {
    increasedContrast ? Palette.bubbleBorder : nil
  }
  /// How opaque the person's message is while it is on its way. A tinted one fades. A solid one stays
  /// opaque, since fading its fill and white text together drops them below 3:1 over the light transcript;
  /// the delivery line under it says it is on its way.
  static func sendingOpacity(solid: Bool) -> Double { solid ? 1 : 0.66 }
}

/// The person's message bubble, in both chat styles: it hugs its text up to 86% of the column, at most
/// 560 points, at the trailing edge, with its tail at the bottom trailing corner. `solid` fills it with the assistant's
/// color and white text. A group message in several pieces passes the trailing corners for each, as a reply's.
struct PersonBubble<Content: View>: View {
  var solid: Color?
  var found: Bool
  /// The trailing corners' radii; the leading ones are 18.
  var top: CGFloat = 18
  var bottom: CGFloat = 4
  var layout = PersonBubbles.layout
  @ViewBuilder var content: () -> Content
  @Environment(\.colorScheme) private var scheme
  @Environment(\.colorSchemeContrast) private var contrast
  private var shape: UnevenRoundedRectangle {
    UnevenRoundedRectangle(topLeadingRadius: 18, bottomLeadingRadius: 18, bottomTrailingRadius: bottom, topTrailingRadius: top, style: .continuous)
  }
  var body: some View {
    layout {
      Group {
        if let solid {
          // Markdown in the bubble draws its quotes and checked boxes in white too; see `markdownOnSolid`.
          content().foregroundStyle(.white, .white).tint(.white).environment(\.markdownOnSolid, true).background(solid, in: shape)
        } else {
          content().foregroundStyle(Color.primary, Palette.bubbleSecondary).background(Palette.user(scheme), in: shape)
        }
      }
      .overlay {
        if let border = PersonBubbles.border(solid: solid != nil, increasedContrast: contrast == .increased) {
          shape.strokeBorder(border)
        }
      }
      // The find outline hugs the bubble.
      .overlay { if found { shape.stroke(Palette.accent, lineWidth: 2) } }
    }
  }
}

/// Group chats in the bubbles style. The web's GroupChats.tsx follows the same rules.
enum GroupBubbles {
  /// A group has no one assistant's color, and any member's would read as that member speaking, so the person's solid
  /// bubbles take the app's green, light `Palette.accent`, which `SolidBubble.fill` keeps as it is.
  static let solidColor = "#246F59"
  /// A group message's pieces: the whole text is Markdown, so a card fence stays code, as Classic shows it.
  static func segments(_ text: String) -> [ReplySegment] {
    ReplyBubbles.segments([ReplyContentPart(id: 0, markdown: text)], streaming: false)
  }
  /// How a group message is laid out in a chat style. Classic keeps the log: flat Markdown, with the person's own row
  /// in its wash. Bubbles lays every message out as a reply and puts the person's own at the trailing edge.
  enum Row {
    case classic(own: Bool)
    case bubbles(own: Bool, segments: [ReplySegment])
  }
  static func row(_ event: GroupEvent, userId: String?, style: ChatStyle) -> Row {
    let own = isOwn(event, userId: userId)
    switch style {
    case .classic: return .classic(own: own)
    case .bubbles: return .bubbles(own: own, segments: segments(event.payload.text ?? ""))
    }
  }
  /// Whether the signed-in person wrote this message. A routine's post arrives as a person's message from a `cron:`
  /// actor with no sender, so it is never theirs.
  static func isOwn(_ event: GroupEvent, userId: String?) -> Bool {
    guard event.kind == "message.user", let userId else { return false }
    return (event.sender?.id ?? event.actor?.id) == userId
  }
}
