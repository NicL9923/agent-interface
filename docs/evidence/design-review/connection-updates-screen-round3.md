# Connection, sign-in and Hermes update recovery: round 3, final

Reviewer: Claude Opus 5.5 (`claude-opus-5-5`), Anthropic. OpenAI Sol
implemented the changes. Round 3 of 3; there is no fourth round. Scope is the
diff `8e5ff07..f6de380` on `nic/full-app-design-review` plus its direct callers
and callees. Earlier findings are in `connection-updates-screen-review.md`
(7.0) and `connection-updates-screen-round2.md` (8.6). Settled findings from
those rounds are reused, not reviewed again.

## Score: 9.0 / 10, passes (bar 9)

All eight round-2 findings are fixed. The six with a visible part are fixed in
pixels. The failed-update screen now reads cleanly on both widths and on
native: one filled Restart, two equal secondary choices, a single divider, and
a balanced confirmation box. The stale-confirmation gap is closed in source and
covered by tests that change the phase and the permission separately.

One new P2 keeps this from scoring higher. The round-3 approval change treats
every 409 as "no longer available." The server also returns 409 while Hermes
installs an update. Fix it in this PR; it's about a one-line change.

Web coordinates are CSS pixels. Native coordinates are full-resolution pixels
in the 1206×2622 frames. **[px]** means seen in pixels. **[src]** means found in
source only.

## Round-2 status

| # | Round-2 issue | Status |
| --- | --- | --- |
| 1 | Confirmation outlives a same-operation phase change | Fixed [src]. Pins `{ action, operationId, phase }` and closes on phase change or lost permission (`src/components/HermesUpgradePanel.tsx:95-102`). `control()` fences the phase too (`:132`). Tests at `tests/hermes-upgrade-ui.test.ts:238-254` cover phase and permission, focus, no POST, and no prompt coming back |
| 2 | Native dev note truncated | Fixed [px]. `native-Connection.png`: two centered lines at y ≈1745 and ≈1798 (`RootView.swift:319`). Crop: `connection-screen-r3-review/native-devnote-r3.png` |
| 3 | Web 390 recovery buttons of unequal height | Fixed [px]. `update-failed-390.png`: "Check and try again" x 42-190 and "Cancel update" x 200-348 both span y 425-490 (`hermes-upgrade.css:56`) |
| 4 | Double rule above Check details | Fixed [px]. `update-failed-1440.png`: one rule at y 651, then Check details at y 698. 390 matches at y 688 (`hermes-upgrade.css:60`) |
| 5 | Native separator under Restart is inset | Fixed [px]. No line under Restart (y ≈1160-1296). The Check/Cancel separator at y ≈1496 runs x 96-1110. Crop: `connection-screen-r3-review/native-recovery-r3.png` |
| 6 | Confirmation box cramped at the bottom | Fixed [px]. `update-restart-confirm-1440.png`: about 11 px above the question and 11 px below "Not now". The ring ends at y 528, and the step dots start at y 543. At 390, the ring ends at y 543 and the dots start at y 557 |
| 7 | Changed-on-another-device notice never clears | Fixed [src]. Scoped to the phase and cleared on close (`HermesUpgradePanel.tsx:95`). Test at `tests/hermes-upgrade-ui.test.ts:256-267` |
| 8 | Approval 409 copy points the wrong way | Fixed for resolved requests [src]. Choices are removed, and the copy is neutral (`Conversation.tsx:530, 543`). It creates new issue 1 |

## New issues

### P2

1. **Approval: a 409 during a Hermes update closes the card for the rest of the session, with false copy.** [src]
   - Round 3 sends every first-attempt 409 to the "closed" state (`src/app/Conversation.tsx:516-519`). Closed hides both buttons (`:530`) and is saved in sessionStorage (`src/app/approval-attempt.ts:16-18`).
   - While an update is in maintenance, the server rejects every non-GET `/api/bots/*` route, approvals included, with 409 and `code: "hermes_maintenance"` (`src/server/app.ts:88-94`). `maintenance()` is true while an install is pending (`src/server/upgrades.ts:199`). Hermes stays reachable during that window, so `connectionLost` is false and Approve stays live.
   - Pixels agree. `update-recovering-1440.png` shows a live, filled Approve at x 554-647, y 673-715 behind the recovering dialog. The dialog says "You can close this", so the card is one click away. This frame is a fixture, so I can't say it matches production maintenance timing.
   - Result: a household member who answers while an admin installs an update sees "This request is no longer available to answer." If the request survives the update, this tab can't answer it until the session ends. Before round 3, this path cleared the attempt and showed the server message, so a retry was possible. I can't tell from source whether a Hermes restart drops pending approvals, which would make the copy true after the fact.
   - Nothing unsafe is sent. This is a truth and recoverability problem.
   - *Fix:* Treat `error.code === "hermes_maintenance"` like other correctable 4xx: clear the attempt and report a decision-specific message, for example "Hermes is updating. Answer after the update finishes." The current server text mentions a draft, which doesn't fit here. Add one case to the existing initial-409 test.

