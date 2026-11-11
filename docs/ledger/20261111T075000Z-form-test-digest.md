# November 11 form tests that raced a thread-pool digest

Branch `t3/transcript-form-flake` over `origin/main` at `589f542`, on NicolasLaptop (Fedora 44, Linux x64, 32 cores), Node 24.22.2. The change
is `tests/setup-ui.ts` and a new `tests/setup-ui-digest.test.ts`. No product code changed.

## The flake was already fixed for the named test

"names a required field left empty and sends nothing" failed in four recorded full-suite runs: `20261108T150000Z-device-routing-...`
(one run), `20261109T205000Z-capabilities-skip-voice-wait` (two of four), `20261110T060000Z-turn-stream` and `20261110T081658Z-keep-reply-row`
(one each). All four predate #316 (`4b8fdc2`, Nov 10 09:16), which added `ready()`: wait for Send to be enabled, because the form's receipt
lookup derives its request ID with `crypto.subtle.digest`, which settles on Node's thread pool in real time, outside the pinned clock and
outside `act()`. A Send clicked while it is still disabled does nothing, so no field is marked invalid.

I did not reproduce it on current `main`. I reproduced it on the file as it stood before #316, and found the same cause still failing
three sibling form tests under heavier saturation.

## Reproduction

Real load did not do it: 6 loaded full `npm test` runs of `main` (8 cores shared with 32 busy loops) never failed the named test, and
`transcript-ui.test.ts` passed 7 of 7 on 1 to 2 cores with 20 to 40 loops (4 whole-file runs, 3 of its form tests). Those runs did fail other tests, listed below. What
reproduces the cause is saturating the thread pool the digest queues on: a setup file (kept outside the repository, run through a copy of
the vitest config) starts N concurrent `pbkdf2` jobs of 100,000 SHA-512 iterations that restart as they end, so each digest waits behind them.
`vitest run -c <that config> tests/transcript-ui.test.ts -t "form replies"`:

| File | Jobs | Runs | Red |
| --- | --- | --- | --- |
| before #316 (`git show 4b8fdc2^:tests/transcript-ui.test.ts`) | 6 | 3 | "works with field IDs..." and "refuses answers longer..." 3 of 3; the named test 0 of 3 |
| before #316 | 10 | 3 | **the named test 3 of 3** (`expected null to be 'true'` on `aria-invalid`), plus "stops looking after 100 refused attempts", "works with field IDs...", "refuses answers longer..." |
| before #316 | 14 | 3 | the same four, 3 of 3 |
| `main` | 6 | 4 | none |
| `main` | 10 and 14 | 4 each | "stops looking after 100 refused attempts" 8 of 8: `expected true to be false`, Send never enabled inside `ready()`'s 1 s, because it waits for 100 digests in a row |
| `main` | 24 | 3 | that one and "finds a form sent after many refusals, however many" 3 of 3 |
| `main` | 64 | 3 | those two and "shows a form sent from another tab or device as sent, and sends nothing" 3 of 3 |

The named test is green on `main` at every level; `ready()` fixed it. Its siblings are the same defect, and #316's wait only buys the digest
a second.

## Change

`tests/setup-ui.ts` answers `crypto.subtle.digest` for SHA-1, SHA-256, SHA-384 and SHA-512 from `node:crypto`, which settles in a microtask
that `act()` already flushes, in every jsdom file, and hands any other algorithm to Web Crypto. `src/shared/retry-id.ts` is the only digest
the web app uses. `tests/setup-ui-digest.test.ts` pins that it returns what Web Crypto returns (views into a larger buffer, plain buffers,
lower-case names), that it settles in three microtask turns with no timer, and that MD5 still reaches Web Crypto's `NotSupportedError`.
With the replacement renamed away, the settling test fails. `ready()` stays: it waits for what the person waits for, and no longer for time.

## After

Same hog, `tests/transcript-ui.test.ts`, `tests/live-reply-ui.test.ts` and `tests/form-retry-ui.test.ts` (140 tests):
24 jobs, 2 runs, 64 jobs, 2 runs: 0 red in all four, where `main` fails 2 and 3 tests at those levels.

Loaded full `npm test` (8 cores, 32 loops), 3 runs of this branch against the 6 of `main`, tests that failed in a run, by file:

| File | `main`, 6 runs | this branch, 3 runs |
| --- | --- | --- |
| `account-transitions-ui.test.ts` | 6 | 3 |
| `live-updates-ui.test.ts` | 3 | 1 |
| `message-markdown.test.ts` | 3 | 0 |
| `plain-text.test.ts` | 0 | 3 |
| `reply-keys.test.ts` | 2 | 1 |
| `send-timing.test.ts` | 1 | 0 |
| `streaming-hold-back.test.ts` | 2 | 1 |

The named test failed in none of the nine. Every file in the table fails the same way on `main` under this load (15 s timeouts and virtual-clock
tests starved), none uses Web Crypto, and none is changed here. `plain-text` and `send-timing` are fixed on `t3/no-wall-clock-tests`.

## Checks

`.agents/tools/check-all` on this branch:

check      result   queued  run    counts
typecheck  pass     -       1.1s   -
lint       pass     -       0.3s   -
ruff       pass     -       0.0s   -
test       pass     14m20s  32.1s  206 files, 3674 tests
build      pass     -       2.9s   892 modules
e2e        pass     2m42s   1m18s  40 tests
py         skipped  -       -      no changes to Python or a file the Python tests read against origin/main

All 6 checks passed (18m58s total, 17m03s of it queued for heavy slots)

## Not done

A full loaded run does not saturate one worker's thread pool the way the hog does, so no full run reproduced the original failure; the
hog is the reproduction, and it is not in the repository. Other tests that await `crypto.subtle.digest` outside the UI files have no
equivalent shim; `retry-id.test.ts` is a node file and awaits the real digest on purpose.
