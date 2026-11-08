# 110. Work W3 event triggers: BEFORE critique and implementation direction

Reviewer: Anthropic Claude Opus 5.5, high effort. I am independent of the OpenAI Terra and Sol implementers of the W3 fixture, harness and capture work.
Scope: W3 only. That covers the trigger list, row actions, delete confirmation, create, edit, feedback and the signing secret, with routines as dependency data. W1 goals, W2a task board and actions, and W2b task editors are accepted at `707140f` and are not re-scored or redesigned here.
Method: saved originals, the labeled collages, the web capture report, offline Pillow crops and contrast samples, and source reading at the worktree, whose product files are byte-identical to `707140f`. I ran no builds, browsers, simulators, devices, services, locks or probes. I edited nothing except this file and `R/110-collages/`.

This is a BEFORE review. It gives no acceptance and no projected AFTER scores.

## Verdict

- **No client is close to 9.** BEFORE means: web 5.3, iPhone 5.6, iPad 5.8. One web frame, `trigger-unsupported`, already scores 9.
- **The baseline is adequate. No recapture is needed.** Every must-fix below is proven by a selected frame, the capture report's recorded geometry, or cited source.
- **One gate, W3. No split.** The secret problems are about placement, rendering and actions inside the existing web panel and native Section. None needs a new sheet or flow. The native delete confirmation moves to the existing `AssistantConfirmationSheet` through the existing Work presenter. That is the W1 precedent, not a structural redesign.
- There are 8 must-fixes. Most of them come from one root cause. Trigger results still go through the generic `change()` path, which locks web Work on any 409 and reports results at the top of Work on both clients. W2a already moved tasks off that path.

## Evidence checked

**Selection.** `R/work-w3-before-final-selection.json` has SHA-256 `405b5bc2…a24a9d`, which matches. It lists 70 selected and 70 unique images: 28 web, 28 iPhone, 14 iPad. I recomputed all 70 SHA-256 values against the selection, and all match. Dimensions match: web 1440×1000, 390×844 and 320×844; iPhone 1206×2622; iPad 1668×2420. The two excluded frames, P1 `trigger-list` (header only) and P2 `trigger-list-expanded` (a duplicate), appear in collages `phone-p1/4.png` and `phone-p2/1.png`. I gave them no score.

**Source bindings, kept as originally captured:**

| Window | Frames | Source |
| --- | --- | --- |
| W0 web | 28 | `765e5e25…` (227 files) |
| P1 iPhone | 13 | `cfc83f0f…` (243) |
| D1 iPad, P2 iPhone | 8, 10 | `44af243f…` (243) |
| P3 iPhone, D2 iPad | 5, 6 | `fa65c9a7…` (243) |

The differences between the native bindings are limited to UITest subject framing and selectors, per reviews 106 to 108. `git diff --stat 707140f -- src ios/AgentInterface` shows only the gated one-line `WorkDesignFixture.swift` change. The fixture hash `5ed79b27…` is recorded in the selection and in the web evidence.

**Web capture report** (`work-triggers-before-r1.json`). Recorded unscrolled positions and `activeElement` values:

| Event | Position | Focus |
| --- | --- | --- |
| Secret panel after create | 508 px above the viewport at 1440, 1,046 px above at 390, 2,763 px above at 200% | `BODY` |
| Uncertain-create alert | 1,674 px above | `BODY` |
| Stale-edit alert | 1,652 px above | `BODY` |
| Toggle notice | 869 px above | `BODY` |
| Delete notice | 796 px above | `BODY` |
| Created notice | 300 px above | `BODY` |
| Edit form | 1,294 px down, 460 px below the fold | still on the Edit button |

Other recorded facts:
- `stale-global-disabled` is 15. A trigger CAS refusal disables 15 Work controls.
- `create-uncertain-refreshed` has 0 disabled targets. Create is live again with the same ID, and that ID now exists.
- `readonly` has 10 disabled trigger buttons.
- `leave-secret`: 0 writes, and no storage entry contains the secret.
- Every trigger button measures 44 px at 1440, 390 and 320. **Plan item D14 is not a defect.**

**Source read:**
- Web: `src/components/AutomationPanel.tsx`, specifically `:22-53` (`change`), `:54-79` (`changeTask`), `:86-102` (Status) and `:385-429` (TriggerSection). Also `src/components/automation.css`.
- Native: `ios/AgentInterface/AutomationTriggerViews.swift` (all of it), `AutomationViews.swift` (`:116-185` `change`, `:187-238` `changeTask`, `:275-333` Status, `:336-417` Work presenter, `:780-860` the accepted task editor) and `AutomationModels.swift:138-170`.
- Also `BotSettingsView.swift:1218` (`AssistantConfirmationSheet`), `tests/automation-ui.test.ts:216-229` and `docs/DesignReview.md`.

