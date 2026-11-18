# November 15 phone Back navigation

Branch `t3/phone-back-navigation` from `origin/main` at `2144c0b8`, run on the Mac mini (Node 24.22.2, Playwright's full
Chromium). Nothing was deployed by this entry. Source state `sha256:b41cd171b28b504244e92682c019291c45cf31ac3c464a443e3fe2f2d879be4a`
before the e2e spec and README were added; the code under test is `src/app/history-nav.ts` and its use in `src/App.tsx` and
`src/app/view.ts`.

## Red runs

`e2e/back-navigation.spec.ts` (16 tests, 390px phone and 1280px two-pane). Each line below was broken by hand, the spec run,
and the line restored byte for byte; the restored spec passes 16 of 16.

| Broken line                                                                                    | Result                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `window.addEventListener("popstate", popped)` in `useBackNavigation`, never registered         | 12 failed, 4 passed: every test that presses Back from a chat, Today, Search, a link, a notification, a reload or a sheet. The 4 that pass need no popstate: the on-screen Back, resizing, two-pane choices. |
| `history.go(depth - landed)`, the pop when the screen steps back                               | 2 failed: "the on-screen Back leaves no entry behind", "a phone widened to two panes drops its entry".                                                                                                       |
| `stepBack`'s sheet branch changed to `if (panel) return true;`, so Back never closes the sheet | 3 failed: sheet over home, sheet over a chat, edited sheet asks first.                                                                                                                                       |
| `depth` without the `mobile &&` condition, so two panes push too                               | 1 failed: "choosing chats adds no entries, so one Back leaves the app".                                                                                                                                      |

## Review findings: red runs

A second pass on two findings from the review of this PR (Back after a sign-out in another tab, and Back on the new group chat
form). Each line below was broken by hand, the named test run, and the line restored byte for byte. Before any fix, both new
e2e tests failed on the branch: the sign-out test with `Expected: "about:blank"`, `Received: "http://127.0.0.1:4173/?bot=ranch"`,
which is the old account's chat coming back into the address, and the group form test because no discard question appeared.
The group form's e2e test scripts `GET /api/groups` with Playwright's `page.route`, because the e2e server hosts no group coordinator.

| Broken line                                                                                             | Result                                                                        |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `history.go(-depth)` in `leaveAccountEntries` replaced by a no-op                                       | e2e: 1 failed, the sign-out in another tab test; 18 passed.                   |
| `stepBack`'s group branch in `src/App.tsx` back to `setCreatingGroup(false)`, skipping the form's guard | e2e: 1 failed, "asks before Back discards it"; 18 passed.                     |
| `useCloseRequest` callback in `GroupCreate` returns `onClose()` without checking `unsaved`              | `tests/collaboration-ui.test.ts`: 1 failed, "asks before the app closes it".  |
| `requestClose` in `GroupCreate` calls `onClose()` directly                                              | `tests/collaboration-ui.test.ts`: 1 failed, "asks for the close button".      |
| `unsaved` counts `name !== ''` instead of the trimmed name                                              | `tests/collaboration-ui.test.ts`: 1 failed, "closes at once, asking nothing". |

`e2e/back-navigation.spec.ts` is 19 tests after this change, all passing.

Checks for this pass (Node 24.22.2, Mac mini): typecheck, lint, ruff and build pass. Vitest 3948 of 3951; the 3 failures are the
tests that need the `127.0.0.2` loopback alias. The full e2e suite passes 74 of 74 run alone. One `check-all` e2e run, which shared
the machine with another worktree's load, failed "Back from a chat shows home" on `Uncaught error: Transition was skipped. New
ViewTransition started`; it passed 20 of 20 repeated alone and in the full run. The cause is `morphNavigate` in
`src/app/navigation-morph.ts` handling only the transition's `finished` promise, a gap older than this PR and not changed here.

## Checks

- `.agents/tools/check-all --keep-going`: typecheck, lint, ruff, build pass. Vitest 3909 of 3912; the 3 failures are the
  tests that need the `127.0.0.2` loopback alias, which this Mac does not have. Python skipped by the tool: no Python change.
- e2e: 71 of 71 on a run alone, which includes `e2e/back-forward-cache.spec.ts`. In the `check-all` run, which shares
  the machine with Vitest, `smoke.spec.ts` "a reply keeps growing across a tool call" failed once on a console error
  (`<rect> attribute height: A negative value`) from an animation, and passed 6 of 6 alone afterwards. It does not touch navigation.

## Not exercised

- A physical phone's system Back gesture, and an installed Android app. Chromium's `page.goBack()` stands in for both.
- A group chat on a phone. It takes the same path as Today and Search (`selectRoom` closes the home list), but the e2e
  server hosts no group coordinator, so no spec opens one.
- The service worker's `client.navigate` fallback (rule 4 in `scripts/service-worker.js`), a full navigation that adds an
  entry of the old document.

## Second review round

GPT-6.1 Sol found that a notification tapped over an edited New group form stored its "kept editing" callback, and a
browser Back while that question was open replaced it with Back's own. Keep editing then cancelled only Back, and
the next Cancel opened the notification's chat. The assistant settings sheet stored its callback the same way, and
Back now reaches it too. Both now add each waiting request with `stayAlso` (`src/app/close-request.ts`), so Keep
editing cancels every request that was waiting.

| Break                                              | Test                                                                                                                     | Failure                                         |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| The group form replaces the waiting callback again | `Back pressed while a notification waits on the group form's question leaves the notification cancelled by Keep editing` | Trail Cook's chat opened: `toBeHidden()` failed |

`e2e/back-navigation.spec.ts` then passed 20 of 20. One full run before that failed `a chat opened again after Back
takes the same two steps` while other worktrees ran suites; it passed in the next full run and 5 of 5 alone.
