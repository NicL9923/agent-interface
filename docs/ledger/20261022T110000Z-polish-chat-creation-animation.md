# October 22 chat header, assistant creation, animation and settings polish

Base `e2037b9`. This records implementation and local validation on branch
`nic/polish-bot-chat-and-creation`. Deployment and the TestFlight distribution of
build 12 are recorded separately once their receipts exist.

The change removes the iPhone tab bar, gives web and iOS a messaging-style chat
header whose avatar opens an assistant card (find on iOS, pin, artifacts, settings,
follow and home section), makes new-assistant creation a two-step flow that saves the
chosen avatar, replaces the Settings follow and section toggle walls with one follow
list and a section manager, animates pinned avatars, lets the iOS keyboard be put
away, redesigns sign-in, and drops the Liquid Glass and bordered frames around the
account avatar. A per-platform conductor keeps two different assistants from playing
the same named animation at once and gives each its own phase and pace. The server
drops Hermes's `thinking.delta` spinner text, the upgrade worker records each
revision's commit date for display instead of hashes, and the Google Workspace card
says whether the assistant has the Google skill and which OAuth client signed its
grant. Web preference saves run through one queue.

Application tests at the final state: 904 web tests across 79 files on Node 26.10 and
on Node 24.21, the TypeScript check and production build, 23 Python suites with one platform suite
skipped, and Ruff. Native validation on the iPhone simulator: 359 unit tests with two
skips; the full iPhone UI suite passed except two tests, one stale (fixed, then
passed) and one Cmd+F timing flake that passed on rerun and in the shell agent's run;
the iPad simulator ran TabletPresentationTests. Visual review used the web fixture
preview at phone and desktop widths in light and dark, and the iOS screenshot tour.

Six rounds of independent GPT-6.1 Sol review (high effort) covered web and server,
and iOS; implementation was Claude. Findings fixed: same-named bots shared animation
cues; a retried avatar save could close over other unsaved edits; a stale UI test;
and a series of preference save races (out-of-order saves, cross-account carryover,
panel snapshots outside the queue, model stars erased by full saves, edits during
failure recovery, overlapping bootstrap reads). The sixth round found nothing serious. In-chat Find on web was deferred as new
scope.

Not exercised: real Google sign-in on web, physical iPhone keyboard and VoiceOver,
and the live Hermes connection. The integration and add-on inputs changed, so the
release needs fresh isolated qualification.