**Outputs:**
- `R/110-collages/contrast-samples.txt` (SHA-256 `19298776…`), produced by `contrast.py`.
- `R/110-collages/before-defects.png` (`97396592…`), produced by `make.py`. It has six labeled crops from originals: A iPhone AX3 hyphenated secret and URL, B truncated editor title, C truncated AX3 routine picker, D delete popover contrast, E clipped web secret at 200%, F locked web form.

**Not used for scores.** The later phone `002` and iPad `001` resets happened after their windows' saved frames. I inferred nothing from them.

## Contrast samples (from originals)

| Element | Pair | Ratio |
| --- | --- | --- |
| iPhone "Event triggers" header, light | `#888789` on `#FAF8F2` | **3.37** (matches the W2 follow-up) |
| iPhone section description footnote, light | `#7F7F7F` on `#FFFFFF` | **4.00** (matches) |
| Accepted "Task board" header, same frame | `#697268` on `#FAF8F2` | 4.70 |
| iPhone header and footnote, dark | `#989A9F`/`#1B211E`, `#969697`/`#2C2C2E` | 5.81, 4.72 |
| iPhone placeholder "Trigger ID" | `#C5C5C7` on white | **1.72** |
| iPhone ID-rule caption, "Managed by Hermes", "Signing secret hidden", "No event triggers yet.", "Create a routine…" | `#7F7F7F` on white | **4.00** |
| iPhone "Save this signing secret now" and "Trigger" headers | `#888789` on `#FAF8F2` | **3.37** |
| iPhone delete popover message | `#8F8F8F` on `#FDFDFD` | **3.18** |
| iPhone delete popover "Delete trigger" label on its pill | `#F12E32` on `#DFDFDF` | **3.04** |
| iPhone disabled toolbar "Create disabled" | `#AEACA6` on `#FCFAF5` | 2.18 (disabled, so exempt, but it reads as a state, see M5) |
| Web muted description, light / dark | `#697268`/`#FAF8F2`, `#A6B4A7`/`#1B211E` | 4.70, 7.57 |
| Web URL `code`, 12 px | `#282C27` on `#FAF8F2` | 13.36 |
| Web routines error | `#A33C32` on `#FAF8F2` | 6.08 |

Web text contrast passes everywhere. On native, every trigger-specific header and every `.secondary` caption in light mode fails 4.5:1. The accepted goal and task code already uses `Palette.muted`, which measures 4.70.

## Parent observations, checked

| Observation | Real? | Scope |
| --- | --- | --- |
| Native placeholder and secondary contrast | Yes: 1.72 and 4.00 | Trigger views only, M8 |
| Full shared status block in the editor | Yes. It takes the top of every editor frame | Change the trigger call site only, M5 |
| Web feedback at the top of Work, far from the row | Yes: 300 to 1,674 px away, focus on `BODY` | M2 |
| A 409 locks the whole panel | Yes: 15 controls, including Cancel and goal controls | M2. Trigger call sites only |
| Native status hidden until a row is expanded | Yes, on every collapsed list frame | M4 |
| Missing or paused routine unclear | Yes. Paused is unflagged on both clients. Missing shows a raw ID, and its Enable stays live on web | M4 |
| Secret wraps, clips and has no Copy | Yes. Native inserts hyphens that are not in the value. Web clips to about 14 of 43 characters | M1 |
| AX picker value truncation | Yes, "Freezer…rt check" on iPhone AX3 | M5 |
| Native delete popover copy and red-button contrast | Yes: 3.18 and 3.04 | M7 |
| Duplicate or refreshed create is ambiguous | Yes, on both clients. The row reads "Signing secret Configured" but no secret was ever shown | M3 |

## BEFORE scores

### Web, mean 5.3 (149/28)

