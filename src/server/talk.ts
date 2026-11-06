import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { isConversationReply } from "../shared/message-origin.js";
import type { Bot, CapabilityKey, Conversation, Message, RealtimeSessionInput, Runtime, SubmissionReceipt } from "../shared/types.js";
import { DEFAULT_TALK_VOICE, MAX_TALK_ANSWER, TALK_TOOL, type TalkAnswer } from "../shared/voice.js";
import { apiRoute } from "./api-route.js";
import { signedIn } from "./auth.js";
import { redactAgents, type Roster } from "./bot-access.js";
import type { BotDirectory } from "./bot-routes.js";
import { httpError } from "./http-error.js";
import type { Store } from "./store.js";

// Each Talk start mints a paid Realtime session on the household's ChatGPT sign-in.
const MINT_INTERVAL_MS = 5_000;
const MINTS_PER_HOUR = 20;
// How long one ask waits for the reply before answering "working"; the client asks again.
const ASK_WAIT_MS = 20_000;
const RECHECK_MS = 2_000;
// A request Hermes admitted but no read shows for this long is gone from the chat, as after a reset.
const MISSING_MS = 30_000;
const running = ["thinking", "working"];

const clean = (text: string | undefined, limit: number) =>
  (text ?? "").replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, limit);

/**
 * What the voice model is told. It names only this assistant, from its name and description,
 * so nothing about another member's private assistant reaches the voice session.
 */
export function talkPersona(bot: Pick<Bot, "name" | "description">) {
  const name = clean(bot.name, 80) || "the assistant";
  const description = clean(bot.description, 400);
  return [
    `You are the speaking voice of ${name}, a household assistant${description ? `: ${description}` : "."}`,
    `${name} does the real work. You listen, pass requests on and read answers back.`,
    `For every real request, such as a question, task, lookup, reminder or anything that needs knowledge, memory or tools, call ${TALK_TOOL} once with the person's own words in "request". Do not answer from your own knowledge and do not reword what they asked.`,
    "You may answer greetings, thanks and small talk yourself, in a sentence.",
    "While you wait for a result, say one short filler such as \"Let me check.\" Do not repeat it.",
    "Read results back conversationally and briefly. Never read Markdown, lists, tables, code or web addresses aloud. Summarize them and say the details are in the chat.",
    "If a result says an approval or a question is waiting, tell the person to check the screen to answer it.",
    "If a result says the work is still going, say the answer will follow, then wait. Do not call the tool again for the same request.",
    "Speak in the language the person uses.",
  ].join("\n");
}

export function talkTools(name: string): RealtimeSessionInput["tools"] {
  return [{
    type: "function", name: TALK_TOOL,
    description: `Send the person's request to ${clean(name, 80) || "the assistant"} and get the answer. Use the person's own words.`,
    parameters: { type: "object", properties: { request: { type: "string", description: "The person's request, in their own words." } },
      required: ["request"], additionalProperties: false },
  }];
}

/** A reply short enough to speak. It ends at a sentence when one ends late enough, and points to the chat for the rest. */
export function spokenText(text: string, limit = MAX_TALK_ANSWER) {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  const head = trimmed.slice(0, limit - 40);
  const sentence = Math.max(...[". ", "! ", "? ", "\n"].map(mark => head.lastIndexOf(mark)));
  const cut = sentence > head.length * 0.6 ? head.slice(0, sentence + 1) : head.slice(0, Math.max(head.lastIndexOf(" "), 1));
  return `${cut.trim()} The rest is in the chat.`;
}

/** Several replies to one request, latest first in importance: earlier ones are left to the chat when they do not fit. */
export function spokenReplies(texts: string[], limit = MAX_TALK_ANSWER) {
  const kept: string[] = [];
  let size = 0;
  for (const text of [...texts].reverse()) {
    if (kept.length && size + text.length + 2 > limit - 40) break;
    kept.unshift(text);
    size += text.length + 2;
  }
  const spoken = spokenText(kept.join("\n\n"), limit);
  return kept.length < texts.length && spoken.length <= limit - 32 ? `${spoken} Earlier parts are in the chat.` : spoken;
}

/**
 * Where a submitted request stands in a conversation read anchored at its message: undefined while
 * it runs or is not yet visible, "missing" when the read shows neither it nor any work.
 * `reply` turns a message into what this person may read.
 */
export function talkAnswer(receipt: SubmissionReceipt, conversation: Conversation, reply: (message: Message) => Message = message => message): TalkAnswer | "missing" | undefined {
  if (receipt.status === "rejected") return { state: "refused", text: receipt.message };
  if (receipt.status === "interrupted") return { state: "interrupted" };
  if (receipt.status !== "accepted") return undefined;
  const { activity } = conversation;
  const active = ["waiting", "blocked", ...running].includes(activity.state);
  const ours = receipt.runId ? activity.runId === receipt.runId : active;
  if (ours && activity.state === "waiting") return { state: "needsApproval", text: conversation.approvals[0]?.title };
  if (ours && activity.state === "blocked") return { state: "needsAnswer", text: conversation.attention?.[0]?.title };
  if (ours && activity.state === "interrupted") return { state: "interrupted" };
  if (ours && running.includes(activity.state)) return undefined;
  const messages = conversation.messages.filter(message => !message.id.endsWith("-inflight"));
  // The add-on names a person's message by its request ID; older ones by the receipt's row.
  const sent = messages.findIndex(message => message.role === "user" && (message.id === receipt.requestId || message.id === receipt.messageId));
  if (sent < 0) return active ? undefined : "missing";
  const later = messages.slice(sent + 1);
  // No other turn followed, so an outcome without a run names this request's turn.
  const latest = !later.some(message => message.role === "user" && (!receipt.runId || message.runId !== receipt.runId));
  if (latest && !activity.runId && activity.state === "interrupted") return { state: "interrupted" };
  // Only what came after the request: a steer joins a run whose earlier replies answered something else.
  const inRun = receipt.runId ? later.filter(message => message.runId === receipt.runId) : [];
  const next = later.findIndex(message => message.role === "user");
  const replies = (inRun.length ? inRun : later.slice(0, next < 0 ? undefined : next)).filter(isConversationReply);
  const texts = replies.map(message => reply(message)).filter(isConversationReply).map(message => message.text.trim()).filter(Boolean);
  if (!texts.length && latest && activity.state === "failed") return { state: "refused", text: "The assistant could not finish this request." };
  return { state: "done", text: spokenReplies(texts) };
}

