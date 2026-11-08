import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { conversationArtifacts, replyArtifacts, windowReplyArtifacts } from "../src/shared/artifacts";
import type { EarlierFiles } from "../src/shared/history";
import type { FileRef, Message } from "../src/shared/types";

// The same vectors drive the iOS mirror, so the panel and chips agree on both clients.
const file = fileURLToPath(new URL("../ios/AgentInterfaceTests/Vectors/reply-artifacts.json", import.meta.url));
const { cases } = JSON.parse(readFileSync(file, "utf8")) as { cases: { name: string; messages: Message[]; files?: FileRef[]; earlier?: EarlierFiles["messages"]; artifacts: [string, string][]; replies: Record<string, string[]> }[] };

it.each(cases)("$name", ({ messages, files, earlier, artifacts, replies }) => {
  const listed = conversationArtifacts(messages, earlier, files);
  expect(listed.map(artifact => [artifact.file.id, artifact.source])).toEqual(artifacts);
  const chips = replyArtifacts(messages, listed, earlier);
  expect(Object.fromEntries([...chips].map(([reply, items]) => [reply, items.map(item => item.file.id)]))).toEqual(replies);
  // A chip is always the panel's own entry, so it opens on exactly what the panel shows.
  for (const items of chips.values()) for (const item of items) expect(listed).toContain(item);
});

it("shows no chips for a window after the start until the history before it is known, then the panel's own", () => {
  const photo = { id: "photo", name: "photo.png", mime: "image/png" };
  const messages: Message[] = [{ id: "u1", role: "user", text: "Fix it" }, { id: "a1", role: "assistant", text: "Fixed", files: [photo] }];
  const window = { messages, files: [photo], earlier: 4 };
  // Unknown history: the photo could be the person's, so no chip rather than a wrong one.
  expect(windowReplyArtifacts(window).size).toBe(0);
  // Known: it was the person's, so still none; and a window from the start needs nothing more.
  expect(windowReplyArtifacts(window, [{ id: "e1", role: "user", files: [photo] }]).size).toBe(0);
  expect(windowReplyArtifacts(window, []).get("a1")?.map(artifact => artifact.source)).toEqual(["Generated"]);
  expect(windowReplyArtifacts({ ...window, earlier: 0 }).get("a1")?.length).toBe(1);
  expect(windowReplyArtifacts({ messages, files: [photo] }).get("a1")?.length).toBe(1);
});
