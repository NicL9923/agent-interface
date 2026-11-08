# 93. Work W2b task create and edit: BEFORE scores and direction

Reviewer: Anthropic Claude Opus 5.5, high effort. Independent of the OpenAI W2 capture and harness implementers.
Scope: W2b only, meaning the task create form or sheet, uncertain-create recovery, and edit including the nested native sheet. W1 and W2a stay settled per `docs/evidence/design-review/work-task-acceptance.json` and review 92: web 19 frames at 9 or above, iPhone 23 at 9, iPad 23 at 9, and 14 annotated comparisons. Triggers, Learning and routines are out of scope.
Repository: `t3-d1b42c2a` at `fd573dc`. Method: source reading, saved images and offline Pillow checks. I ran no builds, browsers, simulators, services, probes or locks, and edited no app, tool, fixture or ledger files.

## Verdict

- **No client is near 9.** BEFORE means: web 5.8, iPhone 6.7, iPad 6.6. Every form needs product work. W3 stays blocked.
- **The shared BEFORE baseline is enough. No BEFORE rerun is needed.** Every defect below is proven by an image or by cited source. Missing states are listed under "Baseline adequacy", and none needs a BEFORE image.
- **The editor code that W2a left alone matches the BEFORE source.** `git diff 1efdced fd573dc` leaves the web create form unchanged. The web edit form is only re-indented, wrapped in `!running &&` and moved above Dependencies. `HermesTaskEditor`, `HermesAssigneePicker`, `HermesTaskDraft` and `HermesTaskCreationIntent` are unchanged. The only native picker change is the reviewer in the detail. Score the editor content in each frame and ignore the surrounding pre-W2a card and detail context in `edit-desktop` and `task-edit-saved`.
- There are 8 must-fixes. Together they make about one routine change set per client, with no refactor.

## Evidence checked

- `R/work-w2b-before-selection.json`: 25 originals. All 25 sha256 values and dimensions match. Web is 11 frames at 1440×1000, 390×844 and 320×844, from web source `f6a87a8d…` (226 files). iPhone is 9 frames at 1206×2622 and iPad is 5 frames at 1668×2420, both from native source `58eb2330…` (243 files).
- Collages in `93-collages/`: `web-phone-a.png`, `web-phone-b.png`, `phone-create.png`, `phone-ax3.png`, `phone-edit-uncertain.png`, `pad-a.png`, `pad-b.png`. I read the three web desktop originals at full size. Contrast samples are in `93-collages/contrast-samples.txt`, and the scripts are `make.py` and `contrast.py`.
- Source:
  - `AutomationPanel.tsx:14-81` (`change` and `changeTask`), `:85-101` (Status), `:192-262` (TaskSection and the create form) and `:276-330` (TaskCard and the edit form).
  - `automation.css`, and global `styles.css:140-142`.
  - `AutomationViews.swift:275-335` (Status), `:356-417` (Work presenter), `:728-821` (picker and editor) and `:822-866` (detail and nested sheet).
  - `AutomationModels.swift:80-128`.
  - `src/server/automation.ts:13,36-38`.
  - `src/hermes/automation.py:318-464`.
  - `scripts/spike/automation_probe.py:171-196`.
  - Tests: `tests/automation-ui.test.ts:185-209`, `AutomationFlowTests.swift:181-209`, `AutomationTests.swift:273-290,361`.
  - Fixture transports: `WorkDesignFixture.swift:123-124`, `capture-design.js:131,709`.
- Read for context: review 68, review 92 and the acceptance JSON.

## BEFORE scores

### Web: mean 5.8

