# Assistant creation and settings validation

Opus 5.5 High closed the creation/settings gate in review 23. Every row scores
at least 9.0 with no blocker. The reviewer rebuilt the two-file patch, recomputed
the source fingerprint, verified both focused receipts and fourteen fresh image
hashes/times, checked all 74 composite hashes, and independently measured Retry.

| Area | Web desktop | Web phone | iPhone | iPad |
| --- | --- | --- | --- | --- |
| Creation | 9.1 | 9.1 | 9.2 | 9.1 |
| Details | 9.1 | 9.1 | 9.2 | 9.1 |
| Confirmations | 9.2 | 9.2 | 9.2 | 9.0 |

The native Details scores are actual judgments from the final Retry frames.
Other scores are reused from the accepted scopes in reviews 20 and 21.

The scope is the two-step creation wizard, Details settings, its four confirmation
prompts, and the shared preview controls used by the wizard. The separate Avatar
editor and other settings tab bodies have later gates. All actions use synthetic
fixtures. No household service, production API or provider was contacted.

## Resulting behavior

Name comes before appearance on both platforms. Descriptions wrap. Helper text
and preview captions use readable type and contrast. Primary actions have a clear
filled style, and Delete has its own section. The web wizard keeps Next and Create
visible, with complete accessible names. Native field prompts use explicit colors.
Native navigation becomes one disclosure at AX sizes, preserving complete words.

Privacy, model and deletion decisions use modal confirmations. The warning travels
with its action. Web confirmations start focus on the safe action and contain
Escape without reaching the parent unsaved-changes guard. Native uses a local
sheet with an opaque background, explicit colors, visible safe cancellation and
scrolling when needed. Discard uses that same native sheet. Native actions run
after dismissal, so a privacy confirmation can reliably lead into a model warning.

Confirmation titles use the latest successfully saved name. A public save clears
old private consent, and a later unshare asks again. A personal save reports
"Assistant saved." Delete explains that Hermes deletes the assistant and WildBots
removes its settings. The load-error state has form gutters and a normal Retry.

## Web checks and evidence

All 45 tests pass in `settings-tests-v9.log`. The production build passes in
`settings-build-v7.log`. Tests cover safe cancellation without writes, parent
cancellation isolation, explicit model confirmation, save retry, saved names,
privacy confirmation and fresh consent after re-sharing.

`settings-v3-after.json` contains 63 base frames across 1440, 768, 390 and 320 px,
light and dark themes, and 200% text. Review 20 independently checked no overflow,
12 modal bounds inside the viewport, safe focus, Escape without a write or parent
discard, and 32 keyboard field checks with no overlap with the sticky footer.
Those checks cover edit controls, not every possible header or creation focus path.

Only the load/error container changed visually after review 20.
`settings-load-error-before.json` and `settings-load-error-after.json` each cover
390 and 1440 px. The after report measures at least 21 px phone gutters, 27 px
desktop gutters, a 128 px Retry button, no overflow and a working retry. The
composite `settings-web-evidence.json` hashes 64 current images: 62 unchanged
reviewed frames and both new load-error frames. It records reuse and replacement.
The historical v3 phone error raw was replaced by this focused rerender; review
20 preserves its original crop and findings.

The original client is an isolated archive of commit `6fc7384`, served separately.
Its Vite client build passed. Its archived full build stopped at the service-worker
manifest path guard, so no baseline production-build pass is claimed. Service
workers were blocked for the visual fixture. The current full build passes.

Current web fingerprint, covering `src`, both capture drivers and the fixture:
`29f2ab92b09c713ec053a24f9d49e0e880e49cf30e78802a544400e94b9e0cf9`.

## Native checks and evidence

Both final runs pass one complete six-variant UI flow, with zero failed or skipped
tests. The full test bundle compiled, but no additional unit-test run is claimed.

- iPhone: `.private/ios-test-20261026T230006Z-35789.xcresult`,
  `ios-settings-themed-v3.log`.
- iPad: `.private/ios-test-20261026T230606Z-39651.xcresult`,
  `ipad-settings-themed-v3.log`.

