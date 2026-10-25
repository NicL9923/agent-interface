import Foundation

/// A run of a code block, as the highlighter reads it. Plain text has no kind.
struct SyntaxToken: Equatable {
  enum Kind: Equatable { case keyword, string, comment, number, type, attribute, added, removed, meta }
  var kind: Kind?
  var text: String
}

/// A small, dependency-free tokenizer for fenced code blocks: keywords, strings, comments, numbers,
/// and types or builtins for the languages assistants write most. It colors, it does not parse, so
/// an odd construct only loses its color. Foundation only, so the Markdown benchmark builds it alone.
enum SyntaxHighlighter {
  /// Longer blocks stay plain: coloring them would cost more than it helps.
  static let limit = 40_000

  /// The block's runs, or nil for a language it does not know or a block too long to color.
  static func tokens(_ code: String, language: String?) -> [SyntaxToken]? {
    guard code.utf16.count <= limit, let name = language.map(normalized), let mode = modes[name] else { return nil }
    switch mode {
    case .diff: return diff(code)
    case .markup: return markup(code)
    case .code(let spec):
      var scanner = Scanner(Array(code), spec)
      return scanner.run()
    }
  }

  /// The fence's first word, lowercased, with common aliases resolved.
  static func normalized(_ language: String) -> String {
    let name = language.lowercased().trimmingCharacters(in: .whitespaces)
    return aliases[name] ?? name
  }

  /// Folds runs into an attributed string with one style per kind.
  static func attributed(_ tokens: [SyntaxToken], style: (SyntaxToken.Kind) -> AttributeContainer) -> AttributedString {
    var result = AttributedString()
    for token in tokens {
      var run = AttributedString(token.text)
      if let kind = token.kind { run.mergeAttributes(style(kind)) }
      result += run
    }
    return result
  }

  // MARK: Languages

  struct Spec {
    var keywords: Set<String> = []
    /// Types, builtins and literals such as `true` and `null`.
    var types: Set<String> = []
    var lineComments: [String] = []
    var blockComments: [(open: String, close: String)] = []
    var quotes: Set<Character> = ["\"", "'"]
    /// `"""` and `'''` strings that span lines.
    var tripleQuotes = false
    /// Backtick strings that span lines, as JavaScript templates and Go raw strings.
    var backticks = false
    /// Identifiers starting with a capital letter read as types.
    var capitalizedTypes = true
    var caseInsensitive = false
    /// `$name` and `${name}` read as variables, as in shell.
    var variables = false
    /// `@name` reads as an attribute or decorator.
    var annotations = false
    /// A `#` comment needs a space or line start before it, so `a#b` stays plain in shell.
    var hashNeedsSpace = false
    /// A word or quoted string followed by `:` is a key, as in JSON, YAML and CSS properties.
    var keys = false
    /// `-` continues a word, as in CSS properties and YAML keys.
    var dashedWords = false
    /// `'` opens a string only when it closes within a character, so Rust lifetimes stay plain.
    var charLiterals = false
    /// `#fff` reads as a number, as CSS colors.
    var hexColors = false
  }
  enum Mode { case code(Spec), diff, markup }

  static let aliases: [String: String] = [
    "sh": "bash", "shell": "bash", "zsh": "bash", "console": "bash", "shellscript": "bash",
    "javascript": "js", "jsx": "js", "mjs": "js", "cjs": "js", "node": "js",
    "typescript": "ts", "tsx": "ts", "jsonc": "json", "json5": "json",
    "py": "python", "python3": "python", "yml": "yaml", "golang": "go", "rs": "rust",
    "patch": "diff", "kt": "kotlin", "kts": "kotlin", "c++": "cpp", "cc": "cpp", "hpp": "cpp", "h": "c",
    "rb": "ruby", "htm": "html", "svg": "xml", "plist": "xml", "xhtml": "xml", "postgres": "sql",
    "postgresql": "sql", "mysql": "sql", "sqlite": "sql", "scss": "css", "less": "css",
  ]

  private static func words(_ text: String) -> Set<String> { Set(text.split(separator: " ").map(String.init)) }
  private static let cLike: [(open: String, close: String)] = [("/*", "*/")]

