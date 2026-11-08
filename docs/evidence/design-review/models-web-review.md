# 35 models focus recheck (Opus 5.5 High, independent, read-only)

Reviewer provider: Anthropic. Implementer provider: OpenAI. No app edits, builds, runtime, browsers, simulators, machine locks or child agents. Scope is M1 from `34-models-web-recheck.md` and the callers it touches. Tools and Skills stay at 9.0 from 34 and were not re-reviewed.

## Verdict

M1 is fixed. The composer picker closes at 9.0 on desktop and phone. No must-fixes remain.

| Screen | Desktop | Phone | Must-fix |
| --- | --- | --- | --- |
| Composer model picker, reasoning and speed | 9.0 | 9.0 | none |
| Tools | 9.0, carried from 34 | 9.0, carried from 34 | none |
| Skills | 9.0, carried from 34 | 9.0, carried from 34 | none |

## Evidence checked

- `source-state.py` over the same four prefixes returns `sha256:997304f6…3ca48 (226 source files)`, matching the claim.
- I recomputed the fingerprint with only `34-source/src/components/ComposerModelPicker.tsx` swapped in and got `sha256:b17a1150…19ebd7d`, the 34 render state. So the picker is the only fingerprinted file that changed. The test file is outside the fingerprint.
- Both `35-source-manifest.json` entries match the worktree and the `35-source` snapshot by sha256. The picker diff against `34-source` is exactly the patch: two dependency arrays, one guard and comment, and one `setError("")`.
- `models-web-tests-v7.log`: 3 files, 73 tests passed, started 07:40:16. The picker was last modified at 07:39:40 and its test at 07:40:15. `models-typecheck-v3.log` finished clean at 07:40:41. These are mtime checks. I did not rerun them.
- All 43 screenshots in `models-web-final-evidence.json` still match their sha256. The evidence records source `b17a1150`, return code 0 and no browser errors. The stale `web-models-capture-error.png` now sits in `models-captures/failed-before-v4/`, outside `after/`.

## Effect behavior, traced from source

Model error effect, `ComposerModelPicker.tsx:44-46`, now depends on `[error]` only.

- **Failed save while open.** `save` clears `error` at `:84`, awaits, then sets it at `:103`. The value changes, so the effect fires and focuses the message. A second failure with the same text still fires, because the clear and the set land in separate renders.
- **Close and reopen.** The open effect calls `setError("")` before its `!open` early return, at `:57`. Closing clears the error, so reopening shows no stale "Model change" message, and the effect never fires on reopen. Base UI's initial focus lands on search. The updated test closes, reopens, and asserts that the text is gone and search has focus (`tests/composer-model-picker.test.ts:85-88`).
- **Confirm and cancel.** Both already cleared the error (`:102,144`). No change.

Inference error effect, `:47-50`, now depends on `[settingsError, settings]` and requires `settings`.

- **Load failure on open.** The open effect sets `settings` to undefined in the same batch that starts the GET (`:60`). Segmented controls only render once `settings` exists (`:129`), so no write can run while the GET is pending. A GET rejection therefore always arrives with `settings` undefined, and the guard skips focus and scroll. The message still renders as `role="alert"` at `:139`, so screen readers announce it without moving focus. This is the right pattern for a background failure.
- **Write failure.** `changeSettings` clears the error at `:69`, and a rejection sets it at `:74` while `settings` still holds the last good value. The guard passes and focus moves to the scoped Reasoning or Speed message. That is the same as the accepted 34 behavior.
- **Settings change alone.** `setSettings` only runs after a successful GET or PATCH, and both paths clear the error first. Adding `settings` to the dependencies cannot refocus a stale error.
- **Reopen after a write failure.** While closed, `settings` and `settingsError` keep their values. On the first render after reopening, neither dependency has changed, so the effect stays quiet. The open effect then resets both. The pre-existing one-frame stale render before that reset is not new and not focus-related.

The new tests would fail on the 34 code. The delayed-GET test types "House" into search and then rejects the GET. Under `[settingsError, open]`, focus would have jumped to the alert, and the `activeElement` assertion at `:102` would fail. The reopen test would fail on the stale text. The write-failure test now asserts focus on the alert at `:174`, which closes the 34 coverage gap.

## Captures

Reusing the 34 frames is sound for this delta, but it is a source argument and not a new render. Every composer error frame in `capture-design.js:372-396` comes from a write failure while the picker is open: a PATCH failing on Ultra, or a model save failing. The capture's GET always succeeds (`:166-173`), and no frame closes and reopens before a shot. In each captured path, the old and new effects fire the same way, so the DOM, focus target and scroll position match. All of these frames came from the `b17a1150` render. No frame shows the load-failure or reopen behavior. The unit tests carry that.

## Composer model picker: 9.0 desktop, 9.0 phone

The accepted 34 frames show each error placed by its control, readable at 6.35:1, and in view below the sticky header at both widths. Focus now moves only for failures the user caused. That was the last blocker.

### Non-blocking, carried

- The error box sits flush with the popover's bottom edge. `scroll-padding-bottom: 12px` on `.model-popover` would fix it.
- "Model change" names the area, not the outcome. "Model not changed" reads better. "Request failed (503)" belongs to the shared copy pass.
- The inference load error has no Retry. Closing and reopening is the only way to retry, while the model catalog error offers "Retry loading models". This predates the delta and the real trigger is rare, so it's tracked rather than blocking.
- W8 triple naming, W9 Reasoning folding to 4×2 on desktop, P-c search announcements, and `aria-current` over `aria-pressed` are unchanged from 33.

### Notes on the delta, not defects

- The write-failure assertion queries the first `[role="alert"]` in the document. It works because only one alert exists in that test. Scoping it to `.inference-controls` would make it sturdier. Optional.
- Clearing `error` on close means a model save that fails after the user closes the picker mid-save leaves no message on reopen. The trigger still shows the old model name, so the outcome is visible. Acceptable.

## Limitations

- No runtime check of this delta. Focus behavior is verified by source tracing and by jsdom tests with Base UI 1.9.0, not in a real browser or screen reader.
- Test and typecheck freshness rests on mtimes and the matching snapshot hash, not on a run fingerprint.
- Real iOS and Android keyboard behavior for touch-open focus is still unverified, as noted in 34.

## Remaining must-fixes

None.
