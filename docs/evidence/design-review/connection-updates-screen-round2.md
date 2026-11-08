# Connection, sign-in and Hermes update recovery: round 2

Reviewer: Claude Opus 5.5, Anthropic, with high effort requested. OpenAI Sol
implemented the changes. Round 2 of at most 3. Scope is the diff
`ead6404..8e5ff07` on `nic/full-app-design-review` plus its direct callers and
callees. Round 1 findings are in `connection-updates-screen-review.md`.

## Score: 8.6 / 10, not yet passing (bar 9)

Every round-1 P1 is fixed in pixels. A failed update now leads with a filled
"Restart Hermes", the disabled Check is gone, and native shows all three
recovery actions above the fold. After Restart, the button says "Restoring…".
During an outage, Approve and Decline are disabled, the card says why, and the
connection notice sits above the decisions row. The unclear-decision logic is
sound. A dropped request maps to 503 or 504 (`src/client-api.ts:106-109`), so
the opposite choice stays locked, and nothing resends without a click.

The score stays under 9 for three reasons. The web confirmation still goes stale
when the phase changes under the same operation. The phone layout of the
most important frame has two visible flaws. And the native 44 pt fix
truncated the sign-in dev note.

Web coordinates are CSS pixels. Native coordinates are full-resolution pixels in
the 1206×2622 frames. **[px]** means seen in pixels. **[src]** means found in
source only.

## Round-1 status

| # | Round-1 issue | Status |
| --- | --- | --- |
| 1 | Disabled Check outranks recovery | Fixed [px] on web 1440, web 390 and native |
| 2 | "Installing…" after Restart | Fixed [px], now "Restoring…" |
| 3 | Approve live during an outage | Fixed [px] [src]: disabled, "Reconnect to Hermes to answer.", dock reordered, Review outlined |
| 4 | Confirmation drops focus | Fixed [src]; prompt focus ring visible [px] |
| 5 | Confirmation not pinned to an operation | Fixed for an operation change [src]. A gap remains, see new issue 1 |
| 6 | Weak confirmation hierarchy | Fixed [px]: primary Yes, stacked "Not now", both visible at 390 |
| 7 | "Test details" label | Fixed [px], now "Check details" |
| 8 | Four names for one outage | Fixed [px]: "Reconnecting" in sidebar, tiles, transcript and dock |
| 9 | Native failed icon in brand green | Fixed [px], red at about x 95-170, y 570-640 |
| 10 | Native recovery tap targets | Fixed [src] with 44 pt frames, and Change server always confirms. Caused new issue 2 |
| 11 | Setup wording | Fixed [px]: "Check now" secondary, heading balanced at 390 |
| 12 | Dialog jumps between states | Fixed [px]: top at y 24 in failed, confirm and recovering, at both widths |
| 13 | Recovering text borrows cancel wording | Open, unchanged. The text comes from the fixture's `status.message` and is not scored |

## New issues, most important first

### P2

1. **Web: an open confirmation outlives a phase change on the same operation.** [src]
   - The prompt closes only when `operationId` changes (`src/components/HermesUpgradePanel.tsx:92`). A restart or cancel from another device keeps the same id. `restart_service` launches against `input.operationId` (`src/server/upgrades.ts:249-270`).
   - While that worker runs, the server sets `canRestartService` to false (`src/server/upgrades.ts:235`, `!held`). Two things can then happen:
     - If `canCancel` stays true, the section changes to "Need to stop this update?" but keeps "Restart the Hermes service…?" open. Clicking "Yes, restart Hermes" does nothing, because `control` returns at `if (!permitted) return;` (`:130`) with no message.
     - If no recovery action is left, `recovery` (`:153`) unmounts the section. Focus falls to `<body>`, but `confirmation` stays set. When the phase goes back to failed, the old "Yes, restart Hermes" prompt reappears on its own, even though nobody just asked for it.
   - Nothing unsafe gets sent; the server checks permissions again. This is the two-admin case round 1 aimed at, though. It ends in a dead button or a prompt that comes back by itself.
   - *Fix:* Also close the confirmation, with the same notice, when the pinned action is no longer permitted or `status.phase` changes. Pin `{ action, operationId, phase }`. Add a test that flips `canRestartService` with the prompt open.

### P3

2. **Native: the dev-server note now truncates. This is a regression.** [px]
   - `native-Connection.png`: "This development server also offers local test accounts i…" is one line at y ≈1772, x 93-1110. In round 1 (`connection-screen-r1/native-Connection.png`), the same note wrapped to two lines. Before/after crops: `connection-screen-r2-review/native-connection-footer-r1.png` and `-r2.png`.
   - The only change to this view is the 44 pt frame on the recovery buttons (`ios/AgentInterface/RootView.swift:329-330`). So the extra height is the likely cause. I can't prove that from source.
   - Only servers with local dev accounts show this note, so production households won't see it.
   - *Fix:* Add `.fixedSize(horizontal: false, vertical: true)` to the note at `RootView.swift:318-319`, as the hero text already has.

3. **Web 390: the recovery buttons have different heights.** [px] [src]
   - `update-failed-390.png`: "Check and try again" wraps to two lines and is tall (x 42-190, y 425-490). "Cancel update" is short and centered beside it (x 200-348, y 436-479). This is the first thing a person sees after a failed update on a phone.
   - Source: the new grid at `src/components/hermes-upgrade.css:56` inherits `align-items: center` from the global `.actions` (`src/styles.css:666-668`).
   - *Fix:* Add `align-items: stretch` to `.upgrade-recovery .actions`. If the wrap looks heavy, use "Try again" since the section already explains the check.

