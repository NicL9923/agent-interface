# November 11 UI tests mock only the client API module

Branch `t3/ui-tests-mock-only-api`, started at `323b071` and rebased onto `589f542`
on NicolasLaptop (Fedora 44, Linux x64, 32 cores), Node 24.22.2. One product line changed: `src/components/Avatar.tsx`
skips its visibility observer when the browser has none, as `Conversation.tsx` already does. Everything else is under `tests/`, plus one
sentence in `AGENTS.md`.

## Result

App-module mocks in UI tests, `vi.mock("../src/...")` other than `client-api` and the server: 44 before, 3 after.

| Mock | Files before | Now |
| --- | --- | --- |
| `Avatar` | 24 | real |
| `use-chat-presence` | 6 | real hook; its reports filtered in the client-API mock |
| `use-device-activity` | 3 | real hook; its reports filtered in the client-API mock |
| `MessageMarkdown` | 3 | real |
| `Composer` pass-through spy | 1 | real; a `Profiler` runs the Stop press inside the commit |
| `When`, `ReplyActions` | 1 | real; see below |
| `DeviceNotifications` | 1 | real |
| `GroupChats` | 1 | real, with the room's two reads answered |
| `portrait-upload` | 1 | kept: jsdom decodes no image and has no canvas, so `preparePortrait` cannot run |
| `DiscoveryPanel`, `ChatModelPicker` | 1 | kept: they simulate a chunk a release retired; a test run from disk cannot lose a file |

`AGENTS.md` names the two kept exceptions in one sentence. Third-party libraries are untouched (`remark-gfm` in
`connection-grace-ui.test.ts`, `@novnc/novnc`, `@xterm/*`, `react-dom` in `avatar-frames.test.ts`, `node:http2`), as is
`tests/index-shutdown.test.ts`, which mocks server modules.

## How each mock went

- **Avatar.** Removing every mock left 495 failures with three causes: the real Avatar reads `getTotalLength`/`getPointAtLength` and
  `matchMedia`, which jsdom lacks, and `IntersectionObserver`. `tests/setup-ui.ts` now shims the first two for every UI file (a path is 100
  units long, a point at distance `d` is `(d, 0)`, no media query matches), which `avatar-component.test.ts`, `linked-chat-ui.test.ts` and
  `worker-opens-ui.test.ts` already did locally. A global `IntersectionObserver` would have switched `Conversation.tsx`'s observer paths on in
  every UI test, so `Avatar` guards on `typeof IntersectionObserver` instead, like `Conversation` does. That left 8 failures, each a test
  that read the mock's markup: they now read the real wrapper (`.avatar-wrap`, its `data-state`, `data-reduced-motion`, `--avatar-size`,
  `aria-label`, and `.avatar-prop[data-prop]`). Two `bot-settings` tests that make `requestAnimationFrame` synchronous recursed through the
  Avatar's frame loop; `stubImmediateFrames()` in `ui-harness.ts` runs a frame at once and drops a request made inside a frame.
- **Presence and device activity.** `withRequest(mocked, { heartbeats: false })` answers `PUT /bots/:id/presence` and `PUT /devices/activity`
  with `{}` without calling `write`, and records them for `takeHeartbeats()`. Six files use it. `chat-presence-ui.test.ts` and
  `device-activity-ui.test.ts` keep the default, so they still read the reports through `write`. The app-ui test that asserted
  `useChatPresence` was called with `(undefined, id)` then `("shared", id)` now asserts what the server would be told: nothing at home,
  `/bots/shared/presence active` on opening the chat, `/bots/shared/presence left` on Back (the window counts as attended through a
  `document.hasFocus` spy).
- **Render counts.** `app-ui` "does not re-render the app" counted Avatar renders. A root `Profiler` counts every commit, and two commits over
  the six minutes are the minute clock's, so it cannot tell them apart; the test compares each avatar wrapper's element and the props React keeps on it
  (`renderedProps`, as `connection-grace-ui` does) before and after, under reduced motion so only a render from above can change them.
  "Keeps the transcript from re-rendering while typing" does the same on each `.conversation-turn`. `shell-ui` used a `Composer` wrapper to
  press Stop inside a commit; a `Profiler`'s `onRender` runs after the commit's DOM is in place, so it finds the Stop button and clicks it
  there. `transcript-rerender` counts each message's row, meta row and time from the props React keeps on their elements, after each `view()`.
