# November 23 harness driver contract and runtime wiring

Code state: `sha256:96b16636e27781a48dab9fd9e2c35f4d93fe4e6f95850745c158e9a2b5cec271`
on top of `2ee7ec9a`, recorded by `.agents/tools/source-state.py`. The checks ran on
NicolasLaptop with Node 24.

## Contract kit against the four Wave 2 drivers

`tests/harness-all-drivers-contract.test.ts` runs `describeHarnessDriverContract` against Codex,
Claude Code, Grok and Pi, each wired to its stdio mock in `tests/fixtures/harness/`. With
`HARNESS_CONTRACT_DIR` set, a mock plays the contract script named by the turn text and records its
pid, which is how the kit counts and kills live harness processes.

The first run, on the unchanged drivers, failed 16 of 40 checks:

| Driver      | Failure observed                                                                                                                                            | Cause                                                                                                           |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Codex       | `a listener added after close received session.ready, session.closed`                                                                                       | `events()` replayed both events to a listener added after close.                                                |
| Claude Code | `Waiting for session.ready did not settle within 8000ms` in all 7 session checks                                                                            | `session.ready` waited for the CLI's `system/init` frame, which the CLI sends only once a user message arrives. |
| Grok        | `a listener added after close received session.closed`, seen once the fixture used a model the mock serves (7 checks first failed on the placeholder model) | `events()` replayed `session.closed` to a listener added after close.                                           |
| Pi          | `question.asked did not include question contract-choice`                                                                                                   | The contract required its own question ID. Pi's dialogs and Claude's AskUserQuestion carry no question ID.      |

Fixes: Codex and Grok return a no-op unsubscribe from `events()` once closed. Claude Code announces
`session.ready` after the initialize handshake with the ID fixed at launch (`--session-id` or
`--resume`), and a later `system/init` only updates `providerSessionId`. The contract now finds the
question by its text and answers with the ID the driver assigned. The reference driver's
self-test in `tests/harness-driver-contract.test.ts` still shows every check failing on its bug.

## Wiring

`src/server/harness/wiring.ts` adds `createCompositeRuntime`. Each mutation below made its targeted
test in `tests/harness-wiring.test.ts` fail. The original source was restored before the checks
that follow.

| Mutation                                             | Failure observed                                                             |
| ---------------------------------------------------- | ---------------------------------------------------------------------------- |
| Drop the startup `markRunningInterrupted()` sweep    | The crashed Hermes-bot row kept the next message from being claimed.         |
| Sweep before `createHarnessRuntime`                  | The native bot's orphaned run lost its recorded `interrupted` event.         |
| Drop `runtimeOf`                                     | `/api/bots` lost the native assistant, because the router sent it to Hermes. |
| Skip the probe cache                                 | A read inside the cache window probed the binaries again.                    |
| Expire the cache one millisecond late (`<=` for `<`) | The read at exactly the TTL kept the stale answer.                           |
| Start a new probe round per call                     | Two concurrent reads probed each binary twice.                               |

## Checks

- `npm run typecheck && npm run lint && npm run format:check` passed.
- `npx vitest run tests/harness-*.test.ts` passed, 192 tests in 8 files.
- `npx vitest run tests/hermes-qualification.test.ts` passed, 5 tests.
- `.agents/tools/check-all --keep-going` at `570da597` passed typecheck, lint, Ruff, all 4,510
  Vitest tests in 245 files, the production build, and the 52 Python test files. Chromium passed
  142 browser tests. All 142 WebKit tests failed at `browserType.launch` because this Fedora host
  lacks `libicu74` and `libjpeg-turbo8`, the baseline recorded for the durable bot queue. This
  change touches no client code, so WebKit was not rerun in the Playwright container.
