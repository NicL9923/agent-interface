# Platform improvements — guard red-runs and Vitest shared-worker isolation

## Red-run verification of new guard tests

To prove the new protection tests fail when their guard is removed, four guards were hand-broken once and verified against `npx vitest run tests/platform-guards.test.ts tests/vault-ui.test.ts tests/code-highlight-retry.test.ts` before restoring:

1. **RFC 9110 weak ETag comparison (`src/server/etag.ts:24`)**: removed `stripWeak(candidate)` from `etagMatches`.
   - Red: `tests/platform-guards.test.ts > RFC 9110 ETag matching > matches exact, weak/strong normalized, multi-tag, array, and wildcard headers` failed (`expected false to be true`).
2. **Per-user SSE stream cap (`src/server/event-stream.ts:79`)**: disabled the `MAX_STREAMS_PER_USER` check.
   - Red: `tests/platform-guards.test.ts > per-user SSE stream cap and bounded computer viewers > enforces MAX_STREAMS_PER_USER with 429 and frees capacity on disconnect` failed (`expected 200 to be 429`).
3. **Web `VaultPanel` 4xx non-locking parity (`src/components/VaultPanel.tsx:100`)**: disabled the definite-4xx branch.
   - Red: `tests/vault-ui.test.ts > reports definite 4xx vault rejections and clears secrets without locking the panel` failed (received `"Hermes could not confirm this change. Reload and review..."` instead of `"Incorrect master password. Secret fields have been cleared."`).
4. **Syntax-highlighter chunk retry (`src/components/MessageMarkdown.tsx:37`)**: commented out `highlighterLoad = undefined` in `.catch()`.
   - Red: `tests/code-highlight-retry.test.ts > retries loading the syntax highlighter chunk after a transient import failure` failed (`expected undefined to be 'const'`).

After restoring all four lines, all 29 tests across the three files passed.

## Vitest shared-worker isolation (79 exceptions -> 0)

Three root causes explained all 79 file-isolation exceptions previously listed in `vitest.config.ts`:

1. **jsdom 31 `focusFixupPending` interval deadlock under fake timers (`tests/setup-ui.ts`)**: removing a focused node while fake timers were active started jsdom's internal 16ms `renderingUpdateNodejsInterval` on the fake clock. Calling `vi.useRealTimers()` without advancing one frame discarded the fake timer while leaving jsdom's closure holding the non-null handle, permanently stalling `window.requestAnimationFrame` for later files in the same worker. Flushing `if (vi.isFakeTimers()) vi.advanceTimersByTime(20)` before `vi.useRealTimers()` fixed 53 cascading UI failures.
2. **File-scoped DOM/URL/navigator/viewport leaks (`tests/setup-ui.ts`)**: tests that called `Object.defineProperty` without `writable: true` (for `HTMLDialogElement.prototype.showModal`/`close`, `HTMLElement.prototype.scrollIntoView`, `URL.createObjectURL`/`revokeObjectURL`) or mutated `document.head`, `navigator.serviceWorker`, or viewport sizes leaked across files. Snapshotting original descriptors once per worker, clearing `document.head` in `afterEach`, and restoring the snapshotted descriptors in `afterAll` (preserving `beforeAll` file-scoped stubs) fixed the remaining UI failures.
3. **Timer spy resurrection after `vi.useRealTimers()` (`tests/conversation-events.test.ts:718-744`)**: calling `vi.spyOn(globalThis, "setTimeout")` while fake timers were installed caused `afterAll`'s `vi.restoreAllMocks()` to re-apply the captured fake `setTimeout` after `afterEach` had already restored Node's real timers, stalling `setTimeout` for all subsequent Node files in the worker. Wrapping `globalThis.setTimeout`/`clearTimeout` directly and restoring in `finally` eliminated all 9 cascading Node server timeouts.

### Shuffled single-worker verification

Both reference seeds pass 100% with `isolated = []` (all 227 test files in a single `shared` worker):

- `npm test -- --sequence.shuffle.files --sequence.seed=731 --maxWorkers=1 --reporter=dot`: **227 passed (227)**, **4132 passed (4132)** (147.34s).
- `npm test -- --sequence.shuffle.files --sequence.seed=1907 --maxWorkers=1 --reporter=dot`: **227 passed (227)**, **4132 passed (4132)** (146.59s).
