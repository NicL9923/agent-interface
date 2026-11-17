import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

// Release archives have no Git metadata. Do not change a containing repository's hooks.
if (existsSync(".git")) {
  const result = spawnSync("node", ["node_modules/husky/bin.js"], { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