| Frame | Score | Concrete blockers to 9 |
| --- | --- | --- |
| `create-desktop` | 6 | Each dependency puts its checkbox on one line and its title on the next, about 83 px per row. The global `label {flex-direction: column}` (`styles.css:140-142`) beats `.automation-check` (`automation.css:17`), which sets no direction. The goal form already fixes this at `:44`. The form has no heading. A 60 px gap sits before the fieldset. Rows give no task status. The help text and Create are below the fold |
| `create-dark` | 6 | Same layout faults. Contrast passes: labels 14.15, checkbox border 4.44 |
| `create-phone-top` | 6 | Same as desktop |
| `create-phone-bottom` | 5 | Seven tasks fill the whole viewport. The list is every board item (`:254`) with no bound, so 100 tasks push "Create task" about 8,000 px down |
| `create-narrow` (320) | 6 | No overflow. Stacked rows, and a long title wraps under a lone checkbox |
| `create-large-text-bottom` (200%) | 7 | The primary Create is large and clear. The help text sits above the anchor and is never shown. There is no 200% top frame |
| `create-uncertain-form` | 4 | Create and Cancel are both disabled and nothing in view says why. The only message is at the top of the panel |
| `create-uncertain-alert` | 6 | Clear, honest copy at 6.08:1. It is generic ("this change") and far from the form, and it never says the task may already exist |
| `create-refreshed` | 5 | The board now lists "Plan the winter supplies". Source shows the form still open below it with the same draft, and its dependency list now offers that task (`:254`, H7). Nothing says the task exists, and any edit to the draft mints a new UUID (`:236`), which means a second task |
| `create-retried` | 7 | It ends with one task and the form closed. "Saved in Hermes." is at the top of the panel, off screen. Focus drops to `body` because the submit button unmounts. The new task is not identified |
| `edit-desktop` | 6 | The form has no heading. "Save task" is not primary (`:307`). Fields stay editable during save because `:304-306` have no `disabled` (H4, source). A 409 goes through `control.change` and locks all of Work, with the error at the top of the panel (`:303`) |

### iPhone: mean 6.7

| Frame | Score | Concrete blockers to 9 |
| --- | --- | --- |
| `task-create-empty` | 6 | The placeholders "Title" and "Instructions" are the only labels, at **1.72:1**. The "Task" and "Wait for these tasks" headers are **3.37:1** on `#FAF8F2`, the same class as the W3 follow-up. "Managed by Hermes" is a **4.00:1** caption. The idle status block takes the top of the sheet. Create is disabled with no reason given |
| `task-create-filled` | 7 | Once filled, Title and Instructions have no label at all. Dependency toggles show no status. Running "Compare snow tire prices" looks the same as the others |
| `task-create-dark` | 7 | Dark contrast passes: headers 5.81, caption 4.72. Filled fields are unlabeled. The dark placeholder is not measurable because both fields are filled |
| `task-create-large-text-top` | 6 | The Instructions placeholder is barely visible. The status block uses about a third of the viewport. The assignee wraps under its label ("Ranch hand ⌃"), so **phone AX3 does not reproduce the truncation lead** |
| `task-create-large-text-bottom` | 8 | Toggles wrap cleanly. No statuses |
| `task-edit` | 6 | Same label and placeholder faults. The empty Instructions is 1.72 |
| `task-edit-saved` | 7 | The nested sheet returns to the detail, and "Saved in Hermes." and "Unassigned" are visible, so C1 is good. It sits in the 4.00 caption block. There is no announcement. The detail context is pre-W2a |
| `task-create-uncertain` | 6 | The banner is near the top and the fields are disabled. Then the generic footnote repeats the refresh instruction (`:303`), which is the H3 class. Nothing says the task may exist |
| `task-create-retried` | 7 | One task appears in Blocked (3). No confirmation is in view. The middle state, the editor after Refresh, is not imaged. Source shows the same H7 hazard as web (`:798`) |

### iPad: mean 6.6

| Frame | Score | Concrete blockers to 9 |
| --- | --- | --- |
| `task-edit` | 6 | Same as phone. The sheet size is fine |
| `task-create-filled` | 7 | Same as phone |
| `task-create-dark` | 7 | Same as phone. The "Wait for these tasks" header is cut at the sheet edge, which is acceptable for a scroll capture |
| `task-create-large-text-top` | 5 | Only Title and Instructions fit. The idle status block uses about a quarter of the sheet, and the placeholder is faint. The assignee is not in any iPad AX3 frame, so the truncation lead is **unproven either way** |
| `task-create-large-text-bottom` | 8 | Clean wrapping |

