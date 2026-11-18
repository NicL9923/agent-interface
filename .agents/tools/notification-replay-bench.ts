// Times the notification replay the background worker runs every 5 seconds: `npx tsx .agents/tools/notification-replay-bench.ts`.
import { Store } from "../../src/server/store.js";
const store = new Store(":memory:");
const users = ["one", "two", "three", "four"];
for (const id of users) store.user({ id, name: id, email: `${id}@example.test` });
const bots = Array.from({ length: 20 }, (_, i) => `bot${i}`);
const pref = (followBots: string[]) => ({
  presentation: "simple" as const,
  theme: "system" as const,
  favorites: [],
  sections: [],
  followBots,
});
store.savePreferences("two", pref(bots.slice(0, 10)));
store.savePreferences("three", pref(bots));
const body = "## Result\n\n**Done** with the [report](https://example.test/a?b=1). ".repeat(20);
const events = Array.from({ length: 500 }, (_, i) => ({
  id: `e${i}`,
  botId: bots[i % 20],
  runId: `run${i}`,
  kind: "completed" as const,
  title: "Work complete",
  body,
  occurredAt: new Date().toISOString(),
}));
for (let i = 0; i < 500; i++) store.participate(`run${i}`, "one");
store.recordEvents(events, "c");
const rows = () => (store.db.prepare("SELECT count(*) n FROM outbox").get() as { n: number }).n;
store.enqueueKnownEvents();
const before = rows();
const times: number[] = [];
for (let i = 0; i < 30; i++) {
  const t = performance.now();
  store.enqueueKnownEvents();
  times.push(performance.now() - t);
}
times.sort((a, b) => a - b);
console.log(
  JSON.stringify({
    outbox: before,
    afterReplay: rows(),
    medianMs: +times[15].toFixed(2),
    p90Ms: +times[27].toFixed(2),
    minMs: +times[0].toFixed(2),
  }),
);
