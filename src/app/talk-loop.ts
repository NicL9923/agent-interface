import { finalTalkStates, MAX_HEARD_LINES, TALK_TOOL, type TalkAnswer } from "../shared/voice";

/** What the person sees: who is talking, or what the assistant is doing. */
export type TalkPhase = "listening" | "thinking" | "working" | "speaking";
export interface TalkCaptions { you: string; assistant: string }
export interface TalkLoopHost {
  /** Sends one client event over the "oai-events" data channel. */
  send(event: Record<string, unknown>): void;
  /** POST /bots/:id/talk/ask. The same request ID never sends twice. `heard` names the progress lines already said. */
  ask(requestId: string, request: string, signal: AbortSignal, heard: readonly string[]): Promise<TalkAnswer>;
  phase(phase: TalkPhase): void;
  captions(captions: TalkCaptions): void;
  /** The person spoke or the assistant answered, which keeps an idle Talk open. */
  activity(): void;
  /** A Realtime error the person should see. Talk keeps going unless the host ends it. */
  problem(message: string): void;
  newId(): string;
}
// A run can take a while; Talk still ends on its own idle and hard limits.
const MAX_FOLLOW_MS = 10 * 60_000;
// The server waits on a running request, but answers a pending decision or an unconfirmed send at
// once, so asking again waits here first.
export const FOLLOW_MS = 2_000;
export const DECISION_FOLLOW_MS = 5_000;

/**
 * The Realtime tool loop. The voice model calls ask_assistant; this sends the request to the
 * assistant as the person's message and speaks its answer. A response.create sent while another
 * response is active fails, so one is queued until the current response is done.
 */
export class TalkLoop {
  private active = false;
  private queued = false;
  private disposed = false;
  private readonly abort = new AbortController();
  private you = "";
  private assistant = "";
  private assistantDone = false;
  private following = 0;
  // The newest progress line of each request that came while a response was active, held until it ends. An
  // answer that arrives first drops it, so the person hears the answer, not what was done on the way to it.
  private readonly held = new Map<string, string>();
  // Every progress line said in this Talk, for every request: a steered request shares its run with the one
  // before it, so a line must not be said once for each. Oldest first, and only the newest are reported.
  private readonly heard = new Set<string>();
  constructor(private readonly host: TalkLoopHost, private readonly name: string, private readonly now: () => number = () => Date.now()) {}

  dispose() { this.disposed = true; this.abort.abort(); }

