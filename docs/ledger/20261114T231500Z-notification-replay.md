# November 14 notification replay skips settled work

Branch `t3/notification-replay` from `origin/main` at `65ed9eb4`, run on the Mac mini (Node 24.22.2). Nothing was
deployed by this entry.

## Change

`BackgroundWorker` calls `store.enqueueKnownEvents()` every 5 seconds, which offers every `notification_events` row of the
last day to `NotificationRepository.enqueue()` inside one transaction. `enqueue()` now reads which people already have an
outbox row for the event and works out recipients first. It builds the notification copy (`markdownPlain`,
`notificationCopy`) only when at least one person has no row yet. `INSERT OR IGNORE` on `UNIQUE(event_id, user_id)` already
ignored the rest, so the rows written are the same.

## Measurement

`npx tsx .agents/tools/notification-replay-bench.ts`: in-memory store, 500 events from the last day over 20 assistants,
4 members (one participant in every run, one following 10 assistants, one following all, one following none),
1 KB Markdown bodies, every notification already queued (1,250 outbox rows). Median of 30 replays, three runs each.

| | median | p90 |
| --- | --- | --- |
| `origin/main` | 176.4, 178.6, 178.4 ms | 181.8 to 194.3 ms |
| this change | 4.6, 5.2, 4.7 ms | 4.8 to 6.8 ms |

The outbox held 1,250 rows before and after every replay in both.

## Application tests

`tests/notification-replay.test.ts` runs the real store on an in-memory database. `.agents/tools/check-all --keep-going`
ran typecheck, lint, ruff, build, e2e and the full Vitest suite; the only failures were the three tests that need the
`127.0.0.2` loopback alias, which this machine lacks.

## Red runs

Each broke one line by hand, ran `tests/notification-replay.test.ts` and `tests/notifications.test.ts`, then restored the
file with `git checkout`.

| Break | Test that failed |
| --- | --- |
| do not drop recipients who already have a row | `builds a notification's copy only when a replay will queue it for someone new` |
| remove the return when nobody is waiting | `builds a notification's copy only when a replay will queue it for someone new` |
| remove the quiet check-in return | `keeps a quiet check-in run out of the outbox on every replay, and still notifies for a check-in that found something` |
| count only pending rows as queued | `does not queue a delivered or failed event again, or change its state` |
| replay all events, not the last day's | `queues the last day for a new follower, and nothing older` |
| drop the private assistant's `mayReceive` filter | `never queues a private assistant's event for anyone but its owner, whoever follows or joined in` |

## Not exercised

A production-sized store and the real push delivery path, which this change does not touch.