### P3

2. **The confirmation question is the quietest text in its box.** [px] [src]
   - `update-restart-confirm-1440.png`: "Restart the Hermes service and check the connection? This may briefly disconnect everyone." sits at x 528-911, y 358-391, in 12 px muted gray. That's smaller than both buttons below it. The consequence, "disconnect everyone", is the part to read before confirming.
   - Source: the confirmation inherits `.upgrade-recovery p` (`hermes-upgrade.css:55`, `0.75rem`, `--muted`).
   - *Fix:* Give `.upgrade-confirmation p` body size and the normal text color.

3. **A closed approval card still says "Your decision needed".** [src]
   - In the closed state, the eyebrow (`Conversation.tsx:528`) still asks for a decision, while the status line below says the request can't be answered. The card goes away on the next refresh, so this is brief.
   - *Fix:* Change the eyebrow for `attempt?.state === "closed"`, or dim the card.

## Strengths

- The failed-update screen is consistent everywhere. The copy recommends Restart, Restart is the only filled control, and Cancel is red outline text. Native shows all three actions above the fold.
- Confirmation safety is now complete for the two-admin case. The prompt is bound to operation, phase and permission. If any of them changes, it retires and moves focus to the title. It never comes back on its own, and a stale "Yes" can't send. The browser fixture covers the same-operation phase change and return (`.agents/tools/capture-connection.js:49-57`).
- The recovering state keeps the dialog top at y 24 on both widths and says "Restoring…", not "Installing…".
- The outage frames are unchanged from round 2 and still consistent. "Reconnecting" is used everywhere. Decisions are disabled with "Reconnect to Hermes to answer." The connection notice sits above the dock, and Review is outlined.
- Sign-in and setup are calm, centered and balanced at both widths. "Check now" is secondary, and the copy says the page checks again on its own.

## Coverage and gaps

These are gaps, not defects:

- Pixels: all 12 web frames and both native frames. I read the web frames at full size. The native frames were downscaled for viewing, so I checked the two changed native regions in full-resolution crops. I did not use `native-contact.png`.
- Web interaction (focus, phase-change retirement, outage buttons, no stale POST) comes from the implementer's reported tests and Chromium fixture runs. I ran nothing.
- Native: compiled Debug captures only. Gestures, system confirmation sheets, Change server, SSO, address entry and a real update were not exercised. XCTest navigation is still blocked by the CoreSimulator/Xcode mismatch.
- VoiceOver, dark mode and large text were not checked on either platform.
- No real provider, update install or production server was involved.
- Not scored, as in earlier rounds: the sidebar showing "Working" and "Thinking" behind a failed update, and the "safe stopping point" recovering text. Both come from the fixture.
- Question-form controls during an outage remain issue 206. They are not claimed as fixed.

## Remaining for the PR

1. Fix new issue 1, the maintenance 409, before merge, with its test case.
2. Optional polish: issues 2 and 3.
3. Keep issue 206 open for question-form outage controls.
4. Carry the coverage gaps above into the PR description as unverified.

## Disclosure

- Model: Claude Opus 5.5 (`claude-opus-5-5`), Anthropic. The client requested High effort. This session exposed only a numeric reasoning-effort value, which I do not map to a named level. I can't confirm from inside the session which level the client applied.
- Commands: `git rev-parse`, `git diff`, `git status`, `grep`, `sed`, `df`, and `sips` for two crops. All read-only apart from the crops.
- Files written: this report, plus `native-recovery-r3.png` and `native-devnote-r3.png` in `/Volumes/DevSSD/scratch/wildbots-design-review/connection-screen-r3-review/`. Originals untouched.
- No source edits, tests, builds, browser or simulator sessions, subagents, commits or messages.
