# November 20 cascade layer fallout

Code state: `t3/fix-cascade-fallout-message-rail`, from `4586b3b4` on `t3/research-openbot-chat-bubbles`.
Node v24.22.2, Chromium from Playwright. Hermes did not take part; every browser read used `e2e/server.ts` and its
fixtures. Evidence files are under `.private/cascade-layer-fallout/`, which Git ignores.

## The question

Before #457 the app's stylesheets had no cascade layers, and rules met by specificity and position. #457 wrapped
`src/styles.css` in `@layer base`, each component sheet in `@layer components` and `src/motion.css` in `@layer motion`.
Its CSS diff without whitespace is those wrappers and nothing else, so every computed difference it causes is fallout
rather than an intended style change. `1ee81000` put the layers in their declared order (see
`20261120T054321Z-cascade-layer-order.md`). In that order a base rule loses to every component rule and a component rule
loses to the motion layer, however specific. The truth to restore is how the app rendered before layers.

## Method

Three builds, each served by `e2e/server.ts` on its own port:

| Build                        | Checkout                                             | Port |
| ---------------------------- | ---------------------------------------------------- | ---- |
| Before layers                | origin/main `2eb5a123`                               | 4301 |
| Layers in the declared order | origin/main `d6b53105` with `1ee81000` cherry-picked | 4303 |
| This branch                  | the worktree                                         | 4305 |

Two reads, both scripts kept in `.private/layer-diff/`:

1. A two-build comparison, adapted from `.agents/tools/diff-computed-styles.mjs`, reads every element's computed style on
   both servers and lists each property that differs. It reads 13 screens: home, the assistant menu, the account menu,
   Settings, Settings with notifications blocked, the command palette, a chat, a chat with an approval and a question,
   Find in chat, a selection with the Quote button, the composer with a photo and a text file attached, an assistant's
   settings, and a group chat. A route patch gives the chat a long Markdown reply with a table, an approval and a
   question, the assistant the instructions its settings need, and the group chat a room. Each screen is read at
   1440 and 390 px in light and dark, and at 390 px with a finger (`hasTouch`, `isMobile`, which matches
   `pointer: coarse`), with one hovered and one focused control per screen.
2. An unwrap read loads one build, replaces each stylesheet link with a style element of its rules, and reads every
   element twice on the same page: as built, and with the base, components and motion blocks unwrapped in place. The
   second read is how the same rules met before layers, in the build's own link order. Through the DevTools protocol it
   also forces `:hover` on every element and `:focus-visible` and `:active` on every control, and reads transition and
   animation declarations with motion allowed. Read on the build before layers it found 0 differences on all 78
   screen and view pairs, so it adds no noise of its own. Read on the layered build it found the same differences as
   the two-build comparison, and more, because it reads every control's states rather than one per screen.

A static scan with `tests/helpers/css-declarations.ts` listed base rules that set a property on a class that a
component rule also sets, and base element rules with states, such as `button:hover:enabled`, against lower-specificity
component rules on classes the source puts on a `<button>`. It found the cases the fixtures do not reach. Most of what it
listed cannot meet on one element, such as `.bot-item small.bot-activity` against `.bot-details-facts .bot-activity`, or
`.decision-card .actions` against the actions row of another panel, and was dropped after reading the markup.

## Differences

Each row is one element and property, before layers and with layers in the declared order, and the two rules that meet.

### Fallout, fixed

