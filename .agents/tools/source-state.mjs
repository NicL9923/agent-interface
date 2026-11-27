#!/usr/bin/env node
/** Identify the source state, including uncommitted files, for validation evidence. */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const paths = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: root, encoding: "utf8" },
).split("\0");

// The ledger records fingerprints of this state, so it cannot be part of it.
const LEDGER_ARCHIVE = "docs/ValidationLedger.md";
const LEDGER_DIR = "docs/ledger/";
const prefixes = process.argv.slice(2);
const digest = createHash("sha256");
let count = 0;

for (const relative of [...new Set(paths)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
  if (!relative || relative === LEDGER_ARCHIVE || relative.startsWith(LEDGER_DIR)) continue;
  if (prefixes.length && !prefixes.some((prefix) => relative.startsWith(prefix))) continue;
  const full = join(root, relative);
  let info;
  try {
    info = statSync(full);
  } catch {
    continue;
  }
  if (!info.isFile()) continue;
  const data = readFileSync(full);
  digest.update(Buffer.from(`${relative}\0${data.length}\0`, "utf8"));
  digest.update(data);
  count += 1;
}

if (prefixes.length && count === 0) {
  console.error("No source files matched the supplied path prefixes.");
  process.exit(1);
}
console.log(`sha256:${digest.digest("hex")} (${count} source files)`);
