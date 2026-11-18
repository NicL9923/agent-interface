# November 15 UI tests pin the minute clock

Branch `t3/pin-ui-test-clock` from `origin/main` at `92b3fadc`, source fingerprint
`sha256:0b6613249499b49883b3d8ac8c5d6b57a732dc818a22807f5e1522f48c8d15f0` before this entry, Node 24.22.2 on NicolasLaptop.

## Change

GPT-6.1 Sol's review of #362 found that `tests/transcript-rerender.test.ts` counts renders of real `When` timestamps
without controlling time. `When` subscribes to a minute clock, so a minute that turned between a test's baseline and
its assertions added a render to every stamp. The file now runs on fake timers fixed at 2026-10-25 12:00 UTC.

The same real clock fails any UI test with a mounted timestamp: the tick renders outside `act()`, and
`tests/setup-ui.ts` fails the test on that warning. `tests/sidebar-ui.test.ts` (Sidebar's `ListDate`) and
`tests/bot-details-ui.test.ts` (BotDetails' `When`) now stop `Date` at the top of a minute in `beforeEach`. A stopped
`Date` never reaches the next minute, so a tick has nothing to render. Their timers stay real because Sidebar tests
wait on real `setTimeout`. A red run with `Date` stopped 1 ms before a minute turned still passed, which showed that
the stopped clock does the work and the minute alignment only spaces the ticks.

Other #362 files checked: `app-ui`, `background-polls-ui`, `bot-settings`, `collaboration-ui`, `connection-ui`,
`conversation-prefetch`, `draft-sync-ui`, `experience-ui`, `group-room-settings-ui`, `home-groups-ui`,
`routine-runs-ui`, `stream-hide-ui` and `transcript-ui` already use fake timers. `avatar-editor`, `bot-menu-ui`,
`chat-header-ui`, `main-assistant-ui`, `preferences-dialog-ui`, `view-failure` and `voice-ui` mount no timestamp.

## Red runs

Each red run waited in real time, through a timer captured before any fake timers, until 200 ms past the next
minute, then continued the test. The scratch edits were reverted with `git checkout`.

| Clock          | Test                                                                               | Result                                                                        |
| -------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Unpinned       | `re-renders only the live turn while a reply streams`                              | Stamp renders grew `[1, 0, 1, 1, 1]`, expected all 0; unwrapped `When` update |
| Fake timers    | same                                                                               | Passed across the 22:41 UTC minute                                            |
| Unpinned       | `says when the assistant last spoke and opens Find in its chat`                    | Unwrapped `When` update                                                       |
| Unpinned       | `marks unread chats until they are on screen or read through their latest message` | Unwrapped `ListDate` update                                                   |
| `Date` stopped | both of the above                                                                  | Passed across the 22:45 UTC minute                                            |

The bot-details red run held the avatar still with reduced motion, so the long wait reported only the clock.
