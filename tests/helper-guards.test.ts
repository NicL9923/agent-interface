// Cheap source checks that keep one shared helper in charge of a mistake-prone job.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sources = (root: string, skip: string[] = []) => (readdirSync(root, { recursive: true }) as string[])
  .map(name => join(root, name).replaceAll("\\", "/"))
  .filter(path => /\.tsx?$/.test(path) && !path.endsWith(".d.ts") && !skip.some(prefix => path.startsWith(prefix)))
  .sort();
const matches = (path: string, pattern: RegExp) => readFileSync(path, "utf8").match(pattern)?.length ?? 0;

describe("server errors", () => {
  it("build HTTP errors only through httpError", () => {
    // A hand-built error with a statusCode reaches Fastify's error handler and becomes the
    // response status, so every one goes through src/server/http-error.ts.
    const found = sources("src/server").filter(path => path !== "src/server/http-error.ts")
      .filter(path => matches(path, /Object\.assign\(\s*new Error\b/g) > 0);
    expect(found).toEqual([]);
  });
});

describe("web data loads", () => {
  // A flag like `let live = true` guards one load by hand. useResource and useAction keep that
  // guard, abort the request and drop stale results the same way everywhere. These remain, each
  // for a reason the hooks do not cover. Remove an entry when its file stops needing it.
  const allowed: Record<string, { count: number; reason: string }> = {
    "src/app/use-conversation.ts": { count: 1, reason: "Coalesces stream notices into one more load instead of dropping them, and its query follows the reader's scroll position." },
    "src/app/use-draft.ts": { count: 1, reason: "Merges the server copy into a draft the person may be editing, so the result is never stored as-is." },
    "src/app/use-submission.ts": { count: 1, reason: "Reconciles a send receipt bound to the identity epoch and settles the draft it sent." },
    "src/app/use-browser.ts": { count: 1, reason: "Registers the service worker; it makes no API request." },
    "src/components/google-identity.ts": { count: 1, reason: "Loads Google's sign-in script; it makes no API request." },
  };
  const flag = /\blet\s+(?:live|current|active|alive|mounted|cancell?ed|stale|ignore|disposed)\s*=\s*(?:true|false)\b/g;

  it("use the request hooks instead of a hand-rolled liveness flag", () => {
    const found = Object.fromEntries(sources("src", ["src/server/"]).map(path => [path, matches(path, flag)]).filter(([, count]) => count));
    expect(found).toEqual(Object.fromEntries(Object.entries(allowed).map(([path, { count }]) => [path, count])));
  });
});
