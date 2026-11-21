# November 21 cascade layer guard on seven more screens

Code state: `t3/extend-cascade-layer-guard` at `8bb7e0e6`, from `bd5ed912` on `t3/followups-459-462`. Node v24.22.2,
Chromium and WebKit from Playwright 1.65.0. Hermes did not take part; every browser read used `e2e/server.ts` and its
fixtures. Evidence files are under `.private/cascade-guard-screens/`, which Git ignores.

## What the guard reads now

`e2e/cascade-layers.spec.ts` reads every element's computed style with the layers as built and with the base,
components and motion blocks unwrapped, and fails on any value that moves (see
`20261120T075539Z-cascade-layer-fallout.md`). The fallout entry listed Talk, automation, routines, the model selector,
the avatar editor, assistant details and a failed upload as screens no fixture reached. Each is now a list of steps in
`e2e/cascade-screens.ts`, read after each step in one page load, in the same four views and both browsers. Chromium also
forces hover, keyboard focus and press on every control, except in a step marked `states: false`, whose controls an
earlier step already read in those states.

| Screen             | Steps                                                                                                                                                                                                                             |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Talk               | Connecting, with Mute disabled. Listening, muted, with both captions, an inline error and the Talk button pressed. Speaking. Thinking. Ended because the connection closed, with the error and Dismiss.                           |
| A failed upload    | A photo and a text file whose uploads Hermes refused, each with its error and Retry, and a HEIC photo refused before upload with its notice.                                                                                      |
| Assistant details  | The Trail Cook mid-reply, so the Now row shows. Then pinned, followed, and a new section with no name and its error.                                                                                                              |
| Automation         | The goal, task groups with Done folded, the trigger and the routine list. Then the goal's clear confirmation, a blocked task open, the new task form, the trigger editor, a routine's delete confirmation and the routine editor. |
| Routines           | Run cards in the chat for a success, a failure, a success not delivered and a run in progress. Then the failed card open with its output. Then that routine's results dialog.                                                     |
| The model selector | The settings picker open, with a favorite starred and an unavailable model. Then a search with no match. Then the chat header's model popover with the inference controls, after turning on Advanced details.                     |
| The avatar editor  | Mascot, a custom color and tuned eyes with Reset eyes. Then a portrait with a prompt over its limit. Then a new assistant's look step, previewing Thinking.                                                                       |

## Fixtures

`e2e/server.ts` gains two switches on the control port, both off again when the next test starts.

- `POST /full-hermes` makes the runtime a Hermes with live voice, routines and assistant configuration. The Ranch Hand
  gets a model, a description and instructions. Three routines have runs of each status the cards draw. The automation
  overview has a goal, four tasks, a trigger and skills. A model catalog and inference settings answer. Routines, run
  results and the extra capabilities stay empty or unsupported with the switch off, so no other spec sees them. The
  member's preferences are saved when the switch turns on and put back when the next test starts, because these screens
  pin, follow, star and turn on Advanced details, and the store kept those for every later test. The first draft of
  this suite showed that: a pin left the next test's home without its "Your assistants" region.
- `POST /upload-failure` makes `upload` throw a 507. The failed upload screen allows the browser's "status of 507"
  console error, the only error it logs, the way other specs allow a refused request they cause on purpose.

Talk needs a microphone and a WebRTC link to OpenAI, which a headless browser has neither of. An init script replaces
`navigator.mediaDevices.getUserMedia` with one audio track and `RTCPeerConnection` with a peer whose data channel the
test speaks for, as `tests/talk-ui.test.ts` does. A page route answers `https://api.openai.com/v1/realtime/calls`. The
session mint goes through the real server route. `use-talk.ts`, `TalkLoop` and `TalkPanel` run unchanged; the test
sends Realtime events such as `response.output_audio_transcript.delta` and the app reaches each phase from them.

A main assistant with check-ins was left out of assistant details. Making one needs the member's own personal assistant,
which WildBots records in its own store rather than in the roster, plus Hermes's delegation policy and routine
deliveries. The check-in group has no CSS of its own; its rows are the same settings rows as the Notify group.

## Changes to the guard

- The read compares each element's values as one joined string and takes the property list once from `body`, rather
  than building one map key per property. On this host the 44 existing screen tests went from 132.9 s to 69.3 s in
  Chromium.
- A stylesheet link that a later step's lazy screen adds is unwrapped at the next read. A link still loading throws,
  since it would read the same in both cascades.
- Between steps the forced states clear and motion comes back on, and before each read the pointer moves to the corner.
  Without the move, the last control a step clicked read hovered at rest, which hid the red run's avatar rule below.

## Differences found

