/** How often open household streams have Hermes's room catalog checked, at most. */
export const GROUP_CATALOG_POLL_MS = 30_000;
/** The soonest a write through the app checks again after the last check, so a burst of sends shares one. */
export const GROUP_CATALOG_WRITE_FLOOR_MS = 1_000;

/**
 * One read of Hermes's room catalog for the people watching. It answers each person's catalog as
 * `GET /api/groups` would, reduced to what home shows, for any person, including one who starts
 * watching later.
 */
export type CatalogRead = (userIds: string[]) => Promise<(userId: string) => string>;
/** `fresh` until the first check that covers it: its client's own read may predate that check's. */
type Viewer = { userId: string; changed: () => void; fresh: boolean };

/**
 * Tells open household streams when a person's visible group catalog changes: a room added,
 * removed, renamed or with new members, or a room's newest message. One check serves every
 * stream. It runs only while a stream is open, at most once per `GROUP_CATALOG_POLL_MS`, and
 * stops with the last stream. A write through the app asks for a check sooner, no sooner than
 * `GROUP_CATALOG_WRITE_FLOOR_MS` after the last one, which restarts the wait for the next.
 * Each person's catalog is compared with the last one seen, so an unchanged catalog sends nothing.
 */
export class GroupCatalogWatch {
  private readonly viewers = new Set<Viewer>();
  /** Each watching person's catalog as last seen. */
  private readonly seen = new Map<string, string>();
  /** Computes anyone's catalog from the last read, so a new viewer starts from it. */
  private project?: (userId: string) => string;
  private timer?: NodeJS.Timeout;
  private due = 0;
  private reading = false;
  private again = false;
  private last = -Infinity;
  /** Advances when the last viewer leaves, so a read that was running then changes nothing. */
  private generation = 0;
  /** The Hermes read in flight, kept across generations so a reconnect never starts a second one. */
  private inflight?: Promise<unknown>;
  constructor(private readonly read: CatalogRead, private readonly interval = GROUP_CATALOG_POLL_MS,
    private readonly floor = GROUP_CATALOG_WRITE_FLOOR_MS) {}

  get watching() { return this.viewers.size; }

  /** Calls `changed` whenever this person's catalog changes, until the returned function runs. */
  watch(userId: string, changed: () => void): () => void {
    const viewer: Viewer = { userId, changed, fresh: false };
    this.viewers.add(viewer);
    if (!this.seen.has(userId) && this.project) {
      try { this.seen.set(userId, this.project(userId)); } catch { /* The next read sets it. */ }
    }
    // Every stream hears once that its catalog is known, and clients read it on that notice rather than
    // on connect. With a starting point from an earlier check, that is now: any later change still
    // differs from it. Without one, it is when the first check lands, since that check could see a
    // change the client's read missed and must not silently start from it.
    viewer.fresh = !this.seen.has(userId);
    // After the caller's stream has opened, which finishes synchronously after this returns.
    if (!viewer.fresh) queueMicrotask(() => { if (this.viewers.has(viewer)) viewer.changed(); });
    // The first viewer starts the checks.
    if (this.viewers.size === 1) this.schedule(0);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.viewers.delete(viewer);
      if (![...this.viewers].some(other => other.userId === userId)) this.seen.delete(userId);
      if (this.viewers.size) return;
      this.stop();
    };
  }

  /** After a write through the app that may change rooms, checks soon instead of waiting for the timer. */
  changed() {
    if (!this.viewers.size) return;
    if (this.reading) { this.again = true; return; }
    this.schedule(Math.max(0, this.last + this.floor - Date.now()));
  }

  close() {
    this.viewers.clear();
    this.stop();
  }

  private stop() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.generation++;
    this.seen.clear();
    this.project = undefined;
    this.reading = false;
    this.again = false;
  }

  /** Checks after `delay`, unless a check is already due sooner. */
  private schedule(delay: number) {
    const at = Date.now() + delay;
    if (this.timer && this.due <= at) return;
    clearTimeout(this.timer);
    this.due = at;
    this.timer = setTimeout(() => void this.check(), delay);
    this.timer.unref?.();
  }

  private async check() {
    this.timer = undefined;
    if (!this.viewers.size) return;
    const generation = this.generation;
    this.reading = true;
    // A read started before the last viewer left may still be running: wait for it, never overlap it.
    if (this.inflight) await this.inflight.catch(() => {});
    if (generation !== this.generation || !this.viewers.size) return;
    this.last = Date.now();
    let project: ((userId: string) => string) | undefined;
    const reading = this.read([...new Set([...this.viewers].map(viewer => viewer.userId))]);
    this.inflight = reading;
    try { project = await reading; }
    catch { /* Hermes or its catalog is unavailable: keep what was seen and try at the next check. */ }
    finally { if (this.inflight === reading) this.inflight = undefined; }
    // A read from before the last viewer left changes nothing, not even whether a read is running.
    if (generation !== this.generation) return;
    this.reading = false;
    if (project) {
      this.project = project;
      const next = new Map<string, string | undefined>();
      const tell: Viewer[] = [];
      for (const viewer of [...this.viewers]) {
        if (!next.has(viewer.userId)) {
          let value: string | undefined;
          try { value = project(viewer.userId); } catch { value = undefined; }
          next.set(viewer.userId, value);
        }
        const value = next.get(viewer.userId);
        if (value === undefined) continue;
        const before = this.seen.get(viewer.userId);
        if (viewer.fresh) { viewer.fresh = false; tell.push(viewer); }
        else if (before !== undefined && before !== value) tell.push(viewer);
      }
      // Recorded before anyone hears: a listener that ends the last stream clears it all, and nothing
      // from this check may be written back after that for a later stream to start from.
      for (const [userId, value] of next) if (value !== undefined) this.seen.set(userId, value);
      for (const viewer of tell) viewer.changed();
    }
    // A listener may have ended the last stream just now.
    if (generation !== this.generation || !this.viewers.size) return;
    if (this.again) { this.again = false; this.schedule(Math.max(0, this.last + this.floor - Date.now())); }
    else this.schedule(this.interval);
  }
}
