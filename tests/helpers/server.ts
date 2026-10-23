import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { expect } from "vitest";
import { hash } from "../../src/server/auth.js";
import type { Store } from "../../src/server/store.js";
import type { Runtime } from "../../src/shared/types.js";

/** A runtime double with only the members a test needs. A misspelled member fails to compile. */
export const fakeRuntime = (members: { [K in keyof Runtime]?: unknown }) => members as unknown as Runtime;

/** Request headers for a household member with a session written straight to the store. */
export function signIn(store: Store, origin: string, id: string,
  options: { email?: string; csrf?: string; now?: number; confirmed?: boolean } = {}) {
  store.user({ id, name: id, email: options.email ?? `${id}@example.invalid` });
  const token = randomBytes(32).toString("hex"), csrf = options.csrf ?? randomBytes(32).toString("hex");
  const now = options.now ?? Date.now();
  store.session(hash(token), id, csrf, now + 600_000);
  if (options.confirmed) store.confirmSession(hash(token), now);
  return { origin, cookie: `session=${token}`, "x-csrf-token": csrf };
}

/** Request headers for a member signed in through local development sign-in. */
export async function localLogin(app: FastifyInstance, origin: string, member = "one") {
  const result = await app.inject({ method: "POST", url: "/api/auth/local", headers: { origin }, payload: { member } });
  expect(result.statusCode).toBe(200);
  return { origin, cookie: `session=${result.cookies[0].value}`, "x-csrf-token": result.json().csrfToken as string };
}