Each device produced 37 fresh images. `design-capture-evidence.py --count 37`
validated both passing receipts, all 74 hashes and each image's capture time
inside its test window. `settings-native-evidence.json` records the results.
Both full-flow receipts match the reviewed base fingerprint:
`3dd5c0a5a8fdbbd432d556705096b2385e5e9f5988b968815bb8fc757f8fb68d`.

Coverage includes normal, dark, AX3, load/save failure and retry, unsupported
configuration, explicit model warnings, chained privacy/model confirmation and
fresh privacy consent after re-sharing. Delete is captured in light, dark and AX3.
Keep is reachable at AX3. The discard cancellation preserves the edited name.
No duplicate banner appears behind the model warning.

The fixture now applies real synthetic deletes to its roster. The loaded flow
first swipes a Delete sheet away and verifies the assistant remains. It then
explicitly confirms a deletion and verifies the same fixture removes it after
refresh. That positive control makes the cancellation assertion falsifiable.
Other Keep paths preserve the form and saved notices.

Native baseline has 28 original wizard/settings images plus four model-warning
images per device. It uses the actual `6fc7384` UI with only invisible accessibility
identifiers added to production views. Driver fixes opened the iPad sidebar and
revealed recycled fields. Earlier failed or partial attempts remain unaccepted.
The rejected system-alert attempt and its source are archived separately.

The shared fixture is `.agents/fixtures/settings-design.json`, SHA-256
`7d12e1ac592e0942f13fbb5b4a8893594fe098581f45e069d61255b81d58eb64`.

## Rendered contrast and annotations

Both devices produce the same sampled text pairs in the final Delete prompts.
`settings-contrast-regions.json` records each region; the sample output is
`reviews/settings-final-contrast-samples.txt`.

| Text | Light | Dark |
| --- | --- | --- |
| Title | 20.65:1 | 14.43:1 |
| Warning | 5.69:1 | 6.67:1 |
| Delete | 6.35:1 | 8.04:1 |
| Keep | 5.91:1 | 9.32:1 |

These measurements exceed 4.5:1. They are pixel samples, not a screen-reader or
whole-app accessibility certification. The explicit Name and MCP prompts also
sample at 4.99:1, improved from the old MCP prompt's 1.72:1.

All 32 comparisons in `settings-annotation-manifest.json` are regenerated from
the final evidence. They cover the wizard, primary/destructive hierarchy, AX3
navigation, the load-error fix and all four native confirmation types.

## Runtime coordination and limits

The final batch acquired the exact shared fcntl lock at 22:59:55.833605Z. Queue
was under 0.001 seconds. One inherited lease covered the focused web supplement
and both serialized native runs, before each repository lock. Cleanup and automatic
coordinator handback completed at 23:12:38.526188Z, taking 762.693 seconds including
cleanup, inside the twenty-minute bound. Both owned devices were Shutdown, no
owned xcodebuild remained, and the shared lock probed free. The receipt is
`settings-themed-heavy-release.json`. Protected and unrelated resources were untouched.

Native text-size captures use AX3, the third accessibility category, not the system
maximum AX5. The web keyboard checks use Chromium. Physical devices, VoiceOver
focus and escape, hardware keyboard Escape and Return, iPad compact multitasking
widths and the iOS 17 form-sheet fallback remain unverified. The simulators run
iOS 27. Scores remain independent reviewer judgments rather than measurements.

## N4 focused correction after review 21

The load failure now shows one padded banner and a bordered Retry button. Its
label has a 44 pt minimum inside the button. The normal dismissable error banner
is rendered only after detail has loaded, so save errors still appear normally.
The capture test requires exactly one static text matching the fixture's load
error. Creation's separate error banner is unchanged.

Current native source fingerprint is
`cd41240f91ed59a901922fdd88dc35adecff890420c12c327cd1cc5752585897`.
The two-file patch is `reviews/22-settings-n4.patch`. Reconstructing the source
before it reproduces the review 21 fingerprint exactly.

Only the settings-error variant was rerun on each device. Both flows pass with
zero skips and seven fresh images each:

- iPhone: `.private/ios-test-20261026T233052Z-47912.xcresult`,
  `ios-settings-n4.log`.
- iPad: `.private/ios-test-20261026T233230Z-49480.xcresult`,
  `ipad-settings-n4.log`.

