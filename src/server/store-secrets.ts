import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { InvalidInput } from "../shared/errors.js";
import type { StoreDatabase } from "./store-database.js";

export type SecretScope = { kind: "bot" | "owner" | "household"; id: string };
export type SecretBotContext = { botId: string; ownerId?: string; shared: boolean };

export interface HeadnetVaultClient {
  getSecret(name: string, scope: SecretScope): Promise<string | undefined>;
  listSecrets(scope: SecretScope): Promise<readonly string[]>;
}

type SecretMetadata = {
  id: string;
  scope: SecretScope;
  name: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
};

type SecretRow = {
  ciphertext: Uint8Array;
  iv: Uint8Array;
  tag: Uint8Array;
};

const keyName = "wildbots_vault_key";
const keyCheckName = "wildbots_vault_key_check";
const householdScope: SecretScope = Object.freeze({ kind: "household", id: "" });

function visibleScopes(bot: SecretBotContext): SecretScope[] {
  return [
    { kind: "bot", id: bot.botId },
    ...(bot.shared === false && bot.ownerId ? [{ kind: "owner" as const, id: bot.ownerId }] : []),
    householdScope,
  ];
}

export function redactSecrets(text: string, knownSecretValues: Iterable<string>): string {
  const values = [...new Set(knownSecretValues)].filter((value) => value.length >= 6);
  if (!values.length || !text) return text;
  const pattern = values
    .sort((a, b) => b.length - a.length)
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  return text.replace(new RegExp(pattern, "g"), "[REDACTED]");
}

function associatedData(scope: SecretScope, name: string): Buffer {
  return Buffer.from(JSON.stringify([scope.kind, scope.id, name]));
}

/** Local writes always use SQLite. The adapter is queried only with scopes visible to the bot. */
export class SecretRepository {
  private readonly key: Buffer;
  private readonly headnetVault?: HeadnetVaultClient;
  private readonly returnedValues = new Map<string, Set<string>>();

  constructor(
    private readonly database: Pick<StoreDatabase, "db" | "transaction">,
    {
      key = process.env.WILDBOTS_VAULT_KEY,
      headnetVault,
    }: {
      key?: string;
      headnetVault?: HeadnetVaultClient;
    } = {},
  ) {
    this.headnetVault = headnetVault;
    const loadKey = () => this.loadKey(key);
    this.key = this.db.isTransaction ? loadKey() : database.transaction(loadKey);
  }

  private get db() {
    return this.database.db;
  }

  private loadKey(configured: string | undefined): Buffer {
    const read = (name: string) =>
      (
        this.db.prepare("SELECT value FROM metadata WHERE key=?").get(name) as
          | { value: string }
          | undefined
      )?.value;
    const insert = (name: string, value: string) =>
      this.db.prepare("INSERT INTO metadata(key,value) VALUES(?,?)").run(name, value);
    if (configured !== undefined && !configured.trim())
      throw new Error("WILDBOTS_VAULT_KEY must not be empty.");
    const saved = read(keyName);
    const key =
      configured === undefined
        ? saved === undefined
          ? randomBytes(32)
          : Buffer.from(saved, "base64url")
        : createHash("sha256").update("wildbots:mini-vault\0").update(configured).digest();
    if (key.length !== 32) throw new Error("Invalid stored WildBots vault key.");

    const check = createHash("sha256")
      .update("wildbots:mini-vault:check\0")
      .update(key)
      .digest("hex");
    const previous = read(keyCheckName);
    if (previous !== undefined && previous !== check)
      throw new Error("The configured WildBots vault key differs from the vault's original key.");
    if (previous === undefined) insert(keyCheckName, check);
    if (configured === undefined && saved === undefined) insert(keyName, key.toString("base64url"));
    return key;
  }