  static let modes: [String: Mode] = {
    let jsKeywords = "async await break case catch class const continue debugger default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch this throw try typeof var void while with yield"
    let jsTypes = "true false null undefined NaN Infinity console window document globalThis Math JSON Promise Array Object String Number Boolean Map Set Date Error RegExp Symbol"
    let js = Spec(keywords: words(jsKeywords), types: words(jsTypes), lineComments: ["//"], blockComments: cLike, backticks: true)
    var ts = js
    ts.keywords.formUnion(words("abstract as declare enum implements interface keyof namespace private protected public readonly type satisfies is infer unique override"))
    ts.types.formUnion(words("any unknown never string number boolean bigint symbol object void Record Partial Readonly Pick Omit"))
    ts.annotations = true
    var java = Spec(
      keywords: words("abstract assert break case catch class const continue default do else enum extends final finally for goto if implements import instanceof interface native new package private protected public return static strictfp super switch synchronized this throw throws transient try var void volatile while record yield sealed permits"),
      types: words("true false null boolean byte char double float int long short String Object Integer List Map System"),
      lineComments: ["//"], blockComments: cLike, tripleQuotes: true)
    java.annotations = true
    var kotlin = java
    kotlin.keywords = words("as break class continue do else false for fun if in interface is null object package return super this throw true try typealias typeof val var when while by catch constructor delegate dynamic field file finally get import init param property receiver set setparam where actual abstract annotation companion const crossinline data enum expect external final infix inline inner internal lateinit noinline open operator out override private protected public reified sealed suspend tailrec vararg")
    kotlin.types = words("true false null Any Unit Nothing Int Long Short Byte Double Float Boolean Char String List Map Set Array println")
    var swift = Spec(
      keywords: words("actor associatedtype async await break case catch class continue default defer deinit do else enum extension fallthrough fileprivate final for func guard if import in init inout internal is let lazy mutating nonisolated nonmutating open operator override private protocol public repeat rethrows return some any static struct subscript super switch throw throws try typealias var weak where while self Self convenience required indirect"),
      types: words("true false nil Int Double Float Bool String Character Array Dictionary Set Optional Result Error Void Any AnyObject Never Task View some print"),
      lineComments: ["//"], blockComments: cLike, quotes: ["\""], tripleQuotes: true)
    swift.annotations = true
    var python = Spec(
      keywords: words("and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case"),
      types: words("True False None self cls int float str bool list dict set tuple bytes object print len range open isinstance super Exception ValueError TypeError KeyError"),
      lineComments: ["#"], tripleQuotes: true)
    python.annotations = true
    let bash = Spec(
      keywords: words("if then else elif fi for while until do done case esac function in return export local readonly declare unset select time shift break continue exit source alias"),
      types: words("echo printf cd ls grep sed awk cat curl wget git npm npx node python python3 pip brew sudo chmod chown mkdir rm cp mv touch find xargs tar ssh scp make docker kubectl test true false set trap read eval exec"),
      lineComments: ["#"], capitalizedTypes: false, variables: true, hashNeedsSpace: true)
    let json = Spec(types: words("true false null"), quotes: ["\""], capitalizedTypes: false, keys: true)
    var yaml = Spec(types: words("true false null yes no on off True False Null ~"), lineComments: ["#"], capitalizedTypes: false, hashNeedsSpace: true, keys: true)
    yaml.dashedWords = true
    var css = Spec(
      keywords: words("@media @import @keyframes @font-face @supports @layer @container @charset !important"),
      types: words("inherit initial unset none auto block inline flex grid absolute relative fixed sticky solid transparent var calc"),
      blockComments: cLike, capitalizedTypes: false, keys: true)
    css.dashedWords = true; css.hexColors = true; css.annotations = true
    let sql = Spec(
      keywords: words("select from where and or not insert into values update set delete create table drop alter add column index view join left right inner outer full on as group by order having limit offset union all distinct case when then else end is null like in between exists primary key foreign references default unique begin commit rollback transaction with returning asc desc if"),
      types: words("int integer bigint smallint text varchar char boolean bool date timestamp timestamptz numeric decimal real float serial uuid json jsonb true false count sum avg min max coalesce now"),
      lineComments: ["--"], blockComments: cLike, capitalizedTypes: false, caseInsensitive: true)
    let go = Spec(
      keywords: words("break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var"),
      types: words("true false nil iota int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 uintptr float32 float64 complex64 complex128 string bool byte rune error any append cap close copy delete len make new panic print println recover fmt"),
      lineComments: ["//"], blockComments: cLike, backticks: true)
    var rust = Spec(
      keywords: words("as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while"),
      types: words("true false None Some Ok Err i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str String Vec Option Result Box Rc Arc HashMap println format vec"),
      lineComments: ["//"], blockComments: cLike)
    rust.charLiterals = true
    let c = Spec(
      keywords: words("auto break case const continue default do else enum extern for goto if inline register restrict return sizeof static struct switch typedef union volatile while #include #define #ifdef #ifndef #endif #if #else #pragma"),
      types: words("void char short int long float double signed unsigned bool size_t NULL true false printf malloc free uint8_t uint32_t int32_t int64_t"),
      lineComments: ["//"], blockComments: cLike)
    var cpp = c
    cpp.keywords.formUnion(words("class namespace template typename public private protected virtual override final new delete this throw try catch using operator friend constexpr noexcept nullptr explicit mutable static_cast dynamic_cast reinterpret_cast const_cast co_await co_return"))
    cpp.types.formUnion(words("std string vector map unique_ptr shared_ptr auto cout endl"))
    let ruby = Spec(
      keywords: words("alias and begin break case class def defined? do else elsif end ensure for if in module next not or redo rescue retry return self super then undef unless until when while yield require require_relative attr_accessor attr_reader private protected public lambda proc"),
      types: words("true false nil puts print p raise Array Hash String Integer Float Symbol"),
      lineComments: ["#"])
    return [
      "js": .code(js), "ts": .code(ts), "java": .code(java), "kotlin": .code(kotlin), "swift": .code(swift),
      "python": .code(python), "bash": .code(bash), "json": .code(json), "yaml": .code(yaml), "css": .code(css),
      "sql": .code(sql), "go": .code(go), "rust": .code(rust), "c": .code(c), "cpp": .code(cpp), "ruby": .code(ruby),
      "html": .markup, "xml": .markup, "diff": .diff,
    ]
  }()