| Frame | Score | Blockers to 9 |
| --- | --- | --- |
| `secret-desktop` | 5 | The panel sits at the top of the section. It landed 508 px above the viewport, with focus on `BODY`. The secret is in a single-line password input with no Copy. New is disabled with no reason |
| `secret-phone` | 5 | Revealed, the input shows "SYNTHETICaaaa…" clipped. The URL is clipped too. No Copy. It landed 1,046 px above |
| `secret-dark` | 5 | Same faults while hidden. Contrast passes |
| `secret-large` (200%) | 4 | 14 of 43 characters are visible. It landed 2,763 px above |
| `secret-narrow` (320) | 4 | Even less of the value is visible. Two buttons wrap onto separate rows |
| `created` | 6 | The new row is visible above New. "Saved in Hermes." is 300 px above, out of view, and focus is on `BODY` |
| `create-uncertain` | 3 | Every field, Create and **Cancel** are disabled. Nothing in view says why. The alert is 1,674 px above |
| `create-uncertain-refreshed` | 4 | The `freezer-door` row now exists, but the form below still holds the same draft with Create enabled. A retry gives a duplicate 409, which locks Work again. Nothing says the secret was never received |
| `edit-stale-refused` | 3 | Save and Cancel are disabled with no message in view. The form has no heading naming the trigger. The description is clipped to one line |
| `edit-stale-alert` | 4 | A clear but generic message, 1,650 px from the form. Resume, Replace and Clear goal are disabled by a definite trigger refusal |
| `toggled` | 5 | The row changed, but the notice is 869 px above. The trigger is now enabled on a paused routine, "Weekly house walk", with no flag |
| `delete-confirm` | 7 | Inline, with a clear Keep. "Delete trigger..." uses three dots where accepted goal copy uses "…". The confirmation does not name the trigger. After deletion the notice is 796 px above and focus is on `BODY` |
| `list-desktop` | 6 | Status is plain text merged with the event list. There is no status treatment like the goal's chip. Paused is unflagged. The URL is unlabeled |
| `list-dark` | 6 | Same. Contrast passes |
| `list-phone` | 6 | Same |
| `list-narrow` | 6 | Same. No overflow |
| `list-large` (200%) | 7 | Scales without overflow. Same row hierarchy faults |
| `readonly` | 5 | Two notes, then 10 dead buttons. Native hides them |
| `platform-off` | 5 | Enable is disabled, but its reason is in a note above the rows, out of view. The orphan's raw ID is shown as its routine |
| `unsupported` | 9 | Matches the accepted goal and task capability notes |
| `first-use` | 7 | A disabled New with its reason directly below. "No event triggers yet." is plain body text. The hint is not tied to the button (`aria-describedby`) |
| `routines-error` | 5 | The error has no Retry. Rows show raw IDs such as "routine-freezer" as if they were names |
| `routines-loading` | 4 | No loading state. Raw IDs. Source `:426` also renders "Create a routine … first" during the load |
| `create-desktop` | 6 | No form heading and no initial focus (source). "Create disabled trigger" is an awkward label. The description is single-line. The ID rule only appears in the browser's validation bubble |
| `create-phone` | 6 | Same |
| `create-narrow` | 6 | Same |
| `create-large` (200%) | 6 | Same. The description is clipped |
| `edit-phone` | 4 | The form is at the bottom of the section, 460 px below the fold, with focus left on Edit. Nothing names the trigger being edited. The description is clipped |

### iPhone, mean 5.6 (157/28)

