# Repository tools

- `python3 .agents/tools/source-state.py` prints the source fingerprint used by the validation ledger, excluding the ledger itself and ignored build/runtime files.
- `python3 .agents/tools/review-collage.py output.png 'Label=screenshot.png' ...` combines screenshots at a common height with labels and preserved aspect ratios; requires Pillow.
- `node .agents/tools/native-smoke.mjs http://127.0.0.1:3004` verifies one-time native authentication, a canonical Hermes conversation, Origin rejection and revocation against a running loopback server with explicit local test accounts. It never prints credentials.
- `bash .agents/tools/validate-ios.sh SIMULATOR_UUID [test|build|live]` runs the native app's simulator checks on the Mac mini with local ad hoc signing for Keychain, task-local derived data and a unique result bundle. Choose a simulator reserved for this work. `live` explicitly exercises the real loopback app server at port 3004; prepare its isolated Hermes fixture first.
- `node .agents/tools/backup-app.mjs APP_DATABASE BACKUP_DIRECTORY` makes a private online SQLite backup, checks its integrity, and retains the latest 14 completed copies. It includes committed WAL data and does not back up Hermes or host secrets.
- `python3 .agents/tools/archive-release.py OUTPUT.tar.gz` packages Git-visible server, build and test inputs without ignored credentials, runtime data or macOS extended-attribute files.
