# November 21 every screen shows the copy preference edits build on

Code state: the working tree on top of `2329206b` on `t3/partial-preference-saves`. That is
`origin/t3/followups-459-462`, which already held `6159ed0d`, so the merge fast-forwarded and needed
no merge commit. The preference code is the same at both commits. Node v24.22.2. Hermes did not
take part. Earlier entry:
[`20261121T054901Z-preference-queue-build-once.md`](20261121T054901Z-preference-queue-build-once.md).

A third review found the queue sound but the screens apart from it. The queue built each edit on
the confirmed copy with the waiting patches laid over it. Home, Today, the palette and assistant
details showed the confirmed copy alone, and Settings showed its own draft, so a person could tap on
a section whose deletion waited, reorder from an order the queue no longer held, or pin from details
while a Home pin waited. A refused save also left the screen silently outside the conversation view.

- The queue now puts each tap's result on screen at once, so the preferences the session hands to
  the app are always the confirmed copy with the waiting patches laid over it. Settings, assistant
  details and the routine manager read them and keep no draft of their own.
- An answer from another preferences route goes through the queue's `confirm`, so the saves still
  waiting stay on screen over it.
- An edit that returns the value it was given queues nothing and answers `"unchanged"`. Pinning,
  following or hiding runs that are already in the asked-for state returns the same value, and a
  move or a member change for a section that is gone does nothing. From Home it says the section
  is gone; from details it says so under the sheet.
- A refusal shows a toast that replaces any "done" notice, such as "Pinned Ranch Hand", and an alert
  inside the Settings or details sheet, which the toast would sit behind.
- `docs/native-api.md` now describes this: one copy on every screen, which fields a patch behind a
  refused or lost save carries, the overlapping-read rule, account change and sign-out, and Retry.

Three existing tests changed with the new behavior, each keeping what it protects. The queue's "one
save at a time" test and its account-change test now see each tap on screen at once, and the session's
overlapping-read test sees the waiting edit on screen while the read is held back. Three UI tests
that mocked `editPreferences` now put the edit's result on screen, as the session does, since the
sheets no longer keep a draft.

## Checks

| Check                                  | Result                      |
| -------------------------------------- | --------------------------- |
| `npm run typecheck`, `npm run lint`    | Compiled and passed         |
| `.agents/tools/check-all --keep-going` | Recorded in the next commit |

### Red runs

The five reviewer cases were written first, in `tests/shell-ui.test.ts`, through the real app screens
with only the client API module mocked. All five failed on `2329206b`, whose preference code is that
of `6159ed0d`:

| Test                                                             | Failure                              |
| ---------------------------------------------------------------- | ------------------------------------ |
| stops offering a section whose deletion waits                    | Home still offered Barn              |
| opens Settings on the order a waiting reorder will save          | Settings reopened on `[A, B, C]`     |
| shows a pin from Home in the assistant's details while it saves  | details showed Pin, not Unpin        |
| takes back a refused pin queued behind another save, and says so | the toast still read "Pinned Shared" |
| says when a theme change from the palette is refused             | no notice at all                     |

The other new tests import code that does not exist at that commit, so each was proven by breaking one
line of the new code by script, running the test file, and writing the original bytes back:

| Break                                                                        | Result                                |
| ---------------------------------------------------------------------------- | ------------------------------------- |
| Show a tap only when its save answers                                        | 3 of the reviewer cases failed        |
| Queue an edit that changed nothing                                           | 1 failed: it sent `{ favorites: [] }` |
| Show another route's answer without the waiting saves                        | 1 failed                              |
| Say nothing on screen when a save is refused                                 | 3 failed                              |
| No refusal inside Settings; none inside details                              | 1 failed each                         |
| Follow, pin from details, pin from Home, or hide runs twice                  | 1 failed each                         |
| Move, or set members, into a section that is gone, from details or from Home | 1 failed each                         |
