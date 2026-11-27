#!/usr/bin/env node
/** Compare fresh and cached native Markdown parsing and code coloring with the optimized compiler. */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const output = join(root, ".private", "markdown-benchmark");
mkdirSync(output, { recursive: true });
const mainSwift = join(output, "main.swift");
writeFileSync(
  mainSwift,
  `import Foundation
let source = String(repeating: "# Ranch report\\n\\nCheck **the gate** and [weather](https://example.test).\\n\\n- Hay\\n- Water\\n\\n| Task | Result |\\n| --- | --- |\\n| Gate | Ready |\\n\\n\`\`\`swift\\nlet answer = 42\\n\`\`\`\\n\\n", count: 100)
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
`,
);

const executable = join(output, "benchmark");
execFileSync(
  "xcrun",
  [
    "swiftc",
    "-O",
    join(root, "ios/AgentInterface/MarkdownParser.swift"),
    join(root, "ios/AgentInterface/MarkdownCache.swift"),
    join(root, "ios/AgentInterface/SyntaxHighlighter.swift"),
    mainSwift,
    "-o",
    executable,
  ],
  { stdio: "inherit" },
);
execFileSync(executable, [], { stdio: "inherit" });