| Frame | Score | Blockers to 9 |
| --- | --- | --- |
| `create-empty` | 5 | Placeholders are the only labels, at 1.72. The "Trigger" header is 3.37 and captions are 4.00. The idle status block takes the top of the sheet. The title truncates to "New event…". The disabled confirm reads literally "Create disabled" |
| `create-filled` | 5 | Filled fields have no labels. The title is truncated. There is no keyboard Hide control, unlike the task editor |
| `create-dark` | 5 | Same layout faults. Dark contrast passes |
| `create-large-text-top` | 5 | The ID rule caption fills the viewport. Fields are unlabeled. The status block costs a screen |
| `create-large-text-bottom` | 5 | The routine picker truncates to "Freezer…rt check" |
| `secret-landing` | 6 | Lands in view, which is good. The header is 3.37 and "Signing secret hidden" is 4.00. No Copy. "I've saved it" clears at once, even before the secret was shown |
| `secret-hidden` | 6 | Same |
| `secret-revealed` | 5 | The line wraps as "SYNTHETI-" plus "Caaa…". **A hyphen that is not in the secret is rendered.** No Copy |
| `secret-dark` | 5 | Same hyphen |
| `secret-large-text` | 4 | Inserted hyphens in both the URL ("in-valid") and the secret ("SYNTHETI-"). See crop A |
| `created` | 6 | The new row is open with its details. No confirmation in view. "Saved in Hermes." is at the top of Work |
| `create-uncertain` | 5 | The banner is in the editor, which is good. The footnote repeats it, the copy is generic, and it never says the trigger may exist |
| `create-uncertain-refreshed` | 4 | The row says "Signing secret: Configured" for a secret nobody saw. No remedy is given. New is live, so a retry ends in a duplicate 409 |
| `edit` | 5 | Unlabeled fields, a truncated title, the status block, and a disabled ID styled like any other value |
| `edit-stale` | 7 | A clear red warning, Save disabled and fields dimmed. Status block noise |
| `toggled` | 5 | No result near the row. Paused routine unflagged |
| `delete-confirm` | 6 | A system popover with message text at 3.18 and the red label at 3.04. It covers the sheet title. W1 replaced this pattern with a readable sheet |
| `list-expanded` | 6 | Values use `.secondary`. Other rows show titles only |
| `list` (P2) | 5 | Collapsed rows show titles only, with no status or routine. Header 3.37, description 4.00 |
| `list-dark` | 6 | Same structure. Dark contrast passes |
| `list-dark-expanded` | 6 | Same |
| `list-large-text` | 6 | Scales cleanly. Header and status faults remain |
| `list-large-text-actions` | 5 | The URL wraps as "hooks.exam-ple", an inserted hyphen |
| `readonly` | 7 | Notes are clear and actions are hidden. Collapsed rows hide status |
| `platform-off` | 6 | Enable is disabled. The reason is at the top of the section, separated by rows |
| `routines-error` | 7 | The banner and Retry are adjacent, which is good. Expanded rows would show raw IDs (source `:74`) |
| `first-use` | 6 | Header 3.37, footnotes 4.00. The disabled New has its reason below, which is fine |
| `unsupported` | 8 | Matches the accepted sections, but the trigger reason uses `.secondary` and the trigger header is 3.37 |

### iPad, mean 5.8 (81/14)

| Frame | Score | Blockers to 9 |
| --- | --- | --- |
| `list` | 5 | Collapsed rows show titles only. Header contrast |
| `list-expanded` | 6 | As on iPhone |
| `list-dark-expanded` | 6 | As on iPhone |
| `list-large-text` | 6 | As on iPhone |
| `list-large-text-actions` | 6 | The URL breaks at a real hyphen, so no inserted glyph here. Value contrast |
| `readonly` | 7 | As on iPhone |
| `create-filled` | 5 | The title fits on iPad. Fields are unlabeled, captions are 4.00 and the status block is present |
| `create-large-text-top` | 5 | With the on-screen key grid shown, about 530 pt of sheet is left, and the idle status block uses part of it. Unlabeled fields |
| `edit-stale` | 7 | As on iPhone |
| `delete-confirm` | 6 | The popover covers the row values. Same contrast as on iPhone |
| `secret-landing` | 6 | Visible and single-line. No Copy. Immediate clear. Header 3.37 |
| `secret-revealed` | 6 | The full value is on one line. No Copy |
| `secret-large-text` | 4 | Inserted hyphen "SYNTHETI-" |
| `created` | 6 | As on iPhone |

## Must-fixes, ranked

**M1. The signing secret must be readable, copyable and seen once, on both clients** (D5).

Web, at `AutomationPanel.tsx:404,411,417`:
- Render the secret panel where the form was, directly below the new row, instead of at the top of the section. Focus its heading with `tabIndex={-1}` on success. Announce "freezer-door was created. Save its signing secret now."
- Hide "New event trigger" while the panel shows. Do not leave it disabled.
- Replace both read-only inputs with labeled wrapped values: `<code class="automation-secret-value">` with `overflow-wrap:anywhere; hyphens:none`, at 0.875rem or larger.
- While hidden, show "Hidden" and **do not render the secret into the DOM**. This replaces the password input's `value`.
- Add "Copy URL" and "Copy secret" using `navigator.clipboard.writeText`, with a polite "Copied." beside the button. Hide Copy when `navigator.clipboard` is unavailable, for example a non-secure LAN preview.
- Copy: "Hermes shows it once. Configure the sending service with this URL and secret. Leaving Work or reloading the page clears it from this screen." Every claim is source-backed (`:395` is local state).

