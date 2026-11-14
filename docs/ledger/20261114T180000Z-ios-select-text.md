# November 14 iOS Select text

Branch `t3/select-text-long-press-dialog` from `origin/main` at `8eded45`. Swift was written on NicolasLaptop
(Fedora 44, Linux x64) and compiled and tested on the Mac mini (Xcode 27, iPhone 17 and iPhone 18 Pro simulators on
iOS 27.0) from detached worktrees of each commit below. Nothing was deployed by this entry.

## Change

The long-press menu of a reply or a person's own message offers **Select text**. It opens a sheet with a non-editable
`UITextView`, because SwiftUI's `Text.textSelection(.enabled)` copies only a whole block. `SelectableText` renders a
reply from the transcript's own Markdown parser into an `NSAttributedString`. Own messages stay plain.

## Application tests

| Commit | `AgentInterfaceTests` | UI tests |
| --- | --- | --- |
| `674b2f9` | 800 executed, 2 skipped, 0 failed | `testSelectTextOpensTheReplyInASelectableSheet`, `testQuoteInReplyAddsTheReplyToTheDraft` passed |
| `feac484` | did not compile: a `switch` expression passed as an argument | not run |
| `f67eb89` | 803 executed, 2 skipped, 0 failed | both passed; the pasted composer value was exactly "Your" |
| `86be6b3` | 803 executed, 2 skipped, 0 failed | Select text passed |
| `aaa1a56` | 804 executed, 2 skipped, 0 failed | Select text passed |

`.agents/tools/check-all` passed on Linux at `674b2f9`: typecheck, lint, 3,883 Vitest tests, build and 55 Playwright e2e
tests. Python was skipped because nothing it reads changed. Later commits changed only Swift under `ios/` and docs.

## Red runs

Each broke one line by hand, ran only the named test, then restored the file with `git checkout` and saw it pass.

| Commit | Break | Test | Failure |
| --- | --- | --- | --- |
| `674b2f9` | drop `.traitBold` for `.stronglyEmphasized` | `testSelectTextRendersAReplyWithoutMarkdownMarks` | `MarkdownTests.swift:72`, "mare" not bold |
| `f67eb89` | list `headIndent` ignores the first block's | `testSelectTextKeepsAQuoteIndentBehindAListMarker` | `MarkdownTests.swift:90`, 11.94 not greater than 16 |
| `f67eb89` | join table cells before parsing | `testSelectTextRendersAReplyWithoutMarkdownMarks` | `MarkdownTests.swift:48`, `left\tright` for `*left\tright*` |
| `f67eb89` | traits ignore the Dynamic Type size | `testSelectTextFollowsTheReadersTextSize` | `MarkdownTests.swift:99`, 17.0 not greater than 25.5 |
| `86be6b3` | keep the default tab stops | `testSelectTextRendersAReplyWithoutMarkdownMarks` | `MarkdownTests.swift:84`, 13 stops for 1 |
| `aaa1a56` | list marker style not copied from the first block | `testSelectTextKeepsATablesColumnsBehindAListMarker` | `MarkdownTests.swift:114`, header stops were the 28-point defaults, not `[139.94]` |

## Visual checks

The UI test's `select-text` capture at `86be6b3` shows the sheet titled "Select text" with Done, "Your" selected with
its handles and the Copy menu, the heading and bold text without Markdown marks, the table in aligned columns and the
code block in a monospaced font.

## Not exercised

A physical iPhone or iPad, an iPad layout, VoiceOver's named Select text action, and Dynamic Type changed while the
sheet is open (the unit test covers the font size for each type size, not the live change).