- **`transcript-rerender` found a dead mock.** It replaced `ReplyActions` in `src/app/ReplyActions.tsx`, which exports no such component, so
  its "actions" counts were always 0 and three assertions on them could not fail. The same counter now reads the real `.message-meta` row.
  Its "markdown" counts measured the turn rendering, which a real `memo`'d Markdown no longer shows, so they are named `rows` and read the message's article.
- **Reduced motion in `app-ui`.** The real live-reply reveal paces text over 300 ms; the file's `beforeEach` now sets reduced motion, which shows
  text at once, and the one test about which avatars move turns motion back on. `streaming-reveal.test.ts` covers the pacing.

No assertion was weakened. Edited assertions read the same fact from the real DOM; the two edited `view-failure` assertions read a real Groups
screen (`.group-panel`) where a stand-in paragraph was.

## Red runs

Each protecting change broken by hand, the file run, the source restored. Where the old test existed, it ran against the same break too.

| Break | Test | Result |
| --- | --- | --- |
| `useChatPresence(undefined, userId)` in `App.tsx` | app-ui, phones on home | failed: 1 |
| `shownRun` read from `conversation`, not `ownConversation` | shell-ui, never names another assistant's run | failed: 1 (the `Profiler` press reaches the same commit) |
| `sameTurnProps` dropped from `TurnView` | transcript-rerender | failed: 6 of 8 |
| `unchanged && previous ? previous : ...` in `use-session.ts` made `false` | app-ui "does not re-render the app" | failed: 1, and the old mock-based test failed too |
| the memo comparators of `Conversation`, `Turns` and `TurnView` always `false` | app-ui "keeps the transcript from re-rendering while typing" | failed: 1, and the old test failed too |
| `Conversation` given a fresh prop each render, and `TurnView`'s comparator dropped | the same test | passed, and so did the old one: both stop at the memo above the turn |

A timer that re-renders `App` every 10 s failed the old mock test in a full-file run. The first avatar check did not: see "Review fixes" below, which finds why and replaces that check.

## Cost, and reduced motion as the default

With motion on, the real Avatar draws a frame every 16 ms of virtual time, and the longest virtual-clock UI tests advance minutes. On an
unloaded machine `home-groups-ui` "does not poll any room's log from home" went from 42 ms to 1,291 ms and the file from 620 ms to 2,585 ms, and
under a loaded full run (8 cores, 32 busy loops) that test timed out at 15 s and dragged seven others after it. `tests/setup-ui.ts` now answers
only the reduced-motion query when a test stubs nothing, `reducedMotionOnly` in `ui-harness.ts` does the same where a file stubs `matchMedia` for
layout, and all eight files that stubbed it use it, `transcript-ui` last (see "Review fixes"). `bot-details-ui`, which asserts a live avatar,
the one `app-ui` test about which avatars move, and the one `transcript-ui` test about avatar reactions turn motion on. Full `npx vitest run`, user CPU time in two
runs each: `origin/main` 357 s and 375 s, this branch 401 s and 398 s, wall time 18 to 19 s for both. The heaviest files stay heavier because they
render the real Avatar's artwork: `bot-settings` about three times its old time, `avatar-editor` and `transcript-ui` about twice.

## Loaded full runs

`npm test` under the same load as the other entries (8 cores, 32 busy loops), tests that failed in a run, by file, `main` over 6 runs and this branch over 3 runs:

| File | `main` | this branch |
| --- | --- | --- |
| `account-transitions-ui.test.ts` | 6 of 6 | 3 of 3 |
| `live-turn-stream.test.ts` | 0 of 6 | 1 of 3 |
| `live-updates-ui.test.ts` | 3 of 6 | 1 of 3 |
| `message-markdown.test.ts` | 3 of 6 | 1 of 3 |
| `plain-text.test.ts` | 0 of 6 | 3 of 3 |
| `reply-keys.test.ts` | 2 of 6 | 1 of 3 |
| `send-timing.test.ts` | 1 of 6 | 0 of 3 |
| `streaming-hold-back.test.ts` | 2 of 6 | 1 of 3 |
| `transcript-ui.test.ts` | 0 of 6 | 1 of 3 |

`home-groups-ui` failed in a loaded run before reduced motion became the default and in none after. `account-transitions-ui`,
`live-updates-ui`, `message-markdown`, `reply-keys` and `streaming-hold-back` fail on `main` under this load too; `plain-text` and `send-timing`
are fixed on `t3/no-wall-clock-tests`. Two are new in the table and I cannot rule this change out for them. In run 3, `transcript-ui`
"checks a retry with a lost response by its ID, slowing down" timed out at 15 s and the tests after it failed on leftover state; that test derives
retry IDs through Web Crypto, whose thread-pool latency `t3/transcript-form-flake` removes and this branch does not carry. `live-turn-stream`
"keeps growth as deltas across a write's change notice" counted 4 reads where it expected 3, once. Neither failed in `main`'s six runs, and
three runs cannot tell a regression from a rarer flake.


