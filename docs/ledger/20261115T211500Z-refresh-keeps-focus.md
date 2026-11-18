# November 15 Work refresh keeps focus

Branch `t3/refresh-keeps-focus` from `origin/main` at `367d47ae`, source fingerprint `sha256:0be92d5412902051f16af65d77d845b6bd81126ae55959fbffd920b63109d4ba` before
this entry, Node 24.22.2 on the Mac mini.

## Change

PR #422's Node 24 CI run failed `waits for the create review result before moving focus from Refresh status`: focus was
on the page, not on Refresh status. jsdom 31, merged in #421, behaves as browsers do: it refuses `focus()` on a disabled
button, and it moves focus to the page, asynchronously, when the focused button becomes disabled. Refresh status was
`disabled` while a change was busy and while it refreshed, so a keyboard user lost their place on it, and the test
depended on when jsdom's move ran. GPT-6.1 Sol's review reproduced the second path. Refresh status now uses
`aria-disabled` and ignores presses while busy, without the hover and press styles.

## Red runs

| Break                             | Test                                                                                   | Failure                               |
| --------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------- |
| Refresh status back to `disabled` | `keeps Refresh status focusable while a change is busy, without refreshing on a press` | focus stayed on the title input       |
| Press guard removed               | `waits for the create review result before moving focus from Refresh status`           | a second read: 4 calls, expected 3    |
| Refresh status back to `disabled` | `waits for the create review result ...`                                               | `aria-disabled` null, expected `true` |

Each file was restored and `tests/automation-ui.test.ts` passed 71 of 71.
