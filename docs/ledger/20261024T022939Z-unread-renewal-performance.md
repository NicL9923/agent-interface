# October 23 unread marks, sign-in renewal and performance validation

This entry covers PR #192 on branch `nic/ux-performance-review`, commit `a73fa28`,
which includes main at `6babefe`. Claude Opus 5.5 implemented the change. The source
fingerprint, from `python3 .agents/tools/source-state.py`, is
`sha256:51fe3f48d25afe9e9c2bef1f705c634eab925e703cb713c250d3dddf14dec6fc` over 1,081
files. Application inputs under `src`, `tests`, `vite.config.ts` and
`vitest.config.ts` are
`sha256:f19da0b3da62031b1236c0f633cc147be2e96bc6a3e7e6ee310fbb9c546636cf`. The native
fingerprint from `source-state.py ios/` is
`sha256:77f9fced8e0feff37afc10c9f90f6651451c39ddbf08bf65eeb46ef64bf77fd4` over 226 files.

The change marks unread chats on home in both clients and renews native sessions in
place, up to 90 days after Google sign-in. iOS poll errors clear when their own read
recovers. Today rereads a settled assistant's history only after its roster preview
changes. Streaming replies parse only their growing block, the web transcript measures
scroll position once per frame, and idle avatars draw about twelve times a second
between blinks and glances.

## Application tests

- On Nicolass-Mini with npm 11.19.1, the typecheck and production build completed.
- All 1,103 application tests passed across 89 files on Node 24.21.0, the production
  runtime, and on Node 26.10.0. GitHub's Node and Python checks passed on the PR.
- New tests that fail without their fix cover:
  - Today reusing a recap redacted under privacy that changed during the read.
  - A pre-renewal session renewed every six days for 120 days, which must stop at 90.
  - Loose lists split by streaming Markdown.
  - The home unread read-through.
  - Idle avatar quiet windows, a property test: eyes open, gaze still and roll under
    0.3 degrees across every slow wait.
- The shared motion answer key `ios/AgentInterfaceTests/Motion/avatar-motion.json`
  now includes the quiet windows. `AvatarMotionParityTests` checks the Swift port
  against them.

## Native tests

- `validate-ios.sh` ran the full AgentInterface scheme on commit `a73fa28` with
  Xcode 27.1 (27A9275) on an iPhone 17 simulator running iOS 27.0. Its iOS inputs
  fingerprint is
  `sha256:bf009bc0927232249553bcc1f4ee8e0741aea6c84133ea0f855012a4b8db2098` over 228
  files.
- 488 tests passed, four documented skips, zero failures. The run took 27 minutes.
- The iOS review fixes have regression tests that fail with the fixes reverted:
  - A poll pass cancelled during renewal must start no stream.
  - Roster and chat dismissals overlapping.
- An earlier combined run on the pre-review iOS commit had one failure. Reading a
  contract fixture failed with "Interrupted system call" after about 38 minutes,
  before the test reached any changed code. That class passed 27 of 27 alone.

## Review and visual checks

- GPT-6.1 Sol reviewed the server and web half, then the iOS half with those fixes,
  at high reasoning effort. Every finding was fixed.
- The web fixture preview showed the unread dot, bold name and brighter preview at
  1280 and 390 pixel widths in WebKit.

## Not exercised

- No avatar frame-rate or battery measurement on a physical iPhone.
- No renewal against a production server; the native tests used fake servers.
- No production release. Several changed server files are Hermes qualification
  inputs, so releasing this commit needs a fresh host qualification.
