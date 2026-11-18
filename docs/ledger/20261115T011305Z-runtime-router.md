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

| Break                                                            | Test                                                                  | Failure  |
| ---------------------------------------------------------------- | --------------------------------------------------------------------- | -------- |
| `on()` always returns the default runtime                        | `sends each call that names an assistant to that assistant's runtime` | 1 failed |
| `capabilities` always asks the default runtime                   | `answers calls that name no assistant from the default runtime`       | 1 failed |
| `byId` no longer refuses an unregistered runtime                 | `refuses to start without its default runtime`                        | 1 failed |
| The fan-out stops filtering rows by the runtime they run on      | `lists each assistant and routine once`                               | 1 failed |
| Optional members are always present                              | `offers an optional member while any runtime has it`                  | 1 failed |
| A missing member no longer refuses                               | `offers an optional member while any runtime has it`                  | 1 failed |
| A lookup without an assistant throws the first runtime's failure | `looks a receipt up on the assistant's runtime`                       | 1 failed |
| A lookup that only failed answers none                           | `looks a receipt up on the assistant's runtime`                       | 1 failed |
| `download` ignores the ID's signature                            | `downloads a file from the runtime its signature names`               | 1 failed |
| Discovery skips the durable-events check                         | `reads each runtime's events from its own source`                     | 1 failed |
| The worker's discovery stops at the first failing runtime        | `keeps each runtime's cursor`                                         | 1 failed |
| The worker records every runtime's cursor as Hermes's            | `keeps each runtime's cursor`                                         | 1 failed |
| `requireCapability` ignores the assistant                        | `refuses steering only for an assistant whose runtime cannot steer`   | 1 failed |
| The steering check names no assistant                            | `refuses steering only for an assistant whose runtime cannot steer`   | 1 failed |
| Hermes's cursor moves to `event_cursor:hermes`                   | `keeps the event cursor from before per-runtime cursors as Hermes's`  | 1 failed |
| Every runtime reads the `event_cursor` row                       | `keeps the event cursor from before per-runtime cursors as Hermes's`  | 1 failed |

Two compile-time guards were broken the same way, with `npm run typecheck` as the test: dropping `watchTurns` from the
router's list of optional members failed it on `everyOptionalListed`, and adding an optional member to `Runtime` failed
it on both that guard and the router's `Required<Runtime>` literal.

## Review fixes

GPT-6.1 Sol's review found three defects with two runtimes. Each fix has a test over two fake runtimes that throw on
anything a test did not configure.

- The worker asked the default runtime whether it had durable events before its per-runtime loop, so a disconnected
  Hermes stopped every other runtime's discovery and cursor. The check now runs inside each runtime's own failure
  boundary: the router refuses a source without durable events in `discoverEvents`, and the worker asks a lone runtime
  itself.
- `listBots()` failed whole when one runtime failed, so `/bots` failed for everyone. A failed runtime now lists its last
  good roster with every assistant `disconnected`, as Hermes marks its own after a failed read. Every consumer already
  treats a disconnected row as proving nothing. Before a runtime has answered once there is nothing to keep, so the
  listing still fails rather than leave its assistants out. A slower, older read never replaces a newer one's roster.
- The routine inventory stays all or nothing, now on purpose and documented on `Runtime.routines`. Check-in
  reconciliation (`MainAssistants.reconcileJobs`) marks a tracked job removed when the inventory lacks it, and the room
  check on a sharing change (`routine-delivery.ts`) skips routines it does not see. Every other caller of `routines()`
  only displays or looks a row up, and the search and Today readers already fall back on a failure.
- A watcher that a later runtime refused leaked the ones already registered. Registration now undoes them before it
  rethrows, and a stop tries every runtime's stop before it reports the first failure.

## Review fix red runs

