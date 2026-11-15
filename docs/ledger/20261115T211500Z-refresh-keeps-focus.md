# November 15 Work refresh keeps focus

Branch `t3/refresh-keeps-focus` from `origin/main` at `367d47ae`, source fingerprint `sha256:0be92d5412902051f16af65d77d845b6bd81126ae55959fbffd920b63109d4ba` before
this entry, Node 24.22.2 on the Mac mini.

## Change

PR #422's Node 24 CI run failed `waits for the create review result before moving focus from Refresh status`: focus was
on the page, not on Refresh status. jsdom 31, merged in #421, refuses `focus()` on a disabled button, as browsers do,
and Refresh status was `disabled` while a change was busy. On a slow runner the test focused it before the failed
create had settled. Refresh status now uses `aria-disabled` and ignores presses while busy, so keyboard users can rest
on it during a change or a refresh.

## Red runs

| Break | Test | Failure |
| --- | --- | --- |
| Refresh status back to `disabled` | `keeps Refresh status focusable while a change is busy, without refreshing on a press` | focus stayed on the title input |
| Press guard removed | `waits for the create review result before moving focus from Refresh status` | a second read: 4 calls, expected 3 |
| Refresh status back to `disabled` | `waits for the create review result ...` | `aria-disabled` null, expected `true` |

Each file was restored and `tests/automation-ui.test.ts` passed 71 of 71.
