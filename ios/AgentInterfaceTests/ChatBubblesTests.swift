import SwiftUI
import XCTest
@testable import AgentInterface

/// The bubbles chat style: which parts of a reply sit in bubbles, the per-person preference, and the
/// solid fill for the person's own messages.
final class ChatBubblesTests: XCTestCase {
  /// A segment as the reader sees it: a bubble with its block count, or the kind of full-width block.
  private func shape(_ text: String, streaming: Bool = false) -> [String] {
    let parts = streaming ? ReplyCards.parseFresh(text) : ReplyCards.parse(text)
    return ReplyBubbles.segments(parts, streaming: streaming).map { segment in
      switch segment.kind {
      case .bubble(let blocks, _): "bubble \(blocks.count)"
      case .block(.table, _): "table"
      case .block(.code, _): "code"
      case .block(.rule, _): "rule"
      case .block(.list, _): "list"
      case .block(.quote, _): "quote"
      case .block: "other block"
      case .inline: "inline"
      case .cards(let cards): "cards \(cards.count)"
      }
    }
  }

  func testConsecutiveProseSharesOneBubble() {
    XCTAssertEqual(shape("Two notes.\n\n## Fences\n\n- North\n- South\n\n> Check the gate first.\n\nThat's all."), ["bubble 5"])
  }
  func testTablesCodeAndRulesStayOutsideBubbles() {
    let table = "| Gate | Battery |\n| --- | ---: |\n| North | 18% |"
    XCTAssertEqual(shape("The battery is low.\n\n\(table)\n\nReplace it this week."), ["bubble 1", "table", "bubble 1"])
    XCTAssertEqual(shape("```swift\nlet level = 0.18\n```\n\nThat reads the north gate."), ["code", "bubble 1"])
    XCTAssertEqual(shape("Morning.\n\n---\n\nEvening."), ["bubble 1", "rule", "bubble 1"])
    XCTAssertEqual(shape("Here:\n\n```sh\nls\n```\n\n\(table)"), ["bubble 1", "code", "table"])
  }
  /// A list or quote that holds a code block, table or rule renders full width, as in Classic, with its
  /// structure intact. Prose around it still forms bubbles, and a list of plain prose stays in one.
  func testAListOrQuoteHoldingAFullWidthBlockLeavesTheBubble() throws {
    let steps = "Before the fix:\n\n1. Stop the gate.\n2. Run this:\n\n   ```sh\n   gate reset\n   ```\n\nThen it reopens."
    XCTAssertEqual(shape(steps), ["bubble 1", "list", "bubble 1"])
    let segments = ReplyBubbles.segments(ReplyCards.parse(steps), streaming: false)
    guard segments.count == 3, case .block(.list(let list), _) = segments[1].kind else { return XCTFail("Expected the list as a block") }
    XCTAssertEqual(list.items.count, 2, "The list keeps both items")
    XCTAssertEqual(list.items[1].blocks, [.paragraph("Run this:"), .code(language: "sh", text: "gate reset")])
    XCTAssertEqual(shape("- Gate\n  - Nested\n\n    | A | B |\n    | --- | --- |\n    | 1 | 2 |"), ["list"], "A table deeper in the list counts")
    XCTAssertEqual(shape("Note:\n\n> Run\n>\n> ```\n> ls\n> ```"), ["bubble 1", "quote"])
    XCTAssertEqual(shape("> Morning.\n>\n> ---\n>\n> Evening."), ["quote"])
    XCTAssertEqual(shape("Plain:\n\n- North\n- South\n\n> Check the gate first."), ["bubble 3"])
  }
  /// Only the bubble that ends a reply points at the assistant. One that a table or code block follows joins
  /// it with the tighter corner instead, as on the web, and a reply part that another part follows has no tail.
  func testOnlyTheReplysFinalBubbleCarriesTheTail() {
    func corners(_ text: String, endsReply: Bool = true) -> [String] {
      let segments = ReplyBubbles.segments(ReplyCards.parse(text), streaming: false)
      return segments.filter(\.isBubble).map { segment in
        let corners = ReplyBubbles.corners(at: segment.id, count: segments.count, endsReply: endsReply)
        return "\(Int(corners.top))/\(Int(corners.bottom))"
      }
    }
    let table = "| Gate | Battery |\n| --- | ---: |\n| North | 18% |"
    XCTAssertEqual(corners("Start with the north gate.\n\n\(table)"), ["18/8"], "A table follows, so the bubble joins it")
    XCTAssertEqual(corners("Before.\n\n```sh\nls\n```"), ["18/8"])
    XCTAssertEqual(corners("Before.\n\n\(table)\n\nAfter."), ["18/8", "8/4"])
    XCTAssertEqual(corners("Only prose."), ["18/4"])
    XCTAssertEqual(corners("Only prose.", endsReply: false), ["18/18"])
  }
  func testCardsSplitTheReplyAndKeepTheirOwnBlock() {
    let card = #"{"version":1,"cards":[{"id":"feed","type":"checklist","title":"Feed","items":[{"id":"hay","text":"Hay"}]}]}"#
    XCTAssertEqual(shape("Before the list.\n\n```agent-ui\n\(card)\n```\n\nAfter it."), ["bubble 1", "cards 1", "bubble 1"])
  }
  func testAnEmptyReplyHasNoBubble() {
    XCTAssertEqual(shape(""), [])
    XCTAssertEqual(shape("\n\n  \n"), [])
  }
  /// A reply groups the same way at every step of streaming as it does once it settles, so nothing
  /// moves when the saved copy replaces the streamed one.
  func testAStreamingReplyGroupsAsItWillOnceSettled() {
    let full = "Checking the gates.\n\n```swift\nlet level = try await gate.battery()\n```\n\n| Gate | Battery |\n| --- | --- |\n| North | 18% |\n\nReplace it soon."
    for length in Array(stride(from: 1, through: full.count, by: 7)) + [full.count] {
      let prefix = String(full.prefix(length))
      XCTAssertEqual(shape(prefix, streaming: true), shape(prefix), "Streamed and settled groupings differ at \(length) characters")
    }
    // Mid-stream, an unclosed fence is already a code block outside the bubble.
    XCTAssertEqual(shape("Checking the gates.\n\n```swift\nlet level", streaming: true), ["bubble 1", "code"])
    XCTAssertEqual(shape(full, streaming: true), ["bubble 1", "code", "table", "bubble 1"])
  }
  /// While a reply streams, its last bubble is still changing, so its text is not cached as settled.
  func testAStreamingBubbleMarksItsGrowingBlockUnsettled() {
    let segments = ReplyBubbles.segments(ReplyCards.parseFresh("First line.\n\nSecond line grows"), streaming: true)
    guard case .bubble(let blocks, let settled)? = segments.first?.kind else { return XCTFail("Expected a bubble") }
    XCTAssertEqual(blocks.count, 2)
    XCTAssertLessThan(settled, blocks.count, "The growing paragraph is not settled")
    let finished = ReplyBubbles.segments(ReplyCards.parse("First line.\n\nSecond line grows"), streaming: false)
    guard case .bubble(_, let all)? = finished.first?.kind else { return XCTFail("Expected a bubble") }
    XCTAssertGreaterThanOrEqual(all, 2, "A finished reply is settled throughout")
  }

