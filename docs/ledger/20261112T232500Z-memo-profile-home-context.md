# November 12 one profile home as a Path or a string is one projection context

Branch `t3/memo-profile-home-context` over `origin/main` at `faeca942`, on NicolasLaptop (Fedora 44, Linux x64), Python
3.14.10. Hermes `ed1afb0`, read from a local clone of upstream at that revision. Nothing was deployed by this entry.

## Defect

`measure-chat-open.mjs --rounds 3` right after the `faeca942` deployment restarted the gateway at 23:08:14 UTC, with
the new `addon-cache` counts. The warm-up warmed 6 of 6 assistants in 14.4 s.

| Assistant | Open 1 | Open 2 | Open 3 |
| --- | --- | --- | --- |
| patch | 4,242 ms, warm=1, reused 86 of 86 | 4,882 ms, reused 0 of 86 | 297 ms, decorated |
| kimberly | 715 ms, warm=1, reused 4 of 4 | 170 ms, reused 0 of 4 | 128 ms, decorated |
| wft-marketing | 735 ms, warm=1, reused 9 of 9 | 367 ms, reused 0 of 9 | 67 ms, shared |
| lumen | 1,406 ms, warm=0, reused 0 of 3 | 190 ms, reused 0 of 3 | 137 ms, decorated |

Every memo reported `emptied=0` and the budget peaked at 89 percent, so the budget did not evict anything; that guess
was wrong. Instead every second open reused no piece at all. A resume projects with `profile_home=self.profile_home`,
a `Path` (`tui_gateway/methods_session.py:615,672-673`), and stores `str(ctx.profile_home)` on the session (`:1028`).
Every later activation projects with that string (`tui_gateway/session_registry.py:814-815`). `projection_context`
compared arguments by `repr`, so `PosixPath('/x')` and `'/x'` were two contexts and the memo emptied on the second
open. The warm-up passes a `Path` as well, which is why the first open adopted it and the second did not.

## Change

`projection_context` compares a `profile_home` given as a string or a path by its normalized path string. Other
arguments still compare by `repr`, and a different home still projects again: its `config.yaml` stamp is keyed by the
home's path.

## Red runs

`python3 .agents/tools/mutate-py.py --batch ... --baseline` over `src/hermes/extension.py`, running
`hermes_projection_memo_test`; the baseline passed.

| Mutation | Result |
| --- | --- |
| profile home compared by repr | failed: test_one_home_as_a_path_or_a_string_reuses_every_piece_and_another_home_does_not (exit 1) |
| profile home compared without normalizing | failed: test_one_home_as_a_path_or_a_string_reuses_every_piece_and_another_home_does_not (exit 1) |
| every home is one context | survived |

The survivor is equivalent: the context's `configs` part holds each home's path with its `config.yaml` stamp, so a
different home is a different context with or without the argument.

## Not changed

- The first open after a restart still costs what Hermes's resume costs. For `patch` that was 3.6 s of `activate`
  even with every piece reused, so it is resume and store-read work outside the projection.
- The resume does not fill the decorated history, so the third open is the first decorated hit. Filling it would
  need a history identity taken before the session exists.
