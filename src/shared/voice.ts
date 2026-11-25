export type VoiceState = "idle" | "requesting" | "recording" | "transcribing";
export interface VoiceTranscript {
  text: string;
  provider?: string;
}
export interface VoiceAudio {
  data: Buffer;
  mime: string;
  provider?: string;
}
export interface VoicePlayback {
  url: string;
  mime: string;
  expiresAt: string;
}
export const MAX_VOICE_BYTES = 8 * 1024 * 1024;
export const MAX_RECORDING_SECONDS = 120;
export const MAX_SPOKEN_TEXT = 12000;
export const VOICE_MIMES = new Set([
  "audio/webm",
  "video/webm",
  "audio/ogg",
  "audio/wav",
  "audio/wave",
  "audio/x-wav",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "audio/aac",
  "audio/mpeg",
  "audio/mp3",
  "audio/flac",
]);
/** Window event the composer sends when recording starts, so a reply being read aloud stops. */
export const STOP_SPEECH = "agent-interface:stop-speech";

/** Live Talk: OpenAI Realtime voices. src/hermes/voice.py VOICES must match TALK_VOICES. */
export const TALK_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "sage",
  "shimmer",
  "verse",
  "marin",
  "cedar",
] as const;
export type OpenAiTalkVoice = (typeof TALK_VOICES)[number];
/** Live Talk: xAI Grok Voice Agent API built-in voices. */
export const GROK_TALK_VOICES = ["eve", "ara", "rex", "sal", "leo"] as const;
export type GrokTalkVoice = (typeof GROK_TALK_VOICES)[number];
export const ALL_TALK_VOICES = [...TALK_VOICES, ...GROK_TALK_VOICES] as const;
export type TalkVoice = (typeof ALL_TALK_VOICES)[number];
export const TALK_PROVIDERS = ["openai", "xai"] as const;
export type TalkProvider = (typeof TALK_PROVIDERS)[number];
export const DEFAULT_TALK_VOICE: OpenAiTalkVoice = "marin";
export const DEFAULT_GROK_TALK_VOICE: GrokTalkVoice = "eve";
export const TALK_MODEL = "gpt-realtime-2.1";
export const GROK_TALK_MODEL = "grok-voice-latest";
export const GROK_TALK_WS_URL = "wss://api.x.ai/v1/realtime";
export const isOpenAiTalkVoice = (value: unknown): value is OpenAiTalkVoice =>
  (TALK_VOICES as readonly unknown[]).includes(value);
export const isGrokTalkVoice = (value: unknown): value is GrokTalkVoice =>
  (GROK_TALK_VOICES as readonly unknown[]).includes(value);
export const isTalkVoice = (value: unknown): value is TalkVoice =>
  (ALL_TALK_VOICES as readonly unknown[]).includes(value);
export const talkProviderForVoice = (voice: TalkVoice | undefined): TalkProvider =>
  isGrokTalkVoice(voice) ? "xai" : "openai";
/** The one tool the voice model calls: the person's request, in their words, for the assistant to handle. */
export const TALK_TOOL = "ask_assistant";
/** Spoken answers longer than this are cut at a sentence; the full reply stays in the chat. */
export const MAX_TALK_ANSWER = 4000;
/** A short-lived browser credential for one Realtime call. */
export interface TalkSession {
  clientSecret: string;
  expiresAt: number;
  model: string;
  voice: TalkVoice;
  /** Live Talk provider. Omitted by older servers (defaults to "openai"). */
  provider?: TalkProvider;
  /** WebSocket endpoint for WebSocket-based Realtime providers such as Grok Voice. */
  wsUrl?: string;
  /** Initial `session.update` event sent right after opening a Grok Voice WebSocket. */
  sessionUpdate?: Record<string, unknown>;
  /** JSON-encoded `session.update` payload for clients that prefer raw wire text (such as iOS). */
  sessionUpdateJson?: string;
}
/** Where the assistant is with one spoken request. `done`, `interrupted` and `refused` are final; the others mean ask again with the same request ID. */
export type TalkState =
  | "done"
  | "working"
  | "needsApproval"
  | "needsAnswer"
  | "interrupted"
  | "refused";
export const finalTalkStates: readonly TalkState[] = ["done", "interrupted", "refused"];
/**
 * What a working assistant has newly said it is doing. `ids` names every new progress line, so the client
 * can report them as heard, and `text` is the newest one, plain and short enough to say aloud.
 */
export interface TalkProgress {
  ids: string[];
  text: string;
}
/** `progress` rides on a `working` answer, which the server returns as soon as a new line exists. */
export interface TalkAnswer {
  state: TalkState;
  text?: string;
  progress?: TalkProgress;
}
/**
 * Progress line IDs a client reports as heard, so the server returns only new ones. A client keeps the
 * newest this many, and the server refuses more, so a long run cannot make its own next ask invalid.
 */
export const MAX_HEARD_LINES = 500;
/** A progress line is spoken whole when it fits, else cut at a sentence. Nothing points to the chat: it is not the answer. */
export const MAX_TALK_PROGRESS = 280;