`design-capture-evidence.py --count 7` validates each focused run's exact count,
hashes and capture times. `settings-n4-evidence.json` keeps those fourteen images
separate from the accepted base. The unchanged 30 states per device retain their
original review 21 receipts. `settings-native-composite-evidence.json` verifies
all 37 current states per device and records the actual source and receipt for
each. No claim is made that all 37 images came from either focused run.

The N4 captures are under `settings-n4-captures/after/{ios,ipad}`. All thirty
comparisons now use the current composite data, with two added N4 pairs. The
original reviewed 37-frame sets remain unchanged. Retry text samples at 4.64:1
on its native bordered fill in the new iPhone image.

The N4 lease started at 23:30:51.875225Z, queued under 0.001 seconds. Automatic
cleanup and coordinator handback finished at 23:34:20.671635Z, taking 208.796
seconds including cleanup, inside the ten-minute bound. Both task devices were
Shutdown, no owned xcodebuild remained, and the exact shared lock probed free.
`settings-n4-heavy-release.json` records the handback. SteadLog's authorized
web-only window has the next slot. No further heavy work is planned pending
review 22.

## Retry correction after review 22

Retry clears `self.error` before starting `loadTab()`, so the loading state appears
while the request runs and the old failure cannot return on success. The existing
catch restores a real error if the new request fails. Retry now uses the shared
solid `.accentProminent` style instead of a translucent bordered fill. The UI test
waits until Name is enabled, then asserts the old error text is absent before
capturing the recovered form.

The two-file patch is `reviews/23-settings-retry.patch`; its before files reconstruct
the reviewed `cd41240f` source exactly. Current native source is
`a9d2bdfdd510b270043687545f649b2518985685acbe7246a0e79db3ce8be516`.

An initial compile attempt stopped before any capture because the local `error`
binding shadowed the state property. The assignment was corrected to `self.error`.
That failed log and its 5.953-second cleanup receipt remain separate and unaccepted.
A new ten-minute reservation ran the corrected source, with no extension of the
ended slot. Both focused flows passed with seven fresh images and zero skips:

- iPhone: `.private/ios-test-20261026T235051Z-56342.xcresult`,
  `ios-settings-n56b.log`.
- iPad: `.private/ios-test-20261026T235227Z-57066.xcresult`,
  `ipad-settings-n56b.log`.

`settings-n56b-evidence.json` validates all fourteen hashes and times against these
receipts with strict `--count 7`. The current composite replaces the earlier N4
seven-frame sets while reusing thirty unaffected review 21 states per device.
The earlier N4 frames, receipts and composite remain preserved. No web checks
were repeated because their inputs did not change.

The new Retry label samples at #FFFDF7 on #246F59, 5.91:1, on both devices.
`settings-retry-contrast.json` records interior text regions, with crops in
`reviews/23-ios-retry-label-crop.png` and `23-ipad-retry-label-crop.png`. These
regions exclude the surrounding background. The recovered frames show no error,
and save-error and saved states still pass. All thirty-two annotated comparisons
now use the current composite, including two new successful-Retry comparisons.

The successful fresh reservation started at 23:50:50.978288Z and its automatic
cleanup handback finished at 23:54:26.086177Z, taking 215.108 seconds including
cleanup, inside the ten-minute bound. Both owned devices were Shutdown, no owned
xcodebuild remained and the exact shared lock probed free. The receipt is
`settings-n56b-heavy-release.json`. SteadLog's subsequent web-only W1 completed
and released separately. No heavy work is active here pending review 23.

## Final independent acceptance

Review 23 closes N5 and N6. The old error disappears after Retry, the recovered
form is enabled, and save failure still preserves edits. On each device the opaque
Retry fill is #246F59 and its label #FFFDF7, 5.91:1. The reviewer measured a
126 by 58 pt target and confirmed that it aligns with the banner gutter. The
reviewer's findings and limits are archived in `settings-final-review.md`.

The progress spinner during Retry and a second consecutive retry failure were
checked from source only. Dark Retry uses the already accepted shared accent
style but was not recaptured in this variant. Previous nonblocking notes remain
accepted, including the small iPad stacked-sheet strip and system form size.
The screen gate is closed; Avatar editor is the next scope.
