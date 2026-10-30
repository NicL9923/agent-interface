# Connection, sign-in and Hermes update recovery: whole-area review, round 1

Reviewer: Claude Opus 5.5, Anthropic, with high effort requested. OpenAI Sol
implemented the UI. Round 1 of at most 3. The score covers the whole area,
not single frames. Reviewed at HEAD `ead6404` on `nic/full-app-design-review`.

## Score: 7.0 / 10, not yet passing (bar 9)

The calm parts are good. Sign-in and setup are warm, centered, and readable at
both widths. The update dialog explains Find, Test, and Install clearly. Under
the hood, the request-identity work is careful. Install and control requests
carry `requestId`s, outcomes are marked uncertain after a 5xx or a dropped
request, and native pins the operation a confirmation applies to.

The score is held down by the moments that matter most: recovery. On a failed
update, the largest control is a disabled button, and the action the copy
recommends is a secondary button in the middle of the row. After Restart, the
button says "Installing…". During a Hermes outage, Approve stays live and is
the strongest call to action on screen.

Web coordinates are CSS pixels. Native coordinates are full-resolution pixels
in the 1206×2622 frames. **[px]** means seen in pixels. **[src]** means found
in source only.

## Issues, most important first

### P1

1. **Failed update: the disabled button outranks the recovery actions.** [px] [src]
   - `update-failed-1440.png`: a disabled "Check for an update" spans x 516-924, y 481-527, styled as the full-width primary. Below it sits a hint that does not apply to a failed install ("A check finds the newest Hermes… until you choose Install", y 543-568).
   - The description says "Restart Hermes to check and restore the connection." "Restart Hermes" (x 701-842, y 680-724) has the same weight as "Check and try again" and "Cancel update", and it is not first in the row.
   - `update-failed-390.png`: same problem; the disabled bar sits at y 492-538.
   - `native-Updates.png`: the disabled "Check for an update" row takes y ≈1945-2100. Only "Check and try again" is visible at y ≈2485. "Restart Hermes" is below the fold, so the action the copy names cannot be seen without scrolling.
   - Source: `src/components/HermesUpgradePanel.tsx:155-165` always renders the action block before recovery, and `:179-183` renders the recovery actions as three equal `Button`s. Native has the same order: `ios/AgentInterface/HermesUpgradeView.swift:19-21`, `:115-160`.
   - *Fix:* When `recovery && !active`, hide the check button and its hint, or move them below recovery. Show recovery right under the versions and style one action as primary. Prefer a server-provided recommended action. Otherwise use Restart when `canRestartService` is true. Keep "Cancel update" visibly secondary. Native already gives it `.destructive`; web does not (`:182`).

2. **After Restart, the button says "Installing…".** [px] [src]
   - `update-recovering-1440.png`: the title says "Restoring the connection" (x 516-795, y 340-365), but the button at x 516-924, y 631-677 says "Installing…". `update-recovering-390.png` shows the same at y 550-596.
   - The user chose to restart, not to install. Here, the wrong verb makes the user wonder whether they started an install by mistake.
   - Source: `HermesUpgradePanel.tsx:121` (`active ? operation === "install" ? "Installing…"`). `recovering` counts as an install phase (`:15`). Native mirrors this in `ios/AgentInterface/Models.swift:741`.
   - *Fix:* Label the button from the phase: `recovering` → "Restoring…", `verifying` → "Checking Hermes…". Or drop the button while recovery runs and keep only the hint "You can close this…".

3. **During a Hermes outage, Approve is live and is the loudest thing on screen.** [px] [src]
   - `connection-lost-1440.png`: filled "Approve" at x 554-647, y 527-571 and filled "Review" at x 1183-1255, y 665-697. The outlined "Reconnect now" at x 527-635, y 774-805 sits below both.
   - `connection-lost-390.png`: Approve at x 40-134, y 358-402. The dock and composer fill y 478-830, about 42% of the viewport.
   - Source: `src/app/Conversation.tsx:270-271` passes only `capabilities.approvals.supported`. `ApprovalCard` disables only on `!supported || decision` (`:509`). It resets `decision` to null on any error (`:503`), so a timed-out POST that may have reached Hermes invites a second, possibly opposite, click. `src/app/StatusDock.tsx:9` ranks decisions above the connection notice.
   - This crosses into the approvals area, which already passed. I flag only how it behaves while disconnected.
   - *Fix:* Pass `connectionLost` to `ApprovalCard` and disable both buttons, with the note "Decisions send when Hermes reconnects." Treat network or 5xx failures as uncertain: keep the card locked and refresh, the same pattern the update panel uses. While disconnected, put the connection notice above decisions, or render Review as an outline button.

