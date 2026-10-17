import Foundation

/// A Markdown block, parsed the way the web's react-markdown and remark-gfm read a reply
/// (src/components/MessageMarkdown.tsx): CommonMark blocks, GFM tables and task lists, and raw
/// HTML skipped like `skipHtml`.
indirect enum MarkdownBlock: Equatable {
  /// Inline Markdown with soft line breaks already collapsed to spaces. A `\n` is a hard break.
  case paragraph(String)
  case heading(level: Int, text: String)
  case code(language: String?, text: String)
  case quote([MarkdownBlock])
  case list(MarkdownList)
  case rule
  case table(MarkdownTable)
}
struct MarkdownList: Equatable {
  /// The first number of an ordered list, which later items count up from. Nil for bullets.
  var start: Int?
  var items: [MarkdownListItem]
}
struct MarkdownListItem: Equatable {
  /// Set for a GFM task item: whether it is checked.
  var task: Bool?
  var blocks: [MarkdownBlock]
}
struct MarkdownTable: Equatable {
  enum Alignment: Equatable { case leading, center, trailing }
  var header: [String]
  var alignments: [Alignment]
  /// Rows padded or cut to the header's width, as GFM does.
  var rows: [[String]]
}

enum Markdown {
  static func parse(_ source: String) -> [MarkdownBlock] {
    let lines = source.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
      .components(separatedBy: "\n").map(expandTabs)
    return blocks(lines[...])
  }

  // MARK: Blocks

  static func blocks(_ lines: ArraySlice<String>) -> [MarkdownBlock] {
    var result: [MarkdownBlock] = []
    var paragraph: [String] = []
    var index = lines.startIndex
    func flush() {
      if !paragraph.isEmpty { result.append(.paragraph(joinParagraph(paragraph))) }
      paragraph = []
    }
    while index < lines.endIndex {
      let line = lines[index]
      if isBlank(line) { flush(); index += 1; continue }
      let spaces = indent(line)
      if spaces >= 4 {
        // Indented text continues a paragraph; otherwise it is an indented code block.
        if !paragraph.isEmpty { paragraph.append(line); index += 1; continue }
        result.append(indentedCode(lines, &index))
        continue
      }
      let content = String(line.dropFirst(spaces))
      if !paragraph.isEmpty, let level = setextLevel(content) {
        result.append(.heading(level: level, text: joinParagraph(paragraph)))
        paragraph = []; index += 1; continue
      }
      if let fence = fenceOpening(content) {
        flush(); result.append(fencedCode(lines, &index, fence: fence, indent: spaces)); continue
      }
      if let heading = atxHeading(content) { flush(); result.append(heading); index += 1; continue }
      if isRule(content) { flush(); result.append(.rule); index += 1; continue }
      if content.hasPrefix(">") { flush(); result.append(quote(lines, &index)); continue }
      if let marker = listMarker(line), paragraph.isEmpty || marker.canInterruptParagraph {
        flush(); result.append(list(lines, &index, first: marker)); continue
      }
      if let end = htmlBlockEnd(lines, index, interruptsParagraph: !paragraph.isEmpty) {
        flush(); index = end; continue
      }
      if let table = table(lines, &index) { flush(); result.append(table); continue }
      paragraph.append(content)
      index += 1
    }
    flush()
    return result
  }

  /// Whether a line starts a block that ends a lazy paragraph continuation.
  static func startsBlock(_ line: String) -> Bool {
    guard !isBlank(line), indent(line) < 4 else { return false }
    let content = String(line.dropFirst(indent(line)))
    return fenceOpening(content) != nil || atxHeading(content) != nil || isRule(content) || content.hasPrefix(">")
      || listMarker(line)?.canInterruptParagraph == true
  }

  private static func indentedCode(_ lines: ArraySlice<String>, _ index: inout Int) -> MarkdownBlock {
    var code: [String] = []
    while index < lines.endIndex, isBlank(lines[index]) || indent(lines[index]) >= 4 {
      code.append(isBlank(lines[index]) ? "" : String(lines[index].dropFirst(4)))
      index += 1
    }
    while code.last == "" { code.removeLast() }
    return .code(language: nil, text: code.joined(separator: "\n"))
  }

