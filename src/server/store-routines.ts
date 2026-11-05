import type { StoreDatabase } from "./store-database.js";

/** Who receives each routine's results, and the trial runs people started. */
export class RoutineRepository {
  constructor(private readonly database: StoreDatabase) {}
  private get db() { return this.database.db; }
  // Recipients belong to one assistant's routine: Hermes lets two assistants hold jobs with one ID.
  // routine_recipients, keyed by routine ID alone, is the earlier record. The previous release still
  // reads it after a rollback, so it is kept and never written here; adoptLegacyRecipients moves it over.
  routineRecipients(botId: string, id: string, users: string[]) {
    this.database.transaction(() => {
      this.db.prepare("DELETE FROM routine_profile_recipients WHERE bot_id=? AND routine_id=?").run(botId, id);
      for (const user of users)
        this.db.prepare("INSERT INTO routine_profile_recipients(bot_id,routine_id,user_id) VALUES(?,?,?)").run(botId, id, user);
      this.db.prepare("INSERT OR IGNORE INTO routine_recipient_sets(bot_id,routine_id) VALUES(?,?)").run(botId, id);
    });
  }
  getRoutineRecipients(botId: string, id: string): string[] {
    const own = this.db.prepare("SELECT 1 FROM routine_recipient_sets WHERE bot_id=? AND routine_id=?").get(botId, id);
    if (own) return (this.db.prepare("SELECT user_id FROM routine_profile_recipients WHERE bot_id=? AND routine_id=?").all(botId, id) as { user_id: string }[]).map(row => row.user_id);
    // Not yet moved over: the earlier record belongs to every assistant holding the ID, until it is.
    if (this.db.prepare("SELECT 1 FROM routine_recipients_adopted WHERE routine_id=?").get(id)) return [];
    return (this.db.prepare("SELECT user_id FROM routine_recipients WHERE routine_id=?").all(id) as { user_id: string }[]).map(row => row.user_id);
  }
  /**
   * Moves the earlier recipients, kept by routine ID alone, to the assistants whose routines hold each
   * ID now: the one that holds it, or, when several do and nobody can tell which was meant, every one.
   * Each ID moves once, when a routine list from Hermes includes it; one Hermes no longer lists waits.
   */
  adoptLegacyRecipients(routines: { id: string; botId: string }[]) {
    const legacy = this.db.prepare("SELECT DISTINCT routine_id AS id FROM routine_recipients WHERE routine_id NOT IN (SELECT routine_id FROM routine_recipients_adopted)").all() as { id: string }[];
    if (!legacy.length) return;
    this.database.transaction(() => {
      for (const { id } of legacy) {
        const holders = [...new Set(routines.filter(routine => routine.id === id).map(routine => routine.botId))];
        if (!holders.length) continue;
        for (const botId of holders) {
          if (this.db.prepare("SELECT 1 FROM routine_recipient_sets WHERE bot_id=? AND routine_id=?").get(botId, id)) continue;
          this.db.prepare("INSERT INTO routine_profile_recipients(bot_id,routine_id,user_id) SELECT ?,routine_id,user_id FROM routine_recipients WHERE routine_id=?").run(botId, id);
          this.db.prepare("INSERT INTO routine_recipient_sets(bot_id,routine_id) VALUES(?,?)").run(botId, id);
        }
        this.db.prepare("INSERT INTO routine_recipients_adopted(routine_id) VALUES(?)").run(id);
      }
    });
  }
  routineTrial(requestId: string): { userId: string; routineId: string; botId: string } | undefined {
    return this.db.prepare("SELECT user_id AS userId,routine_id AS routineId,bot_id AS botId FROM routine_trials WHERE request_id=?").get(requestId) as { userId: string; routineId: string; botId: string } | undefined;
  }
  routineTrials(routineId: string): { requestId: string; userId: string; botId: string }[] {
    return this.db.prepare("SELECT request_id AS requestId,user_id AS userId,bot_id AS botId FROM routine_trials WHERE routine_id=? AND status IN ('accepted','uncertain')").all(routineId) as { requestId: string; userId: string; botId: string }[];
  }
  rememberRoutineTrial(requestId: string, userId: string, routineId: string, botId: string) {
    this.db.prepare("INSERT OR IGNORE INTO routine_trials(request_id,user_id,routine_id,bot_id) VALUES(?,?,?,?)").run(requestId, userId, routineId, botId);
  }
  recordRoutineTrialStatus(requestId: string, status: string) {
    this.db.prepare("UPDATE routine_trials SET status=? WHERE request_id=?").run(status, requestId);
  }
}
