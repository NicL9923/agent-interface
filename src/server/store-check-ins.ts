import { isSilentAnswer } from "../shared/main-assistant.js";
import type { RuntimeEvent } from "../shared/types.js";
import type { StoreDatabase } from "./store-database.js";

export type CheckInJob = { botId: string; jobId: string; userId: string };

/** Each member's managed check-in routine, by the Hermes job that runs it. */
export class CheckInRepository {
  constructor(private readonly database: StoreDatabase) {}
  private get db() { return this.database.db; }
  /** The check-in jobs that should still exist, as this server last created or adopted them. */
  current(): CheckInJob[] {
    return this.db.prepare("SELECT bot_id AS botId,job_id AS jobId,user_id AS userId FROM check_in_jobs WHERE removed_at IS NULL ORDER BY created_at")
      .all() as CheckInJob[];
  }
  /** Records a job as this member's check-ins, or takes back a removal recorded for the same job. */
  track(job: CheckInJob, now = Date.now()) {
    this.db.prepare("INSERT INTO check_in_jobs(bot_id,job_id,user_id,created_at) VALUES(?,?,?,?) ON CONFLICT(bot_id,job_id) DO UPDATE SET user_id=excluded.user_id,removed_at=NULL")
      .run(job.botId, job.jobId, job.userId, now);
  }
  removed(botId: string, jobId: string, now = Date.now()) {
    this.db.prepare("UPDATE check_in_jobs SET removed_at=? WHERE bot_id=? AND job_id=? AND removed_at IS NULL").run(now, botId, jobId);
  }
  /** Whether this job is or was a check-in. A removed one still is, for runs that settle after it went. */
  isCheckIn(botId: string, jobId: string | undefined) {
    return !!jobId && !!this.db.prepare("SELECT 1 FROM check_in_jobs WHERE bot_id=? AND job_id=?").get(botId, jobId);
  }
  /**
   * A check-in speaks only when it finds something: a run that ended without an answer, or with
   * Hermes's silent marker, failed or was stopped leaves no notification and no Today entry.
   * Its chat shows a failed run as a card instead.
   */
  quiet(event: Pick<RuntimeEvent, "botId" | "routineId" | "kind" | "body"> & { checkIn?: boolean }) {
    // `checkIn` marks a run of a check-in that is already gone; see MainAssistants.identify.
    if (!this.isCheckIn(event.botId, event.routineId) && event.checkIn !== true) return false;
    return event.kind !== "completed" || !event.body?.trim() || isSilentAnswer(event.body);
  }
}