| Screen                                     | Element                               | Property      | Before layers (unwrapped) | With layers        | Rules                                                                                        | Fix                                                                                                       |
| ------------------------------------------ | ------------------------------------- | ------------- | ------------------------- | ------------------ | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| A failed upload, pressed                   | `.attachment-image .attachment-retry` | `transform`   | `translateY(1px)`         | `translateX(-50%)` | base `button:active:enabled` against `attachments.css` `.attachment-image .attachment-retry` | `.attachment-image .attachment-retry:active:enabled { transform: translate(-50%, 1px) }`, kept on purpose |
| Automation, every view                     | `.routine-chat-toggle`                | `align-items` | `center`                  | `flex-start`       | base `.checkbox-label`, later in order, against `experience.css` `.routine-chat-toggle`      | `.checkbox-label.routine-chat-toggle`, kept on purpose                                                    |
| Automation, every view                     | `.routine-chat-toggle input`          | `margin-top`  | `0`                       | `3px`              | base `input[type="checkbox"]`, later in order, against `.routine-chat-toggle input`          | `.routine-chat-toggle input[type="checkbox"]`, kept on purpose                                            |
| Automation, every view                     | `.routine-chat-toggle small`          | `font-size`   | 14px                      | 12px               | base `.settings-content .muted`, more specific, against `.routine-chat-toggle small`         | `.settings-content .routine-chat-toggle small`, kept on purpose                                           |
| The model selector, a search with no match | `.model-status` in settings           | `line-height` | 1.55                      | 1.5                | base `.settings-content .muted`, more specific, against `model-selector.css` `.model-status` | `.settings-content .model-status { line-height: 1.55 }`, restoring before layers                          |

The Retry button row is the one the fallout entry left unsure. Before layers the base press rule replaced the
centering, so the button jumped right by half its width while pressed. The new rule keeps both intents: centered, and
the 1 px press nudge every other button gets. It wins by specificity in both cascades, so the guard reads the same value.

The routine toggle's three rules came in with #213 on November 1 and never applied before layers. They put the checkbox
beside the label's first line and the note at 12 px under a 13 px label. Before layers the note was 14 px, larger than
the label it explains, and the checkbox sat centered against both lines. The layered result is what the rules ask for
and reads better, so each selector now outranks the base rule it overrides.

The model status line differs by 0.7 px in settings. No reason favored 1.5 there, so settings keep the 1.55 every other
settings note has; the chat header's popover keeps 1.5.

The other four screens found nothing in either browser.

## Red runs

Each break was built and run with `npx playwright test --project=chromium e2e/cascade-layers.spec.ts`, then restored;
`git status` showed only the intended changes afterwards.

| Break                                                                                                           | Result                                                                                                                                                                                                                                  | Evidence                                             |
| --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| The three CSS files as on `bd5ed912`                                                                            | 12 failed: a failed upload, automation and the model selector in all four views, naming the rows above                                                                                                                                  | `red-before-fixes.log`, `red-before-fixes-moves.txt` |
| One base-layer rule per screen, each more specific than a component rule, added to `src/styles.css`, wide light | 6 of 7 failed, each naming its rule: the Talk meter's opacity while speaking and the ended error's color, the failed chip's border, Pin's color, the folded task note's display, the open run card's chevron, the favorite star's color | `red-synthetic.log`                                  |
| The same, for the avatar editor's pressed preview state, after the pointer move                                 | Failed, naming its `background-color` at rest, focused and pressed. Before the move it passed, because the pointer still hovered the button and the pressed hover rule won in both cascades                                             | `red-synthetic-avatar.log`                           |

## Checks

All on `8bb7e0e6` unless noted.

| Check                               | Command                                                                                                                            | Result                                                                                                                                                                                                                                                                                                               | Evidence                   |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| Cascade layer spec, Chromium        | `E2E_PORT=24110 npx playwright test --project=chromium e2e/cascade-layers.spec.ts`                                                 | Runtime-exercised: 73 passed in 3.5 minutes. The 44 existing screen tests took 69.3 s and the 28 new ones 136.5 s, against 132.9 s for the 44 before this change. A later run under a load average of 40 took 4.2 minutes.                                                                                           | this entry                 |
| Cascade layer spec, WebKit          | the Playwright 1.65.0 container, `--project=webkit e2e/cascade-layers.spec.ts`, on the tree before the pointer move                | Runtime-exercised: 73 passed in 3.0 minutes; the 44 existing screen tests took 70.0 s and the 28 new ones 104.1 s                                                                                                                                                                                                    | this entry                 |
| Every check, Chromium browser suite | `~/.agents/tools/linux-heavy-lock.sh .agents/tools/check-all --keep-going`                                                         | Compiled, lint and Ruff passed. Unit-passed: 229 files, 4,192 tests. Built. Runtime-exercised: 172 of 172 Chromium tests passed, the 73 cascade layer tests among them. The WebKit half failed all 172 with "Host system is missing dependencies", as expected on this host. The run waited 63 minutes for the lock. | `check-all.log`, `e2e.log` |
| Browser suite, WebKit               | `~/.agents/tools/linux-heavy-lock.sh podman run … mcr.microsoft.com/playwright:v1.65.0-noble npx playwright test --project=webkit` | Runtime-exercised: 168 passed, 3 skipped as before, 1 failed in 5.9 minutes. The failure is `e2e/smoke.spec.ts:811`, which fails in WebKit on main too. The 44 existing cascade screen tests took 59.0 s and the 28 new ones 88.5 s. `e2e/server.ts` and `e2e/fixtures.ts` serve every spec, so the whole suite ran. | `webkit-full.log`          |

## Not checked

- A main assistant with check-ins on in assistant details, for the reason above.
- Talk over a real WebRTC connection and microphone; the test speaks for the voice service.
- A routine Hermes reports running in the routine list, with its Stop run button. The running run card in the chat is
  read.
- The chat model popover's save error, which needs Hermes to refuse an assistant save.
- Increased contrast and forced colors.
