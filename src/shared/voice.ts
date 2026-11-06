export type VoiceState = "idle" | "requesting" | "recording" | "transcribing";
export interface VoiceTranscript { text: string; provider?: string }
export interface VoiceAudio { data: Buffer; mime: string; provider?: string }
export interface VoicePlayback { url: string; mime: string; expiresAt: string }
export const MAX_VOICE_BYTES = 8 * 1024 * 1024;
export const MAX_RECORDING_SECONDS = 120;
export const MAX_SPOKEN_TEXT = 12000;
export const VOICE_MIMES = new Set([
  "audio/webm", "video/webm", "audio/ogg", "audio/wav", "audio/wave", "audio/x-wav",
  "audio/mp4", "audio/m4a", "audio/x-m4a", "audio/aac", "audio/mpeg", "audio/mp3", "audio/flac",
]);
/** Window event the composer sends when recording starts, so a reply being read aloud stops. */
export const STOP_SPEECH = "agent-interface:stop-speech";

/** Live Talk: a duplex voice conversation through the OpenAI Realtime API. src/hermes/voice.py VOICES must match. */
export const TALK_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar"] as const;
export type TalkVoice = (typeof TALK_VOICES)[number];
export const DEFAULT_TALK_VOICE: TalkVoice = "marin";
export const TALK_MODEL = "gpt-realtime-2.1";
export const isTalkVoice = (value: unknown): value is TalkVoice => (TALK_VOICES as readonly unknown[]).includes(value);
/** The one tool the voice model calls: the person's request, in their words, for the assistant to handle. */
export const TALK_TOOL = "ask_assistant";
/** Spoken answers longer than this are cut at a sentence; the full reply stays in the chat. */
export const MAX_TALK_ANSWER = 4000;
/** A short-lived browser credential for one Realtime call. */
export interface TalkSession { clientSecret: string; expiresAt: number; model: string; voice: TalkVoice }
/** Where the assistant is with one spoken request. `done`, `interrupted` and `refused` are final; the others mean ask again with the same request ID. */
export type TalkState = "done" | "working" | "needsApproval" | "needsAnswer" | "interrupted" | "refused";
export const finalTalkStates: readonly TalkState[] = ["done", "interrupted", "refused"];
export interface TalkAnswer { state: TalkState; text?: string }