  /** Waits before asking again, ending early when Talk ends. */
  private pause(ms: number) {
    const signal = this.abort.signal;
    return new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, ms);
      signal.addEventListener("abort", done, { once: true });
    });
  }

  /** Asks for a spoken response now, or after the current one ends. */
  respond() {
    if (this.disposed) return;
    if (this.active) { this.queued = true; return; }
    // Counted active at once, so a second call before response.created waits its turn.
    this.active = true;
    try { this.host.send({ type: "response.create" }); }
    catch (error) { this.active = false; throw error; }
  }

  handle(event: { type?: unknown; [key: string]: unknown }) {
    if (this.disposed) return;
    switch (event.type) {
      case "input_audio_buffer.speech_started":
        this.host.activity(); this.host.phase(this.following ? "working" : "listening"); break;
      case "conversation.item.input_audio_transcription.completed":
        this.you = String(event.transcript ?? "").trim(); this.assistant = ""; this.show(); break;
      case "response.created":
        this.active = true; this.host.phase("thinking"); break;
      case "response.output_audio_transcript.delta":
        if (!this.assistant || this.assistantDone) { this.assistant = ""; this.assistantDone = false; }
        this.assistant += String(event.delta ?? ""); this.host.phase("speaking"); this.show(); break;
      case "response.output_audio_transcript.done":
        this.assistant = String(event.transcript ?? this.assistant); this.assistantDone = true; this.host.activity(); this.show(); break;
      case "response.done":
        this.active = false;
        this.host.phase(this.following ? "working" : "listening");
        if (this.queued) { this.queued = false; this.respond(); }
        else this.flushHeld();
        break;
      case "response.function_call_arguments.done":
        if (event.name === TALK_TOOL) void this.call(String(event.call_id ?? ""), String(event.arguments ?? ""));
        else this.output(String(event.call_id ?? ""), "That tool is not available. Answer without it.");
        break;
      case "error": {
        const error = (event.error ?? {}) as { code?: unknown; message?: unknown };
        // Our response.create raced one the server started itself; send it after that one ends.
        if (error.code === "conversation_already_has_active_response") { this.queued = true; break; }
        this.active = false;
        this.queued = false;
        this.host.phase(this.following ? "working" : "listening");
        this.host.problem(typeof error.message === "string" ? error.message.slice(0, 300) : "The voice service reported a problem.");
        break;
      }
    }
  }
  private show() { this.host.captions({ you: this.you, assistant: this.assistant }); }

  private output(callId: string, output: string) {
    this.host.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output } });
    this.respond();
  }

  private say(text: string) {
    this.host.send({ type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text", text }] } });
    this.respond();
  }

  /** Says the oldest held progress line now that no response is active. */
  private flushHeld() {
    const next = this.held.entries().next();
    if (next.done) return;
    this.held.delete(next.value[0]);
    this.say(next.value[1]);
  }

  /** Says a new progress line at once when the voice is free, else holds the newest until it is. */
  private narrate(requestId: string, request: string, answer: TalkAnswer) {
    if (!answer.progress) return;
    const text = `About the earlier request "${request.slice(0, 200)}": ${this.spoken(answer)} Tell the person now, briefly.`;
    if (this.active || this.queued) { this.held.delete(requestId); this.held.set(requestId, text); } else this.say(text);
  }

  private spoken(answer: TalkAnswer) {
    const text = answer.text?.trim();
    switch (answer.state) {
      case "done": return text ? `${this.name} answered: ${text}` : `${this.name} finished without a reply to read. The chat shows what happened.`;
      case "refused": return `${this.name} could not take this request${text ? `: ${text}` : "."}`;
      case "interrupted": return `${this.name}'s work on this was interrupted. Suggest checking the chat.`;
      case "needsApproval": return `${this.name} is waiting for an approval on screen${text ? `: ${text}` : ""}. Tell the person to check the screen. The answer follows once they decide.`;
      case "needsAnswer": return `${this.name} has a question waiting on screen${text ? `: ${text}` : ""}. Tell the person to check the screen to answer it.`;
      case "working": return answer.progress
        ? `${this.name} is working on it and says: "${answer.progress.text}" Tell the person that in one short sentence, in your own words, then wait. The answer will follow.`
        : `${this.name} is still working on it. Tell the person the answer will follow, then wait.`;
    }
  }

  private async call(callId: string, raw: string) {
    let request = "";
    try { request = String((JSON.parse(raw) as { request?: unknown }).request ?? "").trim(); } catch { /* Answered below. */ }
    if (!request) { this.output(callId, "No request was given. Ask the person what they need."); return; }
    const requestId = this.host.newId();
    this.following++;
    this.host.phase("working");
    let answered = false;
    const hear = (answer: TalkAnswer) => {
      for (const id of answer.progress?.ids ?? []) { this.heard.delete(id); this.heard.add(id); }
      for (const id of this.heard) { if (this.heard.size <= MAX_HEARD_LINES) break; this.heard.delete(id); }
    };
    try {
      let answer = await this.host.ask(requestId, request, this.abort.signal, [...this.heard]);
      if (this.disposed) return;
      hear(answer);
      this.output(callId, this.spoken(answer));
      answered = true;
      const started = this.now();
      let told = answer.state;
      // Keep asking with the same ID until it is final; nothing is sent twice.
      while (!finalTalkStates.includes(answer.state) && this.now() - started < MAX_FOLLOW_MS) {
        await this.pause(answer.state === "working" ? FOLLOW_MS : DECISION_FOLLOW_MS);
        if (this.disposed) return;
        answer = await this.host.ask(requestId, request, this.abort.signal, [...this.heard]);
        if (this.disposed) return;
        hear(answer);
        if (finalTalkStates.includes(answer.state) || answer.state !== told && answer.state !== "working") {
          this.say(`About the earlier request "${request.slice(0, 200)}": ${this.spoken(answer)} Tell the person now, briefly.`);
          told = answer.state;
        } else this.narrate(requestId, request, answer);
      }
    } catch (error) {
      if (this.disposed) return;
      const message = error instanceof Error ? error.message : "The request could not be sent.";
      const text = `The request could not reach ${this.name}: ${message} Tell the person, and suggest typing it in the chat.`;
      // A call is answered once; a failure while following up is said as a new message.
      if (answered) this.say(text); else this.output(callId, text);
    } finally {
      // A request that ends, with its answer or a failure, leaves no held line: it would only be old news.
      this.held.delete(requestId);
      this.following--;
    }
  }
}
