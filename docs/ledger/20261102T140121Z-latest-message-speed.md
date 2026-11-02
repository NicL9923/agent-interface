# November 2 faster latest messages on chat open

Branch `t3/latest-message-speed`, rebased on `ee0a39c` (#216). Source fingerprint before
this entry: `sha256:e7d247da7d2d3459722aea7a2b86d3e5f914beba27da191bd3977f17d4bfd268`
(1352 source files). Node 26.10.0 and 24.21.0 ran the web checks, Python 3.14.7 the add-on
checks, and the Mac mini's Xcode 27 toolchain the native checks through
`.agents/tools/validate-ios.sh`.

## What changed

- **Add-on reads:** `agent-interface.open` and `agent-interface.discover` run on a four-worker
  add-on queue, one at a time per assistant, instead of the native socket's read loop. Waiting
  reads hold no thread and never take Hermes's native RPC workers. A global open lock became one
  lock per assistant. Decorated history is reused for up to ten minutes while its history,
  journal, database stamps and redaction state are unchanged.
- **Timing:** each open reports its phases. `GET /api/bots/:id/conversation` sends a
  `Server-Timing` header outside the body, so ETags and 304s are unchanged.
- **Stale answers:** an open answer that newer frames superseded is read again before it can
  change live state.
- **Web:** pointing at, pressing or focusing a home row prefetches that chat's first page into
  the cache the chat opens from. Prefetch state belongs to the signed-in account.
- **iOS:** opening a chat reads the draft and the conversation together and still applies the
  draft first. Home refreshes up to three likely chats' cached copies.

## Application tests

- `npm run typecheck`, `npm run build` and `git diff --check` passed on the rebased head.
- Vitest passed 1,662 tests in 118 files on both Node 26.10.0 and Node 24.21.0.
- `npm run test:py` passed 34 files; `npm run lint:py` passed.
- iOS unit target: 543 run, 2 skipped, 1 failure, the known
  `FixedWaitRuleTests.testUITestsNeverAskIsHittableDirectly`. DailyFlowTests and
  TranscriptFlowTests failed only their known baseline tests. `ObservedChanges.swift` listed
  `homeRequest` twice and missed `openComputer`, which crashed the unit runner on main; fixed.
  `main` changed no iOS files between those runs and the rebase.

## Real Hermes execution

`scripts/spike/maintenance_guard_probe.py` passed 15 of 15 checks in process against Hermes
`acc3cada` with its repair patch, including that a polled add-on read answers through the
connection transport while the only native worker is held. A pooled open over a live gateway
WebSocket was not exercised; host qualification's `extension_probe.py` covers it.

## Visual and browser checks

Headless Chromium against `.agents/tools/preview-app.mjs` on this build: hovering Kitchen
companion issued one first-page read. With every later conversation read delayed by two seconds,
the chat showed its first message 79 ms after the click while the fresh read continued.

## Not exercised

Production latency. The add-on change needs a qualified redeploy, after which `Server-Timing`
on conversation reads shows where the remaining time goes.
