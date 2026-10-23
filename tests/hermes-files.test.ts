import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fileSigner, safeStagedPath } from "../src/server/hermes-files.js";

const token = "file-signing-token";
const unsafe = ["relative/file.txt", "/workspace/../etc/passwd", "/workspace/..", "/workspace/a\0b", "", 42, undefined];
// Signs any value, as only a holder of the Hermes token could.
const forged = (value: object) => {
  const body = Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${body}.${createHmac("sha256", token).update(body).digest("base64url")}`;
};

describe("Hermes staged file paths", () => {
  it("accepts only absolute paths without NUL bytes or parent segments", () => {
    expect(safeStagedPath("/workspace/output/result.png")).toBe(true);
    expect(safeStagedPath("/workspace/..hidden/notes..txt")).toBe(true);
    for (const path of unsafe) expect(safeStagedPath(path)).toBe(false);
  });

  it("never signs an artifact or accepts an identifier with an unsafe path", () => {
    const { artifacts, fileValue } = fileSigner(token);
    const files = artifacts("ranch", { role: "assistant", app_artifacts: [...unsafe.map(path => ({ path })), { path: "/out/chart.png" }] });
    expect(files.map(file => file.name)).toEqual(["chart.png"]);
    expect(fileValue(files[0].id)).toMatchObject({ path: "/out/chart.png", botId: "ranch", kind: "artifact" });
    for (const path of unsafe) {
      const id = forged({ path, name: "file", mime: "text/plain", botId: "ranch", kind: "artifact", version: 1 });
      expect(() => fileValue(id)).toThrow("Unregistered file identifier.");
    }
  });
});
