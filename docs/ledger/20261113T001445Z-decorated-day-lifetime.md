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

A day leans harder on the identity than ten minutes did. After review, it also stamps the `config.yaml` of the home
Hermes runs in, not only the profile's: Hermes's `t()` labels tools in the language configured there
(`agent/i18n.py:89-91`), and `projection_context` already stamped both.

Not covered, and said so in the comment:
- Hermes's projection also reads an attached image's file, the skin and installed language packs.
- A commit the file stamps cannot see. The host runs Linux 6.8 on ext4, with coarse file times, so two commits within
  one clock tick, the second rewriting WAL frames in place at the same size, leave equal stamps. It also needs a
  writer that changes this chat's display rows without touching Hermes's in-memory history.
- A journal restored from a backup sets its version back, which later writes could count up to the old number.

A first fix kept one read-only connection per store to read `PRAGMA data_version`, which moves on every other
connection's commit. On the host's SQLite 3.53.1 it did, against a `.backup` copy of `patch`'s WAL store with Hermes's
own `SessionDB` writing. Re-review found it unsafe, and it was removed:
- Hermes refuses to open a store for writing while any process holds a deleted `-wal` or `-shm` of it
  (`refuse_deleted_wal_generation`, `hermes_state_dbfile.py:355-393`). An untracked connection outlives profile
  deletion, so recreating a deleted assistant would fail until the gateway restarted.
- The connection is invisible to Hermes's lock guard, so a raw open and close elsewhere in the process could strand it
  on an old WAL generation with a frozen version.

Keying the journal's own `data_version` would close the restore case, but any other process's journal commit, such as
the dashboard's, would then drop every assistant's decorated history.

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
| warm-up reuses a projection made under another context | failed: test_a_redaction_change_while_the_warm_up_stood_aside_projects_again (exit 1) |

The second row is #375's fix, run again because its test changed (below).

## Review

Claude Opus 5.5 reviewed `8ac3de22`, then `d40d6099` (GPT-6.1 Sol and Grok unavailable; Nicolas approved Claude
reviewers for this thread). The first review had no medium or high findings; its launch-home configuration and comment
findings are fixed, and the others are recorded above as not covered. The second found the store connection unsafe,
which is why it was removed, and the warm-up test still timing-dependent.

## Test fix

`test_a_redaction_change_while_the_warm_up_stood_aside_projects_again` failed once in a combined run and passed 40 of
40 alone, on this branch and on `origin/main`. It ended its turn as soon as it saw it start, so a loaded machine could
let the warm-up finish without standing aside. Its session record now notes when the warm-up's live-work check, on the
warm-up's thread, reads the running turn, and the turn ends only after that. It passed 30 of 30 alone.
