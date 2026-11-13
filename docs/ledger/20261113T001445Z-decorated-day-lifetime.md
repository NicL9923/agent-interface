# November 13 decorated history lasts a day

Branch `t3/decorated-day-lifetime` over `origin/main`, on NicolasLaptop (Fedora 44, Linux x64), Python 3.14.10.
Hermes `ed1afb0`. Nothing was deployed by this entry.

## Why

After #385, a decorated-history miss for `patch` still costs about 2.4 s: Hermes's display read, the memo's reuse,
decoration and the wire. Hermes's own interpreter on the production host, against a `.backup` copy of `patch`'s
`state.db` (deleted afterward; timings only), read the display history
(`get_messages_as_conversation` with ancestors, row IDs and compacted rows, 8,021 rows) in 1,520, 1,085 and 989 ms.
Under cProfile, 0.17 s of 1.64 s was SQLite's `fetchall`; the rest was Hermes's Python:
`_dedupe_display_generations` (0.67 s), JSON decoding (0.29 s), and identity and replay dedupe. The add-on cannot make
that read cheaper without patching Hermes, so the lever is not making it.

The decorated history already skips the read whenever the chat is unchanged, but only for ten minutes from its fill.
What else ends it is a change it can see: any write to the profile's `state.db` or its WAL, `config.yaml`, redaction
state or the profile's journal. Over the 24 hours before this entry, counted on `.backup` copies (counts only):

| Profile | Rows written to its Bot Chat | Rows written to other sessions |
| --- | --- | --- |
| patch | 9 | 15 |
| lumen | 1 | 0 |
| penny | 0 | 0 |
| wft-marketing | 0 | 0 |

So nearly every open after a ten-minute pause paid the whole read for a chat that had not changed. The comment on
`DECORATED_TTL` already said the lifetime "only bounds what an identity collision could serve". Decoration reads
nothing outside that identity: artifacts are resolved when the tool runs and stored in the journal
(`record_live_tool`), and open requests, live state and windows are computed on every open outside the cache.

## Change

`DECORATED_TTL` is a day instead of ten minutes. A chat left overnight answers its morning open from decorated history
unless something it can see changed. Without readable redaction state the 30-second lifetime still applies. Memory is
unchanged: entries were already kept until replaced or evicted (`DECORATED_LIMIT`), only no longer answered.

A day leans harder on the identity than ten minutes did, so after review it covers two more inputs:
- The `config.yaml` of the home Hermes runs in, not only the profile's. Hermes's `t()` labels tools in the language
  configured there (`agent/i18n.py:89-91`); `projection_context` already stamped both.
- `PRAGMA data_version` of the store, from one read-only connection the add-on keeps per file, reopened when the file
  is replaced. File stamps alone can miss a commit: after the WAL resets, frames are rewritten in place at the same
  size, and two commits within one clock tick leave the same times. The connection never waits for a writer
  (`timeout=0`); a busy store answers None, which only misses. On the production host's SQLite 3.53.1, against a
  `.backup` copy of `patch`'s WAL store (deleted afterward), the version stayed put without commits and moved after a
  commit by Hermes's own `SessionDB`.

Not covered, and said so in the comment: Hermes's projection also reads an attached image's file, the skin and
installed language packs, and a journal restored from a backup sets its version count back, which later writes could
count up to the old number. Keying the journal's own `data_version` would close that, but any other process's journal
commit, such as the dashboard's, would then drop every assistant's decorated history.

## Red runs

`python3 .agents/tools/mutate-py.py --batch ... --baseline` over `src/hermes/extension.py`, running
`hermes_extension_journal_test`; the baseline passed.

| Mutation | Result |
| --- | --- |
| ten-minute lifetime | failed: test_decorated_history_outlives_an_overnight_idle_until_its_bound (exit 1) |
| untracked redaction keeps the day lifetime | failed: test_decorated_history_follows_native_redaction_registries (exit 1) |

After review, the same tool over the four add-on test modules; the baseline passed.

| Mutation | Result |
| --- | --- |
| only the profile home's configuration | failed: test_the_configuration_of_the_home_hermes_runs_in_ends_a_profiles_decorated_history (exit 1) |
| a replaced store keeps its old connection | failed: test_a_stores_version_moves_with_each_commit_another_connection_makes_and_follows_a_replaced_file (exit 1) |
| store version never read | failed: test_a_stores_version_moves_with_each_commit_another_connection_makes_and_follows_a_replaced_file (exit 1) |
| store version left out of the identity | survived |

The survivor needs a commit that leaves every file stamp equal, within one clock tick, which a test cannot stage;
`store_version` itself is tested above.

## Review

Claude Opus 5.5 reviewed `8ac3de22` (GPT-6.1 Sol and Grok unavailable; Nicolas approved Claude reviewers for this
thread). No medium or high findings. Fixed: the launch home's configuration and the clock-tick collision, above, and
the comment's claim that decoration reads nothing else. Not fixed: the journal restore, above.

## Test fix

`test_a_redaction_change_while_the_warm_up_stood_aside_projects_again` failed once in a combined run and passed 40 of
40 alone, on this branch and on `origin/main`. It ended its turn as soon as it saw it start, so a loaded machine could
let the warm-up finish without standing aside. It now holds the turn 30 ms, as `turn_during` does.