Native, at `AutomationTriggerViews.swift:52-69`:
- Render the URL and the revealed secret with no glyph that is not in the value, at every size. SwiftUI `Text` currently hyphenates. Suggested approach: one small read-only `UIViewRepresentable` around `UITextView` with `isEditable = false`, `isSelectable = true`, `isScrollEnabled = false`, `textContainer.lineBreakMode = .byCharWrapping`, a paragraph style with `hyphenationFactor = 0`, a monospaced body font and `adjustsFontForContentSizeCategory = true`. Use it for the row URL at `:76` too.
- Keep `privacySensitive()` and the existing accessibility label.
- Add "Copy URL" and "Copy secret". Copy the secret with `UIPasteboard.general.setItems(..., options: [.localOnly: true, .expirationDate: now + 300 s])`, and confirm with "Copied. The clipboard clears it in 5 minutes." Copy is the main path on iPhone, because leaving the app to paste clears the display (`AutomationViews.swift:53-56`).
- Header: `Text("Save this signing secret now").foregroundStyle(Palette.muted)`. The first row is "freezer-door was created and starts disabled." The "hidden" text becomes "Hidden" in `Palette.muted`.
- On appear, post one announcement.

Both clients:
- "I've saved it" stays disabled until the person has used Show or Copy once. A muted line under it says "Copy or show the secret first."
- After clearing, focus or announce the new row's feedback (M2).

**M2. Trigger results stay with the trigger, and definite refusals never lock Work** (D1, D2).

Web:
- Route toggle, delete, create and edit through the existing `control.changeTask` instead of `control.change` (`:407,409,414-416`). Do not edit `changeTask`, `change` or `Status`. Learning and goals keep `change`.
- Keep a `Record<triggerId, feedback>` like TaskSection's. Render it under the row's actions as `.automation-trigger-feedback` with `tabIndex={-1}` and focus it.
- Success copy: "Enabled." / "Disabled." / "Saved in Hermes." Refusal: the server message plus " Status refreshed." 5xx: "Not confirmed. Use Refresh status at the top of Work." The panel alert and the uncertain lock stay for 5xx only. That is the W1 and W2 behavior.
- Deleted rows: show their feedback at the top of the trigger section, as the W2a removed-task pattern does at `:265`. Use "Deleted gate-left-open." and focus it.
- Add one `sr-only` polite region, "Trigger result".
- Cancel is never disabled by a refusal.

Native:
- Add `changeTrigger(...)` beside `changeTask`, copying its 4xx refresh-then-feedback structure (`AutomationViews.swift:187-234`). Publish `triggerFeedback(triggerId, message, isError, action)` and an announcement.
- Move the secret-publishing guard (`:164-168`, with `acceptsSecrets` and `secretGeneration`) into `changeTrigger`, and delete it from `change`. Call this out as the only edit to shared `change`.
- Send delete through it as well, instead of `changeOK`.
- Render feedback inside the expanded row, after its actions. Deletions render at the top of the Event triggers section and scroll there.
- Hold row expansion in `HermesWorkView` as `expandedTriggers: Set<String>`, following the `collapsedTaskStatuses` reasoning at `:394-395`. Expand a row when it receives feedback, and expand a new trigger's row.
- Editor refusals render inside the editor and the editor stays open. This is the task editor precedent at `:783-786`. Success dismisses the editor.

**M3. Recover from an unconfirmed create without a hidden duplicate** (D16).
- At submit, snapshot the visible trigger IDs. IDs are unique, because the adapter returns 409 for a duplicate, so an ID match is stronger evidence than W2b's title match.
- Add one pure helper per client, `likelyCreatedTrigger(knownIds, draftId, items)`. It matches only when the ID was absent before submit and is present after a later refresh.
- **Before Refresh**, show this in the form or editor, focused and announced: "Not confirmed. Hermes may have created this trigger. Use Refresh status at the top of Work before trying again." Native says "above" instead of "at the top of Work".
- **On a match:** lock the fields and replace Create with a primary **Close**. Copy: "freezer-door is now in Hermes. This request probably created it, but this app never received its signing secret. To get a secret, delete freezer-door and create it again." Close focuses the row on web, or expands it on native. Never send a second POST.
- **No match:** "No trigger with this ID is in Hermes. Create trigger sends the same request again." This is safe, because a duplicate now gets a local 409 under M2.
- Native: pass `suppressRefreshFootnote: true` so the banner is not repeated.

**M4. Rows show status, routine availability and the reason for any disabled action** (D6, D8, D9).

Web, at `:406-408`:
- Add a status chip, "Enabled" or "Disabled". Reuse the goal chip tokens through a trigger-scoped class.
- Events line: "Events: freezer.alert, freezer.recovered".
- Routine line:
  - Paused: "Routine: Weekly house walk · Paused"
  - Missing: "Routine: routine-retired · Not found"
  - Loading: "Routine: loading…"
  - Routine load error: "Routine ID: routine-freezer"
