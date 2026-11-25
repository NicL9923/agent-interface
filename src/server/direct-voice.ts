import type { RealtimeSessionInput } from "../shared/types.js";
import {
  DEFAULT_TALK_VOICE,
  GROK_TALK_MODEL,
  GROK_TALK_WS_URL,
  MAX_SPOKEN_TEXT,
  MAX_VOICE_BYTES,
  TALK_MODEL,
  VOICE_MIMES,
  isGrokTalkVoice,
  isOpenAiTalkVoice,
  type TalkSession,
  type TalkVoice,
  type VoiceAudio,
  type VoiceTranscript,
} from "../shared/voice.js";
import { httpError } from "./http-error.js";

/**
 * Live Talk, transcription and spoken replies straight from OpenAI with the household's API key, so they work
 * without Hermes or its voice plugin. The key never leaves this server: the browser gets only a short-lived
 * Realtime client secret, and every OpenAI failure becomes a fixed sentence with at most the HTTP status.
 */
export interface DirectVoiceOptions {
  /** Defaults to OPENAI_API_KEY in `env`. Blank means unconfigured. */
  apiKey?: string;
  /** Defaults to https://api.openai.com. Tests point it at a loopback server. */
  baseUrl?: string;
  realtimeModel?: string;
  sttModel?: string;
  ttsModel?: string;
  fetch?: typeof fetch;
  /** How long one OpenAI request may take. */
  timeoutMs?: number;
  /** How long a minted Realtime secret lives, in seconds. OpenAI accepts 10 to 7200. */
  secretTtlSeconds?: number;
  env?: Record<string, string | undefined>;
}

export type DirectVoiceStatus = { available: true } | { available: false; reason: string };

export interface DirectVoiceService {
  status(): DirectVoiceStatus;
  realtimeSession(input: RealtimeSessionInput): Promise<TalkSession>;
  transcribeVoice(botId: string, input: { mime: string; data: Buffer }): Promise<VoiceTranscript>;
  synthesizeVoice(botId: string, text: string, voice?: TalkVoice): Promise<VoiceAudio>;
}

export const DIRECT_VOICE_UNCONFIGURED = "Configure OPENAI_API_KEY to enable Live Talk and voice.";
const DEFAULT_BASE_URL = "https://api.openai.com";
const DEFAULT_STT_MODEL = "gpt-4o-mini-transcribe";
const DEFAULT_TTS_MODEL = "gpt-4o-mini-tts";
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_SECRET_TTL = 600;
// The same limits the Hermes voice plugin applies (src/hermes/voice.py), so both paths accept one request shape.
const MAX_INSTRUCTIONS = 6000;
const MAX_TOOLS = 4;
const MAX_TOOLS_JSON = 8 * 1024;
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_TRANSCRIPT = 50_000;

const EXTENSIONS: Record<string, string> = {
  "audio/webm": "webm",
  "video/webm": "webm",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/wave": "wav",
  "audio/x-wav": "wav",
  "audio/mp4": "mp4",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/flac": "flac",
};

/** OpenAI's answer as a fixed sentence: never its body, which can echo the request or name the key. */
function upstreamError(status: number) {
  if (status === 401 || status === 403)
    return httpError(502, "OpenAI refused the configured API key. Check OPENAI_API_KEY.", {
      expose: true,
    });
  if (status === 429)
    return httpError(503, "OpenAI is limiting voice requests right now. Try again shortly.", {
      expose: true,
    });
  return httpError(502, `OpenAI could not handle the voice request (HTTP ${status}).`, {
    expose: true,
  });
}

function validateSession(
  input: RealtimeSessionInput,
  allowedVoice: (voice: unknown) => boolean = isOpenAiTalkVoice,
) {
  if (!allowedVoice(input.voice)) throw httpError(400, "Choose one of the supported voices.");
  if (
    typeof input.instructions !== "string" ||
    !input.instructions.trim() ||
    input.instructions.length > MAX_INSTRUCTIONS
  )
    throw httpError(400, `Voice instructions must be 1 to ${MAX_INSTRUCTIONS} characters.`);
  const tools = input.tools ?? [];
  if (
    !Array.isArray(tools) ||
    tools.length > MAX_TOOLS ||
    JSON.stringify(tools).length > MAX_TOOLS_JSON
  )
    throw httpError(400, `Send at most ${MAX_TOOLS} small function tools.`);
  for (const tool of tools)
    if (
      tool?.type !== "function" ||
      typeof tool.name !== "string" ||
      !TOOL_NAME.test(tool.name) ||
      typeof tool.description !== "string" ||
      tool.description.length > 1000 ||
      typeof tool.parameters !== "object" ||
      tool.parameters === null ||
      tool.parameters.type !== "object"
    )
      throw httpError(400, "Each voice tool must be a named function with an object schema.");
  return tools;
}

