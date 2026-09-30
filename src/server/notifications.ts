import webpush from "web-push";
import { allowedIdentity, type Config } from "./config.js";
import type { Store } from "./store.js";
import type { Runtime } from "../shared/types.js";
export type PushSender = (
  subscription: webpush.PushSubscription,
  payload: string,
) => Promise<unknown>;
export class BackgroundWorker {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private idleWaiters: (() => void)[] = [];
  lastError?: string;
  constructor(
    private store: Store,
    private runtime: Runtime,
    private config: Config,
    private send?: PushSender,
  ) {
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
    return this.running
      ? new Promise((resolve) => this.idleWaiters.push(resolve))
      : Promise.resolve();
  }
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      // A runtime outage must not prevent delivery of already-durable events.
      await this.reconcileRuntime();
      this.store.enqueueKnownEvents();
      await this.deliver();
      this.lastError = undefined;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    } finally {
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
      if (capabilities.durableEvents.supported) {
        const discovery = await this.runtime.discoverEvents(
          this.store.cursor(),
        );
        this.store.recordEvents(discovery.events, discovery.cursor);
      }
    } catch {
      /* Preserve the discovery cursor while Hermes is unavailable. */
    }
  }
  private async deliver() {
    if (!this.send) return;
    for (const item of this.store.outbox()) {
      const user = this.store.getUser(item.user_id);
      if (!user || !allowedIdentity(this.config, user)) continue;
      const subscriptions = this.store.subscriptions(item.user_id);
      // Keep undelivered events durable until this person has a subscription.
      if (!subscriptions.length) continue;
      let failed = false;
      for (const subscription of subscriptions) {
        if (this.store.delivered(item.id, subscription.endpoint)) continue;
        try {
          await this.send(subscription, item.payload);
          this.store.markDelivered(item.id, subscription.endpoint);
        } catch (error) {
          const status = (error as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            this.store.unsubscribe(item.user_id, subscription.endpoint);
            this.store.markDelivered(item.id, subscription.endpoint);
          } else failed = true;
        }
      }
      if (failed) this.store.retryDelivery(item.id, item.attempts + 1);
      else this.store.finishDelivery(item.id);
    }
  }
}