- Label the URL "Webhook URL".
- Disabled-Enable reasons, rendered directly under the actions:
  - Platform off: "Can't enable until the installer turns on Hermes's webhook channel."
  - Missing routine: "Its routine is no longer available. Edit the trigger to choose another routine before enabling it." Disable Enable for an orphan. The adapter refuses that enable with 409 (`automation.py:517-520`), and this also removes harness hazard H7.

Native, at `:70-87`:
- Give the collapsed `DisclosureGroup` label a title plus a `.caption` line in `Palette.muted`, for example "Enabled · Freezer alert check", "Disabled · Weekly house walk (paused)" or "Disabled · Routine not found". This mirrors the accepted task-row pattern at `AutomationViews.swift:709-714`. Combine it for accessibility.
- Expanded values use `LabeledContent { Text(...).foregroundStyle(Palette.muted) }`, which is the task detail pattern at `:936`.
- Add the same two reason footnotes and the same orphan rule.

**M5. Editors: labels, titles, focus, busy state and validation** (D3, D10, D11, D12).

Native, at `AutomationTriggerViews.swift:121-169`:
- Titles "New trigger" and "Edit trigger". The confirm label is "Create" or "Save". That fits beside Cancel at the iPhone width. The footnote already says new triggers start disabled.
- Use `HermesAutomationStatus(control:, compact: true, suppressRefreshFootnote: true)` at this call site only.
- Labeled fields in the task-editor `VStack` style at `:832-841`:
  - "Trigger ID" with the prompt "lowercase-id".
  - "Description (optional)" with "What this trigger is for".
  - "Event names" with "issue.created, issue.closed".
  - Prompts in `Palette.muted`.
- In edit, show the ID as `LabeledContent("Trigger ID", value:)`, not as a disabled field.
- Captions use `Palette.muted`.
- Specific inline messages in `Palette.danger` only after the field has content: an invalid ID, more than 20 events, or a bad character. Add pure helpers on `HermesTriggerInput` that return the problem text.
- While busy, the toolbar shows `ProgressView` "Creating" or "Saving".
- Add the task editor's keyboard Hide accessory (`:812-819`).
- At `dynamicTypeSize.isAccessibilitySize`, stack "Routine" above a `labelsHidden()` picker so the full routine name shows.
- In edit mode, drop "New triggers start disabled." and keep "The selected routine must also be enabled to run."

Web, at `:411-425`:
- Heading `<h4 id>`: "New event trigger" or "Edit trigger", with `aria-labelledby`.
- Edit renders **inside the row's article**, replacing its actions, as the W2b in-card edit does. Focus Description. Cancel returns focus to that row's "Edit trigger". Create autofocuses Trigger ID, and Cancel returns focus to "New event trigger".
- Visible hints under the fields: the ID rule and "Separate names with commas. Up to 20." Link them with `aria-describedby`.
- "Description (optional)" becomes a 2-row `<textarea>`.
- Submit labels: "Create trigger" or "Save trigger". While busy: "Creating…" or "Saving…".
- Stale detection: when the live revision differs from `editing.revision`, show the native copy ("This trigger changed. Close this editor and review its current settings before editing again.") and disable Save. If the trigger is gone: "This trigger is no longer in Hermes."

**M6. Web routine loading and errors** (D4), at `:388-390,403,411,426`:
- While `routineList.loading`, show a `role=status` line, "Loading routines…". Keep New disabled. Never show "Create a routine … first" during a load or after an error.
- Add a "Retry routines" button beside the error that calls `routineList.reload()` once. This matches native `:26`.
- Rows follow M4's loading and error routine text.

**M7. Native delete confirmation and copy** (D15):
- Replace `.confirmationDialog` (`AutomationTriggerViews.swift:39-50`) with `AssistantConfirmationSheet` through a new `HermesWorkSheet.deleteTrigger(HermesSubscription)` case.
- Send the request from `onDismiss` with a `pendingDeleteTrigger`, mirroring `pendingClearGoal` at `AutomationViews.swift:396-401,407-410`.
- Copy: title "Delete this event trigger?", message "<name> will be removed. Its routine stays saved.", accept "Delete trigger", keep "Keep trigger". Web's inline confirm uses the same message.
- On both clients the row button reads "Delete trigger…" with a real ellipsis.

**M8. Native contrast and web read-only parity** (D7, D13):
- Native: trigger headers (`Section("Event triggers")` and "Trigger") use `header: { Text(...).foregroundStyle(Palette.muted) }`. Every `.secondary` in `AutomationTriggerViews.swift:16,18,28,34,61,153,157` becomes `Palette.muted`.
- Web: treat `canManageTriggers !== true` as read-only, matching native `== true`. Hide every trigger write action and New, and keep the notes. This removes 10 dead buttons. Server overviews always carry the flag (`src/server/automation.ts:22,30`).