  // MARK: Scanning

  /// Collects runs, joining neighbors of the same kind.
  private struct Runs {
    var tokens: [SyntaxToken] = []
    mutating func add(_ kind: SyntaxToken.Kind?, _ text: some StringProtocol) {
      guard !text.isEmpty else { return }
      if let last = tokens.last, last.kind == kind { tokens[tokens.count - 1].text += text } else { tokens.append(SyntaxToken(kind: kind, text: String(text))) }
    }
  }

  private struct Scanner {
    let chars: [Character]
    let spec: Spec
    var index = 0
    var runs = Runs()
    init(_ chars: [Character], _ spec: Spec) { self.chars = chars; self.spec = spec }

    func starts(_ text: String, at position: Int) -> Bool {
      var i = position
      for c in text {
        guard i < chars.count, chars[i] == c else { return false }
        i += 1
      }
      return true
    }
    func text(_ range: Range<Int>) -> String { String(chars[range]) }
    func isWordStart(_ c: Character) -> Bool { c.isLetter || c == "_" }
    func isWord(_ c: Character) -> Bool { c.isLetter || c.isNumber || c == "_" || (spec.dashedWords && c == "-") }
    /// The next character after spaces on this line, for telling a key from a value.
    func next(after position: Int) -> Character? {
      var i = position
      while i < chars.count, chars[i] == " " || chars[i] == "\t" { i += 1 }
      return i < chars.count ? chars[i] : nil
    }
    func lineEnd(from position: Int) -> Int {
      var i = position
      while i < chars.count, chars[i] != "\n" { i += 1 }
      return i
    }

