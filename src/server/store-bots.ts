import { assistantNotFoundMessage, Conflict, InvalidInput, NotFound } from "../shared/errors.js";
import { HARNESS_KINDS } from "../shared/harness.js";
import type { CredentialRecord, HarnessKind, ManagedBotRecord } from "../shared/harness.js";
import { assertCredentialConfiguration, assertCredentialPolicy } from "./credential-policy.js";
import type { StoreDatabase } from "./store-database.js";

type RecordInput<T extends { createdAt: number; updatedAt: number }> = Omit<
  T,
  "createdAt" | "updatedAt"
> &
  Partial<Pick<T, "createdAt" | "updatedAt">>;

const botColumns = `id,name,description,instructions,harness,model,provider,reasoning,speed,
  owner_id AS ownerId,owner_os_user AS ownerOsUser,shared,credential_id AS credentialId,
  enabled_tools AS enabledTools,enabled_skills AS enabledSkills,enabled_mcp_servers AS enabledMcpServers,
  created_at AS createdAt,updated_at AS updatedAt,archived_at AS archivedAt`;
const credentialColumns = `id,label,vendor,kind,owner_id AS ownerId,allowed_harnesses AS allowedHarnesses,
  env_var AS envVar,os_user AS osUser,created_at AS createdAt,updated_at AS updatedAt`;

type BotRow = Omit<
  ManagedBotRecord,
  "shared" | "enabledTools" | "enabledSkills" | "enabledMcpServers" | "archivedAt"
> & {
  shared: number;
  enabledTools: string;
  enabledSkills: string;
  enabledMcpServers: string;
  archivedAt: number | null;
};
type CredentialRow = Omit<
  CredentialRecord,
  "ownerId" | "allowedHarnesses" | "envVar" | "osUser"
> & {
  ownerId: string | null;
  allowedHarnesses: string;
  envVar: string | null;
  osUser: string | null;
};

function readBot(row: BotRow): ManagedBotRecord {
  const { shared, enabledTools, enabledSkills, enabledMcpServers, archivedAt, ...fields } = row;
  return {
    ...fields,
    shared: shared === 1,
    enabledTools: JSON.parse(enabledTools) as string[],
    enabledSkills: JSON.parse(enabledSkills) as string[],
    enabledMcpServers: JSON.parse(enabledMcpServers) as string[],
    ...(archivedAt === null ? {} : { archivedAt }),
  };
}

function readCredential(row: CredentialRow): CredentialRecord {
  const { ownerId, allowedHarnesses, envVar, osUser, ...fields } = row;
  return {
    ...fields,
    allowedHarnesses: JSON.parse(allowedHarnesses) as CredentialRecord["allowedHarnesses"],
    ...(ownerId === null ? {} : { ownerId }),
    ...(envVar === null ? {} : { envVar }),
    ...(osUser === null ? {} : { osUser }),
  };
}

/** Bot configuration and references to credentials configured on the host. */
export class ManagedBotRepository {
  constructor(private readonly database: StoreDatabase) {}

  private get db() {
    return this.database.db;
  }

  // Read and validate against one locked snapshot, including when a caller already holds a write transaction.
  private write<T>(operation: () => T): T {
    return this.db.isTransaction ? operation() : this.database.transaction(operation);
  }

  /** Every managed assistant runs on the native harness runtime. */
  runtimeIdForBot(_botId: string): "harness" {
    return "harness";
  }

  listManagedBots(): ManagedBotRecord[] {
    return (
      this.db
        .prepare(`SELECT ${botColumns} FROM managed_bots ORDER BY created_at,id`)
        .all() as BotRow[]
    ).map(readBot);
  }

  getManagedBot(id: string): ManagedBotRecord | undefined {
    const row = this.db.prepare(`SELECT ${botColumns} FROM managed_bots WHERE id=?`).get(id) as
      | BotRow
      | undefined;
    return row && readBot(row);
  }