  // MARK: Preference

  private func decode(_ extra: String) throws -> Preferences {
    try JSONDecoder().decode(Preferences.self, from: Data(#"{"presentation":"simple","theme":"system","favorites":[],"sections":[],"followBots":[]\#(extra)}"#.utf8))
  }
  func testAServerWithoutChatStylesReadsAsBubblesAndTint() throws {
    let old = try decode("")
    XCTAssertEqual(old.chatStyleChoice, .bubbles)
    XCTAssertEqual(old.ownBubbleChoice, .tint)
    let encoded = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(old)) as? [String: Any])
    XCTAssertNil(encoded["chatStyle"], "An untouched choice is not sent")
    XCTAssertNil(encoded["ownBubble"])
  }
  func testSavedChoicesAreRead() throws {
    let saved = try decode(#","chatStyle":"classic","ownBubble":"solid""#)
    XCTAssertEqual(saved.chatStyleChoice, .classic)
    XCTAssertEqual(saved.ownBubbleChoice, .solid)
  }
  /// A value from a newer client reads as the default and stays in the copy this app keeps offline. A settings
  /// save never sends it back; NativeContractTests covers that.
  func testAnUnknownChoiceReadsAsTheDefaultAndStaysInTheCachedCopy() throws {
    var newer = try decode(#","chatStyle":"compact","ownBubble":"gradient""#)
    XCTAssertEqual(newer.chatStyleChoice, .bubbles)
    XCTAssertEqual(newer.ownBubbleChoice, .tint)
    newer.theme = "dark"
    let encoded = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(newer)) as? [String: Any])
    XCTAssertEqual(encoded["chatStyle"] as? String, "compact")
    XCTAssertEqual(encoded["ownBubble"] as? String, "gradient")
  }
  func testChoosingAStyleSavesItsName() throws {
    var preferences = try decode("")
    preferences.chatStyleChoice = .classic
    preferences.ownBubbleChoice = .solid
    let encoded = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(preferences)) as? [String: Any])
    XCTAssertEqual(encoded["chatStyle"] as? String, "classic")
    XCTAssertEqual(encoded["ownBubble"] as? String, "solid")
  }

  // MARK: Solid fill

  func testSolidFillKeepsWhiteTextReadableForEveryAvatarColor() throws {
    for color in AvatarConfig.colors + ["#1084FE", "#FF6700", "#00BCA6", "#FF263C", "#FF309B", "#9159FE", "#FF9800", "#97683D", "#292929"] {
      let fill = try XCTUnwrap(SolidBubble.fill(color), color)
      XCTAssertGreaterThanOrEqual(SolidBubble.contrastWithWhite(fill), 4.5, "\(color) became \(fill)")
    }
  }
  /// Every hue at full sRGB chroma, and the lightest and darkest grays.
  func testSolidFillKeepsWhiteTextReadableAcrossHues() throws {
    for degree in 0..<360 {
      let color = Self.hex(hue: Double(degree))
      let fill = try XCTUnwrap(SolidBubble.fill(color))
      XCTAssertGreaterThanOrEqual(SolidBubble.contrastWithWhite(fill), 4.5, "\(color) at \(degree)° became \(fill)")
    }
    for gray in ["#FFFFFF", "#F2F2F2", "#9A9A9A", "#000000"] {
      let fill = try XCTUnwrap(SolidBubble.fill(gray))
      XCTAssertGreaterThanOrEqual(SolidBubble.contrastWithWhite(fill), 4.5, "\(gray) became \(fill)")
    }
  }
  /// The cap lowers only lightness: the hue survives, and a color already dark enough stays as it is.
  /// The cap is 0.52 on the web too, so both clients draw the same fill; 0.003 allows for 8-bit rounding.
  func testSolidFillKeepsTheHueAndLeavesDarkColorsAlone() throws {
    XCTAssertEqual(SolidBubble.fill("#292929"), "#292929")
    for color in ["#1084FE", "#FF6700", "#00BCA6", "#9159FE"] {
      let fill = try XCTUnwrap(SolidBubble.fill(color))
      XCTAssertEqual(Self.hue(fill), Self.hue(color), accuracy: 4, "\(color) became \(fill)")
      XCTAssertEqual(Self.lightness(fill), 0.52, accuracy: 0.003, "\(color) became \(fill)")
    }
  }
  /// Fills from an independent implementation of the same rule: sRGB to OKLab by way of CIE XYZ, lightness
  /// capped at 0.52, and chroma bisected to the sRGB edge, the most sRGB shows at that lightness and hue.
  /// One unit a channel allows for rounding. A wrong coefficient in this app's conversion moves a fill well past
  /// that, which hue and lightness checks made with the same conversion cannot see. A reference that steps
  /// chroma down 2% at a time lands up to 8 units inside the edge in a channel near zero, where sRGB is
  /// steepest (#FF263C gives #C40826), so it cannot hold the tolerance this needs.
  func testSolidFillMatchesAnIndependentReference() throws {
    let reference = [
      "#1084FE": "#0066CA", "#FF6700": "#AC4300", "#00BCA6": "#007A6B", "#FF263C": "#C50025", "#FF309B": "#BD006E",
      "#9159FE": "#7738DD", "#FF9800": "#975800", "#97683D": "#8B5D32", "#292929": "#292929",
    ]
    for (color, expected) in reference {
      let fill = try XCTUnwrap(SolidBubble.fill(color))
      let (r, g, b) = try XCTUnwrap(AvatarMotion.rgb(fill)), (er, eg, eb) = try XCTUnwrap(AvatarMotion.rgb(expected))
      XCTAssertLessThanOrEqual(max(abs(r - er), abs(g - eg), abs(b - eb)), 1, "\(color) became \(fill), expected \(expected)")
    }
  }
  /// The web's solidFill reads the same cases (tests/solid-bubble.test.ts), so both clients fill a person's bubble
  /// with one color. This algorithm is the reference: a case that fails here is reported, not edited to pass.
  func testSolidFillMatchesTheSharedVectors() throws {
    struct Case: Decodable { var name: String; var color: String; var fill: String? }
    struct Vectors: Decodable { var cases: [Case] }
    let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Vectors/solid-bubble.json")
    let cases = try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url)).cases
    XCTAssertFalse(cases.isEmpty)
    for vector in cases {
      XCTAssertEqual(SolidBubble.fill(vector.color), vector.fill, "\(vector.name): \(vector.color)")
    }
    let covered = Set(cases.map(\.color))
    XCTAssertEqual(AvatarConfig.colors.filter { !covered.contains($0) }, [], "Every avatar color has a vector")
  }
  func testOnlyADrawnAvatarTintsTheBubble() {
    XCTAssertEqual(SolidBubble.tint(AvatarConfig(color: "#FF6700")), "#FF6700")
    XCTAssertNil(SolidBubble.tint(AvatarConfig(mode: .portrait, color: "#FF6700", src: "/api/files/me")), "A portrait keeps the tint")
    XCTAssertNil(SolidBubble.tint(nil))
    XCTAssertNil(SolidBubble.tint(AvatarConfig(color: nil)))
    XCTAssertNil(SolidBubble.tint(AvatarConfig(color: "orange")), "A color that is not hex is ignored, as on the web")
  }

  // MARK: Contrast

  private static let avatarColors = AvatarConfig.colors + ["#1084FE", "#FF6700", "#00BCA6", "#FF263C", "#FF309B", "#9159FE", "#FF9800", "#97683D", "#292929"]
  /// Every text color that can sit in a reply bubble or the person's tinted bubble reads at 4.5:1 on its fill
  /// in both appearances; a task's empty box, a graphic, at 3:1. A palette change that lowers one fails here.
  func testTextInsideABubbleKeepsItsContrastInBothAppearances() {
    let light = Contrast.resolved(Palette.replyBubble, dark: false), dark = Contrast.resolved(Palette.replyBubble, dark: true)
    XCTAssertGreaterThan(abs(light.r - dark.r), 0.5, "The reply fill resolves per appearance")
    for isDark in [false, true] {
      let scheme: ColorScheme = isDark ? .dark : .light
      let reply = Contrast.resolved(Palette.replyBubble, dark: isDark), person = Contrast.resolved(Palette.user(scheme), dark: isDark)
      let pairs: [(String, Color, Contrast.RGBA, Double)] = [
        ("reply text, headings, inline code and list numbers", Color(uiColor: .label), reply, 4.5),
        ("a link in a reply", Palette.accent, reply, 4.5),
        ("a block quote", Palette.quote, reply, 4.5),
        ("a task's empty box", Palette.bubbleSecondary, reply, 3),
        ("the person's text and a file's name", Color(uiColor: .label), person, 4.5),
        ("a file's size under the person's message", Palette.bubbleSecondary, person, 4.5),
        // A group message in the person's bubble is Markdown.
        ("a link in the person's group message", Palette.accent, person, 4.5),
        ("a quote in the person's group message", Palette.quote, person, 4.5),
        ("a checked box in the person's group message", Palette.accent, person, 3),
      ]
      for (name, text, fill, minimum) in pairs {
        let value = Contrast.ratio(Contrast.over(Contrast.resolved(text, dark: isDark), fill), fill)
        XCTAssertGreaterThanOrEqual(value, minimum, "\(name) in \(isDark ? "dark" : "light"): \(String(format: "%.2f", value)):1")
      }
    }
  }
  /// With Increase Contrast on, every person's bubble has an edge at 3:1 against the transcript, solid ones too.
  func testIncreasedContrastGivesEveryPersonsBubbleAVisibleEdge() throws {
    for isDark in [false, true] {
      let scheme: ColorScheme = isDark ? .dark : .light
      let surface = Contrast.resolved(Palette.surface(scheme), dark: isDark)
      let tinted = PersonBubbles.border(solid: false, increasedContrast: true) ?? Palette.user(scheme)
      XCTAssertGreaterThanOrEqual(Contrast.ratio(Contrast.resolved(tinted, dark: isDark), surface), 3, "Tinted in \(scheme)")
      for color in Self.avatarColors {
        let fill = try XCTUnwrap(SolidBubble.fill(color))
        let edge = PersonBubbles.border(solid: true, increasedContrast: true) ?? Color(hex: fill)
        let value = Contrast.ratio(Contrast.resolved(edge, dark: isDark), surface)
        XCTAssertGreaterThanOrEqual(value, 3, "\(color) as \(fill) in \(scheme): \(String(format: "%.2f", value)):1")
      }
    }
  }
  /// While it is on its way, a solid bubble's white text still reads at 4.5:1 over the transcript.
  func testASolidBubbleOnItsWayKeepsItsTextReadable() throws {
    let opacity = PersonBubbles.sendingOpacity(solid: true)
    for isDark in [false, true] {
      let surface = Contrast.resolved(Palette.surface(isDark ? .dark : .light), dark: isDark)
      for color in Self.avatarColors {
        let fill = try XCTUnwrap(SolidBubble.fill(color))
        let background = Contrast.over(Contrast.resolved(Color(hex: fill), dark: isDark), surface, opacity: opacity)
        let text = Contrast.over(Contrast.over(Contrast.resolved(Color.white, dark: isDark), Contrast.resolved(Color(hex: fill), dark: isDark)), surface, opacity: opacity)
        let value = Contrast.ratio(text, background)
        XCTAssertGreaterThanOrEqual(value, 4.5, "\(color) as \(fill) in \(isDark ? "dark" : "light"): \(String(format: "%.2f", value)):1")
      }
    }
  }
  /// The person's bubble takes up to 86% of the column and stops at 560 points, as the web's min(86%, 560px).
  func testThePersonsBubbleStopsAt560Points() {
    XCTAssertEqual(PersonBubbles.layout.width(for: 390), 335.4, accuracy: 0.01, "A phone column")
    XCTAssertEqual(PersonBubbles.layout.width(for: 900), 560, "An iPad column")
  }

  // MARK: Group chats

  private func groupEvent(_ id: String, _ kind: String, _ text: String, who: String) throws -> GroupEvent {
    let json = #"{"event_id":"\#(id)","seq":1,"kind":"\#(kind)","created_at":1,"payload":{"text":\#(String(decoding: try JSONEncoder().encode(text), as: UTF8.self))},\#(who)}"#
    return try JSONDecoder().decode(GroupEvent.self, from: Data(json.utf8))
  }
  private func kinds(_ segments: [ReplySegment]) -> [String] {
    segments.map { segment -> String in
      switch segment.kind {
      case .bubble(let blocks, _): return "bubble(\(blocks.count))"
      case .block(.code, _): return "code"
      case .block(.table, _): return "table"
      case .block: return "block"
      case .inline: return "inline"
      case .cards: return "cards"
      }
    }
  }
  /// Classic keeps every group message flat. Bubbles lays out everyone's message as a reply, the person's included:
  /// prose in bubbles, a table at the column's width. Only the person's own sit at the trailing edge.
  func testGroupRowsFollowTheChatStyle() throws {
    let me = #""sender":{"id":"me","name":"Local test member"}"#
    let mixed = "Here is the plan:\n\n| Dish | Who |\n| --- | --- |\n| Brisket | Kitchen |\n\nI'll post a reminder."
    let rows = [
      (try groupEvent("own", "message.user", mixed, who: me), true),
      (try groupEvent("member", "message.user", mixed, who: #""sender":{"id":"two","name":"Second test member"}"#), false),
      (try groupEvent("bot", "message.member", mixed, who: #""actor":{"kind":"member","id":"kitchen"}"#), false),
      (try groupEvent("routine", "message.user", mixed, who: #""actor":{"kind":"user","id":"cron:job","display_name":"[bot:ranch] Morning brief"}"#), false),
      // A message a native Hermes client wrote names its author only as the actor.
      (try groupEvent("native", "message.user", mixed, who: #""actor":{"kind":"user","id":"me"}"#), true),
    ]
    for (event, own) in rows {
      guard case .classic(let classicOwn) = GroupBubbles.row(event, userId: "me", style: .classic) else { return XCTFail("\(event.id) in Classic") }
      XCTAssertEqual(classicOwn, own, "\(event.id): Classic washes only the person's own row")
      guard case .bubbles(let bubbleOwn, let segments) = GroupBubbles.row(event, userId: "me", style: .bubbles) else { return XCTFail("\(event.id) in Bubbles") }
      XCTAssertEqual(bubbleOwn, own, "\(event.id): only the person's own sit at the trailing edge")
      XCTAssertEqual(kinds(segments), ["bubble(1)", "table", "bubble(1)"], event.id)
    }
    let signedOut = try groupEvent("own", "message.user", "Hi", who: me)
    guard case .bubbles(let own, _) = GroupBubbles.row(signedOut, userId: nil, style: .bubbles) else { return XCTFail("Bubbles") }
    XCTAssertFalse(own, "Before the account loads no message is the person's")
  }
  /// A group message's Markdown groups as a reply's does: a quote holding nested lists is prose, and a card fence stays
  /// code, as Classic shows it, since a group message is never parsed for cards.
  func testGroupMessagesGroupTheirMarkdownAsAReplyDoes() {
    XCTAssertEqual(kinds(GroupBubbles.segments("> - Gates\n>   - North\n>     - Width is fine.\n\nThen the trailer fits through.")), ["bubble(2)"])
    XCTAssertEqual(kinds(GroupBubbles.segments("First\n\n```wildbots-cards\n{\"version\":1,\"cards\":[]}\n```\n\nLast")), ["bubble(1)", "code", "bubble(1)"])
    XCTAssertEqual(kinds(GroupBubbles.segments("")), [])
  }
  /// The person's solid bubbles in a group take the app's green, which keeps white text, white links and inline code,
  /// a white quote and its bar, and a checked box readable; Increase Contrast gives it an edge against the transcript.
  @MainActor func testAGroupsSolidBubbleKeepsEverythingInItReadable() throws {
    let fill = try XCTUnwrap(SolidBubble.fill(GroupBubbles.solidColor))
    XCTAssertEqual(fill, GroupBubbles.solidColor, "The green is dark enough already, so the fill keeps it")
    for isDark in [false, true] {
      let green = Contrast.resolved(Color(hex: fill), dark: isDark), white = Contrast.resolved(Color.white, dark: isDark)
      XCTAssertGreaterThanOrEqual(Contrast.ratio(white, green), 4.5, "Text, links, inline code, quotes and checked boxes are white")
      let bar = Contrast.over(white, green, opacity: MarkdownBlockView.solidQuoteBar)
      XCTAssertGreaterThanOrEqual(Contrast.ratio(bar, green), 3, "A quote's bar at \(MarkdownBlockView.solidQuoteBar)")
      let surface = Contrast.resolved(Palette.surface(isDark ? .dark : .light), dark: isDark)
      let edge = try XCTUnwrap(PersonBubbles.border(solid: true, increasedContrast: true))
      XCTAssertGreaterThanOrEqual(Contrast.ratio(Contrast.resolved(edge, dark: isDark), surface), 3, "Increase Contrast's edge")
    }
  }
  /// What the solid bubble draws a task's box in, both states, resolved as the screen does. The empty box was the
  /// system's secondary gray, which a capture showed all but gone on the green in light.
  @MainActor func testBothTaskBoxesShowOnTheGroupsSolidFill() {
    for isDark in [false, true] {
      let green = Contrast.resolved(Color(hex: GroupBubbles.solidColor), dark: isDark)
      for done in [false, true] {
        let box = Contrast.over(Contrast.resolved(MarkdownListView.boxColor(done: done, onSolid: true), dark: isDark), green)
        XCTAssertGreaterThanOrEqual(Contrast.ratio(box, green), 3, "\(done ? "Checked" : "Empty") in \(isDark ? "dark" : "light")")
      }
    }
  }
  /// On a solid fill a link is as white as the words around it, so it is underlined, and nothing else is.
  @MainActor func testALinkOnASolidFillIsUnderlined() {
    let ink = MarkdownBlockView.solidInk(Markdown.attributed("See [the plan](https://example.com/plan) and `gate 4`."))
    XCTAssertEqual(ink.runs.filter { $0.underlineStyle != nil }.map { String(ink[$0.range].characters) }, ["the plan"])
  }
  /// In a group the person's bubble holds Markdown, so on a narrow row at a large text size it takes the whole row,
  /// as the web's min(100%, max(86%, 16em), 560px), and otherwise follows the 86% and 560-point rules.
  func testThePersonsGroupBubbleUsesTheRowWhenTheTextIsLarge() {
    XCTAssertEqual(PersonBubbles.groupLayout(em: 17).width(for: 319), 274.34, accuracy: 0.01, "A small phone at the default size")
    XCTAssertEqual(PersonBubbles.groupLayout(em: 28).width(for: 319), 319, "A small phone at an accessibility size")
    XCTAssertEqual(PersonBubbles.groupLayout(em: 53).width(for: 900), 560, "The cap still holds")
    XCTAssertEqual(PersonBubbles.groupLayout(em: 17.5).width(for: 300), 280, accuracy: 0.01, "16em wins over 86% while the row has room")
  }

  /// Records every size its parent proposes to it.
  private struct ProposalProbe: Layout {
    final class Log: @unchecked Sendable { var heights: [CGFloat?] = [] }
    let log: Log
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
      log.heights.append(proposal.height)
      return CGSize(width: 100, height: 40)
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) { log.heights.append(proposal.height) }
  }
  /// A bubble's height follows its content. A list row offers a height, and passing it on held a nested list item in
  /// the person's group bubble to one truncated line at the largest text sizes.
  @MainActor func testABubbleNeverOffersItsContentTheRowsHeight() {
    let log = ProposalProbe.Log()
    let bubble = PersonBubbles.groupLayout(em: 44), probe = ProposalProbe(log: log)
    let renderer = ImageRenderer(content: bubble { probe { Color.clear } }.frame(width: 320, height: 90))
    renderer.proposedSize = ProposedViewSize(width: 320, height: 90)
    _ = renderer.uiImage
    XCTAssertFalse(log.heights.isEmpty, "The bubble laid out its content")
    XCTAssertEqual(log.heights.compactMap { $0 }, [], "Every offer leaves the height open: \(log.heights)")
  }

  private static func hex(hue: Double) -> String {
    let h = hue / 60, x = 1 - abs(h.truncatingRemainder(dividingBy: 2) - 1)
    let (r, g, b): (Double, Double, Double) = switch Int(h) {
    case 0: (1, x, 0)
    case 1: (x, 1, 0)
    case 2: (0, 1, x)
    case 3: (0, x, 1)
    case 4: (x, 0, 1)
    default: (1, 0, x)
    }
    return String(format: "#%02X%02X%02X", Int(r * 255), Int(g * 255), Int(b * 255))
  }
  private static func lab(_ color: String) -> OKLab.Value {
    let (r, g, b) = AvatarMotion.rgb(color)!
    return OKLab.from(red: Double(r) / 255, green: Double(g) / 255, blue: Double(b) / 255)
  }
  private static func lightness(_ color: String) -> Double { lab(color).l }
  private static func hue(_ color: String) -> Double {
    let value = lab(color)
    return (atan2(value.b, value.a) * 180 / .pi + 360).truncatingRemainder(dividingBy: 360)
  }
}