    mutating func run() -> [SyntaxToken] {
      while index < chars.count {
        let start = index
        let c = chars[index]
        if let comment = spec.blockComments.first(where: { starts($0.open, at: index) }) {
          var end = index + comment.open.count
          while end < chars.count, !starts(comment.close, at: end) { end += 1 }
          end = min(chars.count, end + comment.close.count)
          runs.add(.comment, text(start..<end)); index = end; continue
        }
        if let marker = spec.lineComments.first(where: { starts($0, at: index) }),
          !(spec.hashNeedsSpace && marker == "#" && index > 0 && !chars[index - 1].isWhitespace)
        {
          let end = lineEnd(from: index)
          runs.add(.comment, text(start..<end)); index = end; continue
        }
        if spec.tripleQuotes, c == "\"" || c == "'", starts(String(repeating: c, count: 3), at: index) {
          let fence = String(repeating: c, count: 3)
          var end = index + 3
          while end < chars.count, !starts(fence, at: end) { end += chars[end] == "\\" ? 2 : 1 }
          end = min(chars.count, end + 3)
          runs.add(.string, text(start..<end)); index = end; continue
        }
        if spec.backticks, c == "`" {
          var end = index + 1
          while end < chars.count, chars[end] != "`" { end += chars[end] == "\\" ? 2 : 1 }
          end = min(chars.count, end + 1)
          runs.add(.string, text(start..<end)); index = end; continue
        }
        if spec.quotes.contains(c), let end = stringEnd(from: index) {
          let kind: SyntaxToken.Kind = spec.keys && next(after: end) == ":" ? .attribute : .string
          runs.add(kind, text(start..<end)); index = end; continue
        }
        if spec.variables, c == "$", index + 1 < chars.count {
          var end = index + 1
          if chars[end] == "{" {
            while end < chars.count, chars[end] != "}", chars[end] != "\n" { end += 1 }
            end = min(chars.count, end + 1)
          } else {
            while end < chars.count, isWord(chars[end]) || (end == index + 1 && "?#@!*0123456789".contains(chars[end])) { end += 1 }
          }
          if end > index + 1 { runs.add(.type, text(start..<end)); index = end; continue }
        }
        if spec.hexColors, c == "#", index + 1 < chars.count, chars[index + 1].isHexDigit {
          var end = index + 1
          while end < chars.count, chars[end].isHexDigit { end += 1 }
          runs.add(.number, text(start..<end)); index = end; continue
        }
        if c.isNumber && c.isASCII || c == "." && index + 1 < chars.count && chars[index + 1].isNumber && chars[index + 1].isASCII,
          index == 0 || !(chars[index - 1].isLetter || chars[index - 1].isNumber || chars[index - 1] == "_")
        {
          index = numberEnd(from: index)
          runs.add(.number, text(start..<index)); continue
        }
        if (spec.annotations && c == "@") || ((c == "#" || c == "!") && spec.keywords.contains(where: { $0.first == c })),
          index + 1 < chars.count, isWordStart(chars[index + 1])
        {
          var end = index + 1
          while end < chars.count, isWord(chars[end]) || chars[end] == "-" && c == "@" { end += 1 }
          let word = text(start..<end)
          runs.add(spec.keywords.contains(word) ? .keyword : .attribute, word); index = end; continue
        }
        if isWordStart(c) {
          var end = index + 1
          while end < chars.count, isWord(chars[end]) { end += 1 }
          // Ruby's `defined?` and similar keep their question mark.
          if end < chars.count, chars[end] == "?", spec.keywords.contains(text(start..<end) + "?") { end += 1 }
          let word = text(start..<end)
          runs.add(kind(of: word, at: end), word); index = end; continue
        }
        runs.add(nil, String(c)); index += 1
      }
      return runs.tokens
    }

    func kind(of word: String, at end: Int) -> SyntaxToken.Kind? {
      // A key before its colon. A CSS pseudo-class such as `a:hover` reads as one too, which is rare
      // enough to accept.
      if spec.keys, next(after: end) == ":" { return .attribute }
      let key = spec.caseInsensitive ? word.lowercased() : word
      if spec.keywords.contains(key) { return .keyword }
      if spec.types.contains(key) { return .type }
      if spec.capitalizedTypes, let first = word.first, first.isUppercase { return .type }
      return nil
    }

    /// The end of a quoted string on one line, or nil when this quote opens none.
    func stringEnd(from position: Int) -> Int? {
      let quote = chars[position]
      var end = position + 1
      while end < chars.count, chars[end] != quote, chars[end] != "\n" { end += chars[end] == "\\" ? 2 : 1 }
      guard end < chars.count, chars[end] == quote else {
        // An unclosed quote colors the rest of its line, as an editor does while typing.
        return spec.charLiterals && quote == "'" ? nil : min(end, chars.count)
      }
      if spec.charLiterals, quote == "'", end - position > 3, chars[position + 1] != "\\" { return nil }
      return end + 1
    }

