# November 12 fixes from the review of the consolidated performance branch

Branch `t3/speed-up-chat-open`, Node 24.22.2 and Python 3.14.10 on NicolasLaptop. An independent review (Claude Opus
5.5, approved by Nicolas because GPT-6.1 Sol and Grok were unavailable) of the whole branch found no issue in privacy,
cache staleness, stream races or compatibility with installed iOS builds and older add-ons, and the findings below.

- **Projection memo budget per session.** Fixed by one gateway budget; red runs are in
  `20261112T035301Z-projection-memo.md`.
- **Today's 2-turn window read 20 turns.** Reverted to the latest page; see the correction in
  `20261112T063000Z-today-answers-without-the-slowest.md`.
- **The shared test fake still refused windows that start inside a turn.** `tests/helpers/fake-hermes.ts` now cuts
  there and keeps the turn's prompt, as `history_window` does. No test reached that path, checked by making it throw:
  nothing failed. `tests/live-turn-runtime.test.ts` "reads a turn whose prompt is hidden from its first reply, as a cut
  window" drives a turn whose prompt is hidden, with Hermes's `started_at`, through the real runtime; with the old
  refusal back in the fake it fails. Such a turn's event names no message before it, as any turn that starts its window
  does, so a client that does not hold its first reply yet reads once to place it: once per routine turn, where each
  turn read used to carry the whole history.
- **`before` without `turns` answered an empty page.** It now answers a page of 20 turns; `tests/app.test.ts` fails with
  the default removed.
- **`limiter` kept its slot when a call threw before returning a promise.** It now frees it;
  `tests/concurrency.test.ts` "frees the slot of a call that throws before it returns a promise" times out without the fix.