/** The secret's value and expiry, whether OpenAI nests them under `client_secret` or not. */
function readSecret(payload: unknown) {
  const outer = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const nested = outer.client_secret;
  const source = (nested && typeof nested === "object" ? nested : outer) as Record<string, unknown>;
  const { value, expires_at: expires } = source;
  if (typeof value !== "string" || value.length < 8 || value.length > 4096 || /\s/.test(value))
    return undefined;
  if (typeof expires !== "number" || !Number.isSafeInteger(expires) || expires <= 0)
    return undefined;
  return { value, expiresAt: expires };
}

export function createDirectVoiceService(options: DirectVoiceOptions = {}): DirectVoiceService {
  const apiKey = (options.apiKey ?? (options.env ?? process.env).OPENAI_API_KEY ?? "").trim();
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const realtimeModel = options.realtimeModel ?? TALK_MODEL;
  const sttModel = options.sttModel ?? DEFAULT_STT_MODEL;
  const ttsModel = options.ttsModel ?? DEFAULT_TTS_MODEL;
  const fetcher = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const secretTtl = options.secretTtlSeconds ?? DEFAULT_SECRET_TTL;

  const configured = () => {
    if (!apiKey) throw httpError(409, DIRECT_VOICE_UNCONFIGURED);
  };

  /** One OpenAI call. Resolves only on a 2xx; the response body is read inside the same timeout. */
  async function call<T>(
    path: string,
    init: { body: string | FormData; json?: boolean },
    read: (response: Response) => Promise<T>,
  ): Promise<T> {
    configured();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetcher(`${baseUrl}${path}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            ...(init.json ? { "Content-Type": "application/json" } : {}),
          },
          body: init.body,
          signal: controller.signal,
        });
      } catch {
        throw controller.signal.aborted
          ? httpError(504, "OpenAI did not answer the voice request in time. Try again.", {
              expose: true,
            })
          : httpError(502, "WildBots could not reach OpenAI for voice. Try again.", {
              expose: true,
            });
      }
      if (!response.ok) {
        // Drain without reading the body into anything that could be logged or returned.
        await response.body?.cancel().catch(() => undefined);
        throw upstreamError(response.status);
      }
      try {
        return await read(response);
      } catch (error) {
        if (error && typeof error === "object" && "statusCode" in error) throw error;
        throw httpError(502, "OpenAI returned an unreadable voice reply.", { expose: true });
      }
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    status() {
      return apiKey ? { available: true } : { available: false, reason: DIRECT_VOICE_UNCONFIGURED };
    },

    async realtimeSession(input) {
      configured();
      const tools = validateSession(input);
      const session = {
        type: "realtime",
        model: realtimeModel,
        instructions: input.instructions,
        audio: {
          input: {
            noise_reduction: { type: "near_field" },
            turn_detection: {
              type: "semantic_vad",
              eagerness: "auto",
              create_response: true,
              interrupt_response: true,
            },
            transcription: { model: sttModel },
          },
          output: { voice: input.voice },
        },
        tools,
        tool_choice: "auto",
      };
      const secret = await call(
        "/v1/realtime/client_secrets",
        {
          json: true,
          body: JSON.stringify({
            expires_after: { anchor: "created_at", seconds: secretTtl },
            session,
          }),
        },
        async (response) => readSecret(await response.json()),
      );
      if (!secret)
        throw httpError(502, "OpenAI returned an unreadable voice session.", { expose: true });
      return {
        clientSecret: secret.value,
        expiresAt: secret.expiresAt,
        model: realtimeModel,
        voice: input.voice,
      };
    },

    async transcribeVoice(_botId, input) {
      configured();
      const mime = input.mime.split(";", 1)[0]!.trim().toLowerCase();
      if (!VOICE_MIMES.has(mime))
        throw httpError(415, "Choose a WebM, Ogg, WAV, MP4, AAC, MP3 or FLAC audio recording.");
      if (!input.data.length) throw httpError(400, "This audio recording is empty.");
      if (input.data.length > MAX_VOICE_BYTES)
        throw httpError(413, "Audio recordings must be 8 MB or smaller.");
      const form = new FormData();
      form.append("model", sttModel);
      form.append("response_format", "json");
      form.append(
        "file",
        new Blob([new Uint8Array(input.data)], { type: mime }),
        `recording.${EXTENSIONS[mime] ?? "webm"}`,
      );
      const text = await call("/v1/audio/transcriptions", { body: form }, async (response) => {
        const value = (await response.json()) as { text?: unknown } | null;
        return value?.text;
      });
      if (typeof text !== "string" || text.length > MAX_TRANSCRIPT)
        throw httpError(502, "OpenAI returned an invalid transcript.", { expose: true });
      return { text: text.trim(), provider: "openai" };
    },

    async synthesizeVoice(_botId, text, voice = DEFAULT_TALK_VOICE) {
      configured();
      const input = text.trim();
      if (!input) throw httpError(400, "Choose a reply with text to read aloud.");
      if (input.length > MAX_SPOKEN_TEXT)
        throw httpError(400, "This reply is too long to read aloud. Ask for a shorter summary.");
      if (!isOpenAiTalkVoice(voice)) throw httpError(400, "Choose one of the supported voices.");
      const data = await call(
        "/v1/audio/speech",
        {
          json: true,
          body: JSON.stringify({ model: ttsModel, input, voice, response_format: "mp3" }),
        },
        async (response) => {
          const declared = Number(response.headers.get("content-length"));
          if (declared > MAX_VOICE_BYTES) {
            await response.body?.cancel().catch(() => undefined);
            return undefined;
          }
          return Buffer.from(await response.arrayBuffer());
        },
      );
      if (!data?.length || data.length > MAX_VOICE_BYTES)
        throw httpError(502, "OpenAI did not return a supported audio reply under 8 MB.", {
          expose: true,
        });
      return { data, mime: "audio/mpeg", provider: "openai" };
    },
  };
}

export interface GrokVoiceOptions {
  /** Defaults to XAI_API_KEY in `env`. Blank means unconfigured. */
  apiKey?: string;
  /** Defaults to https://api.x.ai. Tests point it at a loopback server. */
  baseUrl?: string;
  /** Defaults to wss://api.x.ai/v1/realtime. */
  wsBaseUrl?: string;
  realtimeModel?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** How long a minted xAI Realtime secret lives, in seconds. */
  secretTtlSeconds?: number;
  env?: Record<string, string | undefined>;
}

export interface GrokVoiceService {
  status(): DirectVoiceStatus;
  realtimeSession(input: RealtimeSessionInput): Promise<TalkSession>;
}

export const GROK_VOICE_UNCONFIGURED = "Configure XAI_API_KEY to enable Grok Voice.";
const DEFAULT_XAI_BASE_URL = "https://api.x.ai";
const DEFAULT_XAI_SECRET_TTL = 300;

function xaiUpstreamError(status: number) {
  if (status === 401 || status === 403)
    return httpError(502, "xAI refused the configured API key. Check XAI_API_KEY.", {
      expose: true,
    });
  if (status === 429)
    return httpError(503, "xAI is limiting Grok Voice requests right now. Try again shortly.", {
      expose: true,
    });
  return httpError(502, `xAI could not handle the Grok Voice request (HTTP ${status}).`, {
    expose: true,
  });
}

/**
 * Live Talk through xAI's Grok Voice Agent API (`wss://api.x.ai/v1/realtime`).
 * The master `XAI_API_KEY` never leaves this server: clients receive a short-lived client secret
 * and the validated `session.update` payload to send once the WebSocket opens.
 */
export function createGrokVoiceService(options: GrokVoiceOptions = {}): GrokVoiceService {
  const apiKey = (options.apiKey ?? (options.env ?? process.env).XAI_API_KEY ?? "").trim();
  const baseUrl = (options.baseUrl ?? DEFAULT_XAI_BASE_URL).replace(/\/+$/, "");
  const wsBaseUrl = (options.wsBaseUrl ?? GROK_TALK_WS_URL).replace(/\/+$/, "");
  const realtimeModel = options.realtimeModel ?? GROK_TALK_MODEL;
  const fetcher = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const secretTtl = options.secretTtlSeconds ?? DEFAULT_XAI_SECRET_TTL;

  const configured = () => {
    if (!apiKey) throw httpError(409, GROK_VOICE_UNCONFIGURED);
  };

  return {
    status() {
      return apiKey ? { available: true } : { available: false, reason: GROK_VOICE_UNCONFIGURED };
    },

    async realtimeSession(input) {
      configured();
      const tools = validateSession(input, isGrokTalkVoice);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let secret: { value: string; expiresAt: number } | undefined;
      try {
        let response: Response;
        try {
          response = await fetcher(`${baseUrl}/v1/realtime/client_secrets`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ expires_after: { seconds: secretTtl } }),
            signal: controller.signal,
          });
        } catch {
          throw controller.signal.aborted
            ? httpError(504, "xAI did not answer the Grok Voice request in time. Try again.", {
                expose: true,
              })
            : httpError(502, "WildBots could not reach xAI for Grok Voice. Try again.", {
                expose: true,
              });
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          throw xaiUpstreamError(response.status);
        }
        try {
          secret = readSecret(await response.json());
        } catch {
          throw httpError(502, "xAI returned an unreadable Grok Voice session.", { expose: true });
        }
      } finally {
        clearTimeout(timer);
      }
      if (!secret)
        throw httpError(502, "xAI returned an unreadable Grok Voice session.", { expose: true });
      const sessionUpdate: Record<string, unknown> = {
        type: "session.update",
        session: {
          voice: input.voice,
          instructions: input.instructions,
          turn_detection: { type: "server_vad" },
          audio: {
            input: { format: { type: "audio/pcm", rate: 24000 } },
            output: { format: { type: "audio/pcm", rate: 24000 } },
          },
          tools,
        },
      };
      return {
        clientSecret: secret.value,
        expiresAt: secret.expiresAt,
        model: realtimeModel,
        voice: input.voice,
        provider: "xai",
        wsUrl: `${wsBaseUrl}?model=${encodeURIComponent(realtimeModel)}`,
        sessionUpdate,
        sessionUpdateJson: JSON.stringify(sessionUpdate),
      };
    },
  };
}
