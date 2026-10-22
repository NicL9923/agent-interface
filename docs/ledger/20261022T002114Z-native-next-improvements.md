# October 21 native performance, notifications, Shortcuts and Swift 6

Base `b04a676`; reviewed implementation commit `f47b8cc` with source fingerprint
`sha256:4dca582d76777d7964c975709f88ab5642402e79c4ff49d4335f950027b1bd48` (932 source files).
This records implementation and local validation. Deployment and the TestFlight
distribution of build 11 are recorded separately once their receipts exist.

The change makes the native app follow only the conversation on screen, backs off
uncertain send checks, pauses Today and group polls in the background, skips decoding
unchanged responses, caches reply cards and date formatters, decodes images off the
main thread and caps the working shimmer. The server lets Today revalidate to 304 and
answers an open group room with one Hermes state call. Notifications group by
assistant, replace repeated deliveries, offer Review and Decline on approval requests
and Reply into the draft on finished replies. The app adds Siri and Shortcuts actions,
Spotlight, a configurable widget, haptics, swipe to pin, iPad keyboard shortcuts and
scaled fixed-size text. The store moved to Observation, Siri, notification and Share
text share one held-text queue, and every target builds in Swift 6 with complete
concurrency checking. CI gained an opt-in iOS UI test workflow and cached derived
data, and validation entries moved to this directory.

Application tests at the final state: 858 web tests across 73 files on Node 26.10 and
on Node 24.21, the TypeScript and production build, 23 Python suites with one platform
suite skipped, Ruff and compileall. Native validation on the iPhone simulator ran 336
unit tests with two skips, after the full unit and UI suites passed at `6fc52e6`
(335 unit tests with two skips; 49 UI tests with one tablet-only skip, screenshot tour
excluded). The only later change drops an Ask that lapses while its chat opens; its
regression test failed without the fix. The iPad simulator ran the 335 unit tests,
ParityFlowTests and TabletPresentationTests at `6fc52e6`. Two UI tests that already
failed on iPhone at `b04a676` were corrected without app changes: Today's way home
now uses the tab bar, and saved search results scroll up from the matching reply.

Unit tests measured the polling change: no conversation reads while away from a chat
(previously the whole loaded history every 1.5 seconds without a stream), about six
uncertain-receipt checks in 142.5 seconds instead of about 95, unchanged polls that
decode and publish nothing, one publish per keystroke instead of four, and one request
and one Hermes state call per open group poll instead of two of each.

Independent GPT-6.1 Sol review ran four rounds. Round one found a lost concurrent Ask,
widget freshness lapsing after unchanged polls, a notification reply lost on Discard,
a docs PR staging a missing ledger file, unrelated labels cancelling UI runs, and old
manifest links. Round two confirmed those fixes and found held text joining a restored
unsent message offline and a stranded Ask across two assistants. Round three confirmed
those and found an expired Ask blocking later chats and mixed sources reversing order.
Round four confirmed those and found an Ask landing after its expiry, fixed in
`f47b8cc`. Approve from a notification was replaced with Review because the payload
omits what an approval would run.

Not exercised: physical APNs delivery and notification actions, time-sensitive
delivery (the entitlement needs an Apple Developer website step first), Siri phrase
recognition, the Shortcuts app, Spotlight results, haptic feel, the iPad Commands
overlay updating under Observation, and the new CI UI workflow on GitHub's runner.
Fixture screenshots do not prove real Hermes behavior. Fresh isolated native
qualification is required before activation because integration inputs changed,
including the Hermes add-on's approval IDs.
