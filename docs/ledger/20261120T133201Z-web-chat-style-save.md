# November 20 web chat style saves

Code state: the working tree on top of `20bfd71a` on `t3/research-openbot-chat-bubbles`. Node
v24.22.2. Hermes did not take part; the checks use the mocked client API.

A re-review of the iOS fixes found that the web client did not follow the rule the iOS app had just
been given, and that `docs/native-api.md` described it as if it did. The web's preference queue sent
the whole preferences object on every save. If Your messages was set to Solid on a phone while a
browser tab still held Tinted, changing the theme in that tab sent Tinted and the server restored
it.

`src/app/preference-queue.ts` now leaves `chatStyle` and `ownBubble` out of a save unless the edit
behind it changed that choice. The server keeps a choice a save leaves out
(`src/server/bootstrap-routes.ts`). The change is measured against the value the edit was made on,
a queued one included, not against what the server last confirmed, so a choice changed and changed
back while the first save is on its way is still sent. The iOS reviewer found that exact reversal
dropped in the app's Settings.

`tests/app-ui.test.ts` had a mock that answered a save with the body it was sent, which no longer
describes the server once a save can leave a choice out. The mock now keeps what it holds and merges
the body over it, as the server does. Its second assertion expected both choices in the second
save's body; it now expects only the changed one, that the other is absent, and that Classic is
still on screen.

## Checks

| Check                                                | Result                                                                  | Evidence                                            |
| ---------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------- |
| Typecheck, lint                                      | Compiled and passed                                                     |                                                     |
| Full Vitest                                          | Unit-passed: 4,190 tests in 229 files, 3 of them new                    |                                                     |
| The 3 new queue tests on the queue before the change | Failed as intended: each save carried a choice its edit had not changed | `.private/web-chat-style-save/red-queue-before.log` |

### Red runs

Each line was broken by hand and the file restored from a saved copy.

| Break                                                   | Tests that failed | Evidence                                                      |
| ------------------------------------------------------- | ----------------- | ------------------------------------------------------------- |
| Measure a change against what the server last confirmed | 2 of the 3 new    | `.private/web-chat-style-save/red-compare-with-confirmed.log` |
| Send every choice the value holds                       | all 3 new         | `.private/web-chat-style-save/red-send-everything.log`        |
| An edit never carries a choice                          | all 3 new         | `.private/web-chat-style-save/red-never-send.log`             |

## A pick the values could not show

A final independent review found a case the first version dropped. Tab A last saw Bubbles. Another
tab saves Classic. Tab A queues two unrelated edits; the first answer brings Classic on screen while
the second save, built on Bubbles, still waits. The person reopens Settings and picks Bubbles. The
queue compared that pick with its waiting value, found no change, and left `chatStyle` out, so the
picker went back to Classic.

A change of values cannot show that pick, so the picker now says it. `PreferencesDialog` names the
chat style choices an update sets, and that travels through `usePreferenceEdits` and the session to
the queue's `edit`, which sends a named choice whatever the queue holds. The value comparison stays
as a net for an edit that changes a choice without naming it. The iOS app works the same way.

| Check                                                  | Result                                                    | Evidence                                                      |
| ------------------------------------------------------ | --------------------------------------------------------- | ------------------------------------------------------------- |
| Typecheck, lint, format check                          | Compiled and passed                                       |                                                               |
| Full Vitest                                            | Unit-passed: 4,192 tests in 229 files, 2 more new         |                                                               |
| The 2 new tests, queue and Settings, before the change | Failed as intended: the third save carried no `chatStyle` | `.private/web-chat-style-save/red-explicit-choice-before.log` |
| The Settings pickers name no choice                    | The Settings test failed                                  | `.private/web-chat-style-save/red-picker-names-nothing.log`   |
| The queue ignores the named choice                     | Both new tests failed                                     | `.private/web-chat-style-save/red-queue-ignores-chosen.log`   |
| The edits hook drops the named choice                  | The Settings test failed                                  | `.private/web-chat-style-save/red-hook-drops-chosen.log`      |
| The session drops the named choice                     | The Settings test failed                                  | `.private/web-chat-style-save/red-session-drops-chosen.log`   |

The Settings test opens Settings, queues two saves, lets the first answer with another device's
Classic, closes and reopens Settings, picks Bubbles while the second save waits, and reads the third
save's body.

## Not done

- The rest of the preferences object is still sent whole, as before. A stale tab can still write an
  older theme, favorites or sections over a newer save from another device. That predates this
  branch.
- No browser run. The change is in the queue's logic, which the unit tests exercise through the app
  with the client API mocked.
