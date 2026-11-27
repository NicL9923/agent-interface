# 2026-11-27 — Vault & Secret Inputs, Final Hermes Feature Migration, and Grok Voice Previews

## Summary

Completed the remaining native `HarnessRuntime` migration so memory, learning/skills review, transcript search/history, routine schedule preview & trial run receipts, automations usage, and interactive vault/secret requests run natively in WildBots without Hermes, updated user-facing copy from Hermes to WildBots across server, Web, and iOS, fixed secret/vault inputs, and added sample audio clips for all five xAI Grok Voice voices.

## Key Changes

1. **xAI Grok Voice sample clips**
   - Generated authentic Grok Voice `.m4a` clips (`public/voice-previews/{eve,ara,rex,sal,leo}.m4a`, AAC-LC 24 kHz mono 48 kbps `+faststart`) via the xAI TTS API.
   - Enabled Play/Stop preview buttons for Grok voices on both Web (`src/components/VoicePicker.tsx`) and iOS (`ios/AgentInterface/TalkVoicePicker.swift`).

2. **Vault & secret inputs**
   - Upgraded `src/server/harness/native-vault.ts` to `createNativeVaultService`: manages encrypted named bot secrets (`add_secret`/`remove_secret` with reserved-prefix rejection and metadata-only overview) plus live pending secure requests (`secret_request`, `vault_request_login`, `vault_request_code`) enforcing `profile`, `requestId`, `epoch`, `sessionId`, `method`, explicit requester ownership (`requestedBy`), and origin echo.
   - Added `POST /api/bots/:id/vault/secrets` and `DELETE /api/bots/:id/vault/secrets/:name` in `src/server/vault.ts`, origin/OTP trimming, and MCP tools `vault_request_login` / `vault_request_code` in `src/server/mcp/vault-tools.ts`.
   - Wired `requestSecret`, `requestLogin`, and `requestCode` through `HarnessRuntime` (`src/server/harness/runtime.ts`) and `composeServerRuntime` (`src/server/native-harness.ts`), surfacing pending requests in `conversation.attention` with `activity.state === "blocked"` and clearing them on turn finish/stop/steer/delete/close.
   - Updated Web (`src/components/VaultPanel.tsx`, `src/components/SecureRequestCard.tsx`) and iOS (`ios/AgentInterface/VaultViews.swift`) with trimmed/validated website origins, optional masked authenticator (`otpSecret`) input, Saved secrets CRUD, and input hygiene (`autoCorrect="off" autoCapitalize="off" spellCheck={false}`).

3. **Native Memory, Experience, and Automation migration**
   - Added `src/server/harness/native-experience.ts` implementing native SQLite memory read/edit/delete (with optimistic concurrency revision hashes and `screenText` prompt-injection/secret guards), transcript search with `secrets.redactForBot`, paginated history, cron/interval/once schedule preview, idempotent trial runs & receipts, routine results/output, usage, and model names.
   - Added `src/server/harness/native-automation.ts` implementing native learning/skills overview, diff, approve/reject with revision verification, auto-apply policy toggle, task management, and graceful `approval-settings` (`{ supported: false }`).
   - Updated `HarnessRuntime.systemPromptFor` to always include WildBots `# Memory & skills` (with anti-`MEMORY.md` guidance) and `# Vault & secrets` instructions so newly created assistants know how to use native memory and vault tools from turn one.
   - Replaced user-facing `"Hermes"` copy with `"WildBots"` / `"this assistant"` across server routes, Web UI, iOS UI, and contract fixtures (`ios/AgentInterfaceTests/Contract/today.json`).

## Hand-Broken Red-Run Proofs

Each newly added protective test was verified to fail when its guarded line was broken by hand, then restored:

1. **Explicit login origin echo guard (`src/server/harness/native-vault.ts:360`)**
   - Temporarily disabled `if (entry.expectedOrigin && input.answer.origin !== entry.expectedOrigin)`.
   - Ran `pnpm exec vitest run tests/native-vault-adapter.test.ts`: failed on `coordinates live secret, explicit login, and code requests with actor, origin, cancel, and expiry enforcement` (`promise resolved "{ status: 'ok' }" instead of rejecting` with `Conflict`).
   - Restored guard.
2. **Grok Voice sample playback button (`src/components/VoicePicker.tsx:195`)**
   - Temporarily hid the sample preview button for Grok voices (`{!isGrok && (...)}`).
   - Ran `pnpm exec vitest run tests/talk-ui.test.ts`: failed on `plays and stops Grok Voice sample clips and ships all five preview audio files` (`Play Eve sample: expected null to be truthy`).
   - Restored button.
3. **Native memory optimistic revision guard (`src/server/store-memory.ts:925,1058`)**
   - Temporarily disabled `if (this.documentRevision(botId, kind) !== expectedRevision)`.
   - Ran `pnpm exec vitest run tests/native-experience.test.ts`: failed on `reads, edits, deletes, screens, and injects native SQLite memory into the next turn's prompt` (`expected 200 to be 409`).
   - Restored guard.

## Validation

- Ran `pnpm run format` and `.agents/tools/check-all` (Oxlint, Oxfmt/Prettier format check, Oxc `tsrs` typecheck, Vite + service-worker build, full Vitest suite, and Playwright Chromium + WebKit e2e).
