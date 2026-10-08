import { expect, it } from "vitest";
import { eventHeadline, excerpt, notificationCopy } from "../src/shared/event-copy";

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

it("flattens Markdown and cuts long replies at a word", () => {
  expect(excerpt("# Plan\n\n- [Docs](https://example.test) first\n- then ```code``` done")).toBe("Plan Docs first then done");
  const long = excerpt("word ".repeat(80), 40);
  expect(long.endsWith("word…")).toBe(true);
  expect(long.length).toBeLessThanOrEqual(41);
});
