# Keep the startup request deadline through body reading

Base: `589c68c6`, latest origin/main when this worktree was created.
Source fingerprint: `sha256:c8adc2b8dc681fe750a3a450cf185e5f0e416ae113a18b6f454988579dcd4262` over the named production and test files.
Implemented by GPT-6.1 Sol on NicolasLaptop with Node 24.22.2.

Sol's independent review of #332 reproduced a stalled early-bootstrap body. Fetch had already
resolved its headers, so takeStartupRead removed cancellation forwarding before client-api
consumed the body. The app's 20-second timer could no longer abort that fetch.

The claimed startup read now returns its response promise and a release function. The API
caller releases forwarding in its existing final cleanup, after body consumption or failure.
The early-bootstrap and linked-chat paths use this same caller. Ordinary fetch, fallback after
an early network failure, cached reads, writes, and account checks retain their existing paths.
The boot.js handoff format and the server and native-client contracts are unchanged.

## Regression and validation

The regression runs the real boot.js and client API against a real loopback HTTP server.
The server sends headers and an unfinished JSON body. The test lets those headers arrive,
checks that the request remains pending just before 20 seconds, then advances the clock to its
deadline. Before the fix the request still had not settled, and the new test failed. After the
fix it rejects with status 504 and CONNECTION_UNAVAILABLE, its startup signal is aborted, and
there is no duplicate fetch. The server is closed even when the test fails.

`npx vitest run tests/startup-read.test.ts tests/client-api.test.ts` passed 69 tests in two files.
`npm run typecheck`, `npm run lint`, and `git diff --check` passed. `npm ci` completed.
Logs: `.private/startup-body-red.log` and `.private/startup-body-green.log`.

Full check-all and Chromium/WebKit validation are pending. Independent review is incomplete:
Anthropic has a weekly usage limit and xAI has exhausted its balance. This OpenAI-authored
change remains unmerged until an eligible reviewer is available. No production deployment or
Apple build ran. A production release is required after this application change merges.