## Gate decision

**One gate, W3, accepted only when all three clients pass.** M1 changes rendering and actions in the existing secret containers. M7 reuses an accepted component and presenter. No reviewed pixel calls for a new secret sheet or flow, so the W3a/W3b split in plan 103 is not triggered. Learning stays blocked until W3 passes on web, iPhone and iPad.

## Privacy and uncertain-secret decisions

These rest on this repository's adapter and client source. They do not depend on production Hermes.

- The client never fetches, stores or re-displays a secret. Listings carry only `secretSet` (`automation.py:466-478`). Keep the web and native no-storage behavior. The web hidden state must not put the value in the DOM.
- Copying is an explicit action. Native uses `.localOnly` and a 5-minute expiration. Web cannot expire the clipboard, so its copy makes no claim about clearing.
- Leaving clears the secret. On native, backgrounding or closing Work clears it (`AutomationViews.swift:53-60`). On web, unmounting clears it. The copy says exactly that and nothing more. Adding a leave warning is not part of W3, because it would change the shared settings wrapper.
- After an uncertain create, the copy states only what the client knows: it did not receive a secret. It must not say whether Hermes generated one. The remedy, delete and create again, uses existing actions.
- "I've saved it" is gated on Show or Copy. That gate is a mistake-proofing step, not a policy claim.

**Unavailable in production (`41dfcf2c`), so no new copy may assert:**
- the webhook URL shape, beyond showing the value returned
- signature algorithm or header names
- `*` wildcard semantics or "All events" meaning
- whether a paused routine blocks a triggered run, or whether `deliver="log"` runs the routine
- how the installer enables the platform, or delivery guarantees

Existing captured claims stay as they are: "Run an existing routine when…", "The selected routine must also be enabled to run" and "Hermes shows it once". M4's "· Paused" is a label that mirrors the picker's existing "(paused)" suffix, not a behavior claim. The event-name hint lists allowed characters from the regex only. The `43` length is a fixture fact. Do not show a character count.

## Shared-code impact and regressions

| Change | Shared code touched | Rerun |
| --- | --- | --- |
| Web call sites move to `changeTask` | None. Only the TriggerSection call sites change | Full `tests/automation-ui.test.ts`, including the W1 uncertain-resume lock and W2 task refusal tests |
| Web CSS | New rules scoped under `.automation-triggers`. The base `.automation-form`, `.automation-item` and `.automation-url` rules are not edited | Image-diff the W1 and W2 web frames only if a base rule changes |
| Native `changeTrigger` and secret move | `change` loses its trigger-secret block | Native `Automation*` unit and flow tests, the 3 standing-goal UI tests, and the existing secret background-clear tests |
| Native `HermesWorkSheet.deleteTrigger` and `pendingDeleteTrigger` | Shared Work presenter | Clear-goal, Replace, task-detail and task-editor presenter UI tests |
| Native `expandedTriggers` | Work view state | Task group collapse tests |
| `HermesAutomationStatus` | Call-site arguments only, no definition change | None extra |

No adapter or server change is needed. Rerun the adapter tests only if `automation.py` changes.

## Focused functional tests

**Web** (`tests/automation-ui.test.ts`):
1. Stale PUT 409: an in-form refusal is focused, Cancel stays enabled, goal and task buttons stay enabled, and there is no `role=alert` at the panel.
2. Toggle 409: row feedback, and Work is not locked.
3. Create 502:
   - The "Not confirmed" message is focused and exactly 1 POST was sent.
   - Refresh with the ID present: Close shows, Create is absent, and Close focuses the row. Still exactly 1 POST.
   - Refresh with the ID absent: the resend body is byte-equal.
4. Secret:
   - The panel replaces the form and its heading has focus.
   - While hidden, the secret string appears nowhere in `container.innerHTML`.
   - Show renders the full value.
   - Copy calls `clipboard.writeText` once with the secret.
   - "I've saved it" is disabled until Show or Copy, then clears.
   - No storage entries (extends `:216-223`).
   - Unmounting clears the secret.
5. Routines:
   - While loading: the status line shows, "Create a routine" is absent and New is disabled.
   - On error, Retry fetches `/routines` exactly once more.
