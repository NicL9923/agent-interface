# November 8 form retry answers

Base `298c02dfb0e4ca99b77f26be50f21ad43fa48700`, source fingerprint
`sha256:c1313b2c9a420861b2134ce739a8e297e2b50a2ababeaa58f7a257b0b033ba74`.
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
  94 tests across 2 files.
- `npm run typecheck` compiled with no errors.
- `npm run lint` passed.
- The regression failed without the production fix, then passed with it.
- Removing the web retry restoration preserved a retired field in storage and
  failed the new retired-field test. The production code was restored afterward.

No browser session, iOS build, native unit test, simulator or physical device ran.
The Swift handler calls the extracted `FormRecords.retryAnswers` helper, which
uses the existing known-answer decision table and restores only current fields.
A new native regression passes the still-mounted blank answers alongside the
acceptance saved by another copy and covers unknown, unconfirmed and other
attempts. That test, its mutation check, compilation and the changed native
interaction still need Xcode on the Mac Mini. Linux results do not establish
native behavior.

The other entry points were checked in code: initial form restore, delayed
acceptance, interruption polling, refusal retry and explicit send-again. Only
explicit send-again could discard the already-stored answers while the form
stayed mounted. The API and stored-record formats are unchanged.

Claude Opus 5.5 at high effort approved the original diff and the native-test
extraction through `43cf206`. Its test-strength note was applied afterward: the
native bad-state cases now keep a nonblank mounted answer, so resetting them to
defaults cannot pass. That final change touches only the unrun native test. The
web checks above ran at source fingerprint
`sha256:1949aeafcbb94381c4b0b48ad6b3f77a2bd276478d8f76f4932f239b3b6d7ea4`;
their inputs are unchanged in the final state.
