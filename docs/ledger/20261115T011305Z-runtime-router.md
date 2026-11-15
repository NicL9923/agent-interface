# November 15 runtime router and per-assistant capabilities

Branch `t3/runtime-router` from `origin/main` at `907eb1c`, on the Mac mini with Node 24.22.2. Nothing was deployed
by this entry, and Hermes did not take part.

## Change

`createRuntimeRouter` (`src/server/runtime-router.ts`) implements `Runtime` over several runtimes, dispatching on the
assistant each call names. `src/server/index.ts` registers Hermes as the only runtime and the default. Capabilities are
asked per assistant (`capabilities(botId)`, `requireCapability(key, botId)`), steering included. `lookupSubmission`,
`download`, `routines` and `canonicalSubmit` take the assistant where the caller knows it. Event cursors are kept per
runtime: Hermes keeps the `event_cursor` metadata row, so the previous release still reads it after a rollback, and any
other runtime gets `event_cursor:<id>`. The router is added to `src/shared/qualification-inputs.json`, because it
carries every Hermes call, so the next release needs a new qualification receipt.

## Transparency check

To show the router changes nothing in front of one runtime, `createApp` was edited by hand to wrap every runtime the
suite gives it in a one-runtime router, and the whole Vitest suite ran: 3,967 of 3,970 passed, the three failures being
the `127.0.0.2` tests. The first run of this check found two router defects, since fixed: it appended `undefined`
arguments the caller never passed, and it fixed which optional members existed when it was built. The edit was
reverted.

## Red runs

Each line was broken by hand, the named test ran and failed, and the file was restored.

| Break | Test | Failure |
| --- | --- | --- |
| `on()` always returns the default runtime | `sends each call that names an assistant to that assistant's runtime` | 1 failed |
| `capabilities` always asks the default runtime | `answers calls that name no assistant from the default runtime` | 1 failed |
| `byId` no longer refuses an unregistered runtime | `refuses to start without its default runtime` | 1 failed |
| The fan-out stops filtering rows by the runtime they run on | `lists each assistant and routine once` | 1 failed |
| Optional members are always present | `offers an optional member while any runtime has it` | 1 failed |
| A missing member no longer refuses | `offers an optional member while any runtime has it` | 1 failed |
| A lookup without an assistant throws the first runtime's failure | `looks a receipt up on the assistant's runtime` | 1 failed |
| A lookup that only failed answers none | `looks a receipt up on the assistant's runtime` | 1 failed |
| `download` ignores the ID's signature | `downloads a file from the runtime its signature names` | 1 failed |
| Discovery skips the durable-events check | `reads each runtime's events from its own source` | 1 failed |
| The worker's discovery stops at the first failing runtime | `keeps each runtime's cursor` | 1 failed |
| The worker records every runtime's cursor as Hermes's | `keeps each runtime's cursor` | 1 failed |
| `requireCapability` ignores the assistant | `refuses steering only for an assistant whose runtime cannot steer` | 1 failed |
| The steering check names no assistant | `refuses steering only for an assistant whose runtime cannot steer` | 1 failed |
| Hermes's cursor moves to `event_cursor:hermes` | `keeps the event cursor from before per-runtime cursors as Hermes's` | 1 failed |
| Every runtime reads the `event_cursor` row | `keeps the event cursor from before per-runtime cursors as Hermes's` | 1 failed |

Two compile-time guards were broken the same way, with `npm run typecheck` as the test: dropping `watchTurns` from the
router's list of optional members failed it on `everyOptionalListed`, and adding an optional member to `Runtime` failed
it on both that guard and the router's `Required<Runtime>` literal.

## Checks

See the PR for the `check-all` table.
