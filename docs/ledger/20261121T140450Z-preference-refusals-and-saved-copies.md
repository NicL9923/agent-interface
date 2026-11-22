# November 21 preference refusals, saved copies and the section name field

Code state: the working tree on top of `659f26c0` on `t3/partial-preference-saves`. Node v24.22.2.
Hermes did not take part. Earlier entry:
[`20261121T125435Z-preferences-one-copy-on-screen.md`](20261121T125435Z-preferences-one-copy-on-screen.md).

A fourth review found five things to fix:

1. The section name field in Settings kept its own copy, so Back could write an old name over
   another tab's rename, and resend a refused rename. The field now holds only what the person typed
   since it last matched the screen. Until they type, it shows the screen's name; once a rename is
   sent, it lets go of the text, so a refused rename goes back to the screen's name and is not sent
   again. No other text field in Settings, assistant details or the routine manager saves on blur or
   on leaving: quiet hours read the screen's copy and save on change, and the new-section fields save
   only on submit.
2. Assistant Settings, the third modal that can start a preference save ("Show runs in chat"),
   showed no refusal. All three sheets now show the same alert, `SaveRefusal`, which also scrolls
   itself into view, since the control that made the change may sit far below the top of the sheet.
3. A failed save said "Your draft is kept", wording written for a chat message. The session now words
   every refusal itself: a save that never reached the app did not save, one that timed out may not
   have, and any other refusal gives the server's reason.
4. The saved home and the saved theme were written from the screen's copy, which holds the saves
   still waiting, so a tab closed mid-save left a later launch drawing an unsaved pin. Both are now
   written from the copy the server confirmed. Nothing else keeps or broadcasts preferences: other
   tabs read the server and that saved home, and the widget is drawn from the server's store.
5. The guide now says a later patch for the same field carries the value worked out for that later
   edit, which may repeat or replace a refused or lost change, and the Retry paragraph describes the
   section name field.

Three findings were declined. The guide's list rule now names a deleted item coming back from a stale
copy. The queue's `confirm` comment names the older-answer gap across routes and what would close it,
and the test for an answer from another route says what it does not cover.

## Checks

| Check                                                                                            | Result                                  |
| ------------------------------------------------------------------------------------------------ | --------------------------------------- |
| `npm run typecheck`, `npm run lint`                                                              | Compiled and passed                     |
| `npx vitest run`, full, under the lock                                                           | Unit-passed: 4,305 tests in 233 files   |
| The seven browser specs that open Settings or assistant details, Chromium, after `npm run build` | Runtime-exercised: 91 passed            |
| The same specs, WebKit in the Playwright container                                               | Runtime-exercised: 88 passed, 3 skipped |

The seven specs are `badge`, `back-forward-cache`, `accessibility`, `stylesheet-order`,
`back-navigation`, `smoke` and `preference-saves`.

### Red runs

Each new test was written first and failed on `659f26c0` for the reported reason:

| Test                                                                                            | Failure on `659f26c0`                                   |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| keeps an untouched name in step with the screen, so Back never writes over another tab's rename | the field read "Kids" after the rename to "Little ones" |
| puts a refused rename's field back to the screen's name and does not send it again on Back      | the field still read "Barn"                             |
| says inside the sheet, in view, when a Show runs in chat change was refused                     | Assistant Settings showed no alert                      |
| brings a refusal inside Settings into view                                                      | nothing was scrolled into view                          |
| says a save that never reached the app did not save, and one that timed out may not have        | the message said "Your draft is kept"                   |
| keeps the server's confirmed pins and theme, not the changes still on their way                 | storage held `light` and the unsent pin                 |

The existing test "reports any other refusal without sending the save whole" now expects the full
sentence the session builds, "Your change didn't save. Invalid request", in place of the bare reason
the app used to prefix.

Not covered by a test: that the app passes the refusal to Assistant Settings. The sheet's own test
renders it with the refusal; the app's wiring was checked by reading it.