## Baseline adequacy

No BEFORE recapture is required. The states that are not imaged are each covered another way:

| State | Proof without a BEFORE image |
| --- | --- |
| Web edit fields editable during save (H4) | Source `:304-306`. Plan 68 already ruled it image-free |
| Web form still open after Refresh, with the created task offered as its own dependency (H7) | Source `:248-254`. Test `automation-ui.test.ts:198-209` refreshes and resubmits with the form still mounted |
| Native editor after Refresh | Source `:798` reads `control.value?.tasks.items` live. The fixture persists before it returns 502 (`WorkDesignFixture.swift:123-124`, `capture-design.js:131`) |
| iPad AX3 assignee picker | No defect is claimed. The AFTER `-middle` frame settles it |
| Web help text and actions at 390 and default size | No defect is claimed. AFTER `create-phone-bottom` must show them |

Treat these as "no BEFORE, source-cited" in annotated comparisons. The historical iPad batch disclosure stands as written.

## Proven behavior versus fixture assumptions

| Class | Facts |
| --- | --- |
| **Local adapter source** (`automation.py`) | Create: the title is trimmed to 1–500 characters and must have a UUID. The idempotency key is `wildbots:{profile}:{requestId}`. The task starts blocked. An omitted assignee becomes the profile, and explicit `null` leaves it unassigned (`:422-428`). Assignees and dependencies must be owned and visible or the call returns 404. At most 20 dependencies are allowed (`:403-407`). Update: a running or claimed task returns 409 "A native worker owns this task…" (`:322-323`). `edit_task` and then `assign_task` can each return 409 (`:429-434`), so a **partial write is possible**. **Tasks have no revision or ETag**, so the last write wins. Server bodies are strict, and PATCH requires at least one field (`server/automation.ts:36-38`) |
| **Probe source, not run here** | Repeating a create with the same `requestId` returns the same task id (`automation_probe.py:176-178`). Explicit null unassigns and omission preserves (`:183-185`) |
| **Fixture assumptions** | A lost response is persisted and then answered with 502. Newest-first insertion. No claim races during edit |
| **Unavailable** (production `41dfcf2c`) | Native `create_task` idempotency on that revision, the refusal conditions for `edit_task` and `assign_task`, and the meaning of priority. **Do not add copy that explains priority order.** |

Preserve: the content-keyed request ID (web `editDraft` `:236`, native `HermesTaskCreationIntent`), no auto-resend, the native `current` and account-lifetime guards, the `interactiveDismissDisabled(busy)` and Cancel-while-busy guards, and the running-task refusal copy. Do not invent task revisions.

## Must-fixes, in priority order

**M1. Uncertain create must end without a hidden duplicate, on both clients (B2, H7).**
- At submit, snapshot the board's task IDs. After any later overview refresh while the form or editor is open, look for a task whose ID is not in the snapshot and whose title equals the draft's trimmed title. Put this in one pure helper per client, `likelyCreatedTask(knownIds, title, items)`, and unit-test it.
- **When it matches:** show a callout inside the form, above the actions, and announce it. Suggested copy: "“Plan the winter supplies” is on the board now, so Hermes probably saved it." Disable every field and dependency, and replace Create with a primary **Close** button. On native, the toolbar confirm becomes "Close". Close resets the draft to a fresh UUID. On web it then opens and focuses the found card (M3 mechanics). On native it dismisses to Work with Blocked expanded.
- **When it does not match:** re-enable the form. Add one line by the actions: "This task is not on the board. Create task sends the same request again."
- **Unconfirmed state on web,** before Refresh: add a form-local message by the actions, following W2a's move pattern: "Not confirmed. Hermes may have created this task. Use Refresh status at the top of Work before trying again." Focus it. The panel alert stays as it is (W1 behavior).
- **Native:** stop the generic needs-refresh footnote from repeating the banner in this editor (`:303`). Use an editor-only path so the accepted detail and goal rendering does not change.

