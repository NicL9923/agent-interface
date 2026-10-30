import SwiftUI
import XCTest
@testable import AgentInterface

/// The native Markdown parser against what the web's react-markdown and remark-gfm render
/// (src/components/MessageMarkdown.tsx).
@MainActor final class MarkdownTests: XCTestCase {
  func testCodeKeepsEqualGlyphWidthsUnderTheRoundedAppFontAndScales() throws {
    func width(_ text: String, size: DynamicTypeSize) throws -> CGFloat {
      let renderer = ImageRenderer(content: Text(text).font(MarkdownCodeBlock.codeFont)
        .fixedSize().fontDesign(.rounded).environment(\.dynamicTypeSize, size))
      return try XCTUnwrap(renderer.uiImage).size.width
    }
    let normal = try width("iiiiiiii", size: .large)
    let accessible = try width("iiiiiiii", size: .accessibility3)
    XCTAssertGreaterThan(normal, 10)
    XCTAssertEqual(normal, try width("MMMMMMMM", size: .large), accuracy: 1)
    XCTAssertEqual(accessible, try width("MMMMMMMM", size: .accessibility3), accuracy: 1)
    XCTAssertGreaterThan(accessible, normal * 1.5)
  }

  private func parse(_ text: String) -> [MarkdownBlock] { Markdown.parse(text) }
  private func links(_ text: String) -> [String] {
    Markdown.attributed(text).runs.compactMap { $0.link?.absoluteString }
  }

  func testNestedListsFollowTheItemContentIndent() {
    XCTAssertEqual(parse("- Barn\n  - Hay\n  - Feed\n- House"), [.list(MarkdownList(start: nil, items: [
      MarkdownListItem(blocks: [.paragraph("Barn"), .list(MarkdownList(start: nil, items: [
        MarkdownListItem(blocks: [.paragraph("Hay")]), MarkdownListItem(blocks: [.paragraph("Feed")]),
      ]))]),
      MarkdownListItem(blocks: [.paragraph("House")]),
    ]))])
    // Under "1. ", content starts at column 3, so a bullet at column 2 starts a new list instead.
    XCTAssertEqual(parse("1. Step\n   - Detail"), [.list(MarkdownList(start: 1, items: [
      MarkdownListItem(blocks: [.paragraph("Step"), .list(MarkdownList(start: nil, items: [MarkdownListItem(blocks: [.paragraph("Detail")])]))]),
    ]))])
    XCTAssertEqual(parse("1. Step\n  - Detail").count, 2)
    // A blank line between items keeps one list; a lazy line continues the item's paragraph.
    XCTAssertEqual(parse("- One\n\n- Two\nmore"), [.list(MarkdownList(start: nil, items: [
      MarkdownListItem(blocks: [.paragraph("One")]), MarkdownListItem(blocks: [.paragraph("Two more")]),
    ]))])
    XCTAssertEqual(parse("- One\n\nAfter"), [.list(MarkdownList(start: nil, items: [MarkdownListItem(blocks: [.paragraph("One")])])), .paragraph("After")])
  }

  func testOrderedListsCountFromTheirFirstNumber() {
    guard case .list(let list) = parse("3. Gate\n7. Fence\n1. Water").first else { return XCTFail("Expected a list") }
    XCTAssertEqual(list.start, 3)
    XCTAssertEqual((0..<3).map { MarkdownListView.marker(list, index: $0, depth: 0) }, ["3.", "4.", "5."])
    XCTAssertEqual(MarkdownListView.marker(MarkdownList(start: nil, items: []), index: 0, depth: 1), "◦")
    // A different delimiter starts a new list, and only "1." may interrupt a paragraph.
    XCTAssertEqual(parse("1. A\n2) B").count, 2)
    XCTAssertEqual(parse("The count was\n2. Not a list"), [.paragraph("The count was 2. Not a list")])
    XCTAssertEqual(parse("Steps\n1. First").count, 2)
  }

