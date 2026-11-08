import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { conversationArtifacts, replyArtifacts } from "../src/shared/artifacts";
import type { FileRef, Message } from "../src/shared/types";

// The same vectors drive the iOS mirror, so the panel and chips agree on both clients.
const file = fileURLToPath(new URL("../ios/AgentInterfaceTests/Vectors/reply-artifacts.json", import.meta.url));
const { cases } = JSON.parse(readFileSync(file, "utf8")) as { cases: { name: string; messages: Message[]; files?: FileRef[]; artifacts: [string, string][]; replies: Record<string, string[]> }[] };

it.each(cases)("$name", ({ messages, files, artifacts, replies }) => {
  const listed = conversationArtifacts(messages, [], files);
  expect(listed.map(artifact => [artifact.file.id, artifact.source])).toEqual(artifacts);
  const chips = replyArtifacts(messages, listed);
  expect(Object.fromEntries([...chips].map(([reply, items]) => [reply, items.map(item => item.file.id)]))).toEqual(replies);
  // A chip is always the panel's own entry, so it opens on exactly what the panel shows.
  for (const items of chips.values()) for (const item of items) expect(listed).toContain(item);
});
