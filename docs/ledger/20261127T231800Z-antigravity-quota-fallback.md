# Antigravity inline 429 error detection, retry fast-fail, and fallback cooldown

Branch `t3/fix-subscription-quota-error`, based on `origin/main` at `a8031ac4`.

## Root cause

When Nicolas's Google Antigravity subscription (`nicolas-antigravity-sub`) hit HTTP 429
`RESOURCE_EXHAUSTED` on `gemini-4-neon`, `agy acp` retried 8 times over ~2m30s and then
surfaced the error as a normal `agent_message_chunk` containing
`\n⚠ RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).\n`
followed by `stopReason: "end_turn"`. `AntigravitySession` forwarded that chunk as
`text.delta` and emitted `turn.completed`, saving the raw error into Kim's chat transcript
and preventing `HarnessRuntime` from falling back to OpenRouter DeepSeek V4.1 Flash (`pi`).

## What changed

- `src/server/harness/antigravity-driver.ts`:
  - Buffers only leading `⚠`-prefixed output (zero latency for normal replies), extracts
    Antigravity inline error banners via `extractAntigravityInlineError`, and emits
    `turn.failed` without polluting `text.delta` while preserving normal `⚠` replies.
  - Passes a private per-session `--log-file` (cleaned up on close/exit) and tails it
    during silent turns so sustained HTTP 429 / `RESOURCE_EXHAUSTED` retry loops fail fast
    after 2 failed attempts (~5s) instead of hanging ~2m30s.
- `src/server/harness/runtime.ts`:
  - Adds a 5-minute per-bot quota/rate-limit cooldown (`fallbackCooldownMs`, keyed by
    bot ID + harness + credential + model) so a prompt-specific or bot-specific 429 never
    knocks other healthy bots off Antigravity, while the affected bot's subsequent direct,
    routine, and group turns route straight to the warm fallback during the window and
    automatically retry the primary once it expires.
  - Clears partial primary reasoning and resets activity state to `thinking` when falling
    back on `turn.failed`, and skips speculative `warmSession` on cooled-down primaries.

## Additional root cause discovered on `hermes-prod`

Testing all 11 managed bots on `hermes-prod` showed 10/11 returned `OK` on `gemini-4-neon`
while `kimberly` deterministically returned HTTP 429 `RESOURCE_EXHAUSTED` because Google's
Antigravity backend rejected the exact phrase
`"Be direct: match the length of your reply to the weight of the ask"` in `kimberly`'s
`instructions`. Rewording that single phrase in `managed_bots` restored 3/3 `OK` responses
on `gemini-4-neon` with `kimberly`'s full system prompt, memory, 121 skills, and handoff.

## Red proof

Broke `extractAntigravityInlineError` (returned `undefined`), `startLogWatch` (returned
early), and `isPrimaryInCooldown` (returned `false`) together by hand and ran
`pnpm test tests/harness-antigravity-driver.test.ts tests/harness-runtime.test.ts --testTimeout=2000`.
All 4 protecting tests went red (`2 failed (2) | 4 failed | 28 passed (32)`): inline error
banner conversion, 429 retry-loop fast-fail, runtime fallback cooldown, and end-to-end
real Antigravity ACP inline 429 fallback. Restoring the implementation returned all tests
to green.

## Final run

Validated with `.agents/tools/check-all` before committing and deploying to `hermes-prod`.
