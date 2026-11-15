# November 15 Live Activity unknown work

On origin/main f271c5fa, with Node 24.22.2, the new sender-edge tests failed before the fix. `npx vitest run tests/live-activity.test.ts -t 'holds disconnected|drops a long unknown'` failed both tests: the hidden work allowed an end event, and the outage sent an end event. `npx vitest run tests/live-activity.test.ts -t 'holds work when a conversation read fails'` also failed because it sent end instead of update. `npx vitest run tests/live-activity.test.ts -t 'does not claim an armed run'` failed on main because it sent end instead of starting. `npx vitest run tests/live-activity.test.ts -t 'does not resurrect expired'` failed on main because the unreadable row persisted past eight hours. With the fix in place, removing the expired-state title guard made `-t 'drops a long unknown'` fail with `All caught up` instead of `Status unavailable`; the guard was restored. No Hermes or physical phone was exercised.

For source fingerprint `sha256:ab6fdc6723e9718cfe85b8db1eb778faec91f8450f20d96211dc7de586b3d065`, the Live Activity suite passed 42 tests. Typecheck and lint passed. `check-all` passed typecheck, lint and ruff; its test step passed 4,024 tests and failed three because the Mac lacked the documented 127.0.0.2 loopback alias. Build passed in a separate `check-all --only build,e2e` run. No real APNs, Hermes, simulator or phone was exercised.

The separate browser smoke run passed 79 tests on the same source fingerprint, after 8 minutes 30 seconds queued and 2 minutes 6 seconds running.

## Review fix

The orchestrator's review (Claude Opus 5.5) found that a held unknown row was still refreshed by the five-minute
heartbeat with a new stale date, so during a Hermes outage the Lock Screen kept reading "Working" for up to eight hours.
docs/Plan.md forbids an animation or status claiming work continues when its state is unknown. A held row now carries
the detail "Can't check on this right now", which the widget shows (`ios/Shared/Widgets/WidgetViews.swift`), and while
every running row is held no heartbeat is sent, so the 15-minute stale date lapses and iOS marks the card out of date.

| Break | Test | Failure |
| --- | --- | --- |
| Heartbeat sent while every running row is held | `holds work when a conversation read fails despite an idle roster` | a push was sent during the 30 held minutes |
| Held row keeps its old detail | same test | the detail was not "Can't check on this right now" |

Both restored; `tests/live-activity.test.ts` passed 42 of 42, with typecheck and lint clean.
