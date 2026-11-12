# November 12 each open reports what its caches did

Branch `t3/projection-memo-timing` over `origin/main` at `df2c1a96`, on NicolasLaptop (Fedora 44, Linux x64), Python
3.14.10. Nothing was deployed by this entry.

## Why

After the `68d63485` deployment the warm-up warmed 6 of 6 assistants in 18.2 s, yet `patch`'s first two opens after
the restart still took about 4 s, and `lumen`, `penny` and `wft-admin` opened slower first than before the warm-up.
One guess is that the shared 192 MB projection budget empties memos while eight of them fill. The timing header could
not say: it showed where an open spent its time, not whether it hit the decorated history, reused memo pieces, found
its memo emptied, or adopted the warm-up's projection.

## Change

- `agent-interface.open` answers with `app_cache` beside `app_timing` on every open with history:
  - `decorated`: 1 when the decorated history answered it.
  - `pieces` and `reused`: the projection's pieces and how many the memo reused, when the open projected.
  - `emptied`: how often the shared budget has emptied that session's memo while it held pieces.
  - `fill`: the percentage of the budget every memo keeps after the open.
  - `warm`: on the first open's resume after a restart, 1 when it adopted the warm-up's projection, 0 when it did
    not. A chat that had to be created, or lost the title race to another writer, reports no `warm`.
- The app server passes the plain, non-negative counts into `Server-Timing` as
  `addon-cache;desc="decorated=0 pieces=12 reused=11 ..."`, so `measure-chat-open.mjs` prints them unchanged.
  An older add-on sends none, and the header then has no `addon-cache`.

## Red runs

`python3 .agents/tools/mutate-py.py --batch ... --baseline` over `src/hermes/extension.py`, running
`hermes_projection_memo_test`, `hermes_history_warmup_test` and `hermes_extension_journal_test`; the baseline passed.

| Mutation | Result |
| --- | --- |
| emptied never counted | failed: test_an_open_reports_what_its_caches_did (exit 1) |
| emptied counts an empty memo | failed: test_a_projection_empties_the_memo_used_least_recently_once_the_gateway_passes_its_budget (exit 1) |
| warm adoption never reported | failed: test_a_first_open_adopts_the_warmed_history_and_projects_nothing (exit 1) |
| decorated hit reported as miss | failed: test_decorated_cache_skips_projection_and_binding_and_invalidates (exit 1) |
| reuse not reported | failed: test_an_open_reports_what_its_caches_did (exit 1) |
| fill ignores memos | failed: test_an_open_reports_what_its_caches_did (exit 1) |
| resume counts dropped by later counts | failed: test_a_first_open_adopts_the_warmed_history_and_projects_nothing (exit 1) |

After review, the decorated-hit case moved to `CacheCountTests`, whose fixture projects through the memo, because the
journal test's fixture never does and so could not catch a leftover report. Same tool, `CacheCountTests` alone,
baseline passed:

| Mutation | Result |
| --- | --- |
| an open keeps the last projection's report | failed: test_an_open_reports_what_its_caches_did (exit 1) |

## Review

Claude Opus 5.5 reviewed `1bb1378f`; GPT-6.1 Sol and Grok were unavailable, and Nicolas approved Claude reviewers for
this thread. No blockers or majors. Fixed: the decorated-hit assertion could not fail (moved, above), and the docs
said every read carries all counts, while a resume that created the chat reports no `warm`.

TypeScript, by hand, each restored from a copy afterwards:

| Mutation | Result |
| --- | --- |
| `hermes.ts` reads no `app_cache` | failed: hermes-adapter "reports the add-on round trip and phases for timing" |
| `hermes.ts` keeps negative counts as their absolute value | failed: the same test, which sends `fill: -1` |
| `readTimingHeader` leaves `addon-cache` out | failed: ops "reports where a conversation read spent its time" |

## Not exercised

- A production open. The deployment that carries this change records those numbers.
