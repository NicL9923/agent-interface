# November 20 chat review fixes, web, fourth review

Code state: `t3/research-openbot-chat-bubbles` from `b180694a` to `863fc5ce`. Node v24.22.2, Chromium from
Playwright. Hermes did not take part; browser reads used `e2e/server.ts` or `.agents/tools/preview-app.mjs` and their
fixtures. Evidence files are under `.private/chat-review-fixes-4/`, which Git ignores.

A fourth independent review of the web client found no blockers and four findings. Each one reproduced.

## 1. The rail after a routine card is hidden

Hiding a routine whose card sat above the last sent message moved every message after it. The browser reported only
the column's new size, and the column holds the last sent message, so the rail skipped its check and kept the old
positions. The column's mutation observer now marks the positions stale when a child above the last sent message
joins, leaves or moves, and measures again.

The same observer now adds and drops watched turns from its records, so a reply streaming below the last tick walks no
turn list. While the rail is hidden it watches no turn, reads nothing on scroll and drops its cache; it measures every
message when it shows again.

Tests in `tests/message-rail-ui.test.ts`:

- "marks the turn the reading line meets after a routine card above the last sent message is hidden": hides the card
  through its own button, then Undo brings it back. Red on `b180694a`: Question 30 stayed marked where the line meets
  Question 31 (`rail-hide-red.log`, `rail-red.log`).
- "watches no turn while the rail is hidden, and marks the turn in view once it shows again". Red on `b180694a`: all
  64 turns were observed while hidden (`rail-red.log`).
- The streaming test now also counts the rail's reads of the column's children. Red on `b180694a`: one walk per live
  update (`rail-red.log`).
- The send test now checks that a saved row replacing the one shown while sending measures the 65 sent messages once.

Hand breaks of the fix, each restored afterwards:

| Break                                 | Test that failed                               | Evidence                           |
| ------------------------------------- | ---------------------------------------------- | ---------------------------------- |
| Mutation callback measures nothing    | the hide test                                  | `rail-m1-no-stale-on-mutation.log` |
| Removed children ignored              | the hide test                                  | `rail-m2-no-removed-branch.log`    |
| Added children ignored                | the hide test, at Undo                         | `rail-m3-no-added-branch.log`      |
| Turns watched while hidden            | the hidden rail test                           | `rail-m4-watch-while-hidden.log`   |
| Scroll reads positions while hidden   | the hidden rail test                           | `rail-m5-read-while-hidden.log`    |
| Cache kept while hidden               | the hidden rail test                           | `rail-m6-keep-cache-hidden.log`    |
| Every entries update walks the column | the streaming test                             | `rail-m7-scan-on-entries.log`      |
| Every mutation marks the cache stale  | the send test: 130 row reads where 65 is right | `rail-m8-always-measure.log`       |

In Chromium, in the preview's Ranch hand chat with three earlier questions patched in, the script hid the certificate
check card, which sat above the last sent message, and put the reading line 30 px below the first sent message after
it. The last sent message moved from 2220 to 2119 px. A build of `b180694a`'s rail kept "The north gate sensor…"
marked; this branch's build marks "I replaced it…", the message the line meets (`rail-hide-old.json`,
`rail-hide.json`, `collage-rail-after-hide.png`).

## 2. Hover fills that cut text contrast

Measured in Chromium against the preview, hovered with the mouse, in light and dark (`measure-hover.js`,
`contrast-before.tsv`, `contrast-after.tsv`). "Before" is `b180694a` plus the rail fix.

| Text on the hovered control              | Light before | Light after | Dark before | Dark after |
| ---------------------------------------- | ------------ | ----------- | ----------- | ---------- |
| Selected avatar preview state, its label | 1.18:1       | 5.66:1      | 1.54:1      | 9.32:1     |
| Routine run "Running"                    | 3.83:1       | 4.52:1      | 6.33:1      | 9.20:1     |
| Routine run "Finished, not delivered"    | 3.83:1       | 4.52:1      | 6.33:1      | 9.20:1     |
| Routine run "Failed"                     | 5.16:1       | 6.10:1      | 5.92:1      | 8.60:1     |
| Routine run time                         | 4.62:1       | 5.46:1      | 4.91:1      | 7.13:1     |

The card's quieter fill, rail at 55%, read 4.39:1 for the attention color in light, so it could not be kept for
running and warning runs. The summary now takes rail at 30% in every state, beating the base hover in either cascade.
In light that fill is only slightly darker than the card. The selected avatar state keeps its own fill on hover, in
either cascade.

