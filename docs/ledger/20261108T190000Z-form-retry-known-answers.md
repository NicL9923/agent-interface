# November 8 form retry answers

Base `298c02dfb0e4ca99b77f26be50f21ad43fa48700`, source fingerprint
`sha256:5edb1aada27e687a6bff10ba6b2cea8b0372400c9d61fc97b735a3b5ce7a2b74`.
NicolasLaptop, Fedora Linux, Node 24.22.2, npm 11.19.1, Vitest 5.1.0.

The new `tests/form-retry-ui.test.ts` regression keeps both copies mounted. B starts
its lookup before A sends. B learns of a restart before A's delayed acceptance,
then the acceptance merges A's answers into storage. B chooses to edit and send
again without reloading. Before the fix, its destination is empty rather than
"Marfa". That assertion failed on the base with only the new test added.

Both retry handlers now read the same attempt's admitted answers through the
existing known-answer merge rule before entering editing. The web test verifies
the visible text and toggle, the next saved attempt, and the exact request ID and
message sent. Five additional cases reject missing, older, newer, unconfirmed or
unknown stored answers. A later attempt's record stays intact.

Validation:

- `npm test -- tests/form-retry-ui.test.ts tests/transcript-ui.test.ts` unit-passed
  93 tests across 2 files.
- `npm run typecheck` compiled with no errors.
- `npm run lint` passed.
- The regression failed without the production fix, then passed with it.

No browser session, iOS build, native unit test, simulator or physical device ran.
The Swift handler uses `FormRecords.keepingKnownAnswers`, whose existing native
tests cover its decision table. Those tests and the changed native interaction
still need Xcode on the Mac Mini. Linux results do not establish native behavior.

The other entry points were checked in code: initial form restore, delayed
acceptance, interruption polling, refusal retry and explicit send-again. Only
explicit send-again could discard the already-stored answers while the form
stayed mounted. The API and stored-record formats are unchanged.