### P2

4. **Web confirmation drops keyboard focus.** [src]
   - Clicking "Restart Hermes" calls `setConfirmation`, which unmounts the clicked button (`HermesUpgradePanel.tsx:179-183`). The new `role="group"` (`:170`) gets no focus and no announcement. "Keep current state" and "Yes, restart Hermes" unmount the same way (`:174-177`).
   - Screen-reader and keyboard users end up on `<body>` inside the modal.
   - *Fix:* Focus the confirmation prompt (`tabIndex={-1}`) when it opens. Return focus to the trigger on cancel, and to `#hermes-upgrade-title` after confirming.

5. **Web confirmation does not pin the operation, as native does.** [src]
   - Native records `recoveryOperation` when the confirmation opens and confirms against it (`HermesUpgradeView.swift:9-11`, `:206-210`).
   - Web reads `status.operationId` at the moment of confirming (`HermesUpgradePanel.tsx:103-108`), while polling refreshes `status` every 3 s (`:71`). The server checks only against the current operation (`src/server/upgrades.ts:263`).
   - So a newer operation started from another device while the prompt is open would be restarted or cancelled under copy written for the old one. The window is narrow but real for a household with two admins.
   - *Fix:* Store `{ action, operationId }` in `confirmation`. Send the pinned id, and close the prompt with a notice if `status.operationId` changes.

6. **Confirmation buttons have weak hierarchy and wording.** [px] [src]
   - `update-restart-confirm-1440.png`: "Yes, restart Hermes" (x 528-697, y 739-783) and "Keep current state" (x 707-870) look the same.
   - "Keep current state" is an odd choice when the current state is broken.
   - `update-restart-confirm-390.png`: only "Yes, restart Hermes" is visible (y 773-817), and the way back is below the fold.
   - *Fix:* Make the affirmative button primary. Use "Not now" or "Go back". Stack the two buttons full width under 620px. Native uses `.cancel` "Keep current state" (`HermesUpgradeView.swift:53`) and should match the new wording.

7. **The stepper and test details contradict each other.** [px] [src]
   - `update-failed-1440.png`: the stepper shows "Test in a copy" done (x 683-757, y 290-336). "Test details 0 of 1 passed" (x 516-670, y 839) lists "Restart and verify Hermes", which is an install-stage check.
   - The same mismatch appears in `update-recovering-1440.png` at y 754.
   - Source: `HermesUpgradePanel.tsx:185-186` labels every check "Test details".
   - *Fix:* Rename the summary to "Check details", or count checks per stage. The fixture data shapes this, but the label is in code.

8. **One outage, four names.** [px] [src]
   - `connection-lost-1440.png` shows: "Reconnecting" in the sidebar (x 95-183, y 40, `src/app/Sidebar.tsx:83`); "Connection lost" on the tiles (x 92-150, y 204-218, `src/components/Avatar.tsx:64`); "Ranch hand is reconnecting…" in the transcript (x 595-769, y 277, `Conversation.tsx:67`); and "Hermes is temporarily unavailable" in the dock (x 527-735, y 732, `ConnectionPanel.tsx:14`).
   - *Fix:* Pick one status word for the `unreachable` code, such as "Reconnecting", and keep "temporarily unavailable" only in the panel's explanation.

9. **Native: the failed-update icon is brand green.** [px] [src]
   - `native-Updates.png`: the "!" circle at x ≈95-170, y ≈570-640 is green, while the stepper's failed "Install" is red (y ≈1170-1200).
   - Source: the `Label` at `HermesUpgradeView.swift:62` inherits the tint, while the steps use `Color.red` (`:108`).
   - *Fix:* Give `failed` and `blocked` the danger color, as web does with `.needs-attention` (`hermes-upgrade.css:20`).

