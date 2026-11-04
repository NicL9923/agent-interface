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