**M2. Web edit must lock during save and keep results local (B3, H4).**
- Disable title, instructions, assignee and priority while `control.disabled` (`:304-306`).
- Route PATCH through `changeTask` so a refusal does not lock Work. Add a `source: "edit"` feedback rendered under the Edit and Save area.
- **Refused:** keep the form and draft if the task is still editable. If refresh shows it running, the form leaves under the existing `!running` guard, and the feedback shows in the Move section's running branch.
- **Unconfirmed:** keep the draft with fields disabled until Refresh. PATCH is idempotent, so Save after Refresh is safe.
- **Saved:** close the form, focus the card feedback "Saved in Hermes." and announce it through the existing `Task result` region.

**M3. Web create success must say what happened, where it happened.**
- Close the form, reset the draft, open the created card, expand its group, focus its feedback ("Created. It stays blocked until you start it.") and announce it.
- Find the new ID either by having `changeTask` return the send result (a small extension, with no change for existing callers) or by reusing the M1 matcher.
- Route create refusals (4xx) through `changeTask`-style handling, and render them in the form. Keep the draft.

**M4. Web form hierarchy and dependency list (B1).**
- Add a form heading such as `<h4 id>New task</h4>` with `aria-labelledby`, and "Edit task" for edit.
- Focus Title when the form opens. Return focus to "New task" or "Edit task" on Cancel.
- Label the optional fields: "Instructions (optional)", and a legend "Wait for these tasks (optional)".
- Add the class `primary` to "Save task".
- Make dependency rows a single line, scoped to tasks: `.automation-tasks .automation-check { flex-direction: row; min-height: 44px }`, mirroring `automation.css:44`. Add a muted status suffix, for example "Compare snow tire prices · Running".
- Bound the list with `max-height` and `overflow-y: auto` once there are more than 6 items, so the help text and actions stay reachable.
- Remove the gap before the fieldset.
- Scope every rule under `.automation-tasks`. Do not change the base `.automation-form` rules, because triggers share them.

**M5. Native field labels, placeholders and headers (light).**
- Follow the accepted Start note pattern at `:923-926`, which measured 4.99. Use `VStack { Text("Title"); TextField(…, prompt: Text("What needs doing?").foregroundStyle(Palette.muted)) }` and the same with "Instructions (optional)".
- Give "Task" and "Wait for these tasks" the detail's `header: { Text(…).foregroundStyle(Palette.muted) }` treatment, which measured 4.70.
- Change "Choose up to 20 dependencies." and "No other tasks yet." from `.secondary` to `Palette.muted`.
- Add each task's status as a caption under its toggle title.

**M6. Native editor status chrome.** Use `HermesAutomationStatus(control: control, compact: true)` at `:767`, which is the W2a detail precedent. This removes the idle "Managed by Hermes" caption (4.00:1) and the Refresh block. Both still appear when there is an error, a needs-refresh state or a loss of connection. Change only this call site. The goal and trigger editors keep their accepted rendering.

**M7. The native edit sheet must know the task's current state.**
- Read the live task from `control.value` the same way the detail does (`:837`).
- If the task is running or missing, disable Save and show the detail's own copy: "A Hermes worker is running this task. You can change it after the run finishes." or "This task is no longer available in the current board."
- Route PATCH through `changeTask(taskId:)` so a refusal reconciles without a manual Refresh.
- Show an error `taskFeedback` inside the editor while it is presented, and dismiss on success.
- Give the feedback an edit flag so "Saved in Hermes." renders and scrolls by the summary's "Edit task" button, not under Move task. `publishTaskFeedback` already announces it.

