#!/usr/bin/env node
/** Check the pinned Bun and its staged server bundle before systemd starts WildBots. */

import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "1.4.5";

function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1 || argv[0].startsWith("-")) {
    console.error("Usage: bun-service-check.mjs ABSOLUTE_PATH_TO_BUN");
    process.exit(2);
  }
  const bunPath = argv[0];
  if (!isAbsolute(bunPath)) {
    console.error("provide the absolute path to Bun");
    process.exit(2);
  }

  let version;
  try {
    version = execFileSync(bunPath, ["--version"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    console.error(
      `Cannot run Bun at ${bunPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
  if (version !== VERSION) {
    console.error(`Expected Bun ${VERSION} at ${bunPath}, found ${version}.`);
    process.exit(1);
  }

  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const bundle = join(root, "dist", "server");
  for (const name of ["index.js", "index.js.map", "terminal-host.js"]) {
    const target = join(bundle, name);
    let ok = false;
    try {
      ok = statSync(target).isFile();
    } catch {
      ok = false;
    }
    if (!ok) {
      console.error(`Missing ${target}. Run pnpm run build:server:bun.`);
      process.exit(1);
    }
  }
  console.log(`Bun ${VERSION} and the WildBots server bundle are ready.`);
}

main();
