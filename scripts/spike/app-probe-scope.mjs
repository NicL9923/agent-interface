/** The files whose bytes the app probe's source digest binds. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// The probe runs the whole Fastify app, so every server and shared file counts, including one
// in a nested folder the qualification manifest does not list yet.
const TREES = ["src/server", "src/shared"];
const PROBE_ONLY = ["package.json", "scripts/spike/app-probe-scope.mjs"];

/** The qualification inputs plus the probe-only files, as sorted paths relative to root. */
export function probeScope(root = ".") {
  const manifest = JSON.parse(readFileSync(join(root, "src/shared/qualification-inputs.json"), "utf8"));
  const trees = TREES.flatMap(tree => readdirSync(join(root, tree), { recursive: true })
    .map(name => `${tree}/${String(name).replaceAll("\\", "/")}`)
    .filter(path => !/(^|\/)\./.test(path) && statSync(join(root, path)).isFile()));
  return [...new Set([...manifest, ...trees, ...PROBE_ONLY])].sort();
}