/** Admits one mint per person every few seconds, and a bounded number an hour. */
export class MintLimit {
  private readonly mints = new Map<string, number[]>();
  constructor(private readonly now: () => number = Date.now) {}
  take(userId: string) {
    const now = this.now();
    const recent = (this.mints.get(userId) ?? []).filter(at => now - at < 3_600_000);
    if (recent.length && now - recent[recent.length - 1]! < MINT_INTERVAL_MS)
      throw httpError(429, "Talk is already starting. Wait a moment, then try again.");
    if (recent.length >= MINTS_PER_HOUR)
      throw httpError(429, "Talk has started many times this hour. Try again later, or type your message.");
    recent.push(now);
    this.mints.set(userId, recent);
  }
}

/** Live Talk: a Realtime credential for the browser, and spoken requests sent as ordinary messages. */
export function installTalkRoutes(app: FastifyInstance, collaborators: {
  runtime: Runtime;
  store: Store;
  roster: Roster;
  directory: BotDirectory;
  requireCapability: (key: CapabilityKey) => Promise<void>;
  send: (botId: string, requesterId: string, requestId: string, text: string) => Promise<SubmissionReceipt>;
  now?: () => number;
  waitMs?: number;
}) {
  const { runtime, store, roster, directory, requireCapability, send } = collaborators;
  const now = collaborators.now ?? (() => Date.now()), waitMs = collaborators.waitMs ?? ASK_WAIT_MS;
  const limit = new MintLimit(now);
  apiRoute(app, "POST /bots/:id/talk/session", { before: () => requireCapability("liveVoice") }, async (req, _body, reply) => {
    if (!runtime.realtimeSession) throw httpError(409, "Live voice is unavailable on this Hermes connection.");
    limit.take(signedIn(req).id);
    const [bots, capabilities] = await Promise.all([runtime.listBots(), runtime.capabilities()]);
    const row = bots.find(bot => bot.id === req.params.id);
    if (!row) throw httpError(404, "Bot not found");
    const bot = directory.decorate(row, capabilities.avatarMetadata.supported);
    const session = await runtime.realtimeSession({ voice: bot.voice ?? DEFAULT_TALK_VOICE, instructions: talkPersona(bot), tools: talkTools(bot.name) });
    reply.header("Cache-Control", "no-store");
    return session;
  });
  const ask = z.object({ requestId: z.string().uuid(), request: z.string().trim().min(1).max(4000) }).strict();
  // When each admitted request was first missing from its anchored read, to tell a slow write from a lost one.
  const missing = new Map<string, number>();
  apiRoute(app, "POST /bots/:id/talk/ask", { body: ask }, async (req, { requestId, request }, reply) => {
    const botId = req.params.id, userId = signedIn(req).id;
    reply.header("Cache-Control", "no-store");
    // The same ID returns the recorded request instead of sending it twice.
    let receipt = await send(botId, userId, requestId, request);
    const idempotent = (await runtime.capabilities()).idempotency.supported;
    // Hermes settles an admitted request's receipt, as when its work is interrupted; the recorded one stays as admitted.
    const refresh = async () => {
      if (!idempotent || !["accepted", "uncertain"].includes(receipt.status)) return;
      const known = await runtime.lookupSubmission(requestId).catch(() => null);
      if (known && known.status !== "uncertain") { store.receipt(known); receipt = known; }
    };
    await refresh();
    if (receipt.status === "uncertain") return { state: "working" };
    const redact = await redactAgents(store, roster, userId);
    const deadline = now() + waitMs;
    for (const [id, at] of missing) if (now() - at > 10 * MISSING_MS) missing.delete(id);
    let wake: (() => void) | undefined;
    // Streamed tokens change nothing this waits for; a structural change may settle the run.
    const unwatch = runtime.watch?.(botId, kind => { if (kind !== "inflight") wake?.(); });
    try {
      for (;;) {
        // Anchored at the request, so later turns never push it out of the read.
        const answer = talkAnswer(receipt, await runtime.conversation(botId, { window: { start: requestId } }), redact.message);
        if (answer === "missing") {
          const since = missing.get(requestId) ?? now();
          missing.set(requestId, since);
          if (now() - since >= MISSING_MS) {
            missing.delete(requestId);
            return { state: "refused", text: "This request is no longer in the chat. Check the chat before asking again." };
          }
        } else if (answer) { missing.delete(requestId); return answer; }
        const left = deadline - now();
        if (left <= 0) return { state: "working" };
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, Math.min(left, RECHECK_MS));
          wake = () => { clearTimeout(timer); resolve(); };
        });
        wake = undefined;
        await refresh();
      }
    } finally { unwatch?.(); }
  });
}