  struct Fence { var character: Character; var length: Int; var info: String }
  /// A ``` or ~~~ fence of three or more, whose first info word names the language.
  static func fenceOpening(_ content: String) -> Fence? {
    guard let first = content.first, first == "`" || first == "~" else { return nil }
    let length = content.prefix { $0 == first }.count
    guard length >= 3 else { return nil }
    let info = content.dropFirst(length).trimmingCharacters(in: .whitespaces)
    if first == "`" && info.contains("`") { return nil }
    return Fence(character: first, length: length, info: info.split(separator: " ").first.map(String.init) ?? "")
  }
  private static func fencedCode(_ lines: ArraySlice<String>, _ index: inout Int, fence: Fence, indent opening: Int) -> MarkdownBlock {
    var body: [String] = []
    index += 1
    while index < lines.endIndex {
      let line = lines[index]
      let spaces = indent(line)
      let content = line.dropFirst(spaces)
      index += 1
      if spaces < 4, content.prefix(while: { $0 == fence.character }).count >= fence.length,
        content.drop(while: { $0 == fence.character }).allSatisfy({ $0 == " " || $0 == "\t" })
      { break }
      // Content loses as much indentation as the opening fence had.
      body.append(String(line.dropFirst(min(spaces, opening))))
    }
    return .code(language: fence.info.isEmpty ? nil : fence.info, text: body.joined(separator: "\n"))
  }

