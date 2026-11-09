# November 9 Talk voice turns

Branch `talk-voice-turn`, based on `origin/main` at `7a1f782`. Linux host with Node and Python 3.14,
no Apple toolchain. Hermes source read on `hermes-prod` at `ed1afb082e` (read only).

## What changed

A spoken Talk request that starts a new turn now reaches native `prompt.submit` with
`voice_turn: true`, so Hermes runs that turn on `auxiliary.voice_chat`: its reasoning effort, and its
model when one is set. The server passes the mark only on the send to Hermes, never in the recorded
request, so asking again with the same ID cannot conflict with a request recorded before the change.
The add-on forwards only a literal `true`, and never on a steer. Typed messages carry no mark.

Production configuration, set by hand on November 9 with backups `config.yaml.bak-20261109T150439Z`:
`auxiliary.voice_chat.reasoning_effort: low` in the launch profile and all ten bot profiles. Nothing
else in those files changed.

## Checks that ran

- Typecheck and lint clean. Full `vitest run`: 168 files, 2408 tests passed. Full Python suite ran.
- New tests: `tests/talk-api.test.ts` (spoken request marked, typed message not, recorded request not),
  `tests/hermes-adapter.test.ts` (the add-on call carries `voice_turn` only for a spoken request),
  `tests/hermes_extension_journal_test.py` (a literal true reaches `prompt.submit`; `"true"`, a missing
  mark and a steer do not).

## Mutants, each confirmed red then restored

- The add-on forwards the mark on a steer; forwards any truthy value; never forwards it.
- The adapter drops `voice_turn`.
- The mark is stored in the recorded request; Talk sends without it; a typed message is marked.

## Not exercised

- No real Hermes turn with the mark. Whether a voice-routed turn is faster, and by how much, is not
  measured. The fake gateway models the add-on's call, not Hermes's route binding.
- iOS Talk uses the same `talk/ask` route, so it needs no client change; not run on a device.
