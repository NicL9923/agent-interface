import { InvalidInput } from "../shared/errors.js";
import type { StoreDatabase } from "./store-database.js";

export interface BotChannelRecord {
  botId: string;
  parentBotId: string;
  ownerId: string;
  topic: string;
  createdAt: number;
}

type ChannelRow = {
  bot_id: string;
  parent_bot_id: string;
  owner_id: string;
  topic: string;
  created_at: number;
};

function toChannel(row: ChannelRow): BotChannelRecord {
  return {
    botId: row.bot_id,
    parentBotId: row.parent_bot_id,
    ownerId: row.owner_id,
    topic: row.topic,
    createdAt: row.created_at,
  };
}

export class ChannelRepository {
  constructor(private readonly database: StoreDatabase) {}
  private get db() {
    return this.database.db;
  }

  register(input: {
    botId: string;
    parentBotId: string;
    ownerId: string;
    topic: string;
    now?: number;
  }): BotChannelRecord {
    const topic = input.topic.trim();
    if (!topic || topic.length > 60)
      throw new InvalidInput("Channel topic must be between 1 and 60 characters.");
    const now = input.now ?? Date.now();
    this.db
      .prepare(
        `INSERT INTO bot_channels(bot_id,parent_bot_id,owner_id,topic,created_at)
         VALUES(?,?,?,?,?)
         ON CONFLICT(bot_id) DO UPDATE SET parent_bot_id=excluded.parent_bot_id,owner_id=excluded.owner_id,topic=excluded.topic`,
      )
      .run(input.botId, input.parentBotId, input.ownerId, topic, now);
    return this.getByBotId(input.botId)!;
  }

  getByBotId(botId: string): BotChannelRecord | undefined {
    const row = this.db.prepare("SELECT * FROM bot_channels WHERE bot_id=?").get(botId) as
      | ChannelRow
      | undefined;
    return row ? toChannel(row) : undefined;
  }

  listForOwner(ownerId: string, parentBotId?: string): BotChannelRecord[] {
    const rows = (
      parentBotId
        ? this.db
            .prepare(
              "SELECT * FROM bot_channels WHERE owner_id=? AND parent_bot_id=? ORDER BY created_at ASC, bot_id ASC",
            )
            .all(ownerId, parentBotId)
        : this.db
            .prepare(
              "SELECT * FROM bot_channels WHERE owner_id=? ORDER BY created_at ASC, bot_id ASC",
            )
            .all(ownerId)
    ) as ChannelRow[];
    return rows.map(toChannel);
  }

  forgetBot(botId: string) {
    this.db.prepare("DELETE FROM bot_channels WHERE bot_id=? OR parent_bot_id=?").run(botId, botId);
  }
}
