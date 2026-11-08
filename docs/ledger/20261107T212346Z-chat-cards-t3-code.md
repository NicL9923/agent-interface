# November 7 T3 Code thread, email draft and form card validation

Code state `b88de3a7`, rebased on `a3dfff6` (#263), on NicolasLaptop, Linux, Node
24.22.2 and Python 3.14.10. The ledger-only commit after it does not change these
inputs. No live Hermes, T3 Code MCP connection, mail client, screen reader or physical
device was exercised.

- `npm test`: 149 files and 2,061 tests passed.
- `npm run typecheck`, `npm run lint` and `npm run build`: passed.
- `python3 scripts/run-python-tests.py`: 37 files passed on the first commit, `c93cef9`.
  No Python file changed in the branch; `src/shared/inline-ui-instructions.json`, which
  the add-on reads, did not change after that run.
- `ruff check .`: not run; ruff is not on PATH in this shell. No Python file changed.
- Mutants: 31 distinct hand mutations across `src/shared/reply-cards.ts`,
  `src/shared/t3-code.ts`, `src/shared/retry-id.ts`, `src/components/FormReplyCard.tsx`,
  `src/app/Conversation.tsx` and both server copies of the `submission_conflict` code.
  Each was applied alone and its focused suite failed, then the source was restored.
  One survives by design: the card's own-property read of a null-prototype problem map
  cannot differ from a plain read. Separately, the stale-request-ID test fails against
  `f50ef12` only through an act() warning, because that old race needs Web Crypto to
  finish out of order. The current card has no lagging ID state for that race.
- Visual: the real app server over a scripted runtime, in headless Chromium 1248 at
  1280x860 and 390x844, light and dark. T3 Code thread (started and starting), email
  draft, form (empty, required error, sent through the real message route with a reply).
  No page errors, console errors or CSP reports. The screenshots were taken at
  `b685483`; later commits changed no rendering.

Independent review: GPT-6.1 Sol at high effort, four scoped passes. Every finding was
fixed except the test-reproduction limit noted above. The last fix, comparing a late
answer's own attempt in the saved-record guard, was the reviewer's suggested fix and was
confirmed red and green by hand, not reviewed again.
