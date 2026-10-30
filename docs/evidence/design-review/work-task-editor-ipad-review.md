# 102. Work W2b task editor: iPad AFTER render review

Reviewer: Anthropic Claude Opus 5.5, high effort. This review is independent of the OpenAI implementers, GPT-6.1 Terra and Sol. I used no children.
Method: saved source, logs, receipts, hashes and saved images only. I made offline Pillow crops and contrast samples on the authoritative originals. I ran no builds, browsers, simulators, devices, locks, signing, services or probes. I edited no app, tool, doc, fixture or ledger file. I wrote this file and `102-collages/`, which holds `crop.py`, `contrast.py`, `grid.py`, `contrast-results.txt`, `details-1.png`, `details-2.png` and the crops they combine.

## Verdict

- **iPad W2b gate: passes.** All 9 actual frames score 9. I did not average or project any score.
- **There are no blockers and no mediums.** The four lows from review 100 carry over. The iPad does not raise any of their risks, and it removes one of them, L2. The keyboard limit below is a coverage disclosure, not a defect.
- **W2b closure is ready within the reviewed scope.** Web has 16 frames, accepted in review 98. iPhone has 13, accepted in review 100. iPad has 9, accepted here. That makes 38 of 38 frames at 9. All 6 annotated comparisons are sound. The ledger still has to record this, and this score is not that acceptance record.
- **The plan does not require a new software-key-grid capture.** The reason is given under "Keyboard coverage".

## Proof I verified

| Item | Result |
| --- | --- |
| 9 originals | The sha256 values match `work-w2b-native-pad-r2-evidence.json` byte for byte. Every image is 1668×2420. The 9 are unique, and `excludedRuns` is empty |
| Source pin | `35bc7afb…b477 (243)` appears in the evidence file, the receipt and all 5 run summaries. Running `source-state.py` over the validator's own prefixes on this worktree reproduces it exactly. The 243 per-file hashes in the carry proof match the worktree |
| Carry 8b416 to 35bc7 | The proof's per-file prior and current hashes differ only for `ios/AgentInterfaceUITests/ScreenshotTourTests.swift`. No app, fixture, project or tool byte changed |
| Fixture | `.agents/fixtures/work-tasks.json` hashes to `e8fee514…e744`, which matches the evidence file and the receipt |
| Binding tool | `bind-work-task-captures.py` hashes to `270d6f7c…73d`, which matches |
| Receipt | 5 runs on `A068DC6D`, each with rc 0, 1 passed and 0 skipped, and the exact selector `testWorkTaskEditorDesignReviewAfter`. The screenshots split 4+2+1+1+1 = 9 with exact names. `errors: []`, the device is Shutdown, the lock is free with inode 17430620, and no owned xcodebuild remains. Release was 23:36:26.358236Z, scoped verification 23:36:26.533078Z, and both deadlines held. 687.6 s including cleanup, with a queue of 4.9 µs. The worker finished before the release |
| Run summaries | All 5 say iPad Pro 11-inch (M5), iOS 27.0, `Passed`, 1/0/0 |
| Variant markers | `DESIGN_WORK_TASK_EDITOR_VARIANT <v> complete` appears exactly once in each of the 5 logs |
| Target | Both the large-text and task-create logs print `width=44 height=44 frame=(766.0, 1146.0, 44.0, 44.0)`. The `>= 44` guard, the code 3 title-preserving hide check and the range guards are unchanged (`ScreenshotTourTests.swift:1139-1181`) |
| Assertions | Pad runs keep the plan's native assertions (`:1263-1290`): the refreshed variant makes 1 POST and 2 GETs, with Close and a disabled title. The edit PATCH carries `assignee: null`. Dark and large text make 0 writes. All passed |

The receipt shows the run was released and verified before the parent relayed the images. I can verify the saved records. I cannot verify when they were relayed.

## Keyboard coverage

