import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));

it(
  "serves authenticated HTTP and WebSocket traffic and shuts down under Bun",
  { timeout: 25_000 },
  async ({ skip }) => {
    const result = await run(
      "bun",
      ["run", "--no-env-file", "--no-install", "scripts/bun-smoke.ts"],
      {
        cwd: root,
        timeout: 20_000,
      },
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") skip("Bun is absent from PATH");
      throw error;
    });
    expect(result.stdout).toMatch(/^Bun \S+ smoke passed /m);
  },
);
