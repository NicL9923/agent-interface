# November 12 waiting opens that differ only in window share one activation

Branch `t3/d9d06f0e` over `265f36db`, on NicolasLaptop (Fedora 44, Linux x64), Python 3.14.10. Same source fingerprint
as [the projection memo entry](20261112T035301Z-projection-memo.md). Nothing was deployed.

## Defect

The add-on merged waiting opens only when every parameter matched. The server's turn read (`{start}`, after each
tool event) and a client's page (`{turns: 20}`) queued behind a running open ran back to back, each a full
activation and decoration: about 5.6 s on `patch` (from the design review, not measured here).

## Change

`route` keys an open's merge on its connection and parameters without `window`. The merged job runs one activation
and decoration; `open_locked` cuts each merged request's own window, the last step of an open, into a context
variable the job set, and each request is answered with its own rows and `app_window`. Every answer is copied
separately. `omit_messages` stays in the key, so an open without history never answers one that asked for it.
`LaneQueue` is unchanged: a request joins only a job still waiting, so its computation starts after it arrived.

## Tests and red runs

`tests/hermes_extension_journal_test.py`, `ReadMergeTests`: a turn read, a page and a whole read queued behind a
running open share one activation, and each is cut as it asked (rows 31 to 50 with the prompt as context, 11 to 50,
1 to 50); an `omit_messages` open and a windowed open never merge; a request with another window arriving after the
job started gets its own.

`python3 .agents/tools/mutate-py.py --batch` against `python3 tests/hermes_extension_journal_test.py ReadMergeTests`:

| Mutation | Result |
| --- | --- |
| window still keys the merge | failed: test_waiting_opens_that_differ_only_in_window_share_one_activation_and_each_gets_its_own_cut (exit 1) |
| only the profile keys the merge | failed: test_waiting_opens_merge_only_with_the_same_parameters_connection_and_method (exit 1) |
| every merged open gets the first window | failed: test_waiting_opens_that_differ_only_in_window_share_one_activation_and_each_gets_its_own_cut (exit 1) |
| answers share their rows (against `tests/hermes_open_row_cache_test.py`) | failed: test_changing_one_response_never_changes_another (exit 1) |

Not exercised: real Hermes, release qualification, and a production measurement of merged turn reads.