- **What the frame shows.** `task-create-large-text-keyboard` shows the title cursor and the Hide keyboard platter in a bar at the bottom right of the screen. It shows no on-screen key grid. The dark frame shows the same. `details-1.png` holds the light and dark crops.
- **What the log shows.** `waitForKeyboardLayout` reaches its poll only after `keyboards.firstMatch.waitForExistence(timeout: 3)` returns true (`UITestSupport.swift:72`). In the large-text log, each wait resolves at about 1 s and then polls (`:2066-2099`). After the Hide tap, one existence check passes as gone (`:2140`). So XCUI reported a keyboard element before Hide and none after, but no key grid was rendered. The root note `softwareKeyboardVisible=false` is correct for the pixels. "XCUI keyboard element present" is not the same claim as "software keyboard visible". I make no inference about why the simulator shows this state.
- **What it proves.** The accessory renders on iPad, its 44×44 target was measured, and Hide dismisses the XCUI keyboard element while keeping the editor and title. It does **not** prove the software-key-grid layout, the sheet's avoidance of the keys, or a physical or hardware keyboard.
- **Why no new capture is required.** Review 93's plan names 8 iPad states (`:225-230`). None of them is a keyboard state. The gate (`:241`) is normal, dark and AX3, and the limits (`:246`) exclude hardware keyboards. The keyboard frame is additive. Carry it as an explicit limit: "iPad keyboard frame proves accessory rendering only. Software-key-grid layout on iPad is unverified." Most iPad users type on the on-screen keyboard, so the later whole-app pass should capture one key-grid frame. That pass should not gate W2b.

## Contrast on the originals

Text needs 4.5:1 and icons need 3:1. Every sample passes. The raw output is in `102-collages/contrast-results.txt`.

| Element | Ratio |
| --- | --- |
| Hide keyboard glyph `#69726A` on its light platter `#E4E4E4` | 3.93 |
| Hide keyboard glyph `#A6B4A7` on its dark platter `#202121` | 7.46 |
| "Add instructions" prompt, AX3 light | 4.99 |
| "Add instructions" prompt, dark | 6.44 |
| "Task" and "Wait for these tasks (optional)" headers | 4.70 light, 7.57 dark |
| Status captions, help text, "Choose up to 20 dependencies.", "Saved in Hermes.", "Ready" | 4.99 light, 6.44 dark |
| Assignee value, green | 6.01 light, 7.94 dark |
| Cancel, Create task, Save task, Close | 5.76 light, 6.08 dark |
| Refreshed callout | 21.0 |
| Dark title text | 13.94 |

The disabled assignee in `task-create-refreshed` measures 1.72. It is exempt as a disabled control.

The light glyph platter measures 3.93 here, against 4.91 on the phone, because the iPad accessory sits on a different backdrop. It still passes.

## Scores, each actual frame

| # | Frame | Score | Basis |
| --- | --- | --- | --- |
| 1 | `task-create-large-text-keyboard` | 9 | At AX3, the Title label, the entered title, the cursor and "Instructions (optional)" with its 4.99 prompt are all clear. The Hide platter sits in the bottom bar, clear of the sheet and the composer. Scored only for what it renders. See "Keyboard coverage" |
| 2 | `task-create-large-text-top` | 9 | The Title-to-Instructions range fits at AX3. Labels persist while the field holds text, and the idle status block is gone. The sheet clips at the "Assigned assistant" label, which is a scroll seam that frame 3 covers |
| 3 | `task-create-large-text-middle` | 9 | This settles review 93's open question about the iPad AX3 assignee. "Ranch hand" wraps under its label with no truncation. Priority and the stepper fit. The help text's first line is cut by the sheet edge, a scroll seam. The title ghosts under the glass nav bar, which predates W2b |
| 4 | `task-create-large-text-bottom` | 9 | Four dependency rows wrap cleanly with their statuses at 4.99. "weatherstripping" breaks without a hyphen and the toggles stay centered. The list end and "Choose up to 20 dependencies." are visible |
| 5 | `task-edit` | 9 | "Edit task", a primary Save task, labeled Title and Instructions fields, Unassigned in green at 6.01 and the stepper. The empty sheet below is accepted W2a sheet sizing |
| 6 | `task-edit-saved` | 9 | The nested sheet returns to Task details. "Saved in Hermes." sits under Edit task at 4.99. Status Ready and Unassigned are visible. The surrounding detail is accepted W2a context and was not rescored |
| 7 | `task-create-refreshed` | 9 | The recovery is honest. The callout reads "A task with this title appeared on the board. Hermes may have saved it. Close this form to review it." at 21:1. The confirm becomes a primary Close, the draft keeps its labels, and the assignee is dimmed. See L1 |
| 8 | `task-create-dark` | 9 | All dark text passes. The prompt measures 6.44 and the green 7.94. The cursor is the full accent color. The Hide platter sits in the bottom bar, so phone L2's overlap with the stepper does not occur on iPad |
| 9 | `task-create-filled` | 9 | Seven dependency rows, including a two-line wrap, all have status captions. The two selected rows, Check attic insulation and Draft the winter checklist, are clearly on. Create task is enabled at 5.76 |