  upsertManagedBot(bot: RecordInput<ManagedBotRecord>): ManagedBotRecord {
    return this.write(() => {
      if (!HARNESS_KINDS.includes(bot.harness))
        throw new InvalidInput("Choose a supported harness.");
      if (bot.credentialId === null) {
        if (bot.archivedAt == null)
          throw new InvalidInput("Choose a credential for this native harness.");
      } else {
        const credential = this.getCredential(bot.credentialId);
        if (!credential) throw new InvalidInput("Choose a credential that still exists.");
        assertCredentialPolicy(bot, credential, { kind: "configure" });
      }

      const now = Date.now();
      const row = this.db
        .prepare(
          `INSERT INTO managed_bots(
            id,name,description,instructions,harness,model,provider,reasoning,speed,owner_id,
            owner_os_user,shared,credential_id,enabled_tools,enabled_skills,enabled_mcp_servers,
            created_at,updated_at,archived_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET
            name=excluded.name,description=excluded.description,instructions=excluded.instructions,
            harness=excluded.harness,model=excluded.model,provider=excluded.provider,reasoning=excluded.reasoning,
            speed=excluded.speed,owner_id=excluded.owner_id,owner_os_user=excluded.owner_os_user,
            shared=excluded.shared,credential_id=excluded.credential_id,enabled_tools=excluded.enabled_tools,
            enabled_skills=excluded.enabled_skills,enabled_mcp_servers=excluded.enabled_mcp_servers,
            updated_at=excluded.updated_at,archived_at=excluded.archived_at
          RETURNING ${botColumns}`,
        )
        .get(
          bot.id,
          bot.name,
          bot.description,
          bot.instructions,
          bot.harness,
          bot.model,
          bot.provider,
          bot.reasoning,
          bot.speed,
          bot.ownerId,
          bot.ownerOsUser,
          Number(bot.shared),
          bot.credentialId,
          JSON.stringify(bot.enabledTools),
          JSON.stringify(bot.enabledSkills),
          JSON.stringify(bot.enabledMcpServers),
          bot.createdAt ?? now,
          bot.updatedAt ?? now,
          bot.archivedAt ?? null,
        ) as BotRow;
      return readBot(row);
    });
  }

  deleteManagedBot(id: string): boolean {
    return this.db.prepare("DELETE FROM managed_bots WHERE id=?").run(id).changes === 1;
  }

  setBotHarness(
    id: string,
    harness: HarnessKind,
    model: string,
    now = Date.now(),
  ): ManagedBotRecord {
    return this.write(() => {
      const bot = this.getManagedBot(id);
      if (!bot) throw new NotFound(assistantNotFoundMessage, "assistant_not_found");
      return this.upsertManagedBot({
        ...bot,
        harness,
        model,
        updatedAt: now,
      });
    });
  }

  listCredentials(): CredentialRecord[] {
    return (
      this.db
        .prepare(`SELECT ${credentialColumns} FROM bot_credentials ORDER BY created_at,id`)
        .all() as CredentialRow[]
    ).map(readCredential);
  }

  getCredential(id: string): CredentialRecord | undefined {
    const row = this.db
      .prepare(`SELECT ${credentialColumns} FROM bot_credentials WHERE id=?`)
      .get(id) as CredentialRow | undefined;
    return row && readCredential(row);
  }

  upsertCredential(credential: RecordInput<CredentialRecord>): CredentialRecord {
    return this.write(() => {
      assertCredentialConfiguration(credential);
      const liveBots = this.db
        .prepare(
          `SELECT harness,owner_id AS ownerId,owner_os_user AS ownerOsUser,shared
           FROM managed_bots WHERE credential_id=? AND archived_at IS NULL`,
        )
        .all(credential.id) as Pick<BotRow, "harness" | "ownerId" | "ownerOsUser" | "shared">[];
      for (const bot of liveBots)
        assertCredentialPolicy({ ...bot, shared: bot.shared === 1 }, credential, {
          kind: "configure",
        });

      const now = Date.now();
      const row = this.db
        .prepare(
          `INSERT INTO bot_credentials(
            id,label,vendor,kind,owner_id,allowed_harnesses,env_var,os_user,created_at,updated_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET
            label=excluded.label,vendor=excluded.vendor,kind=excluded.kind,owner_id=excluded.owner_id,
            allowed_harnesses=excluded.allowed_harnesses,env_var=excluded.env_var,os_user=excluded.os_user,
            updated_at=excluded.updated_at
          RETURNING ${credentialColumns}`,
        )
        .get(
          credential.id,
          credential.label,
          credential.vendor,
          credential.kind,
          credential.ownerId ?? null,
          JSON.stringify(credential.allowedHarnesses),
          credential.envVar ?? null,
          credential.osUser ?? null,
          credential.createdAt ?? now,
          credential.updatedAt ?? now,
        ) as CredentialRow;
      return readCredential(row);
    });
  }

  deleteCredential(id: string): boolean {
    return this.write(() => {
      const inUse = this.db
        .prepare("SELECT 1 FROM managed_bots WHERE credential_id=? AND archived_at IS NULL LIMIT 1")
        .get(id);
      if (inUse)
        throw new Conflict("Change the credential on bots that use this one before deleting it.");
      return this.db.prepare("DELETE FROM bot_credentials WHERE id=?").run(id).changes === 1;
    });
  }
}
