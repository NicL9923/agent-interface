import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertCredentialConfiguration,
  assertCredentialPolicy,
  type CredentialUse,
} from "../src/server/credential-policy.js";
import { Store, schemaVersion } from "../src/server/store.js";
import { Conflict, InvalidInput, NotFound } from "../src/shared/errors.js";
import type { CredentialRecord, ManagedBotRecord } from "../src/shared/harness.js";
import previousRelease from "./fixtures/previous-release-schema.json";

const subscription: CredentialRecord = {
  id: "alice-plan",
  label: "Alice's plan",
  vendor: "openai",
  kind: "subscription",
  ownerId: "alice",
  allowedHarnesses: ["codex"],
  osUser: "alice-cli",
  createdAt: 10,
  updatedAt: 10,
};
const apiKey: CredentialRecord = {
  id: "api-key",
  label: "Household API key",
  vendor: "openrouter",
  kind: "api_key",
  allowedHarnesses: ["codex", "pi"],
  envVar: "WILDBOTS_OPENROUTER_KEY",
  createdAt: 11,
  updatedAt: 11,
};
const personalBot: ManagedBotRecord = {
  id: "personal",
  name: "Personal",
  description: "Research",
  instructions: "Cite primary sources.",
  harness: "codex",
  model: "example-model",
  provider: "openai",
  reasoning: "high",
  speed: "fast",
  ownerId: "alice",
  ownerOsUser: "alice-cli",
  shared: false,
  credentialId: subscription.id,
  enabledTools: ["search", "notes"],
  enabledSkills: ["research"],
  enabledMcpServers: ["calendar"],
  createdAt: 20,
  updatedAt: 20,
};

function expectRefusal(
  operation: () => unknown,
  type: typeof InvalidInput | typeof Conflict | typeof NotFound,
  message: string,
) {
  expect(operation).toThrow(expect.objectContaining({ constructor: type, message }));
}