  func testTaskItemsAreReadOnlyChecks() {
    XCTAssertEqual(parse("- [x] Finished **work**\n* [ ] Pending\n- [ ]"), [
      .list(MarkdownList(start: nil, items: [
        MarkdownListItem(task: true, blocks: [.paragraph("Finished **work**")]),
      ])),
      .list(MarkdownList(start: nil, items: [
        MarkdownListItem(task: false, blocks: [.paragraph("Pending")]),
      ])),
      .list(MarkdownList(start: nil, items: [MarkdownListItem(blocks: [.paragraph("[ ]")])])),
    ])
  }

  func testQuotesNestBlocksAndTakeLazyLines() {
    XCTAssertEqual(parse("> Quoted\nlazy line\n> - item\n\nAfter"), [
      .quote([.paragraph("Quoted lazy line"), .list(MarkdownList(start: nil, items: [MarkdownListItem(blocks: [.paragraph("item")])]))]),
      .paragraph("After"),
    ])
    XCTAssertEqual(parse("> outer\n> > inner"), [.quote([.paragraph("outer"), .quote([.paragraph("inner")])])])
  }

  func testRulesAndHeadings() {
    XCTAssertEqual(parse("---\n***\n_ _ _\n- - -"), [.rule, .rule, .rule, .rule])
    XCTAssertEqual(parse("Title\n---"), [.heading(level: 2, text: "Title")])
    XCTAssertEqual(parse("Title\n==="), [.heading(level: 1, text: "Title")])
    XCTAssertEqual(parse("# One\n###### Six ###\n####### Seven\n#Tag"), [
      .heading(level: 1, text: "One"), .heading(level: 6, text: "Six"), .paragraph("####### Seven #Tag"),
    ])
    XCTAssertEqual(parse("## C# notes"), [.heading(level: 2, text: "C# notes")])
    let heading = Markdown.attributed("**Bold** title")
    XCTAssertTrue(heading.runs.contains { $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true })
    XCTAssertEqual(String(heading.characters), "Bold title")
    XCTAssertEqual(MarkdownBlockView.headingFont(1), .title2.weight(.semibold))
    XCTAssertEqual(MarkdownBlockView.headingFont(2), .title3.weight(.semibold))
    XCTAssertEqual(MarkdownBlockView.headingFont(5), .headline)
  }

  func testFencesOfEitherKindAndAnyLength() {
    XCTAssertEqual(parse("~~~python\nprint(1)\n~~~"), [.code(language: "python", text: "print(1)")])
    XCTAssertEqual(parse("````md\n```\ninner\n```\n````"), [.code(language: "md", text: "```\ninner\n```")])
    XCTAssertEqual(parse("```swift title=\"A\"\nlet a = 1\n```"), [.code(language: "swift", text: "let a = 1")])
    // An indented fence removes its own indent from each line, and a ~~~ line does not close ```.
    XCTAssertEqual(parse("  ```js\n  let a\n    b\n  ~~~\n  ```\nAfter"), [.code(language: "js", text: "let a\n  b\n~~~"), .paragraph("After")])
    XCTAssertEqual(parse("```\nunclosed\n\nstill code"), [.code(language: nil, text: "unclosed\n\nstill code")])
    XCTAssertEqual(parse("    indented\n    code\n\nText"), [.code(language: nil, text: "indented\ncode"), .paragraph("Text")])
    XCTAssertEqual(parse("Para\n    continues"), [.paragraph("Para continues")])
  }

  func testSoftBreaksAreSpacesAndHardBreaksStay() {
    XCTAssertEqual(parse("one\ntwo\n  three"), [.paragraph("one two three")])
    XCTAssertEqual(parse("one  \ntwo"), [.paragraph("one\ntwo")])
    XCTAssertEqual(parse("one\\\ntwo"), [.paragraph("one\ntwo")])
    XCTAssertEqual(parse("one\\\\\ntwo"), [.paragraph("one\\\\ two")])
    XCTAssertEqual(parse("a\r\nb"), [.paragraph("a b")])
  }