The other hovers commit `aec99a62` restated were checked against what each control can show while hovered. Every
foreground is ink, muted, message meta, accent or danger, and the lowest pair is message meta on `--accent-soft` at
4.62:1 in light. Icons are ink, muted or accent, 4.80:1 or more. None fails.

The sweep found one more failing pair it could not fix with a fill: an assistant row's "Needs your help" line uses
`--attention`, which in light reads 4.51:1 on the page, 4.11:1 on the wide sidebar at rest, 4.14:1 under the base row
hover, and 3.84:1 on a selected row, at rest on a wide window or hovered on a phone (`measure-rows.js`,
`contrast-rows.txt`). The light `--attention` token is the cause. At `#8c5d2e` it would read 4.51:1 or more on every one
of those fills. It is used in 36 places, so it was left for a separate decision.

## 3. Watch in the activity line

The guard's new screen, a chat with the assistant at the computer, read Watch at 4 px 12 px padding, 13 px text and a
1 px border, against 3 px 8 px, 11 px and no border without layers (`layers-red.log`). `.activity-status .activity-watch`
now sits beside `.activity-watch`. The Retry buttons that also sit in the activity line set all three properties in
two-class rules of their own, so they meet the same way in both cascades. The same screen found two more misses:

- The live rows' 5 px top margin from `.activity-copy p` lost to `.activity-live p { margin: 0 }`, which never applied
  before layers; that margin goes (`layers-red.log`).
- The computer peek's close button lost the base hover fill. It is restated in `motion.css`; its ink icon reads 11.33:1
  in light and 9.18:1 in dark on it (`peek-close-red.log`).

The screen's first full run failed on its own setup in all four views: its conversation route came after the page had
read the chat, and the peek's desktop request drew a 409 that the page health check counts (`layers-green.log`). The
routes now go in before sign-in, and the desktop request is left waiting. In the preview, Watch reads 3 px 8 px, 11 px and no border, light and dark (`watch-*.png`).

## 4. The guard and generated content

The guard compared only the layered read's keys, and drops a pseudo-element whose content is none, so a `::before`
drawn only without layers never compared. It now compares the union and names the empty side "(not drawn)". The test
"the guard sees generated content that only one cascade draws" inserts one pseudo-element each way into a built sheet.
Red with the old comparison: the base-drawn `::before` was missing (`probe-red.log`). With the union, every existing
screen still passed, so it reported no new fallout there (`layers-green.log`).

## Checks

All on `863fc5ce` unless stated.

| Check                      | Command                                                                                                  | Result                                                                                                                                                                                                                                                                                                                                       | Evidence                             |
| -------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Typecheck                  | `npm run typecheck`                                                                                      | Compiled                                                                                                                                                                                                                                                                                                                                     |                                      |
| Lint                       | `npm run lint`                                                                                           | Passed                                                                                                                                                                                                                                                                                                                                       | `lint.log`                           |
| Format                     | `npm run format:check`                                                                                   | Passed                                                                                                                                                                                                                                                                                                                                       | `format.log`                         |
| Build                      | `npm run build`                                                                                          | Built                                                                                                                                                                                                                                                                                                                                        | `build.log`                          |
| Rail and routine tests     | `npx vitest run tests/message-rail-ui.test.ts tests/routine-runs-ui.test.ts`                             | Unit-passed: 17                                                                                                                                                                                                                                                                                                                              |                                      |
| New guard screen, Chromium | `npx playwright test --project=chromium e2e/cascade-layers.spec.ts -g "at the computer" --repeat-each=3` | Runtime-exercised: 12 passed                                                                                                                                                                                                                                                                                                                 | `watch-screen.log`                   |
| Full battery               | `~/.agents/tools/linux-heavy-lock.sh .agents/tools/check-all --keep-going`                               | Failed on e2e only, WebKit. Typecheck, lint, Ruff and build passed; Vitest unit-passed 229 files, 4,187 tests; Python passed 52 files; e2e Chromium runtime-exercised 140 passed, 45 of them cascade layer tests; e2e WebKit 140 failed at launch, "Host system is missing dependencies to run browsers". 5 minutes queued, 12.6 minutes run | `check-all.log`, `check-all-e2e.log` |

## Not checked

- WebKit, which cannot start on this host because its system libraries are missing.
- The routine and avatar hovers on a phone or with increased contrast.
- A screen reader pass; nothing changed what is announced.