  /** The caller must authorize the human who writes to the requested scope. */
  setSecret(scope: SecretScope, name: string, value: string, createdBy: string): SecretMetadata {
    if (
      (scope.kind === "household" ? scope.id !== "" : !scope.id.trim()) ||
      !name.trim() ||
      !value ||
      !createdBy.trim()
    )
      throw new InvalidInput("A secret requires a scope, name, value, and creator.");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(associatedData(scope, name));
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const now = Date.now();
    const record = this.db
      .prepare(
        `INSERT INTO bot_secrets(id,scope_kind,scope_id,name,ciphertext,iv,tag,created_by,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(scope_kind,scope_id,name) DO UPDATE SET
       ciphertext=excluded.ciphertext,iv=excluded.iv,tag=excluded.tag,updated_at=excluded.updated_at
       RETURNING id,created_by AS createdBy,created_at AS createdAt,updated_at AS updatedAt`,
      )
      .get(
        randomUUID(),
        scope.kind,
        scope.id,
        name,
        ciphertext,
        iv,
        cipher.getAuthTag(),
        createdBy,
        now,
        now,
      ) as Omit<SecretMetadata, "scope" | "name">;
    return { ...record, scope, name };
  }

  private decrypt(row: SecretRow, scope: SecretScope, name: string): string {
    const decipher = createDecipheriv("aes-256-gcm", this.key, row.iv, { authTagLength: 16 });
    decipher.setAAD(associatedData(scope, name));
    decipher.setAuthTag(row.tag);
    return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString("utf8");
  }

  async getSecret(
    bot: SecretBotContext,
    name: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    for (const scope of visibleScopes(bot)) {
      signal?.throwIfAborted();
      const row = this.db
        .prepare(
          "SELECT ciphertext,iv,tag FROM bot_secrets WHERE scope_kind=? AND scope_id=? AND name=?",
        )
        .get(scope.kind, scope.id, name) as SecretRow | undefined;
      const value = row
        ? this.decrypt(row, scope, name)
        : await this.headnetVault?.getSecret(name, scope);
      signal?.throwIfAborted();
      if (value === undefined) continue;
      const known = this.returnedValues.get(bot.botId) ?? new Set<string>();
      known.add(value);
      this.returnedValues.set(bot.botId, known);
      return value;
    }
  }

  async listSecrets(bot: SecretBotContext, signal?: AbortSignal): Promise<string[]> {
    const names = new Set<string>();
    for (const scope of visibleScopes(bot)) {
      signal?.throwIfAborted();
      const rows = this.db
        .prepare("SELECT name FROM bot_secrets WHERE scope_kind=? AND scope_id=?")
        .all(scope.kind, scope.id) as { name: string }[];
      for (const { name } of rows) names.add(name);
      for (const name of (await this.headnetVault?.listSecrets(scope)) ?? []) names.add(name);
    }
    signal?.throwIfAborted();
    return [...names].sort();
  }

  /** Redact before publishing tool activity or persisting a bot's transcript. */
  redactForBot(botId: string, text: string): string {
    if (!text) return text;
    const bot = this.db
      .prepare(
        "SELECT owner_id AS ownerId, shared FROM managed_bots WHERE id=? AND archived_at IS NULL",
      )
      .get(botId) as { ownerId: string; shared: number } | undefined;
    const known = new Set(this.returnedValues.get(botId));
    for (const scope of visibleScopes({
      botId,
      ownerId: bot?.ownerId,
      shared: bot?.shared !== 0,
    })) {
      const rows = this.db
        .prepare("SELECT name,ciphertext,iv,tag FROM bot_secrets WHERE scope_kind=? AND scope_id=?")
        .all(scope.kind, scope.id) as (SecretRow & { name: string })[];
      for (const row of rows) known.add(this.decrypt(row, scope, row.name));
    }
    // A harness may put a tool result in JSON before emitting it as log text.
    const values = [...known].filter((value) => value.length >= 6);
    return redactSecrets(
      text,
      values.flatMap((value) => [value, JSON.stringify(value).slice(1, -1)]),
    );
  }
}
