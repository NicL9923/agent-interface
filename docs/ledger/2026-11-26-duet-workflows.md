# 2026-11-26 — Duet-inspired workflows on native WildBots

## Summary

Implemented seven proactive and triage workflows directly on the native SQLite + Bun + WildBots MCP stack:

1. **Inline Today triage** (`src/components/TodayPanel.tsx`, `src/server/experience.ts`): approve/decline external action confirmations, answer inline questions, review pending memory/skill proposals, sign off on tasks, and act on ready drafts directly in Today.
2. **Card-emitting Check-ins & first-class Morning Brief** (`src/server/main-assistant.ts`, `src/app/BotDetails.tsx`): upgraded `checkInPrompt` to attach ready `agent-ui` cards, added `PUT /preferences/morning-brief` managing a daily cron routine on the member's Main Assistant, and pinned the latest brief at the top of Today.
3. **Lightweight SQLite Tasks with human-only Done gate** (`src/server/store-tasks.ts`, `src/server/task-routes.ts`, `src/server/mcp/task-tools.ts`): bots create and update tracked tasks and propose `ready_for_review` with a summary, while only household members can transition a task to `done` or request changes.
4. **Cross-assistant Deliverables ("Outputs") gallery** (`src/server/deliverables.ts`, `src/components/OutputsPanel.tsx`): unified cross-bot index of `wildbots-html` inline views, `agent-ui` cards, and generated files with in-place previews.
5. **Shared personal memory & Topic Channels** (`src/server/store-memory.ts`, `src/server/store-channels.ts`, `src/server/channel-routes.ts`, `src/components/ChannelCreateDialog.tsx`): active personal `user` facts flow across an owner's personal bots (never shared household bots), and `#topic` channels inherit the Main Assistant's model, harness, MCP servers, and shared memory.
6. **External side-effect confirmation cards in WildBots MCP** (`src/server/store-confirmations.ts`, `src/server/confirmation-routes.ts`, `src/server/mcp/confirmation-tools.ts`): `action_confirm` blocks on a structured human preview card before irreversible external writes.
7. **Mobile/quick-capture Brain Dump → triage** (`src/shared/brain-dump.ts`, `src/components/BrainDumpDialog.tsx`): dictation or text capture (reachable from Today, Home, Command Palette, and `/?braindump=1`) sending a structured triage turn to the Main Assistant.

## Red-run proof

- Guard tested: `src/server/store-tasks.ts` (`if (status === "done" && !actor.allowComplete)`).
- Mutation: disabled guard (`if (false && status === "done" && !actor.allowComplete)`).
- Command: `npx vitest run tests/duet-workflows-api.test.ts`
- Result: failed as expected at `tests/duet-workflows-api.test.ts:239` (`expected undefined to be true` on `botDone.result?.isError`).
- Restored guard and re-verified green under `.agents/tools/check-all`.
