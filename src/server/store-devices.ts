import { httpError } from "./http-error.js";
import type { LiveState } from "./live-activity.js";
import type { AccountRepository } from "./store-accounts.js";
import type { StoreDatabase } from "./store-database.js";

export interface LiveActivityRegistration {
  deviceId: string;
  userId: string;
  token: string;
  environment: "sandbox" | "production";
  /** Assistants the app just sent to, shown as starting until Hermes reports them. */
  armed: string[];
  armedAt: number;
  /** What the worker last saw, which carries each row's start time. */
  lastState?: LiveState;
  /** What the device last received. */
  sentState?: LiveState;
  sentAt: number;
  failures: number;
}

/** Native push devices and Live Activity tokens. Both expire with their native session. */
export class DeviceRepository {
  constructor(private readonly database: StoreDatabase, private readonly accounts: AccountRepository) {}
  private get db() { return this.database.db; }
  registerNativeDevice(userId: string, sessionHash: string, deviceId: string, token: string, environment: "sandbox" | "production") {
    this.accounts.pruneNativeAuth();
    const conflicts = this.db.prepare("SELECT user_id FROM native_devices WHERE device_id=? OR (token=? AND environment=?)")
      .all(deviceId, token, environment) as { user_id: string }[];
    if (conflicts.some(row => row.user_id !== userId))
      throw httpError(409, "This notification device belongs to another household member. Sign out there first.");
    // Token rotation can retain an older installation ID. Keep exactly one current registration.
    this.database.transaction(() => {
      this.db.prepare("DELETE FROM native_devices WHERE user_id=? AND token=? AND environment=? AND device_id<>?").run(userId, token, environment, deviceId);
      this.db.prepare("INSERT INTO native_devices VALUES(?,?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET session_hash=excluded.session_hash,token=excluded.token,environment=excluded.environment")
        .run(deviceId, userId, sessionHash, token, environment);
    });
  }
  removeNativeDevice(userId: string, deviceId: string) {
    this.db.prepare("DELETE FROM native_devices WHERE user_id=? AND device_id=?").run(userId, deviceId);
  }
  nativeDevices(userId: string, environment: "sandbox" | "production") {
    this.accounts.pruneNativeAuth();
    return this.db.prepare("SELECT device_id AS deviceId,token,environment FROM native_devices WHERE user_id=? AND environment=?")
      .all(userId, environment) as { deviceId: string; token: string; environment: "sandbox" | "production" }[];
  }
  registerLiveActivity(userId: string, sessionHash: string, deviceId: string, token: string, environment: "sandbox" | "production", armed: string[], armedAt: number) {
    this.accounts.pruneNativeAuth();
    const conflicts = this.db.prepare("SELECT user_id FROM live_activities WHERE device_id=? OR (token=? AND environment=?)")
      .all(deviceId, token, environment) as { user_id: string }[];
    if (conflicts.some(row => row.user_id !== userId))
      throw httpError(409, "This device's Live Activity belongs to another household member. Sign out there first.");
    // A new token replaces the device's previous activity and replays the current state.
    this.database.transaction(() => {
      const previous = this.liveActivityContext(userId, sessionHash, deviceId);
      const pending = previous && armedAt - previous.armedAt < 120_000 ? previous.armed : [];
      const merged = [...new Set([...pending, ...armed])];
      const since = armed.length || !previous ? armedAt : previous.armedAt;
      this.db.prepare("DELETE FROM live_activities WHERE token=? AND environment=? AND device_id<>?").run(token, environment, deviceId);
      this.db.prepare(`INSERT INTO live_activities(device_id,user_id,session_hash,token,environment,armed,armed_at) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(device_id) DO UPDATE SET
        last_state=CASE WHEN session_hash=excluded.session_hash THEN last_state ELSE NULL END,
        sent_state=CASE WHEN session_hash=excluded.session_hash AND token=excluded.token THEN sent_state ELSE NULL END,
        sent_at=CASE WHEN session_hash=excluded.session_hash AND token=excluded.token THEN sent_at ELSE 0 END,
        session_hash=excluded.session_hash,token=excluded.token,environment=excluded.environment,
        armed=excluded.armed,armed_at=excluded.armed_at,failures=0,retry_at=0`)
        .run(deviceId, userId, sessionHash, token, environment, JSON.stringify(merged), since);
    });
  }
  /** Only the native session that owns this activity can reuse its device's grace and history. */
  liveActivityContext(userId: string, sessionHash: string, deviceId: string) {
    const row = this.db.prepare("SELECT armed,armed_at,last_state FROM live_activities WHERE user_id=? AND session_hash=? AND device_id=?")
      .get(userId, sessionHash, deviceId) as { armed: string; armed_at: number; last_state: string | null } | undefined;
    return row ? { armed: JSON.parse(row.armed) as string[], armedAt: row.armed_at, lastState: row.last_state ? JSON.parse(row.last_state) as LiveState : undefined } : undefined;
  }
  removeLiveActivity(userId: string, deviceId: string, token: string) {
    this.db.prepare("DELETE FROM live_activities WHERE user_id=? AND device_id=? AND token=?").run(userId, deviceId, token);
  }
  liveActivities(environment: "sandbox" | "production", now = Date.now()): LiveActivityRegistration[] {
    this.accounts.pruneNativeAuth();
    return (this.db.prepare("SELECT * FROM live_activities WHERE environment=? AND retry_at<=?").all(environment, now) as {
      device_id: string; user_id: string; token: string; environment: "sandbox" | "production"; armed: string; armed_at: number;
      last_state: string | null; sent_state: string | null; sent_at: number; failures: number;
    }[]).map(row => ({ deviceId: row.device_id, userId: row.user_id, token: row.token, environment: row.environment, armed: JSON.parse(row.armed),
      armedAt: row.armed_at, lastState: row.last_state ? JSON.parse(row.last_state) : undefined,
      sentState: row.sent_state ? JSON.parse(row.sent_state) : undefined, sentAt: row.sent_at, failures: row.failures }));
  }
  /** Records what the worker last saw. Bots seen past starting leave the armed list. A token replaced meanwhile is untouched. */
  liveActivityObserved(deviceId: string, token: string, state: LiveState, progressed: string[]) {
    const row = this.db.prepare("SELECT armed FROM live_activities WHERE device_id=? AND token=?").get(deviceId, token) as { armed: string } | undefined;
    if (!row) return;
    const armed = (JSON.parse(row.armed) as string[]).filter(id => !progressed.includes(id));
    this.db.prepare("UPDATE live_activities SET last_state=?,armed=? WHERE device_id=? AND token=?").run(JSON.stringify(state), JSON.stringify(armed), deviceId, token);
  }
  liveActivitySent(deviceId: string, token: string, state: LiveState, sentAt: number) {
    this.db.prepare("UPDATE live_activities SET sent_state=?,sent_at=?,failures=0,retry_at=0 WHERE device_id=? AND token=?")
      .run(JSON.stringify(state), sentAt, deviceId, token);
  }
  /** Backs off a failing token: 15 seconds, doubling to five minutes. */
  liveActivityFailed(deviceId: string, token: string, now: number) {
    this.db.prepare("UPDATE live_activities SET failures=failures+1,retry_at=?+min(300000,15000*(1<<min(failures,5))) WHERE device_id=? AND token=?")
      .run(now, deviceId, token);
  }
}
