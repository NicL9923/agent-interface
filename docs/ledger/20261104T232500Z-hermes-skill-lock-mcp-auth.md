# November 4 skill locks, MCP sign-in state and the browser metadata floor

Source fingerprint `sha256:0e4499fb87ed0fcb8d0a5b5119bd627a5b0b6e801fbb600c99820a715781bb51`, based on main `363f4e94c0169783b5c6b125631dba8d781e5863`. Hermes source: the production revision `3a1e9ef50a570b1544795ddad197ad2dcde430ab`, read only.

The app adopts three Hermes features. Integration administrators can lock or unlock an installed skill from Learning on the web and iOS, and both clients show which skills are locked. Connection cards read native `mcp.servers.status` `needs_auth` to show Reconnect after a provider rejects an MCP sign-in. The shared computer's `browser_cdp` metadata check now uses native Hermes's own parameter scan and matcher.

Application checks: all 121 Vitest files, 1,687 tests passed on Node 26.10.0 and again on Node 24.21.0. Type checking passed. The production build passed from a copy with a real `node_modules`. All 34 Python test files passed on Python 3.14.7, and `ruff check .` passed.

Real Hermes code, in disposable homes with a Python 3.14 environment built from the revision's lock file: the add-on's `skill_list` and `skill_lock` ran against the real native modules. Locking by frontmatter name wrote the directory key, the list showed the lock, native `skill_manage` refused edits, and replayed approvals of a patch, a delete and a batch were refused with `_locked` before any write. The add-on recorded the refused delete approval as a definite refusal, and a reject then worked. The add-on's `mcp_runtime` called the real `mcp.servers.status` through the in-process dispatcher. A server parked the way native parks a rejected OAuth credential read `needs_auth: true`, and its card read Expired. With `HERMES_SOURCE` set, `tests/hermes_computer_test.py` used the real `browser_url_policy`, `browser_cdp_tool` and `url_safety` modules and blocked nine metadata forms across six CDP methods. The same test against the previous `computer.py` let six of them through. The spike automation probe gained lock checks but was not run.

Native checks: Xcode 27.2 on an iPhone 17 simulator, iOS 27.0, under the machine-wide lock. `AutomationTests` (40) and `ContractFixtureTests` (3) passed, including the new lock request test and the regenerated fixtures. UI tests `testLearningLocksAndUnlocksAnInstalledSkill`, `testLearningUsesLoadedDiffRevisionWithReadOnlyPolicy` and `testPolicyFailureRequiresStatusRefreshBeforeAnotherChange` passed. The full `AgentInterfaceTests` unit target ran 555 tests: 552 passed, 2 skipped, and `FixedWaitRuleTests.testUITestsNeverAskIsHittableDirectly` failed on `isHittable` calls this branch doesn't add, the failure already recorded on main. The rest of the UI test target was not run.

Visual check: the loopback preview's Learning panel at 1280 and 390 pixels in light and dark showed the Locked label, the explanation and the Lock and Unlock buttons without horizontal overflow.

Not exercised: a live Hermes profile, the full spike qualification, a live MCP OAuth service, a real shared-computer browser, physical devices and production. Independent review is left to the coordinator.

## Review fixes

Source fingerprint `sha256:2791570f2978250d9946db3b5f4feca8199956aaa31af34eccfccb8a73dd0930`. GPT-6.1 Sol's review of PR #232 found three problems, all fixed:

- A lock refusal from a batch that stopped partway now stays uncertain unless the rollback verifiably finished.
- A Check that outranks `needs_auth` now belongs to one rejection episode, which ends when Hermes reports `needs_auth: false`.
- The browser wrapper now reads `http:/host`, `http:host`, backslash and escaped forms that WHATWG parsing resolves to an authority. Native Hermes misses these too; an upstream report is drafted outside the repository and not filed.

Each new test failed against the previous commit. In the real-module metadata test, native's scan and the previous wrapper let 6 of 9 new forms through. `tests/hermes_automation_test.py` (31 tests), `tests/hermes_integrations_test.py` (17) and `tests/hermes_computer_test.py` (48) passed, the last also with `HERMES_SOURCE` set to the 3a1e9ef source. `ruff check .` passed. The disposable-home lock and MCP status runs against the real modules passed again. No TypeScript or Swift changed, so Vitest and the iOS tests were not rerun.

## Re-review fix

Source fingerprint `sha256:4e32e48beb669fbbc18cd5a4f6f10fa7d913e7d81a65dd31a42dac50da1b9d70`. The re-review accepted the first two fixes. It found that the browser scanner cut a bracketed IPv6 host after userinfo, as in `http:/x)@[fd00:ec2::254]/`. Native read that truncated candidate as nothing, so the call passed. The scanner now keeps the bracketed host whole. It judges an IPv6 host by any IPv4 address the host embeds, and blocks a candidate whose authority can't be parsed. All four new real-module cases, and the new stand-in test, failed against the previous commit. `tests/hermes_computer_test.py` passed all 49 tests, with stand-ins and again with `HERMES_SOURCE` set to the 3a1e9ef source. `ruff check .` passed. JavaScript `\u` and `\x` escapes remain a documented limit.

## Second re-review fix