  func testRawHTMLIsSkippedLikeSkipHtml() {
    XCTAssertEqual(parse("<div>\nhidden\n</div>\n\nShown"), [.paragraph("Shown")])
    XCTAssertEqual(parse("<!-- note\nstill note -->\nText"), [.paragraph("Text")])
    XCTAssertEqual(parse("<script>\nalert(1)\n</script>\nText"), [.paragraph("Text")])
    XCTAssertEqual(parse("<custom-tag>\n\nText"), [.paragraph("Text")])
    // A lone tag cannot interrupt a paragraph, so it stays inline and is stripped there.
    XCTAssertEqual(parse("Text\n<span>"), [.paragraph("Text <span>")])
    XCTAssertEqual(Markdown.inlineSource("a <b>bold</b> `<i>` <https://x.test> c<br/>"), "a bold `<i>` <https://x.test> c")
    XCTAssertEqual(String(Markdown.attributed("Use List<String> here").characters), "Use List here")
  }

  func testImagesBecomeTheWebsOpenImageLinks() {
    XCTAssertEqual(Markdown.inlineSource("![Chart](https://x.test/c.png \"Title\")"), "[Open image: Chart](https://x.test/c.png)")
    XCTAssertEqual(Markdown.inlineSource("![](https://x.test/c.png)"), "[Open image](https://x.test/c.png)")
    XCTAssertEqual(Markdown.inlineSource("![Map]()"), "Map")
    XCTAssertEqual(Markdown.inlineSource("![]()"), "Image unavailable")
    XCTAssertEqual(Markdown.inlineSource("`![a](b)` \\![c](d)"), "`![a](b)` \\![c](d)")
    let image = Markdown.attributed("![Chart](https://x.test/c.png)")
    XCTAssertEqual(String(image.characters), "Open image: Chart")
    XCTAssertEqual(links("![Chart](https://x.test/c.png)"), ["https://x.test/c.png"])
  }

  func testBareURLsAndEmailsAreLinkedOutsideCodeAndLinks() {
    XCTAssertEqual(links("See https://example.com/a_(b). Then www.ranch.test, or mail hand@ranch.test!"),
      ["https://example.com/a_(b)", "http://www.ranch.test", "mailto:hand@ranch.test"])
    XCTAssertEqual(links("(https://example.com/x)"), ["https://example.com/x"])
    XCTAssertEqual(links("`https://example.com` and [site](https://a.test) https://b.test"), ["https://a.test", "https://b.test"])
    XCTAssertEqual(links("no link in example.com or http:/broken"), [])
  }

  func testTablesNeedADelimiterRowAndKeepItsAlignment() {
    XCTAssertEqual(parse("| L | C | R |\n|:--|:-:|--:|\n| 1 | 2 |\n| a | b | c | d |\n\nAfter"), [
      .table(MarkdownTable(header: ["L", "C", "R"], alignments: [.leading, .center, .trailing], rows: [["1", "2", ""], ["a", "b", "c"]])),
      .paragraph("After"),
    ])
    XCTAssertEqual(parse("a | b\nnot a --- delimiter"), [.paragraph("a | b not a --- delimiter")])
    XCTAssertEqual(parse("a | b\n--- | --- | ---"), [.paragraph("a | b --- | --- | ---")])
    XCTAssertEqual(parse("Intro\n| A | B |\n| --- | --- |\n| 1 | 2 |"), [
      .paragraph("Intro"), .table(MarkdownTable(header: ["A", "B"], alignments: [.leading, .leading], rows: [["1", "2"]])),
    ])
    XCTAssertEqual(Markdown.tableCells("| First | | Last |"), ["First", "", "Last"])
    XCTAssertEqual(Markdown.tableCells("| A\\|B | C |"), ["A|B", "C"])
    XCTAssertEqual(Markdown.tableCells("A | B"), ["A", "B"])
    XCTAssertEqual(MarkdownTableView.alignment(.trailing), .trailing)
  }
}

extension MarkdownTests {
  func testCachedParsingMatchesFreshParsingAsFencesAndTablesFinish() {
    let cache = MarkdownCache()
    let variants = ["hello", "```swift\nlet x", "```swift\nlet x = 1\n```", "| One | Two |\n| --- | --- |\n| 1", "| One | Two |\n| --- | --- |\n| 1 | 2 |"]
    for text in variants { XCTAssertEqual(cache.blocks(text), Markdown.parse(text)); XCTAssertEqual(cache.blocks(text), Markdown.parse(text)) }
    cache.clear(); XCTAssertEqual(cache.blocks(variants[0]), Markdown.parse(variants[0]))
  }
}
