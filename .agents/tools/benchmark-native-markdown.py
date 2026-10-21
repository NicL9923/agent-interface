#!/usr/bin/env python3
"""Compare fresh and cached native Markdown parsing with the optimized compiler."""
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
''')
executable = output / 'benchmark'
subprocess.run(['xcrun', 'swiftc', '-O', str(root / 'ios/AgentInterface/MarkdownParser.swift'),
                str(root / 'ios/AgentInterface/MarkdownCache.swift'), str(main), '-o', str(executable)], check=True)
subprocess.run([str(executable)], check=True)
