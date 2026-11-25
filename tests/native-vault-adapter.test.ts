import { afterEach, describe, expect, it } from "vitest";
import { Conflict, InvalidInput, NotFound } from "../src/shared/errors.js";
import type { ManagedBotRecord } from "../src/shared/harness.js";
import type { ProfileVault } from "../src/shared/vault.js";
import { createNativeVaultHandler } from "../src/server/harness/native-vault.js";
import { Store } from "../src/server/store.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function setup() {
  const store = new Store(":memory:");
  store.managedBots.upsertCredential({
    id: "cred-1",
    label: "Test key",
    kind: "api_key",
    vendor: "openai",
    envVar: "TEST_API_KEY",
    allowedHarnesses: ["codex"],
  });
  const mkBot = (id: string, name: string): ManagedBotRecord => ({
    id,
    name,
    description: "",
    instructions: "",
    harness: "codex",
    model: "model-1",
    provider: "openai",
    reasoning: "",
    speed: "",
    ownerId: "one",
    ownerOsUser: "alice",
    shared: true,
    credentialId: "cred-1",
    enabledTools: [],
    enabledSkills: [],
    enabledMcpServers: [],
    createdAt: 1_790_000_000_000,
    updatedAt: 1_790_000_000_000,
  });
  store.managedBots.upsertManagedBot(mkBot("alpha", "Alpha"));
  store.managedBots.upsertManagedBot(mkBot("beta", "Beta"));
  const requireBot = (id: string) => {
    const bot = store.managedBots.getManagedBot(id);
    if (!bot || bot.archivedAt != null) throw new NotFound("Assistant not found.");
    return bot;
  };
  const vault = createNativeVaultHandler(store, requireBot);
  cleanups.push(() => store.close());
  return { store, vault };
}

describe("native vault adapter", () => {
  it("encrypts logins at rest, never returns secrets in overview, isolates per bot, and removes cleanly", async () => {
    const { store, vault } = setup();
    const empty = (await vault({ operation: "overview", profile: "alpha" })) as ProfileVault;
    expect(empty).toMatchObject({
      botId: "alpha",
      profile: "alpha",
      scope: "profile",
      owner: "WildBots",
      items: [],
      sources: [{ name: "local", enabled: true, unlocked: true, needsUnlock: false }],
    });

    const secretPassword = "super-secret-password-canary";
    const secretOtp = "JBSWY3DPEHPK3PXP";
    const added = (await vault({
      operation: "add_login",
      profile: "alpha",
      actor: "one",
      login: {
        label: "  Grocer  ",
        origin: "https://grocer.example.test/",
        identifierType: "email",
        identifier: "alice@example.test",
        password: secretPassword,
        otpSecret: secretOtp,
      },
    })) as { id: string };
    expect(added.id).toMatch(/^vault_[0-9a-f]{12}$/);

    // Verify ciphertext in SQLite does not contain plaintext password or OTP secret.
    const row = store.db
      .prepare(
        "SELECT scope_kind, scope_id, name, ciphertext, created_by FROM bot_secrets WHERE scope_kind='bot' AND scope_id='alpha'",
      )
      .get() as {
      scope_kind: string;
      scope_id: string;
      name: string;
      ciphertext: Uint8Array;
      created_by: string;
    };
    expect(row.name).toBe(`login:${added.id}`);
    expect(row.created_by).toBe("one");
    const cipherText = Buffer.from(row.ciphertext).toString("utf8");
    expect(cipherText).not.toContain(secretPassword);
    expect(cipherText).not.toContain(secretOtp);

    // Overview returns metadata only — never password or otpSecret.
    const overview = (await vault({ operation: "overview", profile: "alpha" })) as ProfileVault;
    expect(overview.items).toEqual([
      {
        id: added.id,
        kind: "login",
        label: "Grocer",
        origin: "https://grocer.example.test",
        createdAt: expect.any(String),
        identifier: "alice@example.test",
        identifierType: "email",
        hasOtp: true,
        backend: "local",
        canRemove: true,
      },
    ]);
    expect(JSON.stringify(overview)).not.toContain(secretPassword);
    expect(JSON.stringify(overview)).not.toContain(secretOtp);

    // Another bot cannot see or remove alpha's login.
    const betaOverview = (await vault({ operation: "overview", profile: "beta" })) as ProfileVault;
    expect(betaOverview.items).toEqual([]);
    expect(await vault({ operation: "remove_login", profile: "beta", itemId: added.id })).toEqual({
      removed: false,
    });

    // Removing from alpha succeeds and leaves overview empty.
    expect(await vault({ operation: "remove_login", profile: "alpha", itemId: added.id })).toEqual({
      removed: true,
    });
    expect(await vault({ operation: "remove_login", profile: "alpha", itemId: added.id })).toEqual({
      removed: false,
    });
    expect(
      ((await vault({ operation: "overview", profile: "alpha" })) as ProfileVault).items,
    ).toEqual([]);
  });

  it("rejects malformed logins, invalid origins, bad item IDs, external sources, and unknown bots", async () => {
    const { vault } = setup();
    const base = {
      label: "Site",
      origin: "https://site.example.test",
      identifierType: "username" as const,
      identifier: "alice",
      password: "pw",
    };

    for (const bad of [
      { ...base, label: "   " },
      { ...base, identifier: "" },
      { ...base, password: "" },
      { ...base, identifierType: "ssn" as "username" },
      { ...base, origin: "not-a-url" },
      { ...base, origin: "ftp://site.example.test" },
      { ...base, origin: "https://user:pass@site.example.test" },
      { ...base, origin: "https://site.example.test/login" },
      { ...base, origin: "https://site.example.test?a=1" },
      { ...base, origin: "https://site.example.test#frag" },
    ]) {
      await expect(vault({ operation: "add_login", profile: "alpha", login: bad })).rejects.toThrow(
        InvalidInput,
      );
    }

    for (const badId of ["", "../escape", "bad id", "a".repeat(201)]) {
      await expect(
        vault({ operation: "remove_login", profile: "alpha", itemId: badId }),
      ).rejects.toThrow(InvalidInput);
    }

    expect(
      await vault({
        operation: "answer",
        profile: "alpha",
        requestId: "req-1",
        actor: "one",
        answer: {
          epoch: "e1",
          sessionId: "s1",
          method: "vault.code",
          value: "123456",
        },
      }),
    ).toEqual({ status: "expired" });

    await expect(
      vault({ operation: "source", profile: "alpha", source: "bitwarden", enabled: true }),
    ).rejects.toThrow(Conflict);
    await expect(
      vault({ operation: "unlock", profile: "alpha", source: "bitwarden", password: "pw" }),
    ).rejects.toThrow(Conflict);
    await expect(
      vault({ operation: "lock", profile: "alpha", source: "bitwarden" }),
    ).rejects.toThrow(Conflict);

    await expect(vault({ operation: "overview", profile: "missing" })).rejects.toThrow(NotFound);
  });
});
