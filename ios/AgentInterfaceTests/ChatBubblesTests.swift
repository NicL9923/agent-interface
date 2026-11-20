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
  /// A value from a newer client reads as the default, and a save of another setting passes it on unchanged.
  func testAnUnknownChoiceReadsAsTheDefaultAndSurvivesASave() throws {
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
  func testOnlyADrawnAvatarTintsTheBubble() {
    XCTAssertEqual(SolidBubble.tint(AvatarConfig(color: "#FF6700")), "#FF6700")
    XCTAssertNil(SolidBubble.tint(AvatarConfig(mode: .portrait, color: "#FF6700", src: "/api/files/me")), "A portrait keeps the tint")
    XCTAssertNil(SolidBubble.tint(nil))
    XCTAssertNil(SolidBubble.tint(AvatarConfig(color: nil)))
    XCTAssertNil(SolidBubble.tint(AvatarConfig(color: "orange")), "A color that is not hex is ignored, as on the web")
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