describe("credential ownership policy", () => {
  const configure = { kind: "configure" } as const;

  it("requires a supported credential kind", () => {
    expectRefusal(
      () => assertCredentialConfiguration({ ...subscription, kind: "oauth" as never }),
      InvalidInput,
      "Choose a subscription or API key credential.",
    );
  });

  it("requires an array of supported native harnesses", () => {
    for (const allowedHarnesses of [null, ["hermes"]]) {
      expectRefusal(
        () =>
          assertCredentialConfiguration({ ...apiKey, allowedHarnesses: allowedHarnesses as never }),
        InvalidInput,
        "Choose only supported native harnesses for this credential.",
      );
    }
  });

  it("requires a subscription owner before the credential can be saved or attached", () => {
    expectRefusal(
      () => assertCredentialConfiguration({ ...subscription, ownerId: undefined }),
      InvalidInput,
      "Set an owner for this subscription credential.",
    );
    expectRefusal(
      () => assertCredentialPolicy(personalBot, { ...subscription, ownerId: "  " }, configure),
      InvalidInput,
      "Set an owner for this subscription credential.",
    );
  });

  it("refuses environment variable references for subscription tokens", () => {
    expectRefusal(
      () => assertCredentialConfiguration({ ...subscription, envVar: "VENDOR_PLAN_TOKEN" }),
      InvalidInput,
      "Sign in through the vendor CLI to set up a subscription credential.",
    );
  });

  it("accepts only environment variable names for an API key reference when one is provided", () => {
    for (const envVar of ["sk-example-value", null]) {
      expectRefusal(
        () => assertCredentialConfiguration({ ...apiKey, envVar: envVar as never }),
        InvalidInput,
        "Enter the environment variable name for this API key.",
      );
    }
    expect(() => assertCredentialConfiguration({ ...apiKey, envVar: undefined })).not.toThrow();
  });

  it("allows a subscription on a matching personal bot, including a login without a stored Unix account", () => {
    expect(() => assertCredentialPolicy(personalBot, subscription, configure)).not.toThrow();
    expect(() =>
      assertCredentialPolicy(personalBot, { ...subscription, osUser: undefined }, configure),
    ).not.toThrow();
  });

  it("refuses a harness outside the credential's allowed list for either credential kind", () => {
    for (const credential of [subscription, apiKey]) {
      expectRefusal(
        () => assertCredentialPolicy({ ...personalBot, harness: "grok" }, credential, configure),
        InvalidInput,
        "Choose a credential that supports the grok harness.",
      );
    }
  });

  it("allows attaching a household subscription to a shared bot when the Unix account matches", () => {
    expect(() =>
      assertCredentialPolicy({ ...personalBot, shared: true }, subscription, configure),
    ).not.toThrow();
    expect(() =>
      assertCredentialPolicy(
        { ...personalBot, shared: true, ownerId: "" },
        subscription,
        configure,
      ),
    ).not.toThrow();
  });

  it("refuses attaching another member's subscription to a personal bot", () => {
    expectRefusal(
      () => assertCredentialPolicy({ ...personalBot, ownerId: "bob" }, subscription, configure),
      InvalidInput,
      "Choose a subscription credential owned by this bot's owner.",
    );
  });

  it("refuses a subscription attached to a bot running under a different Unix account", () => {
    expectRefusal(
      () =>
        assertCredentialPolicy({ ...personalBot, ownerOsUser: "bob-cli" }, subscription, configure),
      InvalidInput,
      "Run this bot under the Unix account that owns the subscription login.",
    );
  });

  it("allows household subscriptions in group chats, handoffs, and group routines", () => {
    for (const use of [
      { kind: "group-chat", multiUser: true },
      { kind: "group-chat", multiUser: false },
      { kind: "handoff", sourceOwnerId: "bob" },
      { kind: "handoff", sourceOwnerId: undefined },
      { kind: "handoff", sourceOwnerId: "alice" },
      { kind: "routine", destination: "group" },
      { kind: "routine", destination: "personal" },
    ] as CredentialUse[]) {
      expect(() => assertCredentialPolicy(personalBot, subscription, use)).not.toThrow();
    }
  });

  it("refuses an unknown context for a subscription", () => {
    expectRefusal(
      () => assertCredentialPolicy(personalBot, subscription, { kind: "unknown" } as never),
      InvalidInput,
      "Choose where this subscription credential will be used.",
    );
  });

  it("allows API keys on personal or shared bots, including the contexts restricted for subscriptions", () => {
    const ownedKey = { ...apiKey, ownerId: "bob" };
    expect(() => assertCredentialPolicy(personalBot, ownedKey, configure)).not.toThrow();
    const shared = { ...personalBot, shared: true };
    const uses: CredentialUse[] = [
      configure,
      { kind: "group-chat", multiUser: true },
      { kind: "handoff", sourceOwnerId: "bob" },
      { kind: "routine", destination: "group" },
    ];
    for (const use of uses)
      expect(() => assertCredentialPolicy(shared, ownedKey, use)).not.toThrow();
  });
});