4. **Web: two rules sit 23 px apart when recovery replaces the action block.** [px] [src]
   - `update-failed-1440.png`: rules at y 651 and y 674, from x 516 to x 924. `update-restart-confirm-1440.png` shows the same at y 721 and 744. Crop: `connection-screen-r2-review/failed-1440-double-rule.png`.
   - Source: the bottom border on `.upgrade-versions`, plus its 22 px margin (`hermes-upgrade.css:26`), sits right above the `.upgrade-checks` top border (`:36`). The action block used to separate them (`HermesUpgradePanel.tsx:202`).
   - *Fix:* Drop one of the two borders when nothing sits between the versions and Check details.

5. **Native: the separator under "Restart Hermes" is inset.** [px]
   - `native-Updates.png`: the row separator runs from x ≈430 to 1110 at y ≈1340. It follows the leading edge of the centered label, not the row. Crop: `connection-screen-r2-review/native-recovery-divider.png`.
   - Source: `ios/AgentInterface/HermesUpgradeView.swift:162-166`.
   - *Fix:* Hide the separator on that row, or set `.alignmentGuide(.listRowSeparatorLeading) { _ in 0 }`.

6. **Web: the confirmation box is cramped at the bottom.** [px] [src]
   - `update-restart-confirm-1440.png`: about 14 px of padding above the question and about 30 px below "Not now" (y 511-542). The focus ring ends at y 546, 7 px above the step dots at y 553. At 390, the ring ends at y 561 and the dots start at y 568.
   - Source: `.upgrade-confirmation .actions` keeps the global `.actions` margin of `18px 0` (`styles.css:671`, `hermes-upgrade.css:58`).
   - *Fix:* Set `margin-bottom: 0` on the confirmation's `.actions`. Add about 8 px of space above the stepper when the prompt is open.

7. **Web: the "changed on another device" notice never goes away.** [src]
   - `notice` is cleared only in `confirm()` (`HermesUpgradePanel.tsx:100`). The panel stays mounted for the whole session (`src/App.tsx:295`, keyed by user). So the notice shows again on every later open, even after that update has finished.
   - *Fix:* Clear `notice` when the dialog closes or when `status.phase` changes.

8. **Approval: the copy after a 409 points the wrong way.** [src]
   - A 409 on a resend means the request is no longer pending. Either the server recorded a decision or the request expired (`src/server/conversation-routes.ts:31-37`). Most often, the first attempt went through.
   - The card says "Hermes could not accept this resend. Refresh the conversation to check its status." (`src/app/Conversation.tsx:544`) and labels the button "Decision unavailable" (`:536`). That reads as a failure. A manual refresh won't unlock the card either, since the lock lives in sessionStorage. The app already refreshes on its own.
   - Also, a first-attempt 409 clears the attempt and turns both buttons back on (`:516`) without asking for a refresh, so the card stays answerable until the next poll.
   - *Fix:* Use "This request is no longer waiting for a decision. It will close when the conversation updates." Show a status instead of a button label. Dispatch the reconnect event in the first-attempt 409 branch too.

## Strengths

- The failed-update frames now say one thing: the description recommends Restart, and Restart is the only filled control. Cancel is red text in an outline button, so it stays secondary.
- At 390, both confirmation choices fit above the fold, stacked full width at 44 px or more.
- The outage frames are consistent. "Reconnecting" is used everywhere, decisions are disabled with a local reason, the connection notice comes first, and Review is outlined at both widths.
- The approval attempt is keyed by user, bot and approval, and saved before the POST (`Conversation.tsx:509-511`). Leaving the chat mid-request can never offer the opposite choice. An unclear resend only offers the same decision again.
- Native Change server now always confirms, and "Stay here" is the cancel.

## Coverage and gaps

- Pixels: all 12 web frames and both native frames, read at full size. I used crops for measurements. I did not use the contact sheets.
- `capture-failure.png` is byte-identical to `connection-lost-1440.png` (same MD5). Per the brief, I ignored the failure file. `connection-lost-1440.png` does show the approval card, disabled, so I scored it.
- Web interaction (focus, stale-operation close, disconnected buttons) comes from the implementer's reported tests and fixture runs. I did not run anything.
- Native: direct Debug captures only. Gestures, the system confirmation sheets, the new Change server dialog, SSO, address entry, VoiceOver, dark mode and large text were not exercised. Tap target sizes come from source only.
- No real update, provider install or production server was involved.
- The question-form outage disable is out of scope here; it's tracked in issue 206.
- In the update frames, the sidebar still shows "Working" and "Thinking" behind a failed restart. That comes from the fixture and is not scored, as in round 1.

## To reach 9

Fix issue 1 and add its test. Fix issues 2 through 6, which are small CSS and
SwiftUI edits, and recapture `update-failed-390`, `update-restart-confirm-1440`,
`native-Updates` and `native-Connection`. Issues 7 and 8 are short copy and
state changes.

## Disclosure

- Model: Claude Opus 5.5 (`claude-opus-5-5`), Anthropic. High effort was requested; this session ran with a lower reasoning-effort setting.
- Commands run: `git diff`, `git rev-parse`, `grep`, `sed`, `md5`, and `sips` for crops. All read-only, apart from the crop files.
- Files written: this report and five crops in `/Volumes/DevSSD/scratch/wildbots-design-review/connection-screen-r2-review/`. I created an empty `/Volumes/DevSSD/scratch/R/` by mistake and removed it right away.
- No source edits, tests, builds, browser or simulator sessions, subagents, commits or messages.
