import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { integrationDigest, isolatedQualification, qualifiedReceipt } from "../src/server/hermes-qualification.js";

const directories: string[] = [];
function temporary() { const path = mkdtempSync(join(tmpdir(), "agent-interface-qualification-")); directories.push(path); return path; }
afterEach(() => { directories.forEach(path => rmSync(path, {recursive:true,force:true})); directories.length = 0; });

describe("exact Hermes upgrade qualification", () => {
  it("uses the same integration digest in the worker, add-on and app", () => {
    const python = execFileSync("python3", ["src/hermes/qualification.py", "--digest", process.cwd()], {encoding:"utf8"}).trim();
    expect(integrationDigest()).toBe(python);
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