describe("managed bot repository", () => {
  const stores: Store[] = [];
  const directories: string[] = [];
  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  function open(path = ":memory:") {
    const store = new Store(path);
    stores.push(store);
    return store;
  }

  it("creates, lists, updates and deletes a bot without changing when it was created", () => {
    const bots = open().managedBots;
    expect(bots.listManagedBots()).toEqual([]);
    bots.upsertCredential(subscription);
    expect(bots.upsertManagedBot(personalBot)).toEqual(personalBot);
    expect(bots.getManagedBot(personalBot.id)).toEqual(personalBot);

    const updated = {
      ...personalBot,
      name: "Research",
      description: "Notes",
      instructions: "Take notes.",
      provider: "custom",
      reasoning: "low",
      speed: "auto",
      enabledTools: [],
      enabledSkills: ["notes"],
      enabledMcpServers: ["files", "notes"],
      updatedAt: 25,
    };
    expect(bots.upsertManagedBot({ ...updated, createdAt: 24 })).toEqual(updated);
    expect(bots.listManagedBots()).toEqual([updated]);
    expect(bots.deleteManagedBot(personalBot.id)).toBe(true);
    expect(bots.getManagedBot(personalBot.id)).toBeUndefined();
    expect(bots.deleteManagedBot(personalBot.id)).toBe(false);
    expect(bots.deleteCredential(subscription.id)).toBe(true);
  });

  it("creates, lists, updates and deletes credentials, storing only the declared reference fields", () => {
    const store = open();
    const bots = store.managedBots;
    expect(bots.listCredentials()).toEqual([]);
    const input = { ...subscription, token: "unexpected-input-field" };
    expect(bots.upsertCredential(input)).toEqual(subscription);
    expect(Object.values(store.db.prepare("SELECT * FROM bot_credentials").get()!)).not.toContain(
      input.token,
    );
    expect(bots.upsertCredential(apiKey)).toEqual(apiKey);
    expect(bots.listCredentials()).toEqual([subscription, apiKey]);
    const updated = {
      ...apiKey,
      label: "Pi API key",
      allowedHarnesses: ["pi"] as const,
      updatedAt: 12,
    };
    expect(bots.upsertCredential({ ...updated, allowedHarnesses: ["pi"], createdAt: 12 })).toEqual(
      updated,
    );
    expect(bots.getCredential(apiKey.id)).toEqual(updated);
    expect(bots.deleteCredential(apiKey.id)).toBe(true);
    expect(bots.deleteCredential(apiKey.id)).toBe(false);
    expect(bots.getCredential(apiKey.id)).toBeUndefined();
    expect(bots.listCredentials()).toEqual([subscription]);
  });

  it("rejects an ownerless subscription before writing it", () => {
    const bots = open().managedBots;
    expectRefusal(
      () => bots.upsertCredential({ ...subscription, ownerId: undefined }),
      InvalidInput,
      "Set an owner for this subscription credential.",
    );
    expect(bots.getCredential(subscription.id)).toBeUndefined();
  });

  it("routes all bots on the native harness runtime", () => {
    const bots = open().managedBots;
    const id = personalBot.id;
    expect(bots.runtimeIdForBot(id)).toBe("harness");
    bots.upsertCredential(apiKey);
    bots.upsertManagedBot({ ...personalBot, credentialId: apiKey.id, shared: true });
    expect(bots.runtimeIdForBot(id)).toBe("harness");
    expect(bots.setBotHarness(id, "pi", "different-model", 30)).toMatchObject({
      harness: "pi",
      model: "different-model",
      credentialId: apiKey.id,
      shared: true,
      createdAt: 20,
      updatedAt: 30,
    });
    expect(bots.runtimeIdForBot(id)).toBe("harness");
    bots.upsertManagedBot({ ...personalBot, credentialId: apiKey.id, archivedAt: 50 });
    expect(bots.runtimeIdForBot(id)).toBe("harness");
  });

  it("refuses a harness change when the bot is missing or its credential does not support the new harness", () => {
    const bots = open().managedBots;
    const id = personalBot.id;
    expectRefusal(() => bots.setBotHarness(id, "pi", "pi-model"), NotFound, "Assistant not found");
    bots.upsertCredential(subscription);
    bots.upsertManagedBot(personalBot);
    expectRefusal(
      () => bots.setBotHarness(id, "pi", "pi-model"),
      InvalidInput,
      "Choose a credential that supports the pi harness.",
    );
    expect(bots.getManagedBot(id)).toEqual(personalBot);
  });

  it("refuses unknown harnesses and missing credentials", () => {
    const bots = open().managedBots;
    expectRefusal(
      () => bots.upsertManagedBot({ ...personalBot, harness: "unknown" as never }),
      InvalidInput,
      "Choose a supported harness.",
    );
    expectRefusal(
      () => bots.upsertManagedBot(personalBot),
      InvalidInput,
      "Choose a credential that still exists.",
    );
    expectRefusal(
      () => bots.upsertManagedBot({ ...personalBot, credentialId: null }),
      InvalidInput,
      "Choose a credential for this native harness.",
    );
    expect(bots.listManagedBots()).toEqual([]);
  });

  it("allows widening a subscription bot to shared when its Unix account matches", () => {
    const bots = open().managedBots;
    bots.upsertCredential(subscription);
    bots.upsertCredential(apiKey);
    bots.upsertManagedBot(personalBot);
    expect(bots.upsertManagedBot({ ...personalBot, shared: true })).toMatchObject({
      shared: true,
      credentialId: subscription.id,
    });
    expect(
      bots.upsertManagedBot({ ...personalBot, credentialId: apiKey.id, shared: true }),
    ).toMatchObject({
      shared: true,
      credentialId: apiKey.id,
    });
  });

  it("refuses credential edits that would invalidate live bot configurations", () => {
    const bots = open().managedBots;
    bots.upsertCredential(subscription);
    bots.upsertManagedBot(personalBot);
    expectRefusal(
      () => bots.upsertCredential({ ...subscription, ownerId: "bob" }),
      InvalidInput,
      "Choose a subscription credential owned by this bot's owner.",
    );
    expectRefusal(
      () => bots.upsertCredential({ ...subscription, allowedHarnesses: [] }),
      InvalidInput,
      "Choose a credential that supports the codex harness.",
    );
    expect(bots.getCredential(subscription.id)).toEqual(subscription);

    bots.upsertCredential(apiKey);
    bots.upsertManagedBot({
      ...personalBot,
      credentialId: apiKey.id,
      ownerOsUser: "other-user",
      shared: true,
    });
    expectRefusal(
      () => bots.upsertCredential({ ...subscription, id: apiKey.id }),
      InvalidInput,
      "Run this bot under the Unix account that owns the subscription login.",
    );
    expect(bots.getCredential(apiKey.id)).toEqual(apiKey);
  });

  it("blocks deletion while a live bot references the credential and clears archived references on deletion", () => {
    const bots = open().managedBots;
    bots.upsertCredential(subscription);
    bots.upsertManagedBot(personalBot);
    expectRefusal(
      () => bots.deleteCredential(subscription.id),
      Conflict,
      "Change the credential on bots that use this one before deleting it.",
    );
    expect(bots.getCredential(subscription.id)).toEqual(subscription);
    expect(bots.getManagedBot(personalBot.id)).toEqual(personalBot);

    bots.upsertManagedBot({ ...personalBot, archivedAt: 0 });
    expect(bots.deleteCredential(subscription.id)).toBe(true);
    const archived = { ...personalBot, archivedAt: 0, credentialId: null };
    expect(bots.listManagedBots()).toEqual([archived]);
    expectRefusal(
      () => bots.upsertManagedBot({ ...archived, archivedAt: undefined }),
      InvalidInput,
      "Choose a credential for this native harness.",
    );
    bots.upsertCredential(apiKey);
    expect(
      bots.upsertManagedBot({ ...archived, credentialId: apiKey.id, archivedAt: undefined }),
    ).toEqual({ ...personalBot, credentialId: apiKey.id });
  });

  it("allows credential edits after archive and checks the current credential when restoring the bot", () => {
    const bots = open().managedBots;
    bots.upsertCredential(subscription);
    const archived = bots.upsertManagedBot({ ...personalBot, archivedAt: 35 });
    bots.upsertCredential({ ...subscription, allowedHarnesses: ["claude-code"] });
    expectRefusal(
      () => bots.upsertManagedBot({ ...archived, archivedAt: undefined }),
      InvalidInput,
      "Choose a credential that supports the codex harness.",
    );
    expect(bots.getManagedBot(archived.id)).toEqual(archived);
  });

  it("participates in an outer store transaction and rolls back the bot and its credential together", () => {
    const store = open();
    const bots = store.managedBots;
    const abort = new Error("Cancel the update.");
    expect(() =>
      store.transaction(() => {
        bots.upsertCredential(subscription);
        bots.upsertManagedBot(personalBot);
        throw abort;
      }),
    ).toThrow(abort);
    expect(bots.listManagedBots()).toEqual([]);
    expect(bots.listCredentials()).toEqual([]);
  });

  it("adds the tables to a previous-release database without changing its version and keeps rows on reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "managed-bots-"));
    directories.push(directory);
    const path = join(directory, "app.sqlite");
    const db = new DatabaseSync(path);
    try {
      for (const object of previousRelease.objects)
        if (object.type === "table") db.exec(object.sql);
      for (const object of previousRelease.objects)
        if (object.type === "index") db.exec(object.sql);
      db.exec(`PRAGMA user_version=${previousRelease.schemaVersion}`);
    } finally {
      db.close();
    }

    expect(schemaVersion).toBe(previousRelease.schemaVersion);
    const store = new Store(path);
    try {
      store.managedBots.upsertCredential(subscription);
      store.managedBots.upsertManagedBot(personalBot);
    } finally {
      store.close();
    }
    const reopened = open(path);
    expect(reopened.db.prepare("PRAGMA user_version").get()).toEqual({
      user_version: previousRelease.schemaVersion,
    });
    expect(reopened.managedBots.getManagedBot(personalBot.id)).toEqual(personalBot);
    expect(reopened.managedBots.getCredential(subscription.id)).toEqual(subscription);
  });
});