Source fingerprint `sha256:285865826cb9dedf9c77b3f528f96afa74ad50db0ac46537e4bf590dcf625dae`. The re-review found no bypass in 10,890 WHATWG-valid metadata cases. It did find a false positive: ordinary script such as `const x={https:[]};` produced a malformed candidate that the fail-closed rule blocked. The wrapper now reads each candidate host as WHATWG does. A host WHATWG rejects passes, because it can't fetch anything. An accepted host is judged in its plain form, after percent-decoding and IDNA mapping. Only a non-ASCII host that Python's IDNA codec can't map still fails closed. On `c5f6d03`, the new lookalike tests failed for `{https:[]}`, `JSON.stringify({http:[],https:[]})` and `{http:[1,2], wss:[]}` on all three script paths. The unclosed bracket case moved from blocked to allowed, since WHATWG rejects it. Every metadata form blocked before is still blocked, and port, userinfo, percent-encoded and fullwidth forms were added. `tests/hermes_computer_test.py` passed all 50 tests, with stand-ins and again with `HERMES_SOURCE` set to the 3a1e9ef source. `ruff check .` passed.

## Third re-review fix

Source fingerprint `sha256:3af842475dc5384538fa5aa266d5c9660081b532d431bbd61fe9f8bcb37a403f`. The review of `60d8dc4` confirmed the false-positive fix and found two gaps.

- The scanner truncated a host after bracketed userinfo, as in `http:/x[abc]@[64:ff9b::a9fe:a9fe]/`. It now reads the authority as WHATWG does: the userinfo ends at the last `@` before the first `/`, `\`, `?` or `#`, and a bracketed host stays whole.
- Python's IDNA codec could map a host differently from WHATWG. Non-ASCII hosts now go through the `idna` package's UTS 46 mapping, and any non-ASCII host is blocked when that mapping is missing or fails.

`docs/SharedComputer.md` now says the matcher is defense in depth, with a network-level block to follow in a separate change. On `60d8dc4`, the new tests failed for the reviewer's examples, for the IPv4-compatible and 6to4 variants, and for the UTS 46 forms: mathematical and fullwidth digits, the modifier capital M, the ideographic full stop, and the percent-encoded forms. The earlier lookalike tests still pass. `tests/hermes_computer_test.py` passed 53 tests with stand-ins in the system Python, which has no `idna`, so 1 test was skipped. All 53 passed with `HERMES_SOURCE` and `idna` 3.20. `ruff check .` passed.

## Fourth re-review fix

Source fingerprint `sha256:13d169cbbbca3c5db2de314beb075c60d130e333cb10ca3db5d6723fd486d2a8`. The review of `e29780c` found 0 bypasses in two corpora of WHATWG-valid metadata cases: 10,890 and 145,700. It also found a regression. `Page.setDocumentContent` with `<style>@import url(http:/169.254.169.254);</style>` kept `);` in the host and passed. Each host is now also judged cut at the first `)`, `;`, quote, `,`, `>`, `}` or whitespace, which is where CSS and markup end a URL.

A new test covers CSS `url()`, `@import`, an unquoted HTML attribute and `srcset` on `Page.setDocumentContent`, `Runtime.evaluate` and `Page.addScriptToEvaluateOnNewDocument`. The test failed on `e29780c`, as did three of the four new real-module cases. The JavaScript lookalike tests still pass. `tests/hermes_computer_test.py` passed 54 tests with stand-ins (2 skipped: no `idna` and no `HERMES_SOURCE`) and all 54 with `HERMES_SOURCE`. `ruff check .` passed.

## Fifth re-review fix

Source fingerprint `sha256:0e00218a48f0407e343498be32abaeb66063f09d18e12b96a8b17d08f3bd7465`. The review of `1bf3daa` found 0 bypasses in both corpora and no false positives across 96 snippets and 48 source files. One gap remained: in `<style>@import url(http:/169.254.169.254);@media print{...}</style>`, the userinfo split used the `@` of `@media` and judged the host `media`. The scanner now also reads the authority cut at the CSS and markup boundary before splitting off userinfo, and keeps the complete reading. `@media` and `@font-face` after a CSS URL, and a `srcset` entry followed by `@2x`, failed on `1bf3daa` and are now blocked. The JavaScript lookalike tests still pass. `tests/hermes_computer_test.py` passed 54 tests with stand-ins (2 skipped) and all 54 with `HERMES_SOURCE`. `ruff check .` passed.

## Sixth re-review fix

Source fingerprint `sha256:dc8f6b4bb6221a3ae518842a552d20d13a5c21450b292c084e19448784075ace`. The review of `118c5bd` found 0 bypasses in both corpora and in 7,992 single-URL CSS, HTML and `srcset` variants. One structural gap remained: after each URL, the scanner skipped ahead to the next quote or whitespace, so a second URL in the same CSS, HTML or string was never read. All 84 multi-import variants got through. The scanner now reads every scheme occurrence on its own and never skips text because of an earlier candidate. A metadata URL in another URL's query is now blocked, which is stricter than native. New multi-URL tests cover CSS `@import` and `url()` lists, `srcset`, an `href` query, and JavaScript arrays built from a comma-joined string and a template literal, on four CDP paths. All of them failed on `118c5bd`. The false-positive tests still pass. `tests/hermes_computer_test.py` passed 55 tests with stand-ins (2 skipped) and all 55 with `HERMES_SOURCE`. `ruff check .` passed.