**M8. Busy state is visible on both clients.**
- Web: while busy, the submit button reads "Creating…" or "Saving…".
- Native: while busy, the toolbar confirm becomes a `ProgressView` labeled "Creating" or "Saving".
- On native create success, post one announcement such as "Created Plan the winter supplies in Blocked." and make sure the Blocked group is expanded.

## Nonblocking notes

1. The web priority number input clobbers partial input: "-" becomes 0 through `Number("")`. Holding a string draft would fix it. This is rare.
2. Web does not enforce the 20-dependency limit on the client. The server returns 400. Native disables extra toggles. Add parity only if it is cheap.
3. A selected dependency that disappears after a refresh stays in the draft with no visible toggle, so the retry returns 404. This is rare, so leave it.
4. On native, Cancel drops the draft. On web, Cancel keeps it until success. Both are acceptable.
5. The assignee picker at AX3: the phone wraps without truncating. If the iPad `-middle` frame truncates, reuse W2a's `.pickerStyle(.inline)` for accessibility sizes (`:908-912`).
6. "New task" stays at the bottom of the board, so W2a's accepted board pixels hold.

## Keep W1 and W2a intact

- Do not change `useAutomation.change`, `Status`, the goal or trigger forms, the shared `HermesAutomationStatus` defaults, or the base `.automation-form` CSS.
- Rerun the W2a functional suites in full: web UI tests, native `Automation*`, and the 3 standing-goal UI tests. M2, M3 and M7 touch `changeTask` callers and feedback rendering.
- Rerun W2a screenshots only if an image diff of the board or detail frames is non-empty. Expected changes are confined to the card's edit area and new feedback states.

## Focused tests (implementation work)

**Web** (`tests/automation-ui.test.ts`):
1. Edit fields are disabled while PATCH is pending (a deferred promise) and enabled again afterward.
2. An edit 409 shows local feedback, Work is not locked (goal and other task controls stay enabled), and the draft is kept. If the refreshed task is running, the running copy shows and the form is gone.
3. Edit success closes the form, focuses the card feedback and fills the announcement region.
4. Create success opens the new card, focuses "Created…", announces it and resets the draft. Reopening gives an empty title and a new UUID.
5. Extend `:198-209`:
   - After a 502, the form-local "Not confirmed" message is visible and focused.
   - If the Refresh overview contains a new ID with the same title: fields are disabled, Close is shown, Create is absent and no second POST is sent. Close focuses that card.
   - If the overview lacks the task: the form is enabled and the resend is byte-equal, which keeps the existing assertion.
6. `likelyCreatedTask` table test: a new ID with the same title matches. A known ID, a different title or whitespace-only differences do not match.
7. Focus: "New task" focuses Title. Cancel returns focus to "New task".

**Native:**
1. Unit test in `AutomationTests`: `hermesLikelyCreatedTask`, the same table.
2. One UI test in `AutomationFlowTests`: edit, the fake server answers PATCH with 409 `claimedTask`, and the refreshed task is running. The editor shows the running copy, Save is disabled, and Work is not left needing refresh.
3. Rerun these unchanged: `testTaskIntentRetainsUUIDForRetryAndUsesFlatFinitePayload`, `testExplicitTaskRetrySendsSameRequestUUIDAfterStatusRead`, `testUnassignedTasksEncodeExplicitNullAndTruncatedBoardsDecode`, `testTaskCreationStaysBlockedUntilExplicitStart`.

**Adapter:** no change. Rerun the 25 adapter tests only if `automation.py` changes.

## AFTER capture matrix (capture-only harness work)

The fixture `work-tasks.json` needs no change. Its lost-response create already persists the task, so after Refresh M1 shows the match.

**Web: 16 frames**, named `web-work-task-<name>`:

| # | Name | Width, theme, font | State |
| --- | --- | --- | --- |
| 1 | create-desktop | 1440 light | New task, `newTask` filled, anchor at the form heading |
| 2 | create-dark | 1440 dark | same |
| 3 | create-phone-top | 390 | anchor at the heading |
| 4 | create-phone-bottom | 390 | anchor at the fieldset. Must show the list end, help text and actions |
| 5 | create-narrow | 320 | anchor at the heading |
| 6 | create-large-text-top | 390, 200% | anchor at the heading (new) |
| 7 | create-large-text-bottom | 390, 200% | anchor at the actions |
| 8 | create-saved | 390 | loaded mode, Create, the new card open and focused (new) |
| 9 | create-uncertain-form | 390 | after the 502, form-local message and disabled form |
| 10 | create-uncertain-alert | 390 | panel top |
| 11 | create-refreshed-form | 390 | after Refresh, the match callout and Close (new, replaces `create-refreshed`) |
| 12 | create-uncertain-closed | 390 | after Close, the single created card focused (replaces `create-retried`) |
| 13 | edit-desktop | 1440 | t_2, Edit task, Unassigned |
| 14 | edit-phone | 390 | same (new) |
| 15 | edit-large-text | 390, 200% | same (new) |
| 16 | edit-saved | 390 | after Save, "Saved in Hermes." under Edit, summary shows Unassigned (new) |

Web assertions:
- The create body keys are exact and use a UUID.
- Uncertain create makes 1 POST, then Refresh makes 1 GET, then **0 further POSTs**. After Close there is exactly one task with the title, it is blocked, and `activeElement` is on that card.
- Each `.automation-check` checkbox sits on its title's first line, within 8 px, and each row is 56 px or less at 390 and default font.
- No horizontal overflow at 320 and 200%.
- The edit PATCH body is exactly `{title, body, priority, assignee: null}`, and focus lands on the feedback.
- No browser errors.

**iPhone: 12 images from 5 variants:**
- `task-create`: `task-create-empty`, `task-create-filled`, `task-create-saved` (new)
- `task-create-dark`: `task-create-dark`, with the title filled and **Instructions empty** so the dark placeholder can be measured
- `task-create-large-text`: `-top`, `-middle` (new: assignee and priority), `-bottom`
- `task-create-uncertain`: `task-create-uncertain`, `task-create-refreshed` (new), `task-create-closed` (replaces `retried`)
- `task-edit`: `task-edit`, `task-edit-saved`

**iPad: 8 images from 5 variants:**
- `task-create-filled`
- `task-create-dark`
- `task-create-large-text-top`, `-middle`, `-bottom`
- `task-create-refreshed` (new variant, one capture)
- `task-edit`, `task-edit-saved`

Native assertions:
- The uncertain flow sends exactly 1 POST, Refresh issues 1 GET, and 0 POSTs follow. After Close, Blocked (3) contains exactly one "Plan the winter supplies".
- The edit PATCH carries explicit `assignee: null`, and the detail is still presented after the editor dismisses.
- Each variant logs `DESIGN_WORK_TASK_VARIANT <v> complete`.

**Total: 36 AFTER images.** Six annotated comparisons:
- web `create-phone-bottom`, `create-uncertain-form` and `edit-desktop`
- iPhone `task-create-empty` and `task-create-uncertain` paired with the new `-refreshed`, disclosed as having no BEFORE
- iPad `task-create-large-text-top`

W2b passes only when web, iPhone and iPad all score 9 or above on every frame above. That covers web desktop, 390, 320, dark and 200%, and native normal, dark and AX3. W3 waits until then.

## Limits

- Synthetic fixtures and iOS 27 simulator captures only. Production Hermes `41dfcf2c` is unavailable.
- No physical device, VoiceOver, hardware keyboard, iOS 17, AX5, compact or split iPad, or browser zoom.
- I did not run the probe or any test.
- Contrast was sampled from rendered pixels, not tokens. Anti-aliasing makes it approximate within about 0.1.
- I wrote only this file and `93-collages/`: 7 collages, `contrast-samples.txt`, `make.py` and `contrast.py`.