6. Rows: the Paused label, and the missing routine label with Enable disabled and its reason. Platform off: the reason sits beside the disabled Enable. There is no PATCH to the orphan.
7. Edit: the form renders in the row with its heading, Description has focus, and Cancel returns focus to the row's Edit. A stale revision shows the warning and disables Save.
8. Read-only (`canManageTriggers` false and undefined): no write buttons and zero writes (extends `:225-229`).
9. Delete: the section feedback is focused and the row is removed.

**Native:**
1. `AutomationTests` table tests:
   - `hermesLikelyCreatedTrigger`
   - `HermesTriggerInput` problem messages
   - the row subtitle helper: enabled, paused, missing, loading, error
2. `AutomationFlowTests`:
   - A toggle 409 shows row feedback. After the refresh, `needsRefresh` is false and Replace goal is enabled.
   - Create success: the secret section is hittable, and "I've saved it" stays disabled until Show is tapped.
   - Delete sheet: Keep sends nothing. Delete sends exactly 1 DELETE after dismissal.
   - Create 502 with the persisted trigger: after Refresh, the editor shows Close and no second POST is sent.
3. Inject the pasteboard writer so a unit test can assert the `.localOnly` and expiration options without reading the system pasteboard.

## AFTER capture matrix

Reuse `.agents/fixtures/work-triggers.json` unchanged. It already has the paused and missing routines, platform-off, read-only, stale and persist-then-502 modes. No server or fixture change is needed. Copy frames need clipboard permission in the web capture context and nothing extra on native. Frame names keep the BEFORE names so comparisons pair one to one. New frames are marked "new".

**Web: 31 frames.** Widths are 390 unless noted.
- **List (7):** `list-desktop` (1440), `list-dark` (1440), `list-phone`, `list-narrow` (320), `list-large` (200%), `list-orphan` (new: barn-door row with Not found and its disabled-Enable reason), `platform-off`.
- **Availability (5):** `readonly`, `unsupported`, `first-use`, `routines-error` with Retry, `routines-loading`.
- **Forms (6):** `create-desktop`, `create-phone`, `create-phone-actions` (new: hints, submit, Cancel), `create-narrow`, `create-large`, `edit-phone`. `edit-phone` must show the in-row form and focus without scrolling.
- **Secret (7):** `secret-desktop`, `secret-phone` (revealed), `secret-dark` (hidden), `secret-large` (revealed), `secret-narrow` (revealed), `secret-copied` (new), `created`. Record the unscrolled landing for each. The panel must be fully visible and focused with no scroll.
- **Actions (3):** `toggled`, `delete-confirm`, `deleted` (new).
- **Refusals (4):** `edit-stale-refused`, `edit-stale-alert`, `create-uncertain`, `create-uncertain-refreshed`. Anchor `edit-stale-alert` at the top of Work to show goal controls enabled.

**iPhone: 31 frames.**
- The 28 BEFORE names, plus `secret-copied`, `deleted` and `list-orphan-expanded`.
- `list` must show all three rows with their subtitles.
- `delete-confirm` is now the confirmation sheet.

**iPad: 16 frames.**
- The 14 BEFORE names, plus `create-large-text-bottom` (the AX3 routine picker) and `secret-copied`.

**Annotated before and after comparisons (6):**
1. Web secret landing and value: `secret-phone` and `secret-large` before and after, with landing offsets 1,046 px and 2,763 px against 0 px after, and the visible character count.
2. Web refusal locality: `edit-stale-refused` and `edit-stale-alert`. 15 locked controls against 0, with the message beside the form.
3. Web uncertain create: `create-uncertain-refreshed`, a live duplicate Create against Close and the secret explanation.
4. iPhone secret wrapping: `secret-large-text`. The inserted hyphens against a clean character wrap with Copy.
5. iPhone editor: `create-empty`. Placeholder-only fields at 1.72:1 and a truncated title, against labels, muted prompts and the full title, with measured ratios.
6. iPhone list and delete: `list` and `delete-confirm`. Title-only rows and a popover at 3.04/3.18, against subtitles and the readable sheet, with measured ratios.

AFTER contrast: re-sample every BEFORE pair in this review on its matching AFTER frame and record the results next to the BEFORE values.

## Score limits

- These are simulator and Playwright images from synthetic fixtures. Native enlarged text is AX3. Web enlarged text is a 200% root font, not browser zoom.
- Not verified: physical devices, VoiceOver output, hardware keyboards, AX5, iOS 17 and compact iPad widths.
- The iPad AX3 create frame shows the on-screen key grid. I made no claim about keyboard absence.
- No score uses production Hermes `41dfcf2c`, and none rests on the reset artifacts.
