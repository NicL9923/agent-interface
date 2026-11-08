# October 22 Hermes update to 41dfcf2c

Production Hermes moved from `acc3cada0da8` (committed October 15) to official upstream
`41dfcf2c1bd7146d4ad46aea08b7dd007900602e` (committed October 22, 15:56 UTC) through the
app's own updater, running app release `release-2c495606-20261022T163032Z`. The updater
operation was `3c46a434-5256-4253-bb97-fd6180478d90`.

The first two checks failed for host reasons. The first refused because the host had
14 GB free, below the 20 GB minimum; removing 120 unreferenced release builds from before
October 20 freed 21 GB. The second checked candidate `92663ae8054a` and failed its
local-network browser probe: the worker inherited the app service's private `/tmp`
user namespace, where AppArmor's user-namespace restriction stops Chrome's sandbox.
PR #176 starts the worker as its own systemd user unit. With it live, the check of
`41dfcf2c` passed source, repair (re-applied over nearby upstream edits with identical
changed lines), upstream, staging, dependencies, real integration and private
regressions. The install passed quiescence, backup, install, verify and release.

Afterwards the gateway, dashboard, app and shared computer services were active, the
gateway reported `41dfcf2c1bd7` with no active agents and both Discord connections
connected, and the native availability check verified authenticated bootstrap, native
connectivity and build 12. A household conversation on the new revision was not
exercised.
