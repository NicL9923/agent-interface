# November 10 two UI tests that raced a Web Crypto digest

Branch `t3/flaky-ui-tests` over `origin/main` at `6e6d398`, on NicolasLaptop (Fedora 44, Linux x64, 32 cores).
The test change is `abeb99f`; this entry is the only other commit. Node 26.13.0 (through `fnm`) for every
reproduction, Node 24.22.2 and 26.13.0 for the full suite. No product code changed. No server, Python, iOS or
Hermes code ran outside the test suite.

## Fault

Both tests failed in CI on `main` in the Node 26.13.0 job and passed on rerun:

- `tests/transcript-ui.test.ts`, "form replies > names a required field left empty and sends nothing", run
  42762359554 at `2d461e3`: `expected null to be 'true'` on `aria-invalid`.
- `tests/live-reply-ui.test.ts`, "a live reply's row when it is saved > streams a retried turn's reply in a new
  node and hands it to that reply's saved copy", run 42818816185 at `f0ae0a5`: `expected [] to deeply equal [ 'u1' ]`.

Both reach `derivedId` in `src/shared/retry-id.ts:25`, which awaits `crypto.subtle.digest`. Node runs the digest on
its libuv thread pool and resolves it in real time. The pinned clock does not move it, and neither `act()` nor
`advance()` waits for it. Under load it settles after the test's next step.

- The form: `FormReplyCard` starts in `looking` (`src/components/FormReplyCard.tsx:124`) and derives each attempt's
  ID for `GET /submissions/:id` (line 156). Until that settles, the fields and Send are disabled (lines 265 and 272).
  The test's `render()` advances 20 fake ms, then clicks Send. When the digest is late, the click lands on a disabled
  button and does nothing, so no field is marked invalid. In those runs "sends nothing" passed without the validation
  ever running.
- The retry: `useTurnRetry.run` derives the retry's ID (`src/app/use-turn-retry.ts:78`) before it posts. The test
  clicked Retry, advanced 0 ms, then read the posted retries. When the digest is late the POST has not happened yet.

The brief's lead was that Retry was disabled by `retry.busy || retry.checking && !retry.resendable`
(`src/app/Conversation.tsx:327`) while a receipt check ran. A probe, not committed, recorded the button at the click
in 12 failing runs under load: every time it was enabled, read "Retrying…" right after the click, and the POST
arrived one 10 ms real-time poll later. Nothing between the click and `fetch` awaits anything but the digest.

## Test defect, not product

A person cannot hit either race. During the form's lookup, Send is disabled and shows a spinner, and a click does
nothing. Validation runs when Send is enabled and clicked, and focuses the field. Retry turns into a disabled
"Retrying…" on the click, before the digest, and the POST follows. Only the tests read state before the
work they started had settled.

## Change

`tests/transcript-ui.test.ts`: a `ready()` helper waits for Send to be enabled, which is what the person waits for.
`fill()` and the malformed-record test already waited on the same state in two different ways; both now use `ready()`.
It is added before the first Send in three tests that clicked or typed during the lookup:

- "names a required field left empty and sends nothing" (the CI failure);
- "works with field IDs that name what every object inherits": same defect, and it failed 4 times in 200 under load
  before the change;
- "refuses answers longer than a message can be, saying by how much": same order. It never failed in these runs.

`tests/live-reply-ui.test.ts`: after the click, the test waits for Retry to leave, which happens once the server takes
the retry, then asserts the posted retries exactly. Nothing an assertion checks changed, and there is no retry setting
or longer timeout.

## Reproduction and counts

`repro.sh LABEL RUNS PARALLEL BUSY -- <vitest args>` (kept outside the repository) runs
`fnm exec --using=v26.13.0 npx vitest run <args> --reporter=json` RUNS times, PARALLEL at once, with BUSY shell busy
loops (`while :; do :; done`), and counts failing tests from the JSON reports. Vitest runs with the repository's
config, as CI does: default `forks` pool, isolation on, 15 s test timeout. For "before", the `origin/main` copies of
the two files ran as `tests/before-*.test.ts`, under the same conditions and in the same session, then were deleted.

| Condition | Test | Before | After |
| --- | --- | --- | --- |
| File alone, 1 at a time, no load, 50 runs | form | 0 / 50 | 0 / 50 |
| File alone, 1 at a time, no load, 50 runs | retry | 0 / 50 | 0 / 50 |
| File, 16 copies at once and 16 busy loops, 200 runs | form file | 12 / 200 (8 the CI test, 4 "field IDs") | 0 / 200 |
| File, 16 copies at once and 16 busy loops, 200 runs | retry | 80 / 200 | 0 / 200 |
| Full `vitest run`, 4 copies at once, 16 runs | form | 2 / 16 | 0 / 16 |
| Full `vitest run`, 4 copies at once, 16 runs | retry | 8 / 16 | 0 / 16 |

Every failure before the change carried the CI message. A first exploratory round of the loaded condition gave 2 / 64
for the form file and 33 / 96 for the retry, at `6e6d398`.

The full-suite rows ran at 4x oversubscription, and other tests failed there before and after, none through
the digest: `plain-text` "reads adversarial text in one pass" (a 2 s wall-clock budget, 9 and 8 runs), `message-markdown`
"renders a reviewed input live as its own prefix: 0" and `streaming-hold-back` "returns a prefix…" (15 s timeouts),
`send-timing` "counts a growth notice…" (1 before) and `group-watch` "leaves no conversation watcher behind…" (1 after).
The last two are server tests that depend on real-time windows. They are listed in the report and not changed here.

`tests/form-retry-ui.test.ts` opens a second form copy whose lookup must reach a held mock before the test resolves
it. It ran 200 times under the loaded condition with no failure, and is unchanged.

## Red proof

Each line was broken by hand on the fixed tests, the test run, and the source restored:

| Broken | Red |
| --- | --- |
| `useTurnRetry.run` returns before posting | retry test: Retry button still present, `expected <button …> to be null` |
| The retry posts without `retryOf` | retry test: `expected [] to deeply equal [ 'u1' ]` |
| Required fields never reported (`src/shared/reply-cards.ts:288`) | form test: `expected [[ '/bots/shared/messages', … ]] to have a length of +0 but got 1` |

The third row shows the form test now covers the validation it is named for.

## Checks

At `abeb99f`:

- `npm ci`, `npm run typecheck` and `npm run lint` passed.
- `npx vitest run tests/transcript-ui.test.ts tests/live-reply-ui.test.ts`: 2 files, 131 tests passed (Node 24.22.2).
- `npm test`: 185 files, 3,085 tests passed on Node 24.22.2, and the same on Node 26.13.0.
- `npm run build` passed. `npm run test:e2e`: 20 Chromium tests passed, after waiting about 20 s for another
  worktree to free port 4173.

## Not done

GitHub's 4-vCPU runner was not used; the load here stands in for it. No independent review ran on this branch.
