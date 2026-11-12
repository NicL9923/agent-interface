# November 12 one assistant's journal writes keep another's decorated history

Branch `t3/36e26aad` over `origin/main` at `1e3cb31`, on NicolasLaptop (Fedora 44, Linux x64), Python 3.14.10.
Hermes `ed1afb0`, read on the production host with `sed` and `grep` only. Nothing was deployed.

## Defect

The add-on's decorated-history cache missed twice in a row for `patch` while it was idle, each miss a full history
read and projection of 5 to 7 s. Watching `patch`'s `state.db` and `state.db-wal` stamps for 130 s on the
production host showed no change, and two back-to-back opens of `patch` alone missed then hit (6.2 s, 0.36 s), so
the file stamps were not the cause.

The cache was keyed on `Journal.mutation`, the journal connection's `total_changes`: one counter for the whole
household. Any journal write invalidated every assistant's cached history, such as another assistant's tool record,
a receipt binding during another chat's open, or a notification event. The first production probe opened the other
assistants between `patch`'s rounds and saw miss, miss, hit. `total_changes` also never counted another connection's
commits, so a journal write from another process left a cached history in place.

## Change

`profile_versions` counts, per profile, every insert, update and delete on `receipts` and `tools`, the journal rows
decorated history reads, through triggers. A row moved to another profile counts for both. Every writer counts:
sibling add-ons and other processes included. `Journal.version(profile)` replaces `Journal.mutation`, which is removed.

## Red runs

`python3 .agents/tools/mutate-py.py --batch` against `python3 tests/hermes_extension_journal_test.py`:

| Mutation | Result |
| --- | --- |
| global counter again | failed: test_poll_never_shows_half_of_a_concurrent_write (exit 1) |
| version never moves | failed: test_decorated_cache_skips_projection_and_binding_and_invalidates (exit 1) |
| receipts only | failed: test_decorated_cache_skips_projection_and_binding_and_invalidates (exit 1) |
| no delete trigger | failed: test_every_write_to_a_profiles_receipts_and_tools_moves_only_its_version (exit 1) |
| no update trigger | failed: test_every_write_to_a_profiles_receipts_and_tools_moves_only_its_version (exit 1) |
| no moved trigger | failed: test_every_write_to_a_profiles_receipts_and_tools_moves_only_its_version (exit 1) |
| fill keyed on stale version | failed: test_decorated_cache_skips_projection_and_binding_and_invalidates (exit 1) |

The existing cache test used an `events` insert to prove invalidation, which held only because of the global
counter. Decorated history reads no events; the test now shows an event and another profile's receipt keep the
cache, and this profile's tool record and another connection's receipt invalidate it.

## Checks

The journal, open row cache, turn binding and shell summary Python tests pass. Not exercised: release qualification
and the running gateway.