  static func atxHeading(_ content: String) -> MarkdownBlock? {
    let level = content.prefix { $0 == "#" }.count
    guard (1...6).contains(level) else { return nil }
    let rest = content.dropFirst(level)
    guard rest.isEmpty || rest.first == " " || rest.first == "\t" else { return nil }
    var text = rest.trimmingCharacters(in: .whitespaces)
    // An optional closing run of #s, separated by a space, is not part of the text.
    if text.allSatisfy({ $0 == "#" }) { text = "" }
    else if let range = text.range(of: #"[ \t]+#+$"#, options: .regularExpression) { text = String(text[..<range.lowerBound]) }
    return .heading(level: level, text: text)
  }
  static func setextLevel(_ content: String) -> Int? {
    let trimmed = content.trimmingCharacters(in: .whitespaces)
    guard let first = trimmed.first, first == "=" || first == "-", trimmed.allSatisfy({ $0 == first }) else { return nil }
    return first == "=" ? 1 : 2
  }
  static func isRule(_ content: String) -> Bool {
    let marks = content.filter { $0 != " " && $0 != "\t" }
    guard let first = marks.first, "-*_".contains(first), marks.count >= 3 else { return false }
    return marks.allSatisfy { $0 == first }
  }

  private static func quote(_ lines: ArraySlice<String>, _ index: inout Int) -> MarkdownBlock {
    var inner: [String] = []
    while index < lines.endIndex {
      let line = lines[index]
      let spaces = indent(line)
      if spaces < 4, line.dropFirst(spaces).hasPrefix(">") {
        var rest = String(line.dropFirst(spaces + 1))
        if rest.hasPrefix(" ") { rest.removeFirst() }
        inner.append(rest)
      } else if !isBlank(line), let last = inner.last, !isBlank(last), !startsBlock(line) {
        inner.append(line)  // A lazy continuation of the quoted paragraph.
      } else { break }
      index += 1
    }
    return .quote(blocks(inner[...]))
  }

  struct ListMarker {
    var indent: Int
    var ordered: Bool
    var number: Int
    /// The bullet character, or the `.` or `)` after an ordered number.
    var symbol: Character
    /// The column the item's content starts at; continuation lines indent at least this far.
    var contentIndent: Int
    var rest: String
    /// An empty item, or an ordered one not starting at 1, cannot interrupt a paragraph.
    var canInterruptParagraph: Bool { !rest.isEmpty && (!ordered || number == 1) }
  }
  static func listMarker(_ line: String) -> ListMarker? {
    let spaces = indent(line)
    guard spaces < 4 else { return nil }
    let content = line.dropFirst(spaces)
    guard let first = content.first else { return nil }
    var marker = ListMarker(indent: spaces, ordered: false, number: 0, symbol: first, contentIndent: 0, rest: "")
    var width = 1
    if !"-*+".contains(first) {
      let digits = content.prefix { ("0"..."9").contains($0) }
      guard (1...9).contains(digits.count), let delimiter = content.dropFirst(digits.count).first,
        delimiter == "." || delimiter == ")"
      else { return nil }
      marker.ordered = true; marker.number = Int(digits) ?? 1; marker.symbol = delimiter; width = digits.count + 1
    }
    let after = content.dropFirst(width)
    let gap = after.prefix { $0 == " " }.count
    guard after.isEmpty || gap > 0 else { return nil }
    let text = after.dropFirst(gap)
    // Five or more spaces start indented code inside the item, one column after the marker.
    let used = text.isEmpty || gap > 4 ? 1 : gap
    marker.contentIndent = spaces + width + used
    marker.rest = text.isEmpty ? "" : String(after.dropFirst(used))
    return marker
  }
  private static func list(_ lines: ArraySlice<String>, _ index: inout Int, first: ListMarker) -> MarkdownBlock {
    var items: [[String]] = []
    var current = [first.rest]
    var contentIndent = first.contentIndent
    index += 1
    func sibling(_ line: String) -> ListMarker? {
      guard let marker = listMarker(line), marker.ordered == first.ordered, marker.symbol == first.symbol,
        marker.indent < contentIndent
      else { return nil }
      return marker
    }
    while index < lines.endIndex {
      let line = lines[index]
      if isBlank(line) {
        // A blank line stays in the list only when the list continues after it.
        var next = index
        while next < lines.endIndex, isBlank(lines[next]) { next += 1 }
        guard next < lines.endIndex, indent(lines[next]) >= contentIndent || sibling(lines[next]) != nil else { break }
        current.append(contentsOf: Array(repeating: "", count: next - index))
        index = next
        continue
      }
      if indent(line) >= contentIndent {
        current.append(String(line.dropFirst(contentIndent)))
      } else if let marker = sibling(line) {
        items.append(current); current = [marker.rest]; contentIndent = marker.contentIndent
      } else if listMarker(line) != nil {
        break  // Another kind of marker starts a new list, even one that could not interrupt a paragraph.
      } else if let last = current.last, !isBlank(last), !startsBlock(line) {
        current.append(String(line.dropFirst(indent(line))))  // A lazy paragraph continuation.
      } else { break }
      index += 1
    }
    items.append(current)
    return .list(MarkdownList(start: first.ordered ? first.number : nil, items: items.map(listItem)))
  }
  private static func listItem(_ lines: [String]) -> MarkdownListItem {
    var lines = lines
    var task: Bool?
    if let first = lines.first, let range = first.range(of: #"^\[[ xX]\][ \t]+(?=\S)"#, options: .regularExpression) {
      task = first[first.index(after: first.startIndex)] != " "
      lines[0] = String(first[range.upperBound...])
    }
    return MarkdownListItem(task: task, blocks: blocks(lines[...]))
  }

  /// A GFM table: a header row with pipes, then a delimiter row with as many cells.
  private static func table(_ lines: ArraySlice<String>, _ index: inout Int) -> MarkdownBlock? {
    let header = lines[index]
    guard header.contains("|"), index + 1 < lines.endIndex,
      let alignments = delimiterRow(lines[index + 1]),
      tableCells(header).count == alignments.count
    else { return nil }
    let width = alignments.count
    var rows: [[String]] = []
    index += 2
    while index < lines.endIndex, !isBlank(lines[index]), !startsBlock(lines[index]) {
      let cells = tableCells(lines[index])
      rows.append(Array(cells.prefix(width)) + Array(repeating: "", count: max(0, width - cells.count)))
      index += 1
    }
    return .table(MarkdownTable(header: tableCells(header), alignments: alignments, rows: rows))
  }
  static func delimiterRow(_ line: String) -> [MarkdownTable.Alignment]? {
    guard indent(line) < 4, line.contains("-") else { return nil }
    let cells = tableCells(line)
    guard !cells.isEmpty, cells.count > 1 || line.contains("|") else { return nil }
    var result: [MarkdownTable.Alignment] = []
    for cell in cells {
      guard cell.range(of: #"^:?-+:?$"#, options: .regularExpression) != nil else { return nil }
      result.append(cell.hasPrefix(":") && cell.hasSuffix(":") ? .center : cell.hasSuffix(":") ? .trailing : .leading)
    }
    return result
  }
  static func tableCells(_ row: String) -> [String] {
    var cells: [String] = []
    var cell = ""
    var escaped = false
    for c in row {
      if escaped {
        if c != "|" { cell.append("\\") }
        cell.append(c)
        escaped = false
      } else if c == "\\" {
        escaped = true
      } else if c == "|" {
        cells.append(cell.trimmingCharacters(in: .whitespaces))
        cell = ""
      } else {
        cell.append(c)
      }
    }
    if escaped { cell.append("\\") }
    cells.append(cell.trimmingCharacters(in: .whitespaces))
    let trimmed = row.trimmingCharacters(in: .whitespaces)
    if trimmed.hasPrefix("|") { cells.removeFirst() }
    if trimmed.hasSuffix("|") && !trimmed.hasSuffix("\\|") && !cells.isEmpty { cells.removeLast() }
    return cells
  }

  static let htmlBlockTags: Set<String> = [
    "address", "article", "aside", "base", "basefont", "blockquote", "body", "caption", "center", "col",
    "colgroup", "dd", "details", "dialog", "dir", "div", "dl", "dt", "fieldset", "figcaption", "figure",
    "footer", "form", "frame", "frameset", "h1", "h2", "h3", "h4", "h5", "h6", "head", "header", "hr",
    "html", "iframe", "legend", "li", "link", "main", "menu", "menuitem", "nav", "noframes", "ol",
    "optgroup", "option", "p", "param", "search", "section", "summary", "table", "tbody", "td", "tfoot",
    "th", "thead", "title", "tr", "track", "ul",
  ]
  private static let openTag = try! NSRegularExpression(pattern: #"^</?([A-Za-z][A-Za-z0-9-]*)(?=[ \t>]|/>|$)"#)
  private static let completeTag = try! NSRegularExpression(
    pattern: #"^(?:<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*/?>|</[A-Za-z][A-Za-z0-9-]*\s*>)\s*$"#)
  /// The line after a raw HTML block, which the web skips. Nil when the line does not start one.
  static func htmlBlockEnd(_ lines: ArraySlice<String>, _ index: Int, interruptsParagraph: Bool) -> Int? {
    let content = String(lines[index].dropFirst(indent(lines[index])))
    guard content.hasPrefix("<") else { return nil }
    let lower = content.lowercased()
    func through(_ terminator: String) -> Int {
      var end = index
      while end < lines.endIndex {
        if lines[end].lowercased().contains(terminator) { return end + 1 }
        end += 1
      }
      return end
    }
    func untilBlank() -> Int {
      var end = index
      while end < lines.endIndex, !isBlank(lines[end]) { end += 1 }
      return end
    }
    for tag in ["script", "pre", "style", "textarea"] where lower.hasPrefix("<" + tag) {
      let next = lower.dropFirst(tag.count + 1).first
      if next == nil || next == " " || next == ">" || next == "\t" { return through("</\(tag)>") }
    }
    if content.hasPrefix("<!--") { return through("-->") }
    if content.hasPrefix("<?") { return through("?>") }
    if content.hasPrefix("<![CDATA[") { return through("]]>") }
    if content.range(of: "^<![A-Za-z]", options: .regularExpression) != nil { return through(">") }
    let range = NSRange(content.startIndex..., in: content)
    if let match = openTag.firstMatch(in: content, range: range), let name = Range(match.range(at: 1), in: content),
      htmlBlockTags.contains(content[name].lowercased())
    { return untilBlank() }
    if !interruptsParagraph, completeTag.firstMatch(in: content, range: range) != nil { return untilBlank() }
    return nil
  }

  // MARK: Inline

  /// Paragraph lines joined as CommonMark does: a line break is a space unless the line ends
  /// in two spaces or a backslash, which make a hard break.
  static func joinParagraph(_ lines: [String]) -> String {
    var result = ""
    for (index, raw) in lines.enumerated() {
      let line = String(raw.drop { $0 == " " || $0 == "\t" })
      let trimmed = String(line.reversed().drop { $0 == " " || $0 == "\t" }.reversed())
      if index == lines.count - 1 { result += trimmed; break }
      let backslashes = trimmed.reversed().prefix { $0 == "\\" }.count
      if line.hasSuffix("  ") { result += trimmed + "\n" }
      else if backslashes % 2 == 1 { result += trimmed.dropLast() + "\n" }
      else { result += trimmed + " " }
    }
    return result
  }

  private static let image = try! NSRegularExpression(
    pattern: #"(?<!\\)!\[((?:[^\[\]\\]|\\.)*)\]\(\s*<?([^\s<>()]*)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)"#)
  private static let inlineHTML = try! NSRegularExpression(
    pattern: #"(?<!\\)(?:<!--[\s\S]*?-->|</?[A-Za-z][A-Za-z0-9-]*(?:\s+[^<>]*?)?\s*/?>)"#)
  /// Inline source for SwiftUI's parser: images become the web's "Open image" links, and inline
  /// HTML tags are dropped like `skipHtml`. Code spans are left as written.
  static func inlineSource(_ text: String) -> String {
    var result = ""
    var plain = ""
    var index = text.startIndex
    func flushPlain() { result += rewrite(plain); plain = "" }
    while index < text.endIndex {
      let c = text[index]
      if c == "\\", text.index(after: index) < text.endIndex {
        plain += text[index...text.index(after: index)]
        index = text.index(index, offsetBy: 2)
        continue
      }
      if c == "`" {
        let run = text[index...].prefix { $0 == "`" }
        let after = text.index(index, offsetBy: run.count)
        if let close = closingBackticks(text, from: after, count: run.count) {
          flushPlain()
          result += text[index..<close]
          index = close
          continue
        }
        plain += run
        index = after
        continue
      }
      plain.append(c)
      index = text.index(after: index)
    }
    flushPlain()
    return result
  }
  private static func closingBackticks(_ text: String, from start: String.Index, count: Int) -> String.Index? {
    var index = start
    while index < text.endIndex {
      if text[index] == "`" {
        let run = text[index...].prefix { $0 == "`" }
        let end = text.index(index, offsetBy: run.count)
        if run.count == count { return end }
        index = end
      } else { index = text.index(after: index) }
    }
    return nil
  }
  private static func rewrite(_ text: String) -> String {
    guard text.contains("<") || text.contains("![") else { return text }
    let images = NSMutableString(string: text)
    for match in image.matches(in: text, range: NSRange(location: 0, length: images.length)).reversed() {
      let alt = images.substring(with: match.range(at: 1)), url = images.substring(with: match.range(at: 2))
      let replacement = url.isEmpty ? (alt.isEmpty ? "Image unavailable" : alt)
        : "[\(alt.isEmpty ? "Open image" : "Open image: \(alt)")](\(url))"
      images.replaceCharacters(in: match.range, with: replacement)
    }
    let value = images as String
    return inlineHTML.stringByReplacingMatches(in: value, range: NSRange(location: 0, length: (value as NSString).length), withTemplate: "")
  }

  /// Inline Markdown as attributed text, with bare URLs and email addresses linked like GFM.
  static func attributed(_ text: String) -> AttributedString {
    let source = inlineSource(text)
    var value = (try? AttributedString(markdown: source, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
      ?? AttributedString(source)
    autolink(&value)
    return value
  }
  private static let bareLink = try! NSRegularExpression(
    pattern: #"(?<![\w/@.:-])(?:(?:https?://|www\.)[^\s<]+|[A-Za-z0-9._+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)"#)
  /// The GFM literal autolinks in plain text, ending before trailing punctuation and unmatched parentheses.
  static func bareLinks(_ text: String) -> [(range: NSRange, url: URL)] {
    bareLink.matches(in: text, range: NSRange(location: 0, length: (text as NSString).length)).compactMap { match in
      var candidate = (text as NSString).substring(with: match.range)
      while true {
        if let last = candidate.last, "?!.,:*_~'\"".contains(last) { candidate.removeLast(); continue }
        if candidate.hasSuffix(")"), candidate.filter({ $0 == ")" }).count > candidate.filter({ $0 == "(" }).count {
          candidate.removeLast(); continue
        }
        break
      }
      let address: String
      if candidate.contains("@") && !candidate.contains("://") && !candidate.hasPrefix("www.") { address = "mailto:" + candidate }
      else { address = candidate.hasPrefix("www.") ? "http://" + candidate : candidate }
      guard candidate.count > 4, let url = URL(string: address) else { return nil }
      return (NSRange(location: match.range.location, length: (candidate as NSString).length), url)
    }
  }
  private static func autolink(_ value: inout AttributedString) {
    let text = String(value.characters)
    for link in bareLinks(text) {
      guard let range = Range(link.range, in: value) else { continue }
      let taken = value[range].runs.contains { run in
        run.link != nil || run.inlinePresentationIntent?.contains(.code) == true
      }
      if !taken { value[range].link = link.url }
    }
  }

  // MARK: Lines

  static func expandTabs(_ line: String) -> String {
    guard line.contains("\t") else { return line }
    var result = ""
    var column = 0
    var leading = true
    for c in line {
      if leading && c == "\t" {
        let width = 4 - column % 4
        result += String(repeating: " ", count: width)
        column += width
      } else {
        if c != " " { leading = false }
        result.append(c)
        column += 1
      }
    }
    return result
  }
  static func indent(_ line: String) -> Int { line.prefix { $0 == " " }.count }
  static func isBlank(_ line: String) -> Bool { line.allSatisfy { $0 == " " || $0 == "\t" } }
}
