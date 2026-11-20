# November 20 chat review fixes on the web, second round

Branch `t3/research-openbot-chat-bubbles`, from `1ee81000` through `bf281b7b`. Node v24.22.2 on
LaptopServer (Fedora). Hermes did not take part: the server tests use the in-memory store and the fake
runtime, the adapter tests the fake transport, the add-on test the fake native gateway, the UI tests
the mocked client API, and the browser checks the e2e server and the preview fixtures. A second
independent review of the web and server changes reported six findings. Each was replayed as a
failing test on the code it was reported against before the fix. Logs are in
`.private/chat-review-fixes-2/`, which Git ignores.

## What the earlier entries describe that no longer holds

- `20261120T050448Z-chat-review-fixes-web.md`: the server no longer admits an answer whose ID merely
  equals the last message's. The last message must be a settled assistant reply. An answer is also
  fenced at Hermes admission, so "nothing is sent to Hermes" on `answer_stale` now covers a refusal
  that comes back from Hermes. "Positions are measured once" now means once per change of the ordered
  sent-message IDs, plus one check of the last sent message on any other change.
- `20261120T054321Z-cascade-layer-order.md`: "component rules that lost to the base layer since #457
  win again" included the reply bubble's transparent border, which then beat its increased-contrast
  color in the base layer. That rule moved into the components layer.

## Findings

| Finding                                                              | Reproduced                                                                                                                                                            | Fix                                                                                                                                    | Now guarded by                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. The stale-answer guard runs before Hermes admission (blocker)     | Yes: the adapter's RPC for an answer carried no `require_idle` (`red-adapter.log`); a Hermes refusal reached the client as 200 `uncertain` (`red-api-agent-case.log`) | Adapter sends `require_idle` for an answer, never steers one, maps 4091 to 409 `answer_stale`; the route withdraws the recorded intent | `tests/hermes-adapter.test.ts` "fences an answer to an idle assistant…"; `tests/hermes_extension_journal_test.py` "a reaction answer arriving while another turn runs is refused, not steered"; `tests/reaction-answers-api.test.ts` "passes Hermes's refusal through…" |
| 2. The API accepts a reaction to a person's message                  | Yes: 200 for an answer naming a final user row, progress line, empty assistant row, or a reply to another assistant (`red-api-agent-case.log`)                        | The route checks `answerableReply`, the rule the clients offer React by                                                                | four cases in `tests/reaction-answers-api.test.ts`                                                                                                                                                                                                                      |
| 3. A matching draft goes blank and read-only while the picker sends  | Yes: the composer read `''` for a 👍 draft; a 👍 typed into the draft was never saved (`red-draft-ui.log`)                                                            | `sendingDraft` and the draft save's pause skip an answering submission                                                                 | `tests/reaction-answers-ui.test.ts` "keeps a 👍 draft shown and editable…" and "saves a 👍 typed into the draft…"                                                                                                                                                       |
| 4. The rail drops focus before the first arrow press                 | Yes: after Tab to the latest tick and a scroll to the top, focus went to `body` (`red-rail-focus.log`)                                                                | A tick's focus event sets the rover, which anchors the window                                                                          | `tests/message-rail-ui.test.ts` "keeps a tick that Tab reached in the window…"                                                                                                                                                                                          |
| 5. Streaming remeasures every sent row                               | Yes: 64 rail row reads for one live-reply update in a 64-prompt chat (`red-rail-stream.log`)                                                                          | The ordered tick IDs keep one array while unchanged; the cache is checked, not cleared, when the entries change                        | "measures no sent message again while a reply streams…" (1 read now); "marks a sent message as the turn in view once its saved row replaces…" guards the ID comparison                                                                                                  |
| 6. The increased-contrast reply border is lost under the layer order | Yes: `.reply-bubble` border `rgba(0, 0, 0, 0)` under `prefers-contrast: more` on the built app (`red-bubble-edge-e2e.log`)                                            | The reply bubble's contrast rule moved into the components layer beside its default                                                    | `e2e/accessibility.spec.ts` "both chat bubbles draw an edge under increased contrast" and "under forced colors"                                                                                                                                                         |

Finding 6 under forced colors did not reproduce: on the build before the fix, Chromium drew both
bubbles' transparent borders in the system text color, and the forced-colors test passed. No
forced-colors border rule existed to move. The person's bubble kept its edge under increased contrast
before the fix, because its default and its contrast rule were both in the base layer.

### The window that stays open

A turn running at the server's fresh read is refused by the route. A turn that starts after the read
and is still running when Hermes takes its admission lock is refused by the add-on with 4091, and the
route answers `answer_stale`. A turn that starts after the read and settles before the admission lock
leaves an idle chat for Hermes, which admits the answer after that turn's reply. The route's read and
the add-on's `running` check cannot see that turn. That needs a whole turn, model reply included, to
fit in the time one send takes to reach Hermes. Retries accept the same window. No test covers it,
because the fake runtime would only restate the assumption; `docs/native-api.md` states it.

## Red runs

Each fix line was broken by hand with `.private/chat-review-fixes-2/mutate.py` (TypeScript) or
`python3 .agents/tools/mutate-py.py` (Python), which restore the file byte for byte, and each went red
for its intended reason (`red-m-<name>.log`, `red-addon-fence.log`):

