import { expect, it } from "vitest";
import { digestCopy, eventHeadline, excerpt, notificationCopy, withoutBotTag } from "../src/shared/event-copy";

it("titles task notifications with the assistant and quotes what happened", () => {
  expect(notificationCopy({ kind: "completed", title: "Hermes completed", body: "**Tailscale is up** on the NAS. Run `tailscale status` to confirm." }, "Nic's Chief"))
    .toEqual({ title: "Nic's Chief", body: "Tailscale is up on the NAS. Run tailscale status to confirm." });
  expect(eventHeadline({ kind: "approval", title: "Approval requested", body: "curl -H 'Authorization: Bearer SYNTHETIC_SECRET'" })).toBe("Needs your approval to continue.");
  expect(eventHeadline({ kind: "failed", title: "Hermes failed", body: "Provider rate limit" })).toBe("Couldn't finish: Provider rate limit");
});

it("says something specific when Hermes recorded no text", () => {
  expect(eventHeadline({ kind: "completed", title: "Hermes completed" })).toBe("Finished. Open the chat for the reply.");
  expect(eventHeadline({ kind: "approval", title: "Approval requested" })).toBe("Needs your approval to continue.");
  expect(notificationCopy({ kind: "completed", title: "Hermes completed" }).title).toBe("Assistant");
});

it("keeps meaningful titles, such as routine results, in the body", () => {
  expect(notificationCopy({ kind: "completed", title: "Trail options are ready", body: "Three loops under five miles." }, "Trail scout"))
    .toEqual({ title: "Trail scout", body: "Trail options are ready: Three loops under five miles." });
});

it("names routines without their owner tag and says when a run did not finish", () => {
  expect(notificationCopy({ kind: "completed", title: "[bot:patch] Daily AI news", body: "**Three** model launches.", routineId: "job" }, "Patch"))
    .toEqual({ title: "Patch", body: "Daily AI news: Three model launches." });
  expect(notificationCopy({ kind: "completed", title: "[bot:patch] Daily AI news", routineId: "job" }))
    .toEqual({ title: "Daily AI news", body: "Daily AI news" });
  expect(eventHeadline({ kind: "failed", title: "[bot:patch] Daily AI news", body: "Provider rate limit", routineId: "job" }))
    .toBe("Daily AI news couldn't finish: Provider rate limit");
  expect(eventHeadline({ kind: "interrupted", title: "Daily AI news", routineId: "job" })).toBe("Daily AI news stopped before finishing.");
  // A restart's own title already explains it, so it reads as written.
  expect(eventHeadline({ kind: "interrupted", title: "Hermes restarted. Review before retrying." })).toBe("Hermes restarted. Review before retrying.");
  expect(withoutBotTag("Weekly [bot:patch] recap")).toBe("Weekly [bot:patch] recap");
});

it("keeps custom approval titles out of notifications, as the chat does", () => {
  expect(notificationCopy({ kind: "approval", title: "Run deploy --token SYNTHETIC_SECRET" }))
    .toEqual({ title: "Assistant", body: "Needs your approval to continue." });
});

it("digests name one assistant once and several beside what each said", () => {
  expect(digestCopy([{ title: "Patch", body: "Daily AI news: Three launches." }, { title: "Patch", body: "Inbox: Two replies." }]))
    .toEqual({ title: "2 updates from Patch", body: "Daily AI news: Three launches. · Inbox: Two replies." });
  expect(digestCopy([{ title: "Patch", body: "Done." }, { title: "Kimberly", body: "Top up hay." }, { title: "Patch", body: "Ready." }]))
    .toEqual({ title: "3 updates from 2 assistants", body: "Patch: Done. · Kimberly: Top up hay. · Patch: Ready." });
});

it("flattens Markdown and cuts long replies at a word", () => {
  expect(excerpt("# Plan\n\n- [Docs](https://example.test) first\n- then ```code``` done")).toBe("Plan Docs first then done");
  const long = excerpt("word ".repeat(80), 40);
  expect(long.endsWith("word…")).toBe(true);
  expect(long.length).toBeLessThanOrEqual(41);
});