| Where                                  | Element                                                                                                                                                                                                          | Property                                          | Before layers                  | With layers                          | Rules                                                                                                                                                         |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phone, Find in chat open               | `.find-bar`                                                                                                                                                                                                      | `z-index`                                         | 5                              | 3                                    | base `.transcript-frame .find-bar` (max-width 620px) against `transcript.css` `.find-bar`                                                                     |
| Phone, a selection                     | `.quote-selection`                                                                                                                                                                                               | `z-index`                                         | 5                              | 3                                    | base `.transcript-frame .quote-selection` (max-width 620px) against `transcript.css` `.quote-selection`                                                       |
| Every chat, every width                | `.composer > .voice-controls`                                                                                                                                                                                    | `display`                                         | `contents`                     | `flex`                               | base `.composer > .voice-controls` against `voice-controls.css` `.voice-controls`. The composer's grid columns swap and the text field grows from 44 to 58 px |
| Home, Today                            | `.today-timestamp`                                                                                                                                                                                               | `font-size`                                       | 13px                           | 12px                                 | base `.muted` against `experience.css` `.today-timestamp`, equal specificity, base sheet later                                                                |
| Phone chat                             | `.composer`                                                                                                                                                                                                      | `box-shadow`                                      | the glass shadow               | the lit edge and `0 5px 18px`        | base `.composer-area > .composer` and its `:focus-within` (max-width 620px) against motion `.composer` and `.composer:focus-within`                           |
| Phone, a chat with the computer in use | `.computer-peek`                                                                                                                                                                                                 | `bottom`                                          | 12px plus the composer overlap | 12px, behind the composer            | base `.transcript-frame .computer-peek` (max-width 620px) against motion `.computer-peek`                                                                     |
| Phone, motion allowed                  | `.settings-sheet[open]`                                                                                                                                                                                          | `animation-duration`, `animation-timing-function` | 260ms, ease-out                | 340ms, the soft spring               | `home.css` `.settings-sheet[open]` (max-width 620px) against motion `dialog[open]`                                                                            |
| Phone, motion allowed                  | `.command-palette[open]`                                                                                                                                                                                         | `animation-duration`, `animation-timing-function` | 220ms, ease-out                | 340ms, the soft spring               | `shell.css` `.command-palette[open]` (max-width 620px) against motion `dialog[open]`                                                                          |
| An assistant's settings, phone         | `.settings-index .settings-row`                                                                                                                                                                                  | `min-height`                                      | 60px                           | 56px                                 | base `.settings-index .settings-row` against `home.css` `.settings-row`                                                                                       |
| Phone, hover                           | `.home .bot-row.selected`                                                                                                                                                                                        | `background`                                      | `--accent-soft`                | transparent                          | base `.bot-item.selected:hover:enabled` against `home.css` `.home .bot-row.selected` (max-width 620px)                                                        |
| Hover                                  | `.home-round`                                                                                                                                                                                                    | `background`                                      | `--accent-soft`                | `--raised`                           | base `button:hover:enabled` against `home.css` `.home-round`                                                                                                  |
| Hover                                  | `.sheet-close`                                                                                                                                                                                                   | `background`                                      | `--accent-soft`                | `--raised`                           | base `button:hover:enabled` against `home.css` `.sheet-close`                                                                                                 |
| Hover                                  | `button.attachment-thumb`                                                                                                                                                                                        | `background`                                      | `--accent-soft`                | `--rail`                             | base `button:hover:enabled` against `attachments.css` `button.attachment-thumb`                                                                               |
| Hover                                  | `.reply-file`                                                                                                                                                                                                    | `background`                                      | `--accent-soft`                | 50% `--accent-soft`                  | base `button:hover:enabled` against `transcript.css` `.reply-file:hover`                                                                                      |
| Hover                                  | `.attachment-notice .icon-button`                                                                                                                                                                                | `color`                                           | `--ink`                        | inherited                            | base `.icon-button:hover:enabled` against `attachments.css` `.attachment-notice .icon-button`                                                                 |
| Hover                                  | `.talk-message .icon-button`                                                                                                                                                                                     | `color`                                           | `--ink`                        | `--muted`                            | base `.icon-button:hover:enabled` against `talk.css` `.talk-message .icon-button`                                                                             |
| Hover                                  | `.attachment-image .attachment-retry`, `.automation-task-group-toggle`, `.avatar-stage-states button`, `.activity-watch`, `.model-option .model-choice`, `.model-option .model-favorite`, `.routine-run-summary` | `background`                                      | `--accent-soft`                | each one's own resting or hover fill | base `button:hover:enabled` against each component's rule                                                                                                     |

The first twelve rows and `.attachment-thumb` showed in the reads of the fixture screens. `.computer-peek`,
`.attachment-notice .icon-button` and `.reply-file` showed when the unwrap read added a stand-in element with each
one's classes to the chat. The Talk icon button and the last row come from the static scan and the rules alone: each is
a `<button>` in the source with a one- or two-class rule that sets the property, and no rule of its own at or above
`button:hover:enabled`'s specificity of (0,2,1).