## Checks

`.agents/tools/check-all` on this branch at its last code commit:

check      result   queued  run    counts
typecheck  pass     -       0.6s   -
lint       pass     -       0.1s   -
ruff       pass     -       0.0s   -
test       pass     3m55s   31.1s  205 files, 3668 tests
build      pass     -       8.4s   892 modules
e2e        pass     20m28s  1m15s  40 tests
py         skipped  -       -      no changes to Python or a file the Python tests read against origin/main

All 6 checks passed (26m19s total, 24m23s of it queued for heavy slots)

## Review fixes

An Opus review of `f46bcbf` found five things. Fixed on top of it, on NicolasLaptop, Node 24.22.2.

1. **`app-ui` "does not re-render the app" compared by structure.** `toEqual` on elements and props passes for a re-render, since React's new props
   object is deep-equal to the last. It now compares each avatar wrapper and its props with `!==`. The "passes when another test ran first" mystery was
   not that. The row menu (`BotMenu`) loads its popup once after first paint, 2 s of virtual time later, through a real `import()`, and swaps the row's
   contents when it lands. A cold run saw the swap land somewhere in the six minutes (the row's avatar was a new element); a run after a test that had
   loaded the popup saw nothing. With identity compared, the cold run failed with no break at all. The test now awaits `preloadBotMenu()` before it
   takes its baseline, as the file's menu tests do. Memoized `Sidebar` and `Conversation` also absorb a bare `App` render, so no avatar can show one: the
   test additionally compares the props React keeps on `.app-shell`, which `App` renders itself.
2. **`transcript-ui` ran the real Avatar's frame loop.** The file now stubs `reducedMotionOnly`, as `app-ui` does, and the one test that
   asserts motion ("cheers the assistant on an approval...", which needs a moving avatar to hear it react) turns motion on, and failed without it.
3. **`app-ui` "keeps the transcript from re-rendering while typing"** compares each `.conversation-turn`'s props with `!==`.
4. **`transcript-rerender`** sampled after each `view()`, so a turn that rendered twice for one update counted once. A `Profiler` around `Conversation`
   now samples after every commit.
5. Two orphaned mock comments removed (`stream-hide-ui`, `collaboration-ui`).

### Red runs

| Break | Test | Before this fix (`f46bcbf`) | Now |
| --- | --- | --- | --- |
| `App` re-renders itself every 10 s (`setInterval` and state in `App`) | app-ui "does not re-render the app", full file | passed (103 of 103) | failed: 1, "the app shell was rendered again"; also failed when run alone |
| `use-session.ts`: `unchanged && previous ? previous` made `false` | the same | failed alone | failed: 1, alone and in the full file |
| `Sidebar` re-renders itself every 10 s | the same, avatar check | not run | failed: 1 (an avatar wrapper got new props) |
| `TurnView` renders twice per update (`useLayoutEffect` that bumps state when `block` changes) | transcript-rerender | passed (8 of 8) | failed: 6 of 8 |
| memo comparators of `Conversation`, `Turns` and `TurnView` all `() => false` | app-ui "keeps the transcript from re-rendering while typing" | failed | failed: 1 |
| any one of those three comparators `() => false` | the same | passed | passed: the other two memo layers absorb it, for both forms of the check |

The last row is not a gap in the identity check: the layers cover each other, and only breaking all three lets typing reach a turn. Identity is the stricter form by
construction; I found no single source break that tells the two forms apart in this test.

### Cost of item 2

`transcript-ui` "checks a retry with a lost response by its ID, slowing down, and sends only that ID again" on an unloaded NicolasLaptop: 1,051 ms
on `f46bcbf`, 41 ms now (the review measured 2,016 ms on its machine, under 66 ms on `main`). The file runs in 3.8 s, from 5.8 s.

`taskset -c 16 npx vitest run tests/transcript-ui.test.ts` with four `yes > /dev/null` spinners on core 16, three runs: 114 of 114 passed each time,
that test taking 451, 444 and 382 ms, files in 37.5, 36.4 and 34.8 s. I tried the same under load on the `f46bcbf` file; it had not finished after
two minutes, so I stopped it and have no number for it. The spinners were stopped afterwards.
