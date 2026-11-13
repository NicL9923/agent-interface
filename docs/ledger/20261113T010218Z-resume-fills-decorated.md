# November 13 the first open after a restart fills the decorated history

Branch `t3/resume-fills-decorated` over #388 (`t3/decorated-day-lifetime`), on NicolasLaptop (Fedora 44, Linux x64),
Python 3.14.10. Hermes `ed1afb0`. Nothing was deployed by this entry.

## Why

After the `53ee15de` deployment restarted the gateway, `patch` opened in 4,443 ms, then 2,363 ms, then 571 ms. The
second open reused every memo piece but still read and decorated the whole history, because the first open's resume
never filled the decorated history: a decorated entry needs an identity taken before the native read, and before a
resume the session does not exist yet. So every chat paid the whole read twice after each restart, and the second
time for nothing, since the chat had not changed.

## Change

Before the resume, the add-on takes the part of the identity outside the session (`store_identity`): the stamps of
the store Hermes's resume reads and its WAL, the configuration Hermes projects under, and native
redaction state, for the profile's home as `get_profile_dir` resolves it, the same way the warm-up does. After the
resume it takes the session's whole identity and keeps it only if that outside part has not moved. The open then
fills the decorated history as an activation's does, under the same checks (`after == identity` and the journal
version decoration read), and the second open answers from it. A store commit, configuration change or redaction
change during the resume leaves the second open to read again. Hermes's resume never reads the journal, so its
version is read after the resume; the fill still requires it to equal the one decoration read.

`history_identity` now builds its outside part with the same `store_identity`.

## Red runs

`python3 .agents/tools/mutate-py.py --batch ... --baseline` over `src/hermes/extension.py`, running the four add-on
test modules; the baseline passed.

| Mutation | Result |
| --- | --- |
| resume never fills | failed: test_the_second_open_after_a_restart_reuses_what_the_first_one_projected (exit 1) |
| store stamped after the resume | failed: test_a_change_during_the_first_open_leaves_the_second_to_read_again (exit 1) |
| redaction left out of the comparison | failed: test_a_change_during_the_first_open_leaves_the_second_to_read_again (exit 1) |
| store left out of the comparison | failed: test_a_change_during_the_first_open_leaves_the_second_to_read_again (exit 1) |

## Test fixture fix

`ProfilesGateway` created each assistant's `entered` event only when that assistant's native call arrived, while
`test_one_assistants_slow_open_never_holds_up_anothers` and `test_one_assistants_opens_still_run_one_at_a_time` read
`entered["slow"]` right after starting the open's thread. The resume now stamps the store first, so the read came
first and raised `KeyError`. The fixture creates both events up front.

## Not exercised

- A production restart. The deployment that carries this records the opens after it.
