# Models and capabilities validation

Models, reasoning and speed, Tools, and Skills pass Claude Opus 5.5 High at 9.0
on web desktop, web phone, iPhone and iPad. The [web recheck](models-web-review.md)
closed the web gate. The [native review](models-native-initial-review.md) accepted
the composer and Skills; the [retry recheck](models-native-review.md) closed Tools.
Each screen was scored separately. No blockers remain in this gate.

## Resulting behavior

Model choices and favorites agree when Hermes reports provider aliases. Changing
a shared assistant's model explains its household scope. A separate confirmation
shows Hermes's actual warning and offers a safe cancel or keep action. Native
confirmation saves only after dismissal and checks the household and assistant
again. Reasoning and speed remain conversation settings.

Web keyboard controls have 44-pixel targets, visible focus and one scrolling
panel. A failed change shows its error beside the relevant control. Background
loading failures preserve search focus and input. Touch opening focuses the
panel without forcing search. Tool and skill lists use the existing Details
save footer, including long lists and enlarged text.

Native captions and search prompts use the app's muted color. Refresh is a
measured 44-point target, and Speed uses a scalable menu at accessibility text
sizes. Recovery explanations sit outside disabled controls so they remain
readable. The reconnect caption measures 4.91:1; required-skill guidance measures
4.99:1 in light mode and AX3 and 6.44:1 in dark mode on both devices.

Required skills stay enabled and are included in saves. Generic descriptions
and duplicate required labels are removed. Failed saves preserve the draft,
and successful saves persist through reopening settings. Explicit settings and
capability retries share one helper that removes the previous failure before
loading again. A successful retry no longer leaves a stale error banner.

## Validation and source states

The artifact root is `/Volumes/DevSSD/scratch/wildbots-design-review`.
`models-source-commands.json` records both fingerprint commands.

- Web: 73 focused tests and typecheck pass. The production build and 43 after
  captures use source `b17a1150`; the final focus-only source is `997304f6` over
  226 inputs. Review 35 verified that the captured paths are unchanged and
  checked the regression tests for background failure, failed writes and reopen.
- Native: complete 26-state flows passed on each device, followed by focused
  caption and retry runs. All passed without skips. The final source is
  `649a3b8bb98b0920bc1fbaf141fd590662d5e8fa276bc2e2237d6555788111e6`,
  over 242 inputs. Each final device set contains 16 unchanged full-flow images,
  six caption corrections and four error/retry images. The metadata preserves
  each segment's own source, passing receipt, image hash and run window.
- The new retry assertion uses the same error query proved present before
  Retry. The banner is outside the scrolling Form, so an offscreen row cannot
  make the assertion pass. It would fail on the previous code.

`models-web-final-evidence.json` and `models-native-final-evidence.json` identify
all 95 final after images. The baseline has 35 web and 52 native images.
Coverage includes wide and narrow web layouts, 320 pixels, tablet, dark mode,
200% web text, AX3, search and no results, aliases, favorites, unavailable and
missing choices, confirmation, failed writes, required skills, empty catalogs,
unsupported capabilities and failed loads with retry.

## Screenshots and limits

Six web and twenty native annotated comparisons are rendered under `annotated/`.
Their manifests retain the original screenshots and pointer specifications;
`models-annotated-evidence.json` records all 26 hashes. The iPad unavailable-model
comparison explicitly discloses the after capture's additional scroll.
Failed and superseded attempts remain separate from accepted evidence.
Screenshots will be uploaded with the final full-app PR.

The shared fixture uses production response shapes and realistic raw model and
skill names. No provider, production service or real household was changed.
Native tests exercised the real controls and fixture-backed saves and readback.
They do not prove raw request counts for Keep; that behavior was checked from
source and visible state.

Physical devices, VoiceOver, hardware keyboard, iOS 17, iPad compact width and
AX5 remain unverified. Enlarged native text is AX3. Touch-focus logic is covered
by web unit tests and Base UI source inspection, not a mobile browser keyboard
run. Nonblocking follow-ups from the reviews remain for the whole-app pass,
including empty/unsupported helper copy and VoiceOver grouping of required text.
