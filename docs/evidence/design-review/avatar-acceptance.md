# Avatar editor validation

Web desktop and phone passed [Opus review 28](avatar-web-review.md) at 9.0.
[Native review 30](avatar-native-review.md) closes iPhone and iPad at 9.0, with
no blocker. Review 29 had scored native at 8.5 because the disabled preview menu
looked enabled. The final review verifies that fix and both alignment changes.

## Resulting behavior

Existing assistants keep a compact face preview visible while their appearance
choices scroll. Save stays visible as the primary action. The creation wizard
retains its full preview. Characters, colors, original artwork and animation
behavior are preserved.

Portrait upload and generation have separate groups. Progress, errors and
unavailable features have visible explanations. Empty portraits cannot be saved
or switched between preview states. Generated and uploaded portraits remain
drafts until Save. A successful save persists through reopening settings.

Web keyboard navigation keeps focused choices visible below the sticky preview
and keeps the modal header in view. The editor now owns the positioning context
for its hidden radio controls. Scoped segmented-control styles prevent settings
from changing the conversation model picker. Slider labels identify their actual
inputs. The file input resets after selection so the same file can be retried.

Enabled native preview labels use the accent color, measured at 5.91:1 in light
mode and at least 8.22:1 in dark. Native Save and preview controls respect the form's loading and busy states.
Disabled preview menus use the native disabled treatment. Swatches retain 44-point
targets, including their padding. The prompt's Save bar hides while editing.
Both platforms report the 2,000-character generation limit near its boundary
and explain how to recover when it is exceeded.

## Web evidence

All 76 focused tests pass in `avatar-web-tests-v7.log`. The production build
passes in `avatar-build-v1.log`. Tests cover portrait retry, exact upload and save
payloads, repeated file selection, input labels, prompt limits and preview state.

`avatar-captures/avatar-after.json` records 24 final screenshots, covering desktop,
tablet and phone widths, 320 pixels, dark mode and 200% text. It includes real
keyboard navigation in both the compact editor and creation wizard, composer
regression checks, held upload progress, errors, unavailable operations, prompt
boundaries and persistence. The baseline has 17 screenshots from commit `627f8f8`.

The final web fingerprint is
`50820eba3c8c9a39539dba2ba4d512a124a0f6b4af016941a7471a95d2f42f18`,
over 224 inputs. `avatar-source-commands.json` records the exact command.
Review 28 independently verified the final evidence. The 200% compact preview
measures 119 pixels high. The prompt warning measures 6.08:1, the near-limit
counter 4.70:1, and the swatch outlines 4.70:1 in light and 7.57:1 in dark.

## Native evidence

The final N9 batch passed one complete six-variant UI flow on each device, with
zero failures or skips. It produced 19 fresh screenshots per device.

- iPhone receipt: `.private/ios-test-20261027T022259Z-24963.txt`.
- iPad receipt: `.private/ios-test-20261027T022806Z-26399.txt`.
- Logs: `ios-avatar-after.log` and `ipad-avatar-after.log`.
- Images: `avatar-n9-captures/after/{ios,ipad}/avatar-*.png`.

`avatar-native-n9-evidence.json` verifies both passing receipts, the exact image
counts, all 38 hashes and each capture time inside its test run. The fingerprint is
`8a4bc2f259bb5644ee9cbe4ae7ca535ec6e731bd44306ea94df8f4dc135e354a`,
over 242 inputs. The exact command includes the three `.agents/tools/` paths
listed in `avatar-source-commands.json`.

Coverage includes geometric and seasonal choices, tuning and measured readback,
empty and busy portraits, generated and uploaded drafts, save failure and retry,
persistence, unavailable operations, load failure, dark mode and AX3. The swatch
test taps its padding and checks a 44 by 44-point accessibility frame. The slider
test requires a value different from 100%. Approximate slider gestures produce
125% on iPhone and 120% on iPad; each test checks its actual saved value.

The previous full native batch also passed the prompt-limit unit test on both
devices. That unchanged test was reused for the final label-only fix. The earlier
creation regression passed before that compact-only change. Review 29 verified
all 38 prior native images, their run windows and the source fingerprint.

The UI driver measures the usable band between the preview and Save bars. Its
near-target slow drag avoids the iPad inertial overshoot that caused earlier
capture failures. It requires the complete target to fit in that band, checks
actual tuning changes and never accepts hidden targets as successful captures.
Earlier failed and partial attempts remain separate from accepted evidence.

## Fixtures, annotations and limits

The shared fixture is `.agents/fixtures/avatar-design.json`. Portraits use the
existing app icon as synthetic image data. They do not demonstrate image-generation
quality. The native baseline captures the actual importer opening. The after
upload flow bypasses OS file selection through an explicit DEBUG-only hook, then
uses the real file validation and multipart upload function. A DEBUG-only request
property preserves those exact multipart bytes for the invalid-host fixture.
No production upload, provider generation or household service was contacted.

Ten web and sixteen native annotated comparisons are staged under `annotated/`.
Their manifests retain each original screenshot and pointer specification.
Additional after-only edge states remain labeled as such, without fabricated
before images. Attachments will be uploaded with the final full-app PR.

Native enlarged text is AX3, not AX5. The iPad focused portrait capture shows
the software keyboard and prompt above it. The iPhone capture shows focus with
Save hidden but no software keyboard, so iPhone keyboard crowding remains
unverified. Physical devices, VoiceOver, hardware keyboards and live provider
delivery were not tested. The existing iPad sheet size remains tight but was
accepted in review 29 because its controls were reachable within five drags.

The final batch acquired the existing shared fcntl lock at 02:22:59.243654 UTC
on October 27, 2026. Cleanup and automatic coordinator handback finished at
02:33:26.939596 UTC. Queue time was under 0.001 seconds. Execution including
cleanup took 627.696 seconds, within the 15-minute bound. Both owned devices
were Shutdown, no matching owned heavy process remained, and the lock probed
free. `avatar-after-heavy-release.json` records the release. Protected and
unrelated devices were untouched.

The reviewer retained one code naming nit. `EnabledPrimaryMenuLabel` refers to
`.primary`, while the enabled Menu renders in its native accent tint. The visual
result is accepted; reconsider the modifier name during the next edit to this view.
