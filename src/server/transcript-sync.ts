import { isDeepStrictEqual } from "node:util";
import type { Conversation, Message, Runtime } from "../shared/types.js";
import { hermesRuntimeId } from "./runtime-router.js";
import type { Store } from "./store.js";

/** The latest Hermes window can carry an unsaved live reply. The request session is Hermes's live ID. */
export function persistedHermesMessages(
  conversation: Pick<Conversation, "messages" | "requestSessionId" | "sessionId">,
): Message[] {
  const sessionId = conversation.requestSessionId ?? conversation.sessionId;
  return sessionId === undefined
    ? conversation.messages
    : conversation.messages.filter((message) => message.id !== `${sessionId}-inflight`);
}

/** Seed or reconcile the shadow using one complete, undecorated Hermes history read. */
export function backfillBotTranscript(
  store: Pick<Store, "transcripts">,
  runtime: Pick<Runtime, "conversation">,
  botId: string,
) {
  return store.transcripts.backfill(botId, hermesRuntimeId, async () => {
    const conversation = await runtime.conversation(botId);
    if (conversation.botId !== botId)
      throw new Error("Cannot backfill a transcript from another bot.");
    if (conversation.activity.state === "disconnected")
      throw new Error("Cannot backfill a transcript while Hermes is disconnected.");
    if (conversation.window) throw new Error("Cannot backfill a transcript from a partial window.");
    return persistedHermesMessages(conversation);
  });
}

const messageFields = {
  id: true,
  runId: true,
  role: true,
  text: true,
  createdAt: true,
  sender: true,
  files: true,
  reasoning: true,
  toolName: true,
  toolCall: true,
  origin: true,
  steered: true,
  interim: true,
} satisfies Record<keyof Message, true>;
const fields = Object.keys(messageFields) as (keyof Message)[];

/** Compare the shared message payload, with the same absent fields as on the wire. */
function payload(message: Message): unknown {
  return JSON.parse(JSON.stringify(fields.map((field) => message[field])));
}

/** Compare the same persisted window in conversation order before applying viewer-specific redaction. */
export function compareShadowPage(
  localMessages: readonly Message[],
  runtimeMessages: readonly Message[],
) {
  const duplicateIds = new Set<string>();
  const byId = (messages: readonly Message[]) => {
    const rows = new Map<string, Message>();
    for (const message of messages) {
      if (rows.has(message.id)) duplicateIds.add(message.id);
      rows.set(message.id, message);
    }
    return rows;
  };
  const local = byId(localMessages);
  const runtime = byId(runtimeMessages);
  const missingFromLocal = [...runtime.keys()].filter((id) => !local.has(id));
  const extraInLocal = [...local.keys()].filter((id) => !runtime.has(id));
  const sharedInLocal = [...local.keys()].filter((id) => runtime.has(id));
  const sharedInRuntime = [...runtime.keys()].filter((id) => local.has(id));
  const mutated = sharedInLocal.filter(
    (id) => !isDeepStrictEqual(payload(local.get(id)!), payload(runtime.get(id)!)),
  );
  const reordered = sharedInLocal.filter((id, index) => id !== sharedInRuntime[index]);
  // A moved and edited row counts once. A missing row alone does not shift the shared order.
  const diffCount = new Set([
    ...missingFromLocal,
    ...extraInLocal,
    ...mutated,
    ...reordered,
    ...duplicateIds,
  ]).size;
  return {
    matches: diffCount === 0,
    diffCount,
    missingFromLocal,
    extraInLocal,
    mutated,
    reordered,
    duplicateIds: [...duplicateIds],
  };
}
