# Memory design validation

Memory passes Claude Opus 5.5 High at 9.0 on web desktop, tablet, phone,
320-pixel width, dark mode and 200% text, and on iPhone and iPad in normal,
dark, AX3 and recovery states. The [web review](memory-web-review.md),
[native recheck](memory-native-review.md) and
[final iPad check](memory-native-final-review.md) close all blockers.
Each captured group was scored separately.

## Resulting behavior

The opening explains that Hermes owns a shared profile. Separate Assistant notes
and About this profile sections give each field a stable label and count. Quiet
captions use the app's readable muted color. Saved notices follow actual writes,
so opening an unchanged profile no longer claims a save occurred.

Conflict drafts remain readable and selectable. Reload asks before discarding
edits, including on retry after failure. Failed reloads retain the draft;
successful reloads restore the saved entries and unlock editing even when the
revision has not changed. Discard explains when fresh profile data is still
required. Closing settings, changing tabs and writing protect unsaved work.

Add memory focuses its new field. Web fields grow with their content up to a
viewport-aware cap and show a scroll hint for longer entries. Read-only fields
have a distinct visual treatment. Counts handle Unicode scalars and known saved
separator overhead; Hermes remains authoritative when its storage format is
unknown. Over-limit drafts cannot submit.

Native Forget confirmation quotes the exact entry, explains its shared scope,
and offers Keep entry. Only explicit confirmation deletes. The request starts
after dismissal, and the parent guard covers the interval before it starts.
Disabled Add uses the same state for its label and icon.

## Evidence and checks

The artifact root is `/Volumes/DevSSD/scratch/wildbots-design-review`.

- Baseline: 20 web screenshots and 18 per native device, 56 total.
- Accepted after: 35 web screenshots and 26 per native device, 87 total.
  `memory-web-after-evidence.json` and `memory-native-final-evidence.json` retain
  hashes, passing receipts, exact device IDs and run-window bindings.
- Native source: `cf30021cbab93fb2fb819ad4cc9af65885b0cd84ce4194d0dd5df6e82bf3fb15`,
  242 inputs. Review 50 independently approved 15 unaffected earlier images
  using exact source reconstruction. Review 51 verified that the final three
  iPad images add nothing else to the 49-image candidate.
- Rendered web source: `de0a6dd51ccc104f69fce8ff8498ed4d6c64c856b5d9b589371765f5996b60fe`,
  226 inputs. `memory-web-final-source-proof.json` reconstructs that state and
  records two accessibility attribute follow-ups plus an unrelated capture-only
  Details selector correction. These change no Memory pixels.
- The 75 focused web tests and pinned typecheck passed. The production build
  and complete web capture passed. Native ExperienceTests passed before later
  presentation corrections; the final UI segments compiled and passed without
  skips. Assertions cover retained drafts, restored values, read-only state,
  save protection and Keep versus confirmed Forget.

Failed and interrupted attempts stay excluded. Native input helpers wait for
keyboard layout, recheck focus and assert the actual replacement. A bounded
second replacement retains diagnostics on failure. Final passing runs did not
need that second attempt. Shared-machine runs use the existing admission lock
and verify owned-resource cleanup before image inspection.

## Screenshots and limits

Six web and seven native annotated comparisons are staged for the final full-app
PR. `memory-annotated-evidence.json` records all 13 hashes. The disabled-Add
comparison explicitly labels its left image as an intermediate revision.
Numbered markers on both Forget comparisons were moved left after review to
avoid covering the target's first letter.

All data is synthetic. No live Hermes, provider or household write was exercised.
Character limits and fixture separator values are test values, not a claim about
every Hermes storage format. Native conflict text selection is enabled in source;
the Copy menu and clipboard readback were not tested.

Physical devices, VoiceOver output, hardware keyboards, iOS 17 fallback, iPad
compact widths and AX5 remain unverified. Enlarged native text uses AX3.
The reload-failure image shows the retained draft's exact count; the passing
assertion and source establish the text itself. The recovered image shows the
saved entries; the assertion establishes that the error disappears.

Nonblocking whole-app follow-ups remain in the review reports, including shared
field borders, native separators, system destructive-label contrast and busy
navigation styling. The [shared navigation recheck](memory-settings-navigation-review.md) accepts
the fresh Details, Avatar, Models, Tools and Skills views at 200% text. All 130
regression captures passed, and the five target images are pixel-identical to
the earlier accepted views. The open More menu was checked from source only;
200% means root font scaling, not browser zoom.
