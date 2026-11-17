import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("collects every application test exactly once across isolation projects", () => {
  const cli = fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url));
  const collected = JSON.parse(
    execFileSync(process.execPath, [cli, "list", "--filesOnly", "--json"], { encoding: "utf8" }),
  ) as { file: string }[];
  const files = collected.map((entry) => entry.file);
  const expected = readdirSync(new URL(".", import.meta.url)).filter((name) =>
    name.endsWith(".test.ts"),
  );
  expect(new Set(files).size).toBe(files.length);
  expect(files.length).toBe(expected.length);
});
