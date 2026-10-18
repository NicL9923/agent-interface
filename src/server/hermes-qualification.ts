import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Shared with the Python qualifier, including this manifest in its own digest.
import qualificationInputs from "../shared/qualification-inputs.json" with { type: "json" };

const integrationFiles = [...qualificationInputs].sort();
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export function integrationDigest(root = appRoot): string {
  const rows = integrationFiles.map(path => path + "\0" + createHash("sha256").update(readFileSync(resolve(root, path))).digest("hex"));
  return createHash("sha256").update(rows.join("\n")).digest("hex");
}
export function qualifiedReceipt(file: string | undefined, revision: unknown, patch: unknown): boolean {
  if (!file || !isAbsolute(file) || typeof revision !== "string" || !/^[0-9a-f]{40}$/.test(revision)) return false;
  try {
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 8192 || info.mode & 0o077 ||
        typeof process.getuid === "function" && info.uid !== process.getuid()) return false;
    const value = JSON.parse(readFileSync(file, "utf8"));
    return value.schemaVersion === 1 && value.revision === revision &&
      value.trackedPatchSha256 === (patch ?? null) && value.integrationDigest === integrationDigest() &&
      value.checks?.realIntegration === true && value.checks?.hostRegressions === true &&
      Object.keys(value.checks).length === 2 && typeof value.qualifiedAt === "string";
  } catch { return false; }
}
export function isolatedQualification(input: {revision: string; home: string} | undefined, origin: URL | undefined): string | undefined {
  if (!input || !/^[0-9a-f]{40}$/.test(input.revision) || !isAbsolute(input.home) ||
      origin?.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)) return undefined;
  try {
    const marker = resolve(input.home, ".agent-interface-isolated");
    if (lstatSync(marker).isSymbolicLink() || readFileSync(marker, "utf8") !== "agent-interface-disposable-spike") return undefined;
    return input.revision;
  } catch { return undefined; }
}
