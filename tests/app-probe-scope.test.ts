// The app probe's source digest must cover everything the probe runs, so its report cannot
// claim a stable code state while an unlisted file changed.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { probeScope } from "../scripts/spike/app-probe-scope.mjs";
import qualificationInputs from "../src/shared/qualification-inputs.json" with { type: "json" };

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function tree(files: string[], manifest: string[]) {
  const root = mkdtempSync(join(tmpdir(), "app-probe-scope-"));
  roots.push(root);
  for (const file of [...files, "src/shared/qualification-inputs.json"]) {
    mkdirSync(join(root, dirname(file)), { recursive: true });
    writeFileSync(join(root, file), file.endsWith(".json") ? JSON.stringify(manifest) : "");
  }
  return root;
}

describe("app probe digest scope", () => {
  it("covers every qualification input and existing file it names", () => {
    const scope = probeScope();
    expect(qualificationInputs.filter(file => !scope.includes(file))).toEqual([]);
    expect(scope.filter(file => !existsSync(file))).toEqual([]);
    expect(scope).toContain("scripts/spike/app-probe.mjs");
    expect(scope).toContain("scripts/spike/app-probe-scope.mjs");
  });

  it("covers a server file added in a nested folder before the manifest lists it", () => {
    const root = tree(["src/server/app.ts", "src/server/repositories/drafts.ts", "src/server/.DS_Store", "src/shared/types.ts", "scripts/spike/extra.py"],
      ["src/server/app.ts", "scripts/spike/extra.py"]);
    expect(probeScope(root)).toEqual([
      "package.json", "scripts/spike/app-probe-scope.mjs", "scripts/spike/extra.py", "src/server/app.ts",
      "src/server/repositories/drafts.ts", "src/shared/qualification-inputs.json", "src/shared/types.ts",
    ]);
  });
});
