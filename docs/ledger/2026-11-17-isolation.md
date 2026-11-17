# Vitest file isolation

The default is `isolate: false`. The explicit exceptions in `vitest.config.ts` are files that failed single-worker shuffled runs after app module-cache resets, timer restoration, and stub cleanup. New files start shared.

Reproduce with `npm test -- --sequence.shuffle.files --sequence.seed=731 --maxWorkers=1` or seed 1907. The migration logs are in the task validation ledger, keyed to the exact input states. The initial all-shared run failed 103 of 224 files. After cleanup, seed 731 failed 63 files; a different shared-file order in seed 1907 found additional failures. A subsequent run found `computer-api` and `live-turn-runtime` timeouts after reducing the exception set. APNs transport also reported an unhandled `ERR_HTTP2_STREAM_CANCEL` while closing its real HTTP/2 session in the initial shuffled run.

These integration fixtures combine per-file I/O mocks with cached lazy UI modules, or real streams/sockets with virtual-clock schedules. Fresh dependency state preserves their existing assertions. The exceptions retain coverage; they do not skip tests or weaken timeouts. `vitest-projects.test.ts` uses Vitest's actual discovery to prevent duplicate or omitted files.

- `tests/account-transitions-ui.test.ts`
- `tests/advanced-routines-ui.test.ts`
- `tests/agent-exchange-ui.test.ts`
- `tests/apns-transport.test.ts`
- `tests/app-badge.test.ts`
- `tests/app-ui.test.ts`
- `tests/app-update.test.ts`
- `tests/approval-settings-ui.test.ts`
- `tests/artifacts-ui.test.ts`
- `tests/automation-ui.test.ts`
- `tests/avatar-component.test.ts`
- `tests/avatar-editor.test.ts`
- `tests/background-polls-ui.test.ts`
- `tests/bot-access.test.ts`
- `tests/bot-details-ui.test.ts`
- `tests/bot-menu-ui.test.ts`
- `tests/bot-settings.test.ts`
- `tests/chat-header-ui.test.ts`
- `tests/chat-model-picker.test.ts`
- `tests/chat-presence-ui.test.ts`
- `tests/collaboration-ui.test.ts`
- `tests/computer-api.test.ts`
- `tests/computer-chunk-failure.test.ts`
- `tests/computer-ui.test.ts`
- `tests/connection-grace-ui.test.ts`
- `tests/connection-ui.test.ts`
- `tests/conversation-prefetch.test.ts`
- `tests/device-notifications.test.ts`
- `tests/discovery-ui.test.ts`
- `tests/error-reports-ui.test.ts`
- `tests/event-stream-ping.test.ts`
- `tests/experience-api.test.ts`
- `tests/experience-ui.test.ts`
- `tests/find-palette-ui.test.ts`
- `tests/group-room-settings-ui.test.ts`
- `tests/hermes-adapter.test.ts`
- `tests/home-groups-ui.test.ts`
- `tests/image-dimensions-ui.test.ts`
- `tests/integrations-ui.test.ts`
- `tests/linked-chat-ui.test.ts`
- `tests/live-reply-ui.test.ts`
- `tests/live-turn-runtime.test.ts`
- `tests/live-updates-ui.test.ts`
- `tests/mac-settings-ui.test.ts`
- `tests/main-assistant-ui.test.ts`
- `tests/message-markdown.test.ts`
- `tests/model-selector.test.ts`
- `tests/ops.test.ts`
- `tests/panels.test.ts`
- `tests/portrait-upload.test.ts`
- `tests/preferences-dialog-ui.test.ts`
- `tests/prefetch-after-action-ui.test.ts`
- `tests/request-hooks.test.ts`
- `tests/routine-rooms-api.test.ts`
- `tests/routine-runs-ui.test.ts`
- `tests/saved-messages.test.ts`
- `tests/saved-roster-ui.test.ts`
- `tests/session-preferences-ui.test.ts`
- `tests/shell-ui.test.ts`
- `tests/sidebar-ui.test.ts`
- `tests/stream-hide-ui.test.ts`
- `tests/stream-revival-ui.test.ts`
- `tests/streaming-reveal.test.ts`
- `tests/submission-state-ui.test.ts`
- `tests/talk-ui.test.ts`
- `tests/thinking-at-send-ui.test.ts`
- `tests/time.test.ts`
- `tests/transcript-rerender.test.ts`
- `tests/transcript-ui.test.ts`
- `tests/ui-primitives.test.ts`
- `tests/usage-ui.test.ts`
- `tests/view-failure.test.ts`
- `tests/voice-ui.test.ts`
- `tests/waiting-input-ui.test.ts`
- `tests/worker-opens-ui.test.ts`

The narrower exception set exposed two additional shared-worker timeouts in seed 731: `service-worker.test.ts` and `direct-routes.test.ts`. Both are now isolated; their clock-driven worker and listener contracts remain intact.

The same narrower seed-731 run also timed out six serialized policy-change cases in `main-assistant-api.test.ts`; it now retains isolation. The run collected each of the 225 files exactly once.
