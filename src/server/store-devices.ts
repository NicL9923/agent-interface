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

/** One assistant's run an activity showed. A run Hermes had not named yet has no `runId`. */
export interface CoveredRun { botId: string; runId?: string }

/** A device that can be asked to start its Live Activity by push (iOS 18 and later). */
export interface LiveActivityStartRegistration {
  deviceId: string;
  userId: string;
  token: string;
  environment: "sandbox" | "production";
  /** The app's account scope, echoed in the activity's attributes so the app can tell whose it is. */
  scope: string;
  /** Runs an activity on this device already showed. Only new work starts another. */
  started: CoveredRun[];
  /** The app dismissed an activity here before the worker recorded what it showed. */
  dismissed: boolean;
  /** When the app last started its own activity after a send. */
  localAt: number;
}

type StartRow = { device_id: string; user_id: string; token: string; environment: "sandbox" | "production"; scope: string; started: string; dismissed: number; local_at: number };
const startRegistration = (row: StartRow): LiveActivityStartRegistration => ({ deviceId: row.device_id, userId: row.user_id, token: row.token,
  environment: row.environment, scope: row.scope, started: JSON.parse(row.started), dismissed: row.dismissed === 1, localAt: row.local_at });

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
  /** Returns whether that activity was still registered. */
  removeLiveActivity(userId: string, deviceId: string, token: string) {
    return this.db.prepare("DELETE FROM live_activities WHERE user_id=? AND device_id=? AND token=?").run(userId, deviceId, token).changes > 0;
  }
  /**
   * The app dismissed or ended its activity. When that activity was still registered, the device's
   * start record is marked in the same step, so no worker pass in between starts it again; the
   * worker then records what is running as covered. Late cleanup of an activity the server already
   * ended marks nothing, so newer work can still start.
   */
  dismissLiveActivity(userId: string, deviceId: string, token: string) {
    this.database.transaction(() => {
      if (this.removeLiveActivity(userId, deviceId, token))
        this.db.prepare("UPDATE live_activity_starts SET dismissed=1 WHERE user_id=? AND device_id=?").run(userId, deviceId);
    });
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
  /** Every installation with a Live Activity the worker updates, including ones backing off. */
  liveActivityDevices() {
    return new Set((this.db.prepare("SELECT device_id FROM live_activities").all() as { device_id: string }[]).map(row => row.device_id));
  }
  /**
   * The token is the device's, not the account's, so whoever registers it now holds it: an account
   * that signed out offline must not keep starting activities on this device.
   */
  registerLiveActivityStart(userId: string, sessionHash: string, deviceId: string, token: string, environment: "sandbox" | "production", scope: string) {
    this.accounts.pruneNativeAuth();
    const conflict = this.db.prepare("SELECT user_id FROM live_activity_starts WHERE device_id=?").get(deviceId) as { user_id: string } | undefined;
    if (conflict && conflict.user_id !== userId)
      throw httpError(409, "This device's Live Activity belongs to another household member. Sign out there first.");
    this.database.transaction(() => {
      this.db.prepare("DELETE FROM live_activity_starts WHERE token=? AND environment=? AND device_id<>?").run(token, environment, deviceId);
      this.db.prepare(`INSERT INTO live_activity_starts(device_id,user_id,session_hash,token,environment,scope) VALUES(?,?,?,?,?,?)
        ON CONFLICT(device_id) DO UPDATE SET session_hash=excluded.session_hash,token=excluded.token,environment=excluded.environment,
        scope=excluded.scope,failures=0,retry_at=0`)
        .run(deviceId, userId, sessionHash, token, environment, scope);
    });
  }
  removeLiveActivityStart(userId: string, deviceId: string) {
    this.db.prepare("DELETE FROM live_activity_starts WHERE user_id=? AND device_id=?").run(userId, deviceId);
  }
  liveActivityStarts(environment: "sandbox" | "production", now = Date.now()): LiveActivityStartRegistration[] {
    this.accounts.pruneNativeAuth();
    return (this.db.prepare("SELECT * FROM live_activity_starts WHERE environment=? AND retry_at<=?").all(environment, now) as StartRow[]).map(startRegistration);
  }
  /** The current registration, read again just before a start is sent. */
  liveActivityStart(deviceId: string): LiveActivityStartRegistration | undefined {
    const row = this.db.prepare("SELECT * FROM live_activity_starts WHERE device_id=?").get(deviceId) as StartRow | undefined;
    return row && startRegistration(row);
  }
  /** The app is starting its own activity after a send, so the worker leaves this device alone for a while. */
  liveActivityStartedLocally(userId: string, sessionHash: string, deviceId: string, now: number) {
    this.db.prepare("UPDATE live_activity_starts SET local_at=? WHERE user_id=? AND session_hash=? AND device_id=?").run(now, userId, sessionHash, deviceId);
  }
  /** Records the assistants the device's activity shows now, or `[]` once nothing is running. */
  liveActivityStartCovered(deviceId: string, token: string, started: CoveredRun[]) {
    this.db.prepare("UPDATE live_activity_starts SET started=?,dismissed=0,failures=0,retry_at=0 WHERE device_id=? AND token=?").run(JSON.stringify(started), deviceId, token);
  }
  liveActivityStartFailed(deviceId: string, token: string, now: number) {
    this.db.prepare("UPDATE live_activity_starts SET failures=failures+1,retry_at=?+min(300000,15000*(1<<min(failures,5))) WHERE device_id=? AND token=?")
      .run(now, deviceId, token);
  }
  removeLiveActivityStartToken(deviceId: string, token: string) {
    this.db.prepare("DELETE FROM live_activity_starts WHERE device_id=? AND token=?").run(deviceId, token);
  }
  /** Backs off a failing token: 15 seconds, doubling to five minutes. */
  liveActivityFailed(deviceId: string, token: string, now: number) {
    this.db.prepare("UPDATE live_activities SET failures=failures+1,retry_at=?+min(300000,15000*(1<<min(failures,5))) WHERE device_id=? AND token=?")
      .run(now, deviceId, token);
  }
}
