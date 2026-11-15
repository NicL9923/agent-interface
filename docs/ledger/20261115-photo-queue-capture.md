# Photo queue envelope capture

Base `92b3fadc4f712a4338166c5f6184183fae54ca6c`, fetched `origin/main` before editing. Python 3.14, Node 24.22.2, NicolasLaptop. No production host or deployed Hermes was used.

Hermes `ed1afb082eb3e46cf2edae9d8f68fb67b09ee4df` was read from `/home/nic/scratch/wildbots-review/hermes-agent`. SHA-256: `session_auto_continue.py` `d89e10766095877342c5cce6378f1ac54fbefbd808e55018412d9e5e698157b2`, `methods_prompt.py` `86b6e4a760f4cbe1d01d929a7e552eac53c5da0792bed754ad14fd286e95dfed`, `method_ctx.py` `2f8b8098dc16bfecb6c31de15eca21ab426f48f7e18e8adb78492a0bb70d5514`. The `_enqueue_prompt` function has SHA-256 `697ecfde2d7635be2d086263a04aaa9960ef6e45fba71f21f86a1331ff47ad40` at `ed1afb0` and both qualified revisions `b9cb268` and `d23cc6b`. `tests/hermes_upstream_queue.py` copies that function and its four queue helpers verbatim, SHA-256 `9f4c7e6cc9f285602da1d75e0bebe27567069b1def3adc21fc03e3a4f8b55f2a`.

`methods_prompt.py` calls `_handle_busy_submit` with the request ID on the same thread. `method_ctx.bind_module` binds its globals to the server module. Under `history_lock`, the busy handler calls `_enqueue_prompt`, which returns the actual new or merged envelope, or `None` for a duplicate. The extension captures its image paths in that call, scoped to the request ID and session. It does not infer ownership from text or depend on the entry still being queued. No envelope remains a legitimate no-warning case. Other turns and joined prompts retain their existing handling. Attaching and submitting are still separate native requests; this change cannot prevent a different turn taking a photo.

## Regression evidence

The three photo-only cases call the pinned upstream enqueue and helpers through the fake gateway's native enqueue edge. The bridge and receipt are real. They cover an entry drained before another entry appears, an empty prompt merged into another sender's text after the photo was taken, and a new empty entry without its photo. Other tests cover text with photos, joined sends, and no queue entry. These do not start a full Hermes process.

`python3 .agents/tools/mutate-py.py --batch /tmp/photo-mutations.json` restored production source byte for byte. With the original `92b3fadc` implementation, the drained-entry case failed on the false `imagesMissing`. With Claude's attempted empty-text guard, the merged-entry case failed because `imagesMissing` was absent. Both runs used the pinned upstream queue functions. Replacing the captured images with an empty list also made the drained-entry test fail. `python3 tests/hermes_photo_staging_test.py` then passed 27 tests.

The hook is installed only when both native functions exist. If a future unqualified Hermes revision removes or bypasses them, queued receipts do not report missing photos; source qualification is required before using such a revision.

Source state for the focused pass: `extension.py` SHA-256 `888b42b3d041dbfc9de802d50ac98a6fdcfcffe6d9d3d2392015d8b8617488a4`, `hermes_photo_staging_test.py` `76beba42b36c97edba449c16d4dabec78ef7c2f6d0b1c92021b5f601afe536e5`, `hermes_turn_binding_test.py` `d5356634fc31fa36c7e6af26bbec807c81b30af32c39a5c060fc5f0d8f8d3465`. The fixture subsequently received its `typing.Any` import and upstream MIT license notice. Logs: `/tmp/photo-test.log`, `/tmp/photo-upstream-repro.log`. Full validation is queued under the machine lock.

`python3 tests/hermes_turn_binding_test.py` passed 42 tests at `91489670`. Log: `/tmp/photo-turn-test.log`.
