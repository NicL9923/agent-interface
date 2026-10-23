import type { StoreDatabase } from "./store-database.js";

/** Who receives each routine's results, and the trial runs people started. */
export class RoutineRepository {
  constructor(private readonly database: StoreDatabase) {}
  private get db() { return this.database.db; }
  routineRecipients(id: string, users: string[]) {
    this.database.transaction(() => {
      this.db
        .prepare("DELETE FROM routine_recipients WHERE routine_id=?")
        .run(id);
      for (const user of users)
        this.db
          .prepare("INSERT INTO routine_recipients VALUES(?,?)")
          .run(id, user);
    });
  }
  getRoutineRecipients(id: string): string[] {
    return (
      this.db
        .prepare("SELECT user_id FROM routine_recipients WHERE routine_id=?")
        .all(id) as { user_id: string }[]
    ).map((x) => x.user_id);
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
