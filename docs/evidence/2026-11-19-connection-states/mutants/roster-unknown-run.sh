#!/usr/bin/env bash
# Runs each roster-unknown mutant list against the file each entry names. Lists hold (file, old, new).
set -u
cd "$(dirname "$0")/../../../.."
M=docs/evidence/2026-11-19-connection-states/mutants
SERVER="npx vitest run tests/hermes-adapter.test.ts tests/connection-server.test.ts tests/conversation-events.test.ts tests/runtime-router.test.ts"
WEB="npx vitest run tests/connection-grace-ui.test.ts tests/saved-roster-ui.test.ts"
python3 - "$M" "$SERVER" "$WEB" <<'PY'
import runpy, subprocess, sys, pathlib
m, server, web = sys.argv[1:]
paths = {"unknown-roster.ts": "src/server/unknown-roster.ts", "hermes.ts": "src/server/hermes.ts",
         "runtime-router.ts": "src/server/runtime-router.ts", "runtime-snapshot.ts": "src/server/runtime-snapshot.ts",
         "event-routes.ts": "src/server/event-routes.ts", "use-session.ts": "src/app/use-session.ts", "App.tsx": "src/App.tsx"}
for name, cmd in (("server", server), ("web", web)):
    caught = total = 0
    for file, old, new in runpy.run_path(f"{m}/roster-unknown-{name}.py")["MUTANTS"]:
        total += 1
        out = subprocess.run(["python3", str(pathlib.Path.home() / ".agents/tools/mutate.py"), "--replace", old, new, paths[file], cmd], capture_output=True, text=True)
        ok = out.returncode == 0
        caught += ok
        print(("caught   " if ok else "SURVIVED ") + f"{file}: {old.strip()[:90]!r}")
    print(f"{name}: {caught} of {total} caught")
PY
