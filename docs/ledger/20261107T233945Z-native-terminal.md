# November 7 system terminal in the iOS app, server and page

Based on main `a3dfff61abfebb822b473b58815c7918ca3eeb88`, uncommitted. Fingerprint
`sha256:e535eeb7c60dfdf5e6709590abcc4fc42c4744b862fac78e8da1c49b3d25aa34` from
`python3 .agents/tools/source-state.py` over `src/server/native-auth.ts`,
`src/server/auth.ts`, `src/server/store-accounts.ts`, `src/server/store.ts`,
`src/server/store-database.ts`, `src/server/computer.ts`, `src/server/app.ts`,
`src/native-terminal.ts`, `src/native-terminal.css`, `native-terminal.html`,
`src/lib/terminal-input.ts`, `vite.config.ts` and the four test files below. On
NicolasLaptop, Linux, Node 24.22.2. This covers native identity confirmation, the
terminal for native sessions and the `/native/terminal` page. The terminal request
card and the iOS app were built in parallel and are recorded separately.

Application checks: `npm run typecheck`, `npm run lint` and `npm run build` passed.
The full Vitest run passed 2,013 of 2,015 tests. The two failures need updates
outside this part: the route table in `src/server/bot-access.ts` needs
`POST /api/auth/native/confirm`, and the iOS contract fixture `computer.json` needs
regenerating for the new terminal reason a native session sees.

New and changed tests: `tests/native-api.test.ts` (sign-in records a confirmation;
every refusal of `POST /api/auth/native/confirm`), `tests/computer-api.test.ts`
(native confirmation window, page ticket, Origin, session, type and expiry checks,
revocation, audit and alerts), `tests/native-terminal-page.test.ts` and
`tests/terminal-input.test.ts`.

Mutants: each protected line was broken by hand, separately, and its focused test
failed, then the source was restored. In `computer.ts`: the page Origin check, the
ticket type check, the ticket session check, the native stand-in limited to
requests without a bearer, the native confirmation lookup (ignored, or replaced by
the web one), and the audit user taken from the ticket's session. In
`native-auth.ts`: the bearer-only check, the same-account check, the 10 minute and
missing-proof checks, `confirmation_expired` in place of `session_expired`, and
Google's issue time on sign-in. In `store-accounts.ts`: the later-of-two
confirmation rule. In the page: input refused while disconnected, the emulator
reset per attachment, the server's size range, one ended report, ignoring a replaced
socket, the text area that cannot take focus, tap versus drag, the scroll remainder,
the normal-buffer versus full-screen scroll choice, the ticket path pattern, Control
characters, Return as a carriage return, the paste limit and retrying a failed
emulator load. In `terminal-input.ts`: the byte limit, four-byte characters,
application cursor keys and the Control character set. One mutant, looking up the
web table before the native one, was equivalent because the tables never share a
hash, and was replaced by the two lookup mutants above.

Browser check: the built page ran in Playwright's Chromium with touch, against a
local fake terminal socket. Real xterm 6 rendered, a tap reported `focus` and left
the helper text area unfocused, a drag scrolled 23 rows of scrollback, a drag in the
alternate screen sent the arrow keys xterm sends for a wheel, and the bridge sent
`ls\r`, `\x03`, `\x1b[A` and a paste. A first version that relied on constructed
wheel events did not scroll: xterm's scrollback reads the legacy `wheelDeltaY`,
which Chromium sets to 0 on a constructed event.

Not exercised: a real tmux shell, a WKWebView on iOS, Google sign-in, production.
