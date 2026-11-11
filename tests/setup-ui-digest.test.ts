// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

// tests/setup-ui.ts replaces crypto.subtle.digest in every jsdom file; these pin what that replacement promises.
const real = (algorithm: string, data: BufferSource) => SubtleCrypto.prototype.digest.call(crypto.subtle, algorithm, data);
const hex = (buffer: ArrayBuffer) => Buffer.from(buffer).toString("hex");

describe("the digest the UI tests run on", () => {
  it.each(["SHA-1", "SHA-256", "SHA-384", "SHA-512"])("returns what Web Crypto returns for %s, from a view into a larger buffer or a plain buffer", async algorithm => {
    const bytes = new TextEncoder().encode("wildbots-form\u0000key\u0000bot");
    const padded = new Uint8Array(bytes.length + 8);
    padded.set(bytes, 3);
    const view = padded.subarray(3, 3 + bytes.length);
    const expected = hex(await real(algorithm, bytes));
    expect(hex(await crypto.subtle.digest(algorithm, view))).toBe(expected);
    expect(hex(await crypto.subtle.digest(algorithm, bytes.buffer.slice(0)))).toBe(expected);
    expect(hex(await crypto.subtle.digest({ name: algorithm.toLowerCase() }, bytes))).toBe(expected);
  });

  it("settles in the microtasks act() flushes, not on Node's thread pool, so a test never waits for it in real time", async () => {
    let settled = false;
    void crypto.subtle.digest("SHA-256", new Uint8Array(16)).then(() => { settled = true; });
    // Three turns of the microtask queue, with no timer and no I/O in between.
    for (let turn = 0; turn < 3; turn++) await Promise.resolve();
    expect(settled).toBe(true);
  });

  it("leaves an algorithm it does not replace to Web Crypto, which refuses it", async () => {
    await expect(crypto.subtle.digest("MD5", new Uint8Array(1))).rejects.toMatchObject({ name: "NotSupportedError" });
  });

  it("leaves data that is neither a view nor a buffer to Web Crypto, which refuses it rather than hashing nothing", async () => {
    await expect(crypto.subtle.digest("SHA-256", "abc" as unknown as BufferSource)).rejects.toBeInstanceOf(TypeError);
  });
});