Each fix moves the losing rule into its competitor's layer, beside it, so specificity decides as before. The Find and
Quote stacking moved to `transcript.css`, the voice controls rule to `voice-controls.css`, the settings row height to
`home.css`, and the composer shadows, the computer peek's position and the two phone open animations to `motion.css`,
under the same `prefers-reduced-motion: no-preference` condition as the wide-screen ones. Today's timestamp drops the
`font-size` that never applied before layers. Each hover the base `button:hover:enabled` or `.icon-button:hover:enabled`
gave is restated as a `:hover:enabled` rule in the component's sheet.

### Intended change, kept

| Where       | Element              | Property     | Before layers                                          | With layers | Why                                                                                                                                                                                                               |
| ----------- | -------------------- | ------------ | ------------------------------------------------------ | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hover       | `.attachment-remove` | `background` | `--accent-soft`                                        | `--danger`  | The button's icon is `--surface`. On `--accent-soft` it measures 1.18:1 in light and 1.54:1 in dark; on `--danger` 6.08:1 and 9.12:1. `.attachment-remove:hover:enabled` now wins by specificity in both cascades |
| Wide, hover | `.message-rail-tick` | `background` | `--accent-soft` (the rail did not exist before layers) | transparent | This branch's rail answers a hover with its mark only. `.message-rail-tick:hover:enabled` keeps the box clear by specificity in both cascades                                                                     |

### Unsure, left as layered

- `.attachment-image .attachment-retry` while pressed. Before layers `button:active:enabled` replaced its
  `translateX(-50%)` centering with `translateY(1px)`, so the Retry button under a failed photo jumped right by half its
  width. With layers it stays centered. Restoring the jump seemed wrong; a failed upload is on no fixture screen.
- `button:disabled { cursor: not-allowed }` against `cursor: pointer` on `.reply-file`, `.automation-task-group-toggle`,
  `.routine-run-summary` and `.message-rail-tick`. None of these buttons is ever disabled in the source, so nothing shows.

### This branch's own stylesheets

The unwrap read of this branch's build found only the rail tick above. `message-rail.css`, the bubble rules in
`message-markdown.css` and `styles.css`, and the tint block in `motion.css` decide nothing by layer on the screens read.
By eye, at 1440 and 390 px in light and dark, the reply bubbles, the person's bubble with its attribution and time, the
table's right-edge fade, the code block and the rail with its current tick look as intended.

## After the fixes

The two stylesheet commits cherry-pick cleanly onto the layered candidate. Compared with the build before layers on all
13 screens and 6 views, the only difference is the `.attachment-remove` hover above, in every view. The unwrap read of
this branch's final build with reduced motion found 0 differences on all 78 screen and view pairs
(`unwrap-branch-reduce.json`). With motion allowed it found differences only in `transform` on the avatar's SVG groups,
with a different unwrapped value each time and the same built value. `Avatar.tsx` moves those groups from
`requestAnimationFrame`, which runs between that script's separate reads; the guard below compares within one
synchronous evaluation and does not see them (`unwrap-branch-motion.json`).

## The guard

`e2e/cascade-layers.spec.ts` reads each screen with the layers as built and unwrapped, as the unwrap read does, and fails
on any value that moves. Chromium forces hover, keyboard focus and press on every control. It runs wide in light with
motion allowed, wide in dark, at 390 px in dark, and at 390 px with a finger in light with motion allowed. Its screens
are the seven in `e2e/screens.ts`, which `e2e/stylesheet-order.spec.ts` now shares, plus a long chat with a table, an
approval, a question, an attachment, Find in chat and the message rail, a selection with the Quote button, and an
assistant's settings. Its 40 tests took 147 seconds together in the full Chromium run on this host.

A static test was the other option. It would cover every stylesheet, but the scan above showed its cost: it cannot tell
which classes share an element, so most of what it reported was false, and it cannot see two rules that meet on
different classes of one element. The browser read is exact for what it reads and catches both directions and the
motion layer. Its limit is the screens it reads.

`e2e/phone-overlays.spec.ts` checks the reviewer's case directly: at 390 px it puts the Quote button below a selection
over the floating composer, and Find in chat in a 180 px tall view under it, and checks which is on top where they
overlap.

## The rail after a reflow