9 of 9 frames score 9.

## Findings

### Blockers

None.

### Mediums

None.

### Lows carried from review 100

None of these is new, and none blocks the gate.

- **L1. Mixed disabled cues.** `task-create-refreshed` dims the assignee to 1.72, but the Title and Instructions text and the stepper glyphs stay pure black. This is the same as on the phone, and the iPad does not change the risk.
- **L2. The dark keyboard circle overlaps the stepper.** This does not reproduce on iPad. The accessory renders in the screen-bottom bar, about 380 pt below the sheet.
- **L3. AX3 coverage seam.** `-middle` ends on the help text's first line. `-bottom` starts at "Check attic insulation". So at AX3, the rest of the help text, the "Wait for these tasks (optional)" header and the first three rows are never imaged. The iPad AX3 wrap of the longest title, "Schedule the chimney sweep and confirm the date with the household", is one of those rows. The normal-size `task-create-filled` frame shows all of them, and the plan did not require them at AX3.
- **L4. The runtime warning "Invalid frame dimension (negative or non-finite)."** It appears in 4 of the 5 pad summaries and is absent from `task-edit`, the same pattern as the phone. It is unlocated and has no visible effect in any frame.

### Observation, not a finding

The light AX3 keyboard frame draws the caret in `#C8DBD5`, a pale tint of the accent `#246F59`, at about 1.4:1 on white. The dark frame draws the full accent `#8BD2B2`. The system caret blinks, so one frame cannot establish its steady color, and the caret is not part of what this gate scores. If it matters later, the whole-app pass should check it.

## Annotation `ipad-create-ax`

- **Bindings.** The PNG hash `b123ffb6…692` matches the manifest. The BEFORE `3ee95783…191a` matches both `work-w2b-before-selection.json` and the plan entry in `work-w2b-annotated-plan.json`. The AFTER is the R2 `-top` original at `41a01c68…3ee`.
- **Preservation.** Each panel is a 1:1 copy of its original at offsets (0,143) and (1692,143). The mean difference is at most 0.15/255. The only changed pixels are the marker badges, within boxes x 223-286 BEFORE and x 260-319 AFTER, and the text starts at about x 320. The marks touch no glyph, and the aspect ratio is exact.
- **Claims.** BEFORE 1, "Instructions is only a pale placeholder; entered title text has no persistent field label", is accurate. AFTER 1 points at the left edge of "Title" and AFTER 2 at "Instructions (optional)". Both captions are accurate, and the 4.99 prompt measurement backs "readable prompt". The caption claims AX3 only. The manifest's `limits` keeps the keyboard and hardware disclaimer.
- With this comparison, all 6 of the plan's comparisons are sound: web 3 in review 98, phone 2 in review 100 and iPad 1 here.

## Collages

The 5 root collages in `work-w2b-native-pad-r2-collages/` are labeled with the correct frame names, and the tiles keep the 0.689 aspect ratio. I scored from the 9 originals at native size and from native crops, not from the collages.

## Limitations

- These are simulator images only: iPad Pro 11-inch (M5) on iOS 27.0. I make no claims about VoiceOver, a physical device, a hardware keyboard, the software key grid on iPad, AX5, iOS 17, or compact and split iPad layouts.
- The functional proof keeps its original bindings: R1 `d02d33` 33 unit and 5 UI tests, the R4 2 affected task UI tests, the R6 phone 44×44, hide and range proof, and the R7 phone 4 tours. The R2 pad tours ran on `35bc7`, which differs from `8b416` only in the UITest helper, as review 101 accepted. I asked for no repeat runs.
- Contrast comes from PNG pixel sampling. Glass backgrounds vary slightly with the content behind them.
- Small pad sheet sizing and global glass nav-bar ghosting predate this work, from accepted W2a. I saw no new material change to either. Both stay with the later whole-app pass.
- I did not re-review the web or phone frames, the other 5 annotations, or the review 101 scroll fix.
