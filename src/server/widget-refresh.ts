import type { Bot, Runtime } from "../shared/types.js";
import { allowedIdentity, type Config } from "./config.js";
import type { Store } from "./store.js";
import { visible } from "./bot-access.js";
import { ApnsError, type ApnsRefreshSender } from "./apns.js";
import { FailureTracker, quietLog, type Log } from "./logging.js";

/**
 * iOS budgets background pushes to a few an hour and may drop the rest, so each device gets at
 * most one this often. A change inside the window goes out when it ends.
 */
export const WIDGET_REFRESH_MS = 15 * 60_000;
/** How often the roster is compared. Widgets are not a live view; the Live Activity is. */
export const WIDGET_CHECK_MS = 30_000;

/**
 * Wakes a person's iPhones and iPads to rewrite their widget snapshot when what the widgets show
 * changes: an assistant's name, state, latest message, color or pin. The push carries nothing but
 * the request, so widgets still never see a sign-in token or anything the app did not fetch itself.
 */
export class WidgetRefresh {
  readonly push: FailureTracker;
  /** What each device last asked to show, by device and token, and when it was last woken. */
  private sent = new Map<string, { signature: string; at: number }>();
  private checkedAt = Number.NEGATIVE_INFINITY;
  constructor(
    private store: Store,
    private runtime: Pick<Runtime, "listBots">,
    private config: Config,
    private send?: ApnsRefreshSender,
    log: Log = quietLog,
    private now: () => number = Date.now,
  ) {
    this.push = new FailureTracker(log, "Widget refresh");
  }

  async tick() {
    if (!this.send || !this.config.apns) return;
    const now = this.now();
    if (now - this.checkedAt < WIDGET_CHECK_MS) return;
    this.checkedAt = now;
    const devices = this.store.allNativeDevices(this.config.apns.environment).filter(device => {
      const user = this.store.getUser(device.userId);
      return !!user && allowedIdentity(this.config, user);
    });
    const known = new Set(devices.map(device => `${device.deviceId}:${device.token}`));
    for (const key of this.sent.keys()) if (!known.has(key)) this.sent.delete(key);
    if (!devices.length) return;
    const roster = await this.runtime.listBots();
    const signatures = new Map<string, string>();
    for (const device of devices) {
      const key = `${device.deviceId}:${device.token}`;
      let signature = signatures.get(device.userId);
      if (signature === undefined) signatures.set(device.userId, signature = this.signature(device.userId, roster));
      const last = this.sent.get(key);
      // A device first seen since this server started already has what the app last read; wake it
      // for the next change instead of waking every phone on each restart.
      if (!last) { this.sent.set(key, { signature, at: Number.NEGATIVE_INFINITY }); continue; }
      if (last.signature === signature || now - last.at < WIDGET_REFRESH_MS) continue;
      // Recorded before sending, so a failure waits out the window instead of retrying every pass.
      this.sent.set(key, { signature, at: now });
      try {
        await this.send(device);
        this.push.success();
      } catch (error) {
        // Apple says the token is gone: forget the device, as alert delivery does.
        if (error instanceof ApnsError && error.apnsStatus === 410) { this.store.removeNativeDevice(device.userId, device.deviceId); continue; }
        // Not delivered: the change is still due once the window ends.
        this.sent.set(key, { signature: last.signature, at: now });
        this.push.failure(error);
      }
    }
  }

  /** What this person's widgets show, as the app's snapshot builds it. */
  private signature(userId: string, roster: Bot[]) {
    const pinned = new Set(this.store.preferences(userId).favorites);
    return JSON.stringify(roster.map(bot => ({ ...bot, ...this.store.presentation(bot.id) }) as Bot).filter(bot => visible(bot, userId)).map(bot => {
      const avatar = bot.avatar?.mode === "portrait" ? undefined : bot.avatar?.color;
      return [bot.id, bot.name, bot.activity, bot.lastMessage?.at, bot.lastMessage?.text.slice(0, 200), avatar, pinned.has(bot.id)];
    }));
  }
}