`src/app/MessageRail.tsx` checked its position cache only against the last sent message. A reflow that moved earlier
messages and left the last one in place kept the old turn marked. The rail now watches each child of the column, which
is one turn or run card, with its resize observer, and a MutationObserver adds new children. A resize of a child that
ends above the last sent message marks the cache stale, and so does a new column width; either measures every
message again. A resize of the last turn or the column, where a reply streams, no longer reads the last row: the render
that grew them already did. The streaming test now delivers the resize report a browser sends for the growing turn:
before the fix one live reply update cost two row reads with it, and after the fix one. That count comes from jsdom; no
browser measured it.

## Red runs

Each protecting test was run against the code it protects, broken by hand, and restored; `git status` showed only the
intended changes afterwards.

| Break                                                | Test that failed                                                                                                                                                                                                                | Evidence              |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| Unfixed `MessageRail.tsx`                            | "marks the turn the reading line meets after turns above the last sent message reflow", "measures again when the column's width changes", and the streaming test with the resize report added (2 row reads, expected at most 1) | `rail-red.log`        |
| No stale mark for a turn above                       | the reflow test                                                                                                                                                                                                                 | `rail-m1.log`         |
| No width comparison                                  | the width test                                                                                                                                                                                                                  | `rail-m2.log`         |
| Every resize report reads the last row               | the streaming test                                                                                                                                                                                                              | `rail-m3.log`         |
| No `contains(last)` check                            | the streaming test                                                                                                                                                                                                              | `rail-m4b.log`        |
| Turns not observed                                   | the reflow test                                                                                                                                                                                                                 | `rail-m5.log`         |
| The column excluded by name as well as by `contains` | none: the clause was redundant and was removed                                                                                                                                                                                  | `rail-m4.log`         |
| Before the Find and Quote move                       | both tests in `e2e/phone-overlays.spec.ts`: they overlapped and the composer was on top                                                                                                                                         | `overlays-red.log`    |
| Every stylesheet as on `1288467b`                    | all 40 cascade layer tests, naming the rows in the fixed table                                                                                                                                                                  | `layers-red.log`      |
| No rail tick hover rule                              | the wide chat tests, on `.message-rail-tick` `background-color`                                                                                                                                                                 | `layers-red-rail.log` |

## Checks

All on `8f8963e9` with this entry uncommitted, which changes no code.

| Check                                            | Command                                                                                        | Result                                                                                                                | Evidence               |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Typecheck                                        | `npm run typecheck`                                                                            | Compiled                                                                                                              | `typecheck.log`        |
| Lint                                             | `npm run lint`                                                                                 | Passed                                                                                                                | `lint.log`             |
| Build                                            | `npm run build`                                                                                | Built                                                                                                                 | `build-final.log`      |
| Unit and integration tests                       | `~/.agents/tools/linux-heavy-lock.sh npm test`                                                 | Unit-passed: 232 files, 4,234 tests                                                                                   | `test.log`             |
| Browser suite, Chromium                          | `~/.agents/tools/linux-heavy-lock.sh env E2E_PORT=4311 npx playwright test --project=chromium` | Runtime-exercised: 134 passed in 5.6 minutes, the 40 new cascade layer tests and the 2 phone overlay tests among them | `e2e-chromium.log`     |
| Browser suite, WebKit                            | `npx playwright test --project=webkit e2e/phone-overlays.spec.ts`                              | Not run: the browser cannot launch, "Host system is missing dependencies to run browsers"                             | `e2e-webkit.log`       |
| Before and after against the build before layers | two-build comparison, 13 screens, 6 views                                                      | Runtime-exercised: only the `.attachment-remove` hover differs                                                        | `base-vs-fixed.txt`    |
| This branch's build with and without layers      | unwrap read, 13 screens, 6 views, both motion settings                                         | Runtime-exercised: 0 differences with reduced motion; avatar animation frames only with motion allowed                | `unwrap-branch-*.json` |

## Not checked

- WebKit. It cannot start on this host because its system libraries are missing, which fails the same way on
  origin/main. The cascade layer spec reads only the resting state there, since forcing states needs the DevTools
  protocol.
- The dev server, native-computer.html, native-terminal.html and the avatar specimen page.
- Screens no fixture reaches: Talk, automation, routines, the model selector, the avatar editor, assistant details, a
  real computer handoff and a failed upload. Their fixes rest on the static scan and stand-in elements.
- A group chat in the guard. The two-build comparison read it in every view, and it showed only the selected row hover.
- Increased contrast and forced colors.
- A rule pair that meets on two different classes of one element on a screen no read covers.
