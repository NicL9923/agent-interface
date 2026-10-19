import webpush from "web-push";
import { allowedIdentity, type Config } from "./config.js";
import { maxDeliveryAttempts, type Store } from "./store.js";
import type { Runtime } from "../shared/types.js";
import { visibleTo } from "./bot-access.js";
import { createApnsSender, type ApnsClearSender, type ApnsSender, type NativeDevice } from "./apns.js";
import { FailureTracker, quietLog, safeError, type Log } from "./logging.js";
import { LiveActivities, type LiveActivitySender } from "./live-activity.js";
export type PushSender = (
  subscription: webpush.PushSubscription,
  payload: string,
) => Promise<unknown>;
export function inQuietHours(settings: import('../shared/types.js').Preferences['notifications'], now = new Date()) {
  if (!settings?.quietStart || !settings.quietEnd) return false;
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone:settings.timezone, hour:'2-digit',minute:'2-digit',hourCycle:'h23' }).formatToParts(now);
  const time = `${parts.find(part=>part.type==='hour')!.value}:${parts.find(part=>part.type==='minute')!.value}`;
  return settings.quietStart < settings.quietEnd ? time >= settings.quietStart && time < settings.quietEnd : time >= settings.quietStart || time < settings.quietEnd;
}
export class BackgroundWorker {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private idleWaiters: (() => void)[] = [];
  private closeApns?: () => void;
  private retainedAt = 0;
  readonly createdAt = Date.now();
  lastTickAt?: number;
  readonly loop: FailureTracker;
  readonly discovery: FailureTracker;
  readonly push: FailureTracker;
  readonly clears: FailureTracker;
  readonly live: LiveActivities;
  constructor(
    private store: Store,
    private runtime: Runtime,
    private config: Config,
    private send?: PushSender,
    private sendApns?: ApnsSender,
    private log: Log = quietLog,
    sendLiveActivity?: LiveActivitySender,
    private sendClear?: ApnsClearSender,
  ) {
    this.loop = new FailureTracker(log, "Background worker");
    this.discovery = new FailureTracker(log, "Hermes event discovery");
    this.push = new FailureTracker(log, "Push delivery");
    this.clears = new FailureTracker(log, "Notification clearing");
    if (!sendApns && config.apns) {
      const sender = createApnsSender(config.apns)!;
      this.sendApns = sender;
      sendLiveActivity ??= sender.liveActivity;
      this.sendClear ??= sender.clear;
      this.closeApns = () => sender.close();
    }
    this.live = new LiveActivities(store, runtime, config, sendLiveActivity, log);
    if (!send && config.vapidPublicKey) {
      webpush.setVapidDetails(
        config.vapidSubject,
        config.vapidPublicKey,
        config.vapidPrivateKey,
      );
      this.send = (subscription, payload) =>
        webpush.sendNotification(subscription, payload, {
          timeout: 15000,
          TTL: 86400,
        });
    }
  }
  start() {
    this.timer = setInterval(() => void this.tick(), 5000);
    this.timer.unref();
    void this.tick();
  }
  stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    const stopped = this.running
      ? new Promise<void>((resolve) => this.idleWaiters.push(resolve))
      : Promise.resolve();
    return stopped.then(() => { this.closeApns?.(); });
  }
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      // A runtime outage must not prevent delivery of already-durable events.
      await this.reconcileRuntime();
      this.store.enqueueKnownEvents();
      const expired = this.store.expireNotifications();
      if (expired) this.log.info({ expired }, "Expired notifications that stayed undelivered for a day");
      if (Date.now() - this.retainedAt >= 3600000) {
        this.retainedAt = Date.now();
        const removed = this.store.pruneRetention();
        if (removed.sessions || removed.notifications) this.log.info(removed, "Removed expired sessions and old notifications");
      }
      await this.deliver();
      // Clearing is a courtesy; its failures never hold up delivery.
      try { await this.clearRead(); } catch (error) { this.clears.failure(error); }
      // Live Activity pushes never hold up notifications; their failures are tracked separately.
      try { await this.live.tick(); } catch (error) { this.live.push.failure(error); }
      this.loop.success();
    } catch (error) {
      this.loop.failure(error);
    } finally {
      this.lastTickAt = Date.now();
      this.running = false;
      for (const resolve of this.idleWaiters.splice(0)) resolve();
    }
  }
  private async reconcileRuntime() {
    try {
      const capabilities = await this.runtime.capabilities();
      if (capabilities.idempotency.supported)
        for (const pending of this.store.pending()) {
          try {
            const receipt = await this.runtime.lookupSubmission(
              pending.input.requestId,
            );
            if (receipt) this.store.receipt(receipt);
          } catch {
            /* Preserve uncertain intent, never replay. */
          }
        }
      if (!capabilities.durableEvents.supported)
        throw new Error(capabilities.durableEvents.reason ?? "Durable events are unavailable");
      const discovery = await this.runtime.discoverEvents(
        this.store.cursor(),
      );
      // Titles name the assistant; a roster failure keeps the previous names.
      if (discovery.events.length) try {
        this.store.botNames = new Map((await this.runtime.listBots()).map(bot => [bot.id, bot.name]));
      } catch { /* Fall back to the last known names. */ }
      this.store.recordEvents(discovery.events, discovery.cursor);
      this.discovery.success();
    } catch (error) {
      // Preserve the discovery cursor while Hermes is unavailable.
      this.discovery.failure(error);
    }
  }
  private async deliver() {
    if (!this.send && !this.sendApns) return;
    for (const item of this.store.deliveryGroups()) {
      try {
        const user = this.store.getUser(item.user_id);
        if (!user || !allowedIdentity(this.config, user)) continue;
        // Security alerts are never batched, so the group payload carries their kind.
        const security = JSON.parse(item.payload).kind === "security";
        if (!security && inQuietHours(this.store.preferences(item.user_id).notifications)) continue;
        // An assistant made private after this was queued, held by quiet hours or a digest, stays with its owner.
        // News the person is reading in the chat, or already read there on any device, needs no alert.
        if (!security) item.items = item.items.filter(row => {
          const due = visibleTo(this.store, JSON.parse(row.payload).botId, item.user_id) && !this.store.seenInChat(row.id);
          if (!due) this.store.finishDelivery(row.id);
          return due;
        });
        if (!item.items.length) continue;
        // Rebuild the frozen membership's display after revocation, preserving its
        // tag and each endpoint's delivery receipts without exposing removed titles.
        const original = JSON.parse(item.payload);
        const deliveryPayload = original.url === '/?view=today' ? JSON.stringify({...original,title:`${item.items.length} assistant update${item.items.length===1?'':'s'}`,body:item.items.slice(0,3).map(row=>JSON.parse(row.payload).title).join(' · ')}) : item.payload;
        const subscriptions = this.send ? this.store.subscriptions(item.user_id) : [];
        const devices = this.sendApns && this.config.apns ? this.store.nativeDevices(item.user_id, this.config.apns.environment) : [];
        // Keep undelivered events durable until this person has a subscription.
        if (!subscriptions.length && !devices.length) continue;
        let failed: string | undefined;
        // A send can take a while; an assistant made private meanwhile stops the rest of this
        // delivery before its frozen payload reaches another endpoint. The next pass drops it.
        // Reading the chat on one device meanwhile likewise stops the alert reaching the others.
        const stillVisible = () => item.items.every(row => security || visibleTo(this.store, JSON.parse(row.payload).botId, item.user_id) && !this.store.seenInChat(row.id));
        let revoked = false;
        for (const subscription of subscriptions) {
          if (item.items.every(row => this.store.delivered(row.id, subscription.endpoint))) continue;
          if (!stillVisible()) { revoked = true; break; }
          try {
            await this.send!(subscription, deliveryPayload);
            for (const row of item.items) this.store.markDelivered(row.id, subscription.endpoint);
            this.push.success();
          } catch (error) {
            const status = (error as { statusCode?: number }).statusCode;
            if (status === 404 || status === 410) {
              this.store.unsubscribe(item.user_id, subscription.endpoint);
              for (const row of item.items) this.store.markDelivered(row.id, subscription.endpoint);
            } else {
              failed = `Web Push ${status ?? "error"}: ${error instanceof Error ? error.message : String(error)}`;
              this.push.failure(failed);
            }
          }
        }
        for (const device of revoked ? [] : devices) {
          const endpoint = `apns:${device.environment}:${device.token}`;
          if (item.items.every(row => this.store.delivered(row.id, endpoint))) continue;
          if (!stillVisible()) { revoked = true; break; }
          try {
            await this.sendApns!(device, deliveryPayload);
            for (const row of item.items) this.store.markDelivered(row.id, endpoint);
            this.push.success();
          } catch (error) {
            const result = error as { statusCode?: number; reason?: string; message?: string };
            if (result.statusCode === 410 || (result.statusCode === 400 && ["BadDeviceToken", "DeviceTokenNotForTopic"].includes(result.reason ?? ""))) {
              this.store.removeNativeDevice(item.user_id, device.deviceId);
              for (const row of item.items) this.store.markDelivered(row.id, endpoint);
            } else {
              failed = `APNs ${result.statusCode ?? "error"}: ${result.reason ?? result.message ?? String(error)}`;
              this.push.failure(failed);
            }
          }
        }
        if (revoked) continue;
        let abandoned = 0;
        for (const row of item.items) {
          if (failed === undefined) this.store.finishDelivery(row.id);
          else if (this.store.retryDelivery(row.id, row.attempts + 1, failed.slice(0, 300))) abandoned++;
        }
        if (abandoned) this.log.warn({ notifications: abandoned, error: failed }, `Gave up delivering notifications after ${maxDeliveryAttempts} attempts`);
      } catch (error) {
        // One malformed notification must never block delivery of everything queued after it.
        const message = `Delivery error: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300);
        let abandoned = 0;
        for (const row of item.items) if (this.store.retryDelivery(row.id, row.attempts + 1, message)) abandoned++;
        this.log.error({ error: safeError(error), notifications: item.items.length, abandoned }, "Could not deliver a notification");
      }
    }
  }
  /** Removes notifications read in one place from the person's other iPhones and iPads. */
  private async clearRead() {
    if (!this.sendClear || !this.config.apns) return;
    const environment = this.config.apns.environment;
    const byEndpoint = new Map<string, { device?: NativeDevice; botIds: Set<string>; rows: string[] }>();
    for (const row of this.store.readOnDevices()) {
      const device = this.store.nativeDevices(row.user_id, environment).find(device => `apns:${device.environment}:${device.token}` === row.endpoint);
      const entry = byEndpoint.get(row.endpoint) ?? { device, botIds: new Set(), rows: [] };
      byEndpoint.set(row.endpoint, entry);
      entry.rows.push(row.outbox_id);
      // The device that read the chat already cleared its own notifications.
      if (device && device.deviceId !== row.reader) entry.botIds.add(row.bot_id);
    }
    for (const [endpoint, entry] of byEndpoint) {
      // iOS throttles background pushes and drops them for a closed app, so a failed clear is
      // not retried. Opening the chat on that device clears the rest.
      if (entry.device && entry.botIds.size) try {
        await this.sendClear(entry.device, [...entry.botIds]);
        this.clears.success();
      } catch (error) { this.clears.failure(error); }
      for (const id of entry.rows) this.store.markCleared(id, endpoint);
    }
  }
}
