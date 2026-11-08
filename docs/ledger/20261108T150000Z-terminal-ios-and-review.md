# November 8 iOS terminal, terminal request card and review fixes

Branch `t3/ce20c380`, after merging main `c2fae16` (#264 and #267). This entry covers
the iOS half of the system terminal and the terminal request card, the fixes from two
independent reviews, and the checks run after the merge. The server and page half is
in `20261107T233945Z-native-terminal.md`; the card's add-on and web half is in
`20261107T230000Z-terminal-request-card.md`.

Application checks after the merge, on NicolasLaptop (Linux, Node 24.22.2):
`npm run typecheck`, `npm run lint` and `npm run build` passed. The full Vitest run
passed 2,108 of 2,108. A first run failed `transcript-ui.test.ts` "names a required
field left empty and sends nothing", a timing flake from #264 that passes alone and on
a rerun; a separate branch (`t3/form-test-wait-editable`) fixes it. Python: 37 test
files passed, and ruff 0.17.3 found nothing.

Native checks on the Mac mini (Xcode 27.2, iPhone 18 Pro simulator, iOS 27.0) through
`.agents/tools/validate-ios.sh`:

- Before the merge, the unit target plus `VaultFlowTests` and `ShellFlowTests`: every
  terminal unit and UI test passed. Two `ShellFlowTests` failed,
  `testCommandKOpensTheQuickSwitcherAndGoesWhereChosen` and
  `testGroupChatNamesSendersSuggestsMentionsAndUpdatesLive`; both fail the same way on
  main `a3dfff6`. `VaultFlowTests/testSecureRequestsAdvanceWithoutSendingChatAndClearOnBackground`
  failed once on keyboard focus and passed on the next run.
- `DirectRouteTests` fail on main `a3dfff6` as on this branch (two or three per run), from #263. They are
  not fixed here. `NativeContractTests/testTheObservedListNamesEveryTrackedProperty`
  also failed on main, because `ObservedChanges.swift` named the computed `sending`
  instead of the stored `sendingRequests`; this branch corrects that entry.
- After the merge: the full unit target and the five terminal UI tests passed 639,
  with only the two `DirectRouteTests` above failing as on main.

Break by hand: with the terminal screen changed to paste the assistant's command as
soon as the shell connects, `VaultFlowTests/testTerminalRequestOffersTheCommandToPasteNeverRunsIt`
failed (0 passed, 1 failed); restored, it passed. On the web, the same auto-paste
break failed two tests in `tests/computer-ui.test.ts` ("offers the suggested command
and pastes it only when the person asks" and "moves a panel that is already open");
restored, all 29 passed.

Independent review by GPT-6.1 Sol (high effort), cross-provider from the Claude
implementers. Findings and fixes:

- Pasting the command automatically when the shell connected could answer a program
  still waiting for one key. The web panel and the iOS screen now show the command
  with **Paste at prompt** and **Dismiss**; nothing reaches the shell on its own. This
  also resolved a second finding, that reopening the card pasted the command again.
- iOS gated **Confirm with Google** on the Hermes connection, which would block an
  administrator repairing a Hermes that is down. It now needs only the app server
  sign-in. The Settings Computer row also stays open while the terminal works and the
  desktop does not.
- Declining, timing out and replying in chat told the assistant nothing ran, which it
  cannot know. Those results now say whether anything ran is unknown.

A scoped re-review of those fixes found two more, both fixed: a second tap on iOS
**Paste at prompt** while the first paste was in flight could paste twice, so the
offer is now taken before the paste starts; and the tool description still said Open
terminal pastes the command.

Not exercised: a real tmux shell from iOS, Google sign-in in the system browser, a
WKWebView against the real `/native/terminal` page (UI tests use a fixture page), and
real Hermes. The Hermes qualification receipt needs a fresh run before release,
because `src/hermes/computer.py` and the qualification inputs changed.
