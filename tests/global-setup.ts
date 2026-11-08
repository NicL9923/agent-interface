import { readFileSync } from "node:fs";
import { satisfiesEngine } from "../scripts/node-engine.mjs";

// Older Node releases inside the major hang the event-stream tests until they time out, which
// reads as a flaky suite. Refuse to start instead, and say which version to use.
export default function checkNode() {
  const range = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).engines.node;
  if (satisfiesEngine(process.version, range)) return;
  // Printed and exited, not thrown: Vitest's startup-error printer loses a thrown message on old Node.
  console.error(`\nNode ${process.version} is outside this repository's supported range (${range}).\nSwitch to the version in .node-version, for example with \`nvm use\`.\n`);
  process.exit(1);
}
