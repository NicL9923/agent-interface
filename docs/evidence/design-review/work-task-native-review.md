# 92. Work W2a iPad start-note recheck, R6

Reviewer: Anthropic Claude Opus 5.5, high effort, independent of the OpenAI root.
Scope: the 5-line `task-detail` delta, phone carry, the R6 receipt and the new `task-detail-start-note` frame. Review 91's settled scopes are not reopened.
Source: `sha256:f55bda23…a44afd` (243 files). Binder `work-w2a-native-pad-after-r6-evidence.json`.

## Verdict

- **`task-detail-start-note` (R6) scores 9.** It replaces review 91's 8.
- **Source delta and phone carry: accepted.**
- iPad matrix: 2 R3 + 6 R4 + 14 R5 + 1 R6 = **23 of 23 at 9 or above.**
- **Full W2a can close and commit. W2b create/edit can start.** Totals: web 19 (review 82), phone 23 (reviews 84 to 91), iPad 23.
- No full-app acceptance or PR.

## Score

| Frame | sha256 | Score | Basis |
| --- | --- | --- | --- |
| `task-detail-start-note` | `7ab89a72…a83e` | **9** | The disclosure is open with a down chevron. "Start note (optional)" is black (21:1). The **"Start note" prompt is visible at 4.99:1** (`#697268` on white), and the field's bottom separator and the footer "Hermes checks the task's current state and dependencies before changing it." (4.99) all sit inside the sheet with margin above its rounded bottom. Start task (semibold), Block task… and Request review… are above it. "Move task" header is 4.70 on `#FAF8F2`. Not 10: "Remove dependency" sits on the nav hairline and "Draft the winter checklist · In review" ghosts under the nav material. That is the scroll-edge class accepted in reviews 84 to 91. Crop: `92-collages/pad-r6-start-note-sheet.png` |

The first three R6 frames (`task-detail-top` `569350fa…`, `-dependencies` `a22bc623…`, `-actions` `b0c7feeb…`) are the same size as their R5 counterparts. Pixel diffs against R5 are confined to x 91–868, y 20–481, which is the status bar clock and backdrop above the sheet. Sheet content is identical. Collage `work-w2a-pad-detail-r6.png` agrees. No new issue, no re-score.

## Proof checked

- **Delta:** `diff -u` snapshot vs current reproduces `work-w2a-native-start-note-range-delta.patch` exactly. One hunk at `ScreenshotTourTests.swift:1006`, 5 added lines, after the first three captures of `case "task-detail"`. Snapshot `2a4552af…ac1d` equals review 91's current tour file. Current is `c1d68197…2d87`. Both match the reuse proof.
- **Fingerprint:** `source-state.py` with the four `validate-ios.sh` prefixes prints `f55bda23…a44afd (243)`. An in-memory fingerprint with the snapshot swapped in gives `2d4c37ad…af95694 (243)`, review 91's source. App, controller and all other branches are unchanged.
- **Footer string:** exact match for `AutomationViews.swift:935`, which is the only native occurrence. It renders when `!running`. Task `t_00000005` is Blocked, so the row exists. It sits in the same section after the `DisclosureGroup`, so label → footer covers the field.
- **Log, R6 iPad:** the label reveal was a no-op (y 891.7 in band 361…913). The footer started `exists=false`, and generic `reveal` made one drag (−209.8). At attempt 1 the footer frame was (143, 853, 548, 52), inside the band. `revealRange` then returned before any gesture, and there are **zero `DESIGN_WORK_RANGE` lines**, consistent with source. Both new assertions passed: the test passed with 0 failures and logged `DESIGN_WORK_W2A_AFTER_VARIANT task-detail complete`.
- **Phone carry:** the phone R4 log puts the label at y 668 pt, with a nav bottom of about 142 pt (band top 154 − 12). The R4 frame (1206×2622, 402×874 pt) shows the footer cell ending at about 820 pt, under phone `contentBottom` = 874 − 34 = 840. The footer is materialized, so the `if !hasFrame` branch is skipped, `revealRange` early-returns and both assertions hold. The phone path would be gesture-free and capture the same frame. Crop: `92-collages/phone-r4-start-note-bottom.png`. **Carry approved.**
- **Summary:** `.private/ios-test-20261028T194142Z-11018.txt` reports inputs `f55bda23…` (243), iPad Pro 11-inch (M5) `A068DC6D`, iOS 27.0 (24A434), exit 0, Passed, 1 passed / 0 failed / 0 skipped. The log ends `** TEST EXECUTE SUCCEEDED **`.
- **Binder:** all 4 hashes and mtimes match. There are 4 unique images and `excludedRuns: []`. Fixture `e8fee514…` and binder tool `3376c9f1…` match. The mtimes (…562.07, …574.16, …587.44, …603.69) all fall inside xcresult 1793216508.496..605.289.
- **Receipt:** the verifier stdout parses equal to the receipt. Admitted 19:41:42.419099Z with a queue of 6.7 µs, and stopWorkAt − 360 = admission. Cleanup is +120. Release was at 19:43:29.679954Z and the scoped verification at 19:43:29.840398Z. Execution was 107.26 s, inside 360 + 120. A068 is Shutdown, errors are `[]`, there are no owned xcodebuild processes, the lock probe reads free, the inode is 17430620, child exit is 0, and both deadline checks are true.
- **Requests:** `task-detail-requests.jsonl` is one line, `{"method":"GET","path":"","read":1}`. GET-only.
- **Matrix:** `work-w2a-native-pad-approved-matrix.json` has 22 rows (R3 2, R4 6, R5 14) with `pending: ["task-detail-start-note"]`. This review fills the pending slot.

## Blocking vs nonblocking

- **Blocking:** none.
- **Nonblocking, carried:**
  1. Scroll-edge ghosting under the nav bar.
  2. W3 "Event triggers" contrast (3.37 / 4.00).
  3. The "Move task" header over the running explanation is a copy nit.
- **Nonblocking, new:** the delta covers the screenshot, not the product. On iPad, opening the disclosure still leaves the field below the fold until the user scrolls. Review 91 already logged this as an optional product idea, and it does not affect the score.

## Limits

Not verified: physical devices, VoiceOver, hardware keyboard, iOS 17, AX5 (native AX3 only), compact or split iPad windows. The 14 annotated comparisons were accepted earlier and were not re-reviewed.

I ran only `source-state.py`, an in-memory fingerprint swap, diff/hash/mtime/JSON checks, log greps, Pillow sampling, diffs and crops. I wrote this file and `92-collages/`: `delta-check.diff`, `pad-r6-start-note-sheet.png` and `phone-r4-start-note-bottom.png`.