| Break                                                                                     | Test                                                                      | Failure  |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------- |
| The worker checks the default runtime's durable events before the loop, as before the fix | `still reads every other runtime's events`                                | 1 failed |
| The worker never asks a lone runtime about durable events                                 | `asks that runtime whether it has durable events`                         | 1 failed |
| A runtime with no roster to keep answers none                                             | `keeps a failed runtime's last roster`                                    | 1 failed |
| An older read's roster replaces a newer one                                               | `keeps the roster of the read that started last`                          | 1 failed |
| A kept roster is not marked disconnected                                                  | `lists every assistant, the failed runtime's as disconnected`             | 1 failed |
| The routine fan-out drops a failed runtime's routines                                     | `fails the routine inventory whole`                                       | 1 failed |
| The routine fan-out drops a failed runtime's routines                                     | `removes no tracked check-in while one runtime's routines cannot be read` | 1 failed |
| A refused registration leaves earlier watchers registered                                 | `undoes every watcher already registered`                                 | 1 failed |
| A stop that throws skips the stops after it                                               | `tries every stop when one throws`                                        | 1 failed |
| A stop that throws is swallowed                                                           | `tries every stop when one throws`                                        | 1 failed |

One break was discarded: limiting the worker's own check to the default source left the router's per-source check in
place, so it did not recreate the defect and its test passed. The first row is the break that does.

## Second review fixes

GPT-6.1 Sol reproduced two more defects at `42918f2`. The code state for this section is `42918f2` merged with
`origin/main` at `f271c5fa`, plus the commit that adds this section. No real Hermes run took part.

- If a second runtime never answered, every `listBots()` failed, and `/api/bots` answered 502. The previous section's
  "the listing still fails" rule is replaced. `listBots()` now lists every assistant that can be shown and marks the
  listing `incomplete` when some runtime gave no fresh answer (`BotListing` in `src/shared/types.ts`). Hermes marks
  its own last-roster fallback the same way. `completeRoster` and `rosterBot` in `src/server/bot-access.ts` refuse an
  incomplete listing with a 503 for readers that act on what it leaves out.
- A Live Activity pass turned a cached disconnected assistant whose conversation it could not read into `done`, sent
  APNs `event: "end"`, and removed the registration. A disconnected state now keeps the row from the previous pass, an
  incomplete roster keeps the rows of assistants it leaves out, and a pass holding a row sends no heartbeat. The same
  test with Hermes alone, run against `origin/main`'s source at `f271c5fa`, also sent the `end`, so this was also a
  production bug.

Every `listBots()` consumer, classified:

| Consumer                                                                                                                     | Kind                         | Handling                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `GET /bots`, `visibleBots`, bootstrap snapshot, roster watcher and its notices, group catalog notice, widget refresh, badges | Display                      | Lists what can be shown. The bootstrap snapshot is never kept while incomplete.                                      |
| Notification titles (`BackgroundWorker`)                                                                                     | Display                      | Merges with the previous names, so a missing assistant keeps its name.                                               |
| Live Activities                                                                                                              | Display that ends activities | Keeps rows it cannot confirm finished.                                                                               |
| `Roster.note`, `exists`, `has` (the access gate)                                                                             | Privacy gate                 | `exists` lets through an ID the incomplete roster lacks only if this server has stored a name for it. `has` refuses. |
| `MainAssistants.roster` (check-in reconciliation, main-assistant clearing)                                                   | Reconcile                    | `completeRoster`. An incomplete roster skips the pass.                                                               |
| `presentations` (sharing change room check, routine delivery and room saves)                                                 | Privacy decision             | `completeRoster`. A missing member would make a room look closed.                                                    |
| Hermes upgrade busy check                                                                                                    | Gate                         | `completeRoster`. An incomplete roster counts as busy.                                                               |
| Lookups by ID: talk, vault, voice, push test, experience, starters, `GET /bots/:id`, avatar, voice, main-assistant picker    | Existence check              | `rosterBot`. 503 instead of 404 when the incomplete roster lacks the ID.                                             |

Privacy versioning (`assistants_changed`) reads the store, not the roster. Delivery pruning (`pruneRetention`) does
not read the roster.

### Red runs against the head before the fix

These are the new tests run on `42918f2` merged with `origin/main`, with this change's `src/` reverted.

| Test                                                                                                | Failure on the head                                                |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `lists the other runtimes' assistants when one has not answered since the server started`           | `/api/bots` answered a non-array error body                        |
| `keeps a running assistant as it was while Hermes is down` (Hermes only, also run on `origin/main`) | Sent events `["update", "end"]`                                    |
| `keeps a run whose runtime went down as it was`                                                     | Sent events `["update", "end"]`                                    |
| `clears no main assistant while one runtime has not answered`                                       | Rejected with the raw `Codex is unreachable`, not `ReconcileError` |
| `lets a known assistant past the access check`                                                      | A never-seen ID passed the gate                                    |
| `lists the assistants that can be shown while one runtime is down`                                  | The listing rejected                                               |
| `passes a runtime's own incomplete roster on as incomplete`                                         | No marker                                                          |
| `keeps the successful bot roster visible and disconnected during an outage` (Hermes adapter)        | No marker                                                          |
| `keeps the row of an assistant a restarted server cannot list yet`                                  | The pass rejected with `Codex is unreachable`                      |

