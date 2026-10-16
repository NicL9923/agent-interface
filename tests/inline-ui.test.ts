import Fastify from "fastify";
import { expect, it } from "vitest";
import { parseInlineDocument, inlineUiInstructions } from "../src/shared/inline-ui";
import { installInlineUi, inlineUiShellPolicy } from "../src/server/inline-ui";
import { installSecurityHeaders } from "../src/server/security-headers";
import { Script } from "node:vm";
import { inlineUiShell } from "../src/server/inline-ui";

it("accepts only the bounded, explicit UI contract", () => {
  const doc = { version: 1, title: " Planner ", html: "<button>Compare</button>" };
  expect(parseInlineDocument(JSON.stringify(doc))).toEqual({ ...doc, title: "Planner" });
  for (const value of [null, [], { ...doc, version: 2 }, { ...doc, title: " " }, { ...doc, html: "" }, { ...doc, url: "https://example.test" }, { ...doc, html: "a".repeat(100000) }])
    expect(parseInlineDocument(JSON.stringify(value))).toBeNull();
  expect(parseInlineDocument('{"version":1')).toBeNull();
  expect(inlineUiInstructions).toContain("wildbots-html");
});

it("serves only a static isolated shell without relaxing app script policy", async () => {
  const app = Fastify();
  installSecurityHeaders(app, "https://app.example.test");
  installInlineUi(app);
  app.get("/", async () => "app");
  try {
    const response = await app.inject("/inline-ui");
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-security-policy"]).toBe(inlineUiShellPolicy);
    expect(response.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-dns-prefetch-control"]).toBe("off");
    expect(inlineUiShellPolicy).toContain("sandbox allow-scripts");
    expect(inlineUiShellPolicy).not.toContain("allow-same-origin");
    expect(inlineUiShellPolicy).toContain("connect-src 'none'");
    // Catch HTML/JS quoting errors before opening a browser.
    const script = inlineUiShell.slice(inlineUiShell.indexOf("<script>") + 8, inlineUiShell.lastIndexOf("</script>"));
    expect(() => new Script(script)).not.toThrow();
    const page = await app.inject("/");
    expect(page.headers["content-security-policy"]).not.toContain("script-src 'unsafe-inline'");
    expect(page.headers["x-frame-options"]).toBe("DENY");
  } finally { await app.close(); }
});
