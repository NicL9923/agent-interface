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

## Red runs

`python3 .agents/tools/mutate-py.py --batch ... --baseline` over `src/hermes/extension.py`, running
`hermes_extension_journal_test`; the baseline passed.

| Mutation | Result |
| --- | --- |
| ten-minute lifetime | failed: test_decorated_history_outlives_an_overnight_idle_until_its_bound (exit 1) |
| untracked redaction keeps the day lifetime | failed: test_decorated_history_follows_native_redaction_registries (exit 1) |
