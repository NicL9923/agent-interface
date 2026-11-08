#!/usr/bin/env python3
"""Compare fresh and cached native Markdown parsing and code coloring with the optimized compiler."""
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[2]
output = root / '.private' / 'markdown-benchmark'
output.mkdir(parents=True, exist_ok=True)
main = output / 'main.swift'
main.write_text('''import Foundation
let source = String(repeating: "# Ranch report\\n\\nCheck **the gate** and [weather](https://example.test).\\n\\n- Hay\\n- Water\\n\\n| Task | Result |\\n| --- | --- |\\n| Gate | Ready |\\n\\n```swift\\nlet answer = 42\\n```\\n\\n", count: 100)
let repeats = 100
func benchmark(_ label: String, _ work: () -> [MarkdownBlock]) {
    let start = ContinuousClock.now
    var count = 0
    for _ in 0..<repeats { count += work().count }
    let elapsed = start.duration(to: .now)
    print("\\(label): \\(elapsed), blocks consumed: \\(count)")
}
benchmark("Fresh parse", { Markdown.parse(source) })
let cache = MarkdownCache()
benchmark("Cached parse, including first miss", { cache.blocks(source) })
let code = String(repeating: "func load(_ id: String) async throws -> [Int] {\\n  // Fetch the rows\\n  let rows = try await api.get(\\"/rows?id=\\\\(id)\\")\\n  return rows.map { $0 * 42 }\\n}\\n", count: 40)
func color(_ label: String, _ work: () -> AttributedString?) {
    let start = ContinuousClock.now
    var count = 0
    for _ in 0..<repeats { count += work()?.characters.count ?? 0 }
    print("\\(label): \\(start.duration(to: .now)), characters colored: \\(count)")
}
color("Fresh code coloring", { SyntaxHighlighter.tokens(code, language: "swift").map { SyntaxHighlighter.attributed($0) { _ in AttributeContainer() } } })
color("Cached code coloring, including first miss", { cache.highlighted(code, language: "swift", settled: true) { _ in AttributeContainer() } })
''')
executable = output / 'benchmark'
subprocess.run(['xcrun', 'swiftc', '-O', str(root / 'ios/AgentInterface/MarkdownParser.swift'),
                str(root / 'ios/AgentInterface/MarkdownCache.swift'), str(root / 'ios/AgentInterface/SyntaxHighlighter.swift'), str(main), '-o', str(executable)], check=True)
subprocess.run([str(executable)], check=True)