10. **Native: sign-in recovery links have small tap targets next to an account-bound action.** [px] [src]
    - `native-Connection.png`: "Retry connection" (x ≈288-596) and "Change server" (x ≈652-916) are footnote text at y ≈1990-2030, about 13-17 pt tall and 18 pt apart.
    - "Change server" signs the device out (`HomeStates.swift:127-128`). It confirms only when the server does not confirm sign-out (`:130-137`).
    - Source: `ios/AgentInterface/RootView.swift:325-333`.
    - *Fix:* Give each button a hit area of at least 44 pt (`.frame(minHeight: 44)` with `.contentShape`). Consider confirming "Change server" whenever the user is signed in, since a mis-tap there costs a sign-in.

### P3

11. **Setup screen wording.** [px] [src]
    - "Check setup again" is the filled primary (`signin-setup-1440.png` x 465-975, y 783-831), but the page already polls every 8 s (`SignIn.tsx:34`).
    - "After saving, restart the app. This page will pick up the new settings automatically" reads as a contradiction.
    - At 390, the heading leaves "app" alone on the last line (x 45-110, y 430).
    - *Fix:* Say "This page checks again automatically." Make the button secondary ("Check now"). Add `text-wrap: balance` to `.sign-in-setup h2`.

12. **The dialog jumps between states.** [px] At 1440, the dialog top moves from y 24 (failed) to y 175 (recovering), so the close button jumps about 150 px. *Fix:* Anchor the dialog at a fixed top offset on desktop, or set a min-height.

13. **The recovering description borrows cancellation language.** [px] "Waiting for a safe stopping point, then checking the connection" (`update-recovering-1440.png` y 389) comes from the fixture's `status.message`. The real server says "…reach a safe boundary" (`src/server/upgrades.ts:225`). For a restart the user requested, "Restarting Hermes and checking the connection" is plainer. I cannot tell from here how close the fixture text is to production text.

## Strengths

- Sign-in at 1440 and 390 has a single clear path: who is waiting, then one way in. The local-account note is explicit, so test mode can't be mistaken for production.
- The setup card puts the copyable command, its purpose, and the next step in one place.
- The compact connection panel tells users their draft is kept and that messages won't be resent automatically. That is the right reassurance for an uncertain write.
- Update safety: `requestId` on install and control requests, an `uncertain` lock after ambiguous failures (`HermesUpgradePanel.tsx:81-93`), and polling that keeps running after the dialog closes. Native pins operations at confirmation and gives Cancel `.destructive`.
- The stepper's sr-only state text (`:145`) and the role="status" description give screen readers progress without relying on color alone.

## Coverage and gaps

- Pixels: the 12 web frames and 2 native frames listed in the brief. I read each one at full size. I did not use the contact sheet.
- Web frames come from the agent's fixture runs in desktop and phone Chromium. They include cancelling Restart, confirming it, and the recovery state. I did not drive any interaction myself.
- Native: direct Debug captures of existing-server sign-in and a failed update. The update form is cut off below "Check and try again". I have not seen native "Restart Hermes", "Cancel update", the system confirmation sheet, address entry, SSO, or a real update.
- No real provider, Hermes upgrade, installation, or production server was involved. I make no claims about VoiceOver, dark mode, or large text. Native XCTest did not run because of the existing service mismatch.
- In the update frames, the sidebar shows Ranch hand "Working" and Garden planner "Thinking", although the dialog says Hermes could not restart. I can't tell whether the fixture is missing connection loss or the app is missing it, so I have not scored it.
- Issues 4 and 5 are source-only and unverified at runtime.

## Suggested round-2 priorities

1. Rebuild the failed and recovering hierarchy on both platforms (issues 1, 2, 6, and 9). Recapture `update-failed`, `update-restart-confirm`, and `update-recovering` at 390 and 1440, plus a native frame scrolled to the recovery section.
2. Lock decisions while disconnected and reorder the dock (issue 3). Recapture `connection-lost` at both widths.
3. Fix focus in the web confirmation and pin its operation (issues 4 and 5), with a unit test for each.
4. Unify the outage vocabulary and native tap targets (issues 8 and 10). The P3 wording fixes can go in with these.
