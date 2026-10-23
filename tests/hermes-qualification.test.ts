import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { execFileSync } from "node:child_process";
import { integrationDigest, isolatedQualification, qualifiedReceipt } from "../src/server/hermes-qualification.js";
import qualificationInputs from "../src/shared/qualification-inputs.json" with { type: "json" };

const directories: string[] = [];
function temporary() { const path = mkdtempSync(join(tmpdir(), "agent-interface-qualification-")); directories.push(path); return path; }
afterEach(() => { directories.forEach(path => rmSync(path, {recursive:true,force:true})); directories.length = 0; });

/** Repository files a module imports by relative path, statically or with a literal dynamic import. */
function relativeImports(path: string) {
  const source = readFileSync(path, "utf8");
  const specifiers = [...source.matchAll(/(?:import|export)\s[^;]*?from\s*["'](\.[^"']+)["']|import\(\s*["'](\.[^"']+)["']\s*\)/g)]
    .map(match => match[1] ?? match[2]);
  return specifiers.map(specifier => {
    const target = normalize(join(dirname(path), specifier));
    // TypeScript sources import their siblings by the emitted .js name.
    return target.endsWith(".js") && existsSync(target.slice(0, -3) + ".ts") ? target.slice(0, -3) + ".ts" : target;
  }).filter(target => existsSync(target));
}
describe("exact Hermes upgrade qualification", () => {
  it("uses the same integration digest in the worker, add-on and app", () => {
    const python = execFileSync("python3", ["src/hermes/qualification.py", "--digest", process.cwd()], {encoding:"utf8"}).trim();
    expect(integrationDigest()).toBe(python);
  });
  it("binds every Hermes adapter module to the receipt", () => {
    // A receipt covers only listed files, so an unlisted adapter module could change after qualification.
    const adapter = readdirSync("src/server").filter(name => /^hermes.*\.ts$/.test(name)).map(name => `src/server/${name}`);
    expect(adapter.filter(path => !qualificationInputs.includes(path))).toEqual([]);
  });
  it("binds every module a bound module imports, apart from plumbing that never reaches Hermes", () => {
    // Moving integration code into a new module must not move it out of the receipt.
    // A module here never calls the runtime or reads its data, so editing it needs no requalification.
    const plumbing: Record<string, string> = {
      "src/server/apns.ts": "Apple push transport",
      "src/server/auth.ts": "sign-in and sessions",
      "src/server/etag.ts": "HTTP validators",
      "src/server/logging.ts": "log formatting",
      "src/server/route-path.ts": "route pattern lookup",
      "src/server/security-headers.ts": "HTTP headers",
      "src/server/static-cache.ts": "static asset caching",
    };
    const unbound = new Map<string, string>();
    for (const path of qualificationInputs.filter(path => /\.(ts|mjs|js)$/.test(path)))
      for (const imported of relativeImports(path))
        if (!qualificationInputs.includes(imported) && !(imported in plumbing)) unbound.set(imported, path);
    expect(Object.fromEntries(unbound)).toEqual({});
    // The scan itself must see imports, or the check above passes vacuously.
    expect(relativeImports("src/server/app.ts")).toEqual(expect.arrayContaining(["src/server/store.ts", "src/server/auth.ts"]));
    expect(relativeImports("src/server/store.ts")).toContain("src/server/store-presentation.ts");
    expect(Object.keys(plumbing).filter(path => !existsSync(path) || qualificationInputs.includes(path))).toEqual([]);
  });
  it("accepts only a private receipt for the exact source, repair and current integration", () => {
    const file = join(temporary(), "qualified.json");
    const revision = "a".repeat(40), patch = "b".repeat(64);
    const receipt = {schemaVersion:1,revision,trackedPatchSha256:patch,integrationDigest:integrationDigest(),qualifiedAt:new Date().toISOString(),checks:{realIntegration:true,hostRegressions:true}};
    writeFileSync(file, JSON.stringify(receipt), {mode:0o600});
    expect(qualifiedReceipt(file, revision, patch)).toBe(true);
    expect(qualifiedReceipt(file, "c".repeat(40), patch)).toBe(false);
    expect(qualifiedReceipt(file, revision, null)).toBe(false);
    for (const invalid of [{...receipt,integrationDigest:"d".repeat(64)}, {...receipt,checks:{realIntegration:true,hostRegressions:false}}]) {
      writeFileSync(file, JSON.stringify(invalid));
      expect(qualifiedReceipt(file, revision, patch)).toBe(false);
    }
    writeFileSync(file, JSON.stringify(receipt));
    chmodSync(file, 0o644);
    expect(qualifiedReceipt(file, revision, patch)).toBe(false);
    chmodSync(file, 0o600);
    const link = file + ".link";
    symlinkSync(file, link);
    expect(qualifiedReceipt(link, revision, patch)).toBe(false);
  });
  it("permits provisional source only in a marked disposable loopback environment", () => {
    const home = temporary(), input = {revision:"a".repeat(40),home};
    expect(isolatedQualification(input, new URL("http://127.0.0.1:19119"))).toBeUndefined();
    writeFileSync(join(home, ".agent-interface-isolated"), "agent-interface-disposable-spike");
    expect(isolatedQualification(input, new URL("http://127.0.0.1:19119"))).toBe(input.revision);
    expect(isolatedQualification(input, new URL("https://example.com"))).toBeUndefined();
    expect(isolatedQualification({...input,revision:"main"}, new URL("http://127.0.0.1:19119"))).toBeUndefined();
  });
});
