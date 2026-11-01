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