### Red runs with one line broken

`mutate.py` in the session scratchpad replaced one exact string, ran the named tests, and restored the file. Every
break went red.

| Break                                                             | Test                                                                                                            | Failure  |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------- |
| The router ignores a runtime's own `incomplete` marker            | `passes a runtime's own incomplete roster on as incomplete`                                                     | 1 failed |
| The router keeps an incomplete answer as the last complete roster | same                                                                                                            | 1 failed |
| The router does not mark a failed runtime's listing incomplete    | `lists the assistants that can be shown while one runtime is down`                                              | 1 failed |
| A never-answered runtime fails the listing, as on the head        | `lists the other runtimes' assistants when one has not answered`                                                | 1 failed |
| Hermes's stale roster carries no marker                           | `keeps the successful bot roster visible and disconnected during an outage`                                     | 1 failed |
| `completeRoster` accepts an incomplete listing                    | `clears no main assistant`, `refuses a sharing change it cannot check`, `answers a lookup by ID with a refusal` | 3 failed |
| `rosterBot` answers not found on an incomplete listing            | `answers a lookup by ID with a refusal`                                                                         | 1 failed |
| `Roster.exists` refuses a known ID on an incomplete roster        | `lets a known assistant past the access check`                                                                  | 1 failed |
| `Roster.exists` admits a never-seen ID on an incomplete roster    | same                                                                                                            | 1 failed |
| `Roster.has` answers false on an incomplete roster                | same                                                                                                            | 1 failed |
| `presentations` reads the partial roster                          | `refuses a sharing change it cannot check`                                                                      | 1 failed |
| Main-assistant reconciliation reads the partial roster            | `clears no main assistant`                                                                                      | 1 failed |
| The upgrade busy check reads the partial roster                   | `counts an incomplete roster as busy`                                                                           | 1 failed |
| Notification names are replaced, not merged                       | `keeps the names of those it leaves out`                                                                        | 1 failed |
| The bootstrap snapshot is kept while incomplete                   | `never serves a bootstrap from memory while the roster is incomplete`                                           | 1 failed |
| A disconnected state ends the run as done                         | both Live Activity outage tests                                                                                 | 2 failed |
| An incomplete roster drops the rows it leaves out                 | `keeps the row of an assistant a restarted server cannot list yet`                                              | 1 failed |
| A held row still gets a heartbeat                                 | all three Live Activity outage tests                                                                            | 3 failed |

## Checks

See the PR for the `check-all` table.

## Narrowed to the seam

GPT-6.1 Sol's third review found more gaps in the incomplete-roster design: `visibleBots()` in
`src/server/collaboration.ts` dropped the marker, so a known omitted assistant's room answered 404 and iOS cleared it;
`Roster.note` let a made-up ID through on an empty or all-disconnected incomplete roster; and Live Activity held rows
had no bound. Roster availability with several runtimes is speculative until a second runtime exists, so it moves to
step 2 in `docs/RuntimePlan.md`, with Sol's scenarios as its acceptance cases, and comes out of this change.

The commit that adds this section reverts the previous section's code, then removes the router's cached-roster
fallback from the first review round. Everything else from that round stays: durable events are checked inside each
runtime's own failure boundary, a refused watcher undoes the ones already registered, and a stop tries every stop.

- `listBots()` and `routines()` over several runtimes are all or nothing again: one runtime's failure fails the call,
  as a lone runtime's does today. With Hermes alone nothing changes, since Hermes answers its own last roster marked
  disconnected rather than failing.
- `incomplete`, `BotListing`, `completeRoster`, `rosterBot` and the seen-before gate are gone. Every call site they
  touched reads as it does on `origin/main`. `bot-access.ts`, `live-activity.ts`, `hermes.ts`, `upgrades.ts`,
  `vault.ts` and `voice.ts` have no diff against `origin/main`.
- The Live Activity unknown-state fix, which the previous section found is also a production bug with Hermes alone,
  moves to its own PR from `origin/main`.

The red runs in the previous section are kept as a record; their tests left with the code they covered.

| Break                                                                      | Test                                                                      | Failure  |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------- |
| The router's `listBots` drops a failed runtime's answer instead of failing | `fails the roster and the routine inventory whole when one runtime fails` | 1 failed |
