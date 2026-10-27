# 28 Avatar web recheck, delta since 26

Reviewer: Claude Opus 5.5, high effort. OpenAI implemented the change. This was a read-only review: no builds, browsers, simulators, locks, tests, subagents or product edits. Native is out of scope and gets no score.

## Verdict

| Surface | Score | Gate |
| --- | --- | --- |
| Web desktop, light and dark | 9.0 | Passes. The delta caused no regression. |
| Web phone, light, dark and 200% text | 9.0 | Passes. M1 and M2 are closed. |

**The Avatar web screen passes the ≥9 gate with no blockers.** Web can move to the next screen once native finishes separately.

## Inputs I checked myself

- All 14 files in `28-source-manifest.json` hash the same in the worktree and in `28-source/`, so the captures show the reviewed source.
- `28-web-delta.patch` covers only `src/`. Tests changed too: `bot-settings.test.ts` now asserts the S1 copy (line 741) and the new over-limit copy (line 748).
- Timeline: the last source edit was at 20:44:58. Then came the tests at 20:45:01 (76/76, `avatar-web-tests-v7.log`), the fingerprint file at 20:50:49, and the build, finished at 20:53:08 (`tsrs --noEmit`, then Vite, then the worker). The 24 captures ran from 20:53:11 to 20:53:53, and the report is from 20:53:53. Every capture is newer than every source file and the build.
- I could not reproduce the 224-file fingerprint in `avatar-web-after-source.txt`, because the path prefixes used to make it aren't recorded. The manifest hashes already bind the source, so this doesn't block anything. To avoid the question next time, save the exact `source-state.py` arguments next to the hash.
- `avatar-after.json`: 24 paths, 24 geometry entries, `browserErrors` empty, `overflow` false and `attention` empty everywhere, and `outerScrollTop` 0 on every editor shot. Model segments are `3px`/`nowrap` ×2. Both keyboard checks have `headerVisible` and `tileVisible` true.
- Collages and crops are in `reviews/28-web-collages/`, built only from the raw `avatar-captures/after/*.png`. I did not use any annotated or older collage files.

## Prior findings

| Item | Result | Evidence, measured from the report and the pixels |
| --- | --- | --- |
| M1, sticky stage at 200% | **Fixed** | `geo-large` stage: y 218 to 337, **119px**, down from 234. That is under the 160 target. The footer starts at 727, which leaves **390px** for the form, up from about 285. That's 46% of the 844 viewport. The note now renders below the stage in normal flow and scrolls away. In `tune-bottom-large`, all three sliders and Reset eyes are visible, where before only two fit and the Eye width label was cut off. At 100% the stage dropped from 133 to **91px** on phone and to 91px on desktop. |
| M2.1, portrait status at 200% | **Captured, passes** | `portrait-status-large`: the stage bottom is at 337 and the footer is y 683.6, 149.4px tall. That leaves **346.6px** of form, above the 260 threshold. "Portrait ready to save." wraps to its own row above Save as I predicted, and it reads cleanly. |
| M2.2, prompt limit at 390 | **Captured, passes** | Near limit: "1,900 of 2,000 characters", 14px, rgb(105,114,104) on rgb(250,248,242) = **4.70:1**. Over limit: two lines of danger text, 14px, rgb(163,60,50) = **6.08:1**. Generate is disabled, and Save stays disabled only because no portrait exists. The copy now says "Shorten the text to generate a portrait", which is accurate. The text sits about 10px under the textarea with clear space before Generate (`z2`). |
| S1, impossible next step | **Fixed** | `portraitNextStep` names only the supported operation, or "Portraits are unavailable. Choose Geometric or Mascot." when neither is supported, and a test covers it. The extra top margin I suggested was not added. The line sits about 10px under the generation note box. That's tight but readable (`z2`). Non-blocking. |
| S2, charcoal swatch in dark | **Fixed** | Every swatch now has a 1px `--muted` outline. I sampled it at the swatch edge: dark rgb(166,180,167) on rgb(27,33,30) = **7.57:1**, light rgb(105,114,104) on rgb(250,248,242) = **4.70:1**. Both clear the 3:1 non-text minimum. Charcoal is plainly visible in dark now (`z1`). Focus is not broken: `.swatch:has(input:focus-visible)` has specificity 0,2,1, which beats the new `.swatch` outline at 0,1,0, so the 3px accent focus ring still wins. |
| S3, duplicate CSS | **Fixed** | One base first-child rule plus its 620px override. The blank lines are gone. `scroll-padding-top` is now `calc(44px + 4.5rem)`: 116px at 100%, against the 91px stage, and 188px at 200%, against the 119px stage. That matches the keyboard check's `visibleTop` of 300.5, which is 209.5 + 91. |
| S4, desktop select width | **Fixed** | The cap is on `.avatar-preview-controls`, not the select, but the effect is the same: the select measures 320px (20rem) at 1440, down from about 506. This is the cleaner change. At 200% on phone the cap is 640px, so it doesn't apply. |
| Feedback copy, one live region | Verified | "Portrait ready to save." appears beside Save in `portrait-generated-phone`, `portrait-uploaded-phone-dark`, `portrait-generated-desktop` and `portrait-status-large`. Only the always-mounted `role="status"` paragraph carries it, and no banner duplicates it. |
| Note association | Verified | The select's `aria-describedby` points to the note's `useId` id. The note renders exactly when `compactPreview` does, which is also the only time the select exists. |
| W1, W2, T3, T4, persistence | Unchanged and still holding | `save-error-phone` stage is at y 258.9 with the banner fully visible. The failed and retry bodies match. The upload readback is `/api/files/preview-upload-45190cdc…` with `origin: "uploaded"`, and the portrait loaded. I didn't re-review the settled code. |

## Web desktop: 9.0, holds

Shots I saw: `geo-desktop`, `geo-desktop-dark`, `accessory-keyboard-focus`, `portrait-generated-desktop` (`d1`, `d2`). The 91px stage with the note underneath looks lighter than before. The 320px select fixes the 26 nit. The dark Save button and the stage are unchanged. `portrait-generated-desktop` puts the stage at y 246.3 instead of 209.5 only because the shorter portrait form makes the dialog shorter and it centers lower. That's not a regression. The only remaining item is the S2 nit below.

## Web phone: 9.0

Shots I saw: all 16 phone captures, including the three new ones (`p1`–`p4`). At 100% the stage holds the 64px avatar and the select in 91px. The note sits under the rule, and the tile grid, error banner, busy state, dark uploaded state and creation all match 26 or improve on it. At 200%, sticky chrome now takes 54% of the viewport, down from 66%, and the three-slider block fits in one screen. The 200% and limit evidence that 26 lacked now exists and shows no defect. I scored only from these images.

## Non-blocking nits, optional

1. **Next-step spacing in the unavailable state.** `BotSettings.tsx:584`: give that `<p>` its own class with `margin-top: 12px`.
2. **The selected swatch has a double ring.** The muted outline sits inside the surface gap, right against the accent ring. It reads as selected, just slightly busy, more so in dark. Optional fix: `.swatch:has(input:checked) { outline-color: transparent; }`.
3. **The over-limit textarea doesn't look invalid.** `aria-invalid` is set, but the border doesn't change. The danger text is enough, so this is a nit.
4. **Pre-existing, outside the delta.** When generation isn't supported, the prompt textarea still looks editable. It would be cleaner disabled, but leave this for a later pass.

None of these needs a recapture before the next screen.