- Server: the answer's `require_idle` dropped, the 4091 mapping dropped, a steer of an answer allowed,
  the intent not withdrawn, the refusal not passed through, the guard comparing IDs only.
- Add-on: the existing `require_idle` check disabled. The add-on itself is unchanged; the new test pins
  the fence an answer now depends on.
- Web: an answer counted as the draft's sent copy, the draft save paused for an answer.
- Rail: no rover on focus, a new ID array on every update, the cache cleared on every entries change,
  the ID comparison reduced to a length comparison.
- CSS: the person's bubble's contrast selector renamed, rebuilt, e2e red for `person`
  (`red-person-contrast-e2e.log`).

One mutant survived first: `withdraw` deleting only an `uncertain` row behaved the same as deleting the
row. Hermes answers a request it already admitted with that receipt before any refusal, so a refused
request has nothing settled to keep. The status filter was removed.

## Cascade review

The layer order `theme, base, components, motion, utilities` became real in `1ee81000`. This branch's
own rules were read against it: `message-markdown.css`, `message-rail.css`, `reactions.css`, the bubble
and meta-row rules in `styles.css`, and the tint block in `motion.css`. Only the reply bubble's
contrast border depended on the old order. The rail's and the React menu's button rules now beat the
base `button`, `button:hover:enabled` and `button:focus-visible` rules, as intended; their own focus
outlines (2 px) replace the base 3 px outline. The tint block is in `motion`, above both layers in
either order. Rules this branch did not touch were not changed.

## Checks

| Check            | Code state       | Command                                                                                           | Result                                                                         | Evidence                                                 |
| ---------------- | ---------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------- |
| Typecheck, lint  | each commit      | `npm run typecheck`, `npm run lint`                                                               | Compiled; passed                                                               | terminal                                                 |
| Build            | `bf281b7b`       | `npm run build`                                                                                   | Built                                                                          | `.private/chat-review-fixes-2/build.log`                 |
| Bubble edges e2e | `bf281b7b` build | `npx playwright test e2e/accessibility.spec.ts --project=chromium -g "chat bubbles draw an edge"` | 2 passed                                                                       | `.private/chat-review-fixes-2/green-bubble-edge-e2e.log` |
| check-all        | `bf281b7b`       | `~/.agents/tools/linux-heavy-lock.sh .agents/tools/check-all --keep-going`                        | Every check passed except e2e, whose 92 WebKit tests could not start a browser | `.private/chat-review-fixes-2/check-all.log`             |
| Browser          | `bf281b7b` build | `PREVIEW_PORT=3426 PREVIEW_REACTIONS=1 node .agents/tools/preview-app.mjs`, `playwright-cli`      | Runtime-exercised in Chromium; see below                                       | `.private/chat-review-fixes-2/*.png`                     |

The run on `bf281b7b` (queued 128 s for the machine lock, ran 648 s):

| check     | result | run   | counts                 |
| --------- | ------ | ----- | ---------------------- |
| typecheck | pass   | 1.2s  | -                      |
| lint      | pass   | 1.2s  | -                      |
| ruff      | pass   | 0.0s  | -                      |
| test      | pass   | 22.4s | 232 files, 4,232 tests |
| build     | pass   | 2.4s  | 914 modules            |
| e2e       | FAIL   | 3m33s | 184 tests, 92 failed   |
| py        | pass   | 6m47s | 52 files               |

All 92 Chromium tests passed, the two bubble-edge tests among them. All 92 WebKit tests stopped at
browser launch with "Host system is missing dependencies to run browsers", as on origin/main
`d6b53105` (`.private/chat-review-fixes/baseline-e2e-d6b53105.log`, 89 per browser then; this branch
adds the layer-order test and the two bubble tests). The full e2e output is
`.private/chat-review-fixes-2/e2e.log`.

## Browser

A `playwright-cli` session on the preview, closed afterwards; the preview was stopped by the process
listening on port 3426.

- Both bubbles in Kitchen companion at 1440×900, light and dark (`bubbles-*`, `bubbles-collage.png`):
  under `prefers-contrast: more` both borders read 1 px `rgb(95, 104, 94)` in light and
  `rgb(166, 180, 167)` in dark; under forced colors both read 1 px `rgb(0, 0, 0)` in light and
  `rgb(255, 255, 255)` in dark. Every bubble shows its edge in the screenshots.
- Rail at 1440×640 (`rail-*`): Shift+Tab from the transcript focused "Fixture turn 64". With the
  transcript scrolled to 0, focus stayed on that tick and the window still held turns 51 to 64. Once
  focus went back to the transcript, the window moved to turns 45 to 58 with turn 45 marked.
- Draft (`draft-*`): a 👍 typed and saved in the composer, then the picker's 👍 held at the network.
  The request carried `answering: "k63a"`, the composer still showed 👍 and was not read-only, and
  " and salt" typed meanwhile stayed after the answer went through.

## Not exercised

No WebKit or Firefox run (WebKit cannot start on this host), no screen reader pass, no Windows high
contrast on real hardware, no live Hermes or add-on process, no iOS build or test. No independent
re-review ran on these fixes.
