import { spawnSync } from "node:child_process";
import { copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const build = spawnSync(
  "bun",
  [
    "build",
    "src/server/index.ts",
    "--outdir",
    "dist/server",
    "--target",
    "bun",
    "--sourcemap=linked",
  ],
  { cwd: root, stdio: "inherit" },
);

if (build.error?.code === "ENOENT") {
  console.error("Bun is missing from PATH. Install Bun 1.4.5 and add its directory to PATH.");
  process.exit(1);
}
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);

// The terminal starts this helper relative to the server module's import.meta.url.
copyFileSync(
  fileURLToPath(new URL("src/server/terminal-host.py", root)),
  fileURLToPath(new URL("dist/server/terminal-host.py", root)),
);
