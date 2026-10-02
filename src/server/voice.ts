import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Runtime } from "../shared/types.js";
import type { VoiceAudio, VoiceTranscript } from "../shared/voice.js";
import { MAX_SPOKEN_TEXT, MAX_VOICE_BYTES, VOICE_MIMES } from "../shared/voice.js";
import { signedIn } from "./auth.js";

type VoiceRuntime = Runtime & {
  transcribeVoice?(botId: string, input: { mime: string; data: Buffer }): Promise<VoiceTranscript>;
  synthesizeVoice?(botId: string, text: string): Promise<VoiceAudio>;
};
const failure = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const botParams = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/) });
const AUDIO_TTL = 5 * 60_000;
const MAX_CACHED_AUDIO = 32 * 1024 * 1024;

/** Install after authentication and multipart plugins. Audio never becomes a shared artifact. */
export async function registerVoiceRoutes(app: FastifyInstance, runtime: VoiceRuntime, options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const audio = new Map<string, { userId: string; botId: string; expires: number; data: Buffer; mime: string }>();
  const busy = new Set<string>();
  const prune = () => { for (const [key, entry] of audio) if (entry.expires <= now()) audio.delete(key); };
  const cleanup = setInterval(prune, 30_000); cleanup.unref();
  app.addHook("onClose", async () => { clearInterval(cleanup); audio.clear(); });
  const checkBot = async (req: FastifyRequest, botId: string) => {
    signedIn(req);
    if (!(await runtime.listBots()).some(bot => bot.id === botId)) throw failure(404, "This assistant is no longer available.");
  };
  const operation = async <T>(req: FastifyRequest, fn: () => Promise<T>) => {
    const key = signedIn(req).id;
    if (busy.has(key)) throw failure(429, "A voice request is already running. Wait for it to finish.");
    busy.add(key);
    try { return await fn(); } finally { busy.delete(key); }
  };
  app.post("/api/bots/:id/voice/transcribe", async (req, reply) => {
    const botId = botParams.parse(req.params).id;
    await checkBot(req, botId);
    if (!runtime.transcribeVoice) throw failure(409, "Voice transcription is unavailable on this Hermes connection.");
    return operation(req, async () => {
      let input: { data: Buffer; mime: string } | undefined;
      // Consume the complete multipart body before paying for transcription, so
      // extra files/fields cannot sneak past the first-file convenience API.
      for await (const part of req.parts({ limits: { fileSize: MAX_VOICE_BYTES, files: 1, fields: 0, parts: 1 } })) {
        if (part.type !== "file") throw failure(400, "Send one audio recording without extra fields.");
        const mime = part.mimetype.split(";", 1)[0]!.trim().toLowerCase();
        if (!VOICE_MIMES.has(mime)) { part.file.resume(); throw failure(415, "Choose a WebM, Ogg, WAV, MP4, AAC, MP3 or FLAC audio recording."); }
        const data = await part.toBuffer();
        if (part.file.truncated || data.length > MAX_VOICE_BYTES) throw failure(413, "Audio recordings must be 8 MB or smaller.");
        if (!data.length) throw failure(400, "This audio recording is empty.");
        input = { data, mime };
      }
      if (!input) throw failure(400, "Choose an audio recording.");
      const result = await runtime.transcribeVoice!(botId, input);
      if (typeof result.text !== "string" || result.text.length > 50000) throw failure(502, "Hermes returned an invalid transcript.");
      return reply.header("Cache-Control", "private, no-store").send({ text: result.text.trim(), ...(typeof result.provider === "string" ? { provider: result.provider } : {}) });
    });
  });
  app.post("/api/bots/:id/voice/speak", async (req, reply) => {
    const botId = botParams.parse(req.params).id;
    const { messageId } = z.object({ messageId: z.string().min(1).max(300) }).strict().parse(req.body);
    await checkBot(req, botId);
    if (!runtime.synthesizeVoice) throw failure(409, "Spoken replies are unavailable on this Hermes connection.");
    return operation(req, async () => {
      const message = (await runtime.conversation(botId)).messages.find(item => item.id === messageId && item.role === "assistant");
      if (!message?.text.trim()) throw failure(404, "Choose a completed assistant reply to listen to.");
      if (message.id.endsWith("-inflight")) throw failure(409, "Wait for this assistant reply to finish before listening.");
      if (message.text.length > MAX_SPOKEN_TEXT) throw failure(400, "This reply is too long to read aloud. Ask for a shorter summary.");
      const result = await runtime.synthesizeVoice!(botId, message.text);
      const mime = result.mime.split(";", 1)[0]!.trim().toLowerCase();
      if (!VOICE_MIMES.has(mime) || !Buffer.isBuffer(result.data) || !result.data.length || result.data.length > MAX_VOICE_BYTES)
        throw failure(502, "Hermes did not return a supported audio reply under 8 MB.");
      prune();
      const userId = signedIn(req).id;
      for (const [key, entry] of audio) if (entry.userId === userId) audio.delete(key);
      let total = [...audio.values()].reduce((sum, entry) => sum + entry.data.length, 0);
      for (const [key, entry] of audio) { if (total + result.data.length <= MAX_CACHED_AUDIO) break; total -= entry.data.length; audio.delete(key); }
      const key = randomUUID(), expires = now() + AUDIO_TTL;
      audio.set(key, { userId, botId, data: result.data, mime, expires });
      return reply.header("Cache-Control", "private, no-store").send({ url: `/api/voice/audio/${key}`, mime, expiresAt: new Date(expires).toISOString() });
    });
  });
  app.get("/api/voice/audio/:audioId", async (req, reply) => {
    const userId = signedIn(req).id;
    const { audioId } = z.object({ audioId: z.string().uuid() }).parse(req.params);
    prune();
    const entry = audio.get(audioId);
    if (!entry || entry.userId !== userId) throw failure(404, "This audio reply expired. Request speech again.");
    audio.delete(audioId);
    await checkBot(req, entry.botId);
    return reply.header("Cache-Control", "private, no-store").header("Content-Disposition", 'inline; filename="reply.audio"').type(entry.mime).send(entry.data);
  });
}