    func numberEnd(from position: Int) -> Int {
      var end = position
      if chars[end] == "0", end + 1 < chars.count, "xXbBoO".contains(chars[end + 1]) {
        end += 2
        while end < chars.count, chars[end].isHexDigit || chars[end] == "_" { end += 1 }
        return end
      }
      while end < chars.count {
        let c = chars[end]
        if c.isNumber || c == "_" || c == "." && end + 1 < chars.count && chars[end + 1].isNumber { end += 1; continue }
        if (c == "e" || c == "E"), end + 1 < chars.count, chars[end + 1].isNumber || "+-".contains(chars[end + 1]) { end += 2; continue }
        break
      }
      // Units and suffixes, such as 10px, 2.5f and 100u64.
      while end < chars.count, chars[end].isLetter || chars[end] == "%" { end += 1 }
      return end
    }
  }

  // MARK: Line and tag modes

  static func diff(_ code: String) -> [SyntaxToken] {
    var runs = Runs()
    let lines = code.split(separator: "\n", omittingEmptySubsequences: false)
    for (index, line) in lines.enumerated() {
      let kind: SyntaxToken.Kind? =
        line.hasPrefix("+++") || line.hasPrefix("---") || line.hasPrefix("@@") || line.hasPrefix("diff ") || line.hasPrefix("index ") ? .meta
        : line.hasPrefix("+") ? .added : line.hasPrefix("-") ? .removed : nil
      runs.add(kind, line)
      if index < lines.count - 1 { runs.add(nil, "\n") }
    }
    return runs.tokens
  }

  /// HTML and XML: comments, tag names, attribute names and their quoted values.
  static func markup(_ code: String) -> [SyntaxToken] {
    let chars = Array(code)
    var runs = Runs()
    var index = 0
    func starts(_ text: String, _ at: Int) -> Bool {
      text.enumerated().allSatisfy { at + $0.offset < chars.count && chars[at + $0.offset] == $0.element }
    }
    while index < chars.count {
      if starts("<!--", index) {
        var end = index + 4
        while end < chars.count, !starts("-->", end) { end += 1 }
        end = min(chars.count, end + 3)
        runs.add(.comment, String(chars[index..<end])); index = end; continue
      }
      if chars[index] == "<", index + 1 < chars.count, chars[index + 1].isLetter || "/!?".contains(chars[index + 1]) {
        var end = index + 1
        while end < chars.count, "/!?".contains(chars[end]) { end += 1 }
        runs.add(nil, String(chars[index..<end]))
        var name = end
        while name < chars.count, chars[name].isLetter || chars[name].isNumber || "-:_.".contains(chars[name]) { name += 1 }
        runs.add(.keyword, String(chars[end..<name]))
        index = name
        // Inside the tag: attribute names, `=`, and quoted values, until it closes.
        while index < chars.count, chars[index] != ">" {
          let c = chars[index]
          if c == "\"" || c == "'" {
            var close = index + 1
            while close < chars.count, chars[close] != c { close += 1 }
            close = min(chars.count, close + 1)
            runs.add(.string, String(chars[index..<close])); index = close
          } else if c.isLetter {
            var close = index
            while close < chars.count, chars[close].isLetter || chars[close].isNumber || "-:_.".contains(chars[close]) { close += 1 }
            runs.add(.attribute, String(chars[index..<close])); index = close
          } else { runs.add(nil, String(c)); index += 1 }
        }
        if index < chars.count { runs.add(nil, ">"); index += 1 }
        continue
      }
      if chars[index] == "&" {
        var end = index + 1
        while end < chars.count, end - index < 10, chars[end].isLetter || chars[end].isNumber || chars[end] == "#" { end += 1 }
        if end < chars.count, chars[end] == ";" {
          runs.add(.type, String(chars[index...end])); index = end + 1; continue
        }
      }
      runs.add(nil, String(chars[index])); index += 1
    }
    return runs.tokens
  }
}
