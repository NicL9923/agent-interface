import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, request } from "../client-api";
import { GROK_TALK_WS_URL, STOP_SPEECH } from "../shared/voice";
import { setTalkLive } from "./talk-live";
import { TalkLoop, type TalkCaptions, type TalkPhase } from "./talk-loop";

const PCM_SAMPLE_RATE = 24_000;

function downsampleToPcm16(input: Float32Array, inputRate: number): Uint8Array {
  const ratio = inputRate / PCM_SAMPLE_RATE;
  const length = Math.max(1, Math.floor(input.length / ratio));
  const bytes = new Uint8Array(length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.max(start + 1, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j]!;
    const sample = Math.max(-1, Math.min(1, sum / (end - start)));
    view.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

function base64ToPcmFloats(encoded: string): Float32Array {
  const binary = atob(encoded);
  const count = Math.floor(binary.length / 2);
  const floats = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const lo = binary.charCodeAt(i * 2);
    const hi = binary.charCodeAt(i * 2 + 1);
    const raw = lo | (hi << 8);
    const signed = raw >= 0x8000 ? raw - 0x10000 : raw;
    floats[i] = signed / 0x8000;
  }
  return floats;
}

export type TalkStatus = "idle" | "connecting" | TalkPhase;
export interface Talk {
  status: TalkStatus;
  captions: TalkCaptions;
  muted: boolean;
  /** Why Talk could not start or stopped. It stays until the next start or dismiss. */
  error: string;
  /** Why Talk ended by itself, such as a quiet spell. */
  notice: string;
  start(): void;
  end: () => void;
  toggleMute: () => void;
  dismiss: () => void;
  /** Shows why Talk cannot start, without starting it. */
  explain(message: string): void;
}
const CALLS_URL = "https://api.openai.com/v1/realtime/calls";
export const TALK_IDLE_MS = 5 * 60_000;
export const TALK_MAX_MS = 30 * 60_000;
const empty: TalkCaptions = { you: "", assistant: "" };
// A phone stops a hidden page's audio and timers unpredictably, so Talk ends with it there.
const phone = () =>
  typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;

function microphoneError(error: unknown) {
  const name = error instanceof DOMException ? error.name : "";
  return name === "NotAllowedError"
    ? "Microphone permission was denied. Allow it in your browser settings, then start Talk again."
    : name === "NotFoundError"
      ? "No microphone was found. Connect one, then start Talk again."
      : "The microphone could not start. Close other apps using it, then try again.";
}

/**
 * A live duplex voice conversation with one assistant over WebRTC. The server mints a short-lived
 * secret; the browser sends its offer straight to OpenAI. Everything is released when Talk ends,
 * the assistant changes, the view closes or the page goes away.
 */
export function useTalk(botId: string, name: string): Talk {
  const [status, setStatus] = useState<TalkStatus>("idle");
  const [captions, setCaptions] = useState<TalkCaptions>(empty);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const generation = useRef(0);
  const parts = useRef<{
    pc?: RTCPeerConnection;
    channel?: RTCDataChannel;
    socket?: WebSocket;
    audioContext?: AudioContext;
    processor?: ScriptProcessorNode;
    sourceNode?: MediaStreamAudioSourceNode;
    playingNodes?: Set<AudioBufferSourceNode>;
    nextPlayTime?: number;
    muted?: boolean;
    stream?: MediaStream;
    audio?: HTMLAudioElement;
    loop?: TalkLoop;
    timer?: ReturnType<typeof setInterval>;
    live?: boolean;
    started: number;
    heard: number;
  }>({ started: 0, heard: 0 });

  const release = useCallback(() => {
    generation.current++;
    const current = parts.current;
    current.loop?.dispose();
    clearInterval(current.timer);
    if (current.channel) {
      current.channel.onmessage = current.channel.onclose = null;
      current.channel.close();
    }
    if (current.socket) {
      current.socket.onopen =
        current.socket.onmessage =
        current.socket.onclose =
        current.socket.onerror =
          null;
      current.socket.close();
    }
    if (current.playingNodes) {
      for (const node of current.playingNodes) {
        try {
          node.stop();
        } catch {
          /* Already ended. */
        }
      }
      current.playingNodes.clear();
    }
    if (current.processor) {
      current.processor.onaudioprocess = null;
      current.processor.disconnect();
    }
    current.sourceNode?.disconnect();
    if (current.audioContext) void current.audioContext.close().catch(() => {});
    if (current.pc) {
      current.pc.onconnectionstatechange = current.pc.ontrack = null;
      current.pc.close();
    }
    current.stream?.getTracks().forEach((track) => track.stop());
    if (current.audio) {
      current.audio.pause();
      current.audio.srcObject = null;
    }
    parts.current = { started: 0, heard: 0 };
    setTalkLive(false);
    setStatus("idle");
    setMuted(false);
  }, []);
  const end = useCallback(
    (why = "") => {
      release();
      setNotice(why);
    },
    [release],
  );
  const fail = useCallback(
    (message: string) => {
      release();
      setError(message);
    },
    [release],
  );

  const start = useCallback(async () => {
    if (parts.current.live) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === "undefined") {
      setError(
        "Talk needs a browser with microphone and WebRTC support over a secure connection. You can still type or record.",
      );
      return;
    }
    const run = ++generation.current;
    const stale = () => generation.current !== run;
    // The microphone and speaker now belong to Talk: no recording, no reply read aloud.
    window.dispatchEvent(new Event(STOP_SPEECH));
    setTalkLive(true);
    setError("");
    setNotice("");
    setCaptions(empty);
    setStatus("connecting");
    const current = parts.current;
    current.live = true;
    try {
      try {
        current.stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
        });
      } catch (cause) {
        if (!stale()) fail(microphoneError(cause));
        return;
      }
      if (stale()) {
        current.stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const session = await request("POST /bots/:id/talk/session", { params: { id: botId } });
      if (stale()) return;
      const startLimits = () => {
        current.started = current.heard = Date.now();
        current.timer = setInterval(() => {
          const now = Date.now();
          if (now - current.started >= TALK_MAX_MS)
            end("Talk ended after 30 minutes. Start it again to keep talking.");
          else if (now - current.heard >= TALK_IDLE_MS) end("Talk ended after five quiet minutes.");
        }, 10_000);
      };
      if (session.provider === "xai" || session.wsUrl) {
        if (typeof WebSocket === "undefined" || typeof AudioContext === "undefined") {
          fail("Grok Voice needs a browser with WebSocket and Web Audio support.");
          return;
        }
        const wsUrl =
          session.wsUrl ?? `${GROK_TALK_WS_URL}?model=${encodeURIComponent(session.model)}`;
        const socket = (current.socket = new WebSocket(wsUrl, [
          `xai-client-secret.${session.clientSecret}`,
        ]));
        const playingNodes = (current.playingNodes = new Set<AudioBufferSourceNode>());
        current.nextPlayTime = 0;
        const stopPlayback = () => {
          for (const node of playingNodes) {
            try {
              node.stop();
            } catch {
              /* Already ended. */
            }
          }
          playingNodes.clear();
          current.nextPlayTime = 0;
        };
        const loop = (current.loop = new TalkLoop(
          {
            send: (event) => {
              if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
            },
            ask: (requestId, text, signal, heard) =>
              request("POST /bots/:id/talk/ask", {
                params: { id: botId },
                body: { requestId, request: text, ...(heard.length ? { heard: [...heard] } : {}) },
                signal,
              }),
            phase: (phase) => {
              if (!stale()) setStatus(phase);
            },
            captions: (next) => {
              if (!stale()) setCaptions(next);
            },
            activity: () => {
              current.heard = Date.now();
            },
            problem: (message) => {
              if (!stale()) setError(message);
            },
            newId: () => crypto.randomUUID(),
          },
          name,
        ));
        socket.onopen = () => {
          if (stale()) return;
          if (session.sessionUpdateJson) socket.send(session.sessionUpdateJson);
          else if (session.sessionUpdate) socket.send(JSON.stringify(session.sessionUpdate));
          const ctx = (current.audioContext = new AudioContext({ sampleRate: PCM_SAMPLE_RATE }));
          void ctx.resume().catch(() => {});
          const source = (current.sourceNode = ctx.createMediaStreamSource(current.stream!));
          const processor = (current.processor = ctx.createScriptProcessor(2048, 1, 1));
          processor.onaudioprocess = (audioEvent) => {
            if (stale() || current.muted || socket.readyState !== WebSocket.OPEN) return;
            const samples = audioEvent.inputBuffer.getChannelData(0);
            const pcm = downsampleToPcm16(samples, ctx.sampleRate);
            socket.send(
              JSON.stringify({ type: "input_audio_buffer.append", audio: bytesToBase64(pcm) }),
            );
          };
          source.connect(processor);
          processor.connect(ctx.destination);
          setStatus("listening");
          startLimits();
        };
        socket.onmessage = (event) => {
          if (stale()) return;
          try {
            const parsed = JSON.parse(String(event.data)) as {
              type?: unknown;
              delta?: unknown;
              [key: string]: unknown;
            };
            if (parsed.type === "input_audio_buffer.speech_started") stopPlayback();
            if (
              (parsed.type === "response.output_audio.delta" ||
                parsed.type === "response.audio.delta") &&
              typeof parsed.delta === "string" &&
              current.audioContext
            ) {
              const ctx = current.audioContext;
              const floats = base64ToPcmFloats(parsed.delta);
              if (floats.length > 0) {
                const buffer = ctx.createBuffer(1, floats.length, PCM_SAMPLE_RATE);
                buffer.getChannelData(0).set(floats);
                const node = ctx.createBufferSource();
                node.buffer = buffer;
                node.connect(ctx.destination);
                const at = Math.max(ctx.currentTime, current.nextPlayTime ?? 0);
                node.start(at);
                current.nextPlayTime = at + buffer.duration;
                playingNodes.add(node);
                node.onended = () => playingNodes.delete(node);
              }
            }
            loop.handle(parsed);
          } catch {
            /* A malformed event changes nothing. */
          }
        };
        socket.onerror = () => {
          if (!stale())
            fail(
              "Could not reach xAI for Grok Voice. Check your connection, then start Talk again.",
            );
        };
        socket.onclose = () => {
          if (!stale()) fail("The Grok Voice connection closed. Start Talk again.");
        };
        return;
      }
      const pc = (current.pc = new RTCPeerConnection());
      const audio = (current.audio = new Audio());
      audio.autoplay = true;
      pc.ontrack = (event) => {
        audio.srcObject = event.streams[0] ?? null;
        void audio.play().catch(() => {});
      };
      for (const track of current.stream.getAudioTracks()) pc.addTrack(track, current.stream);
      const channel = (current.channel = pc.createDataChannel("oai-events"));
      const loop = (current.loop = new TalkLoop(
        {
          send: (event) => {
            if (channel.readyState === "open") channel.send(JSON.stringify(event));
          },
          ask: (requestId, text, signal, heard) =>
            request("POST /bots/:id/talk/ask", {
              params: { id: botId },
              body: { requestId, request: text, ...(heard.length ? { heard: [...heard] } : {}) },
              signal,
            }),
          phase: (phase) => {
            if (!stale()) setStatus(phase);
          },
          captions: (next) => {
            if (!stale()) setCaptions(next);
          },
          activity: () => {
            current.heard = Date.now();
          },
          problem: (message) => {
            if (!stale()) setError(message);
          },
          newId: () => crypto.randomUUID(),
        },
        name,
      ));
      channel.onopen = () => {
        if (!stale()) {
          current.heard = Date.now();
          setStatus("listening");
        }
      };
      channel.onmessage = (event) => {
        try {
          loop.handle(JSON.parse(String(event.data)));
        } catch {
          /* A malformed event changes nothing. */
        }
      };
      channel.onclose = () => {
        if (!stale()) fail("The voice connection closed. Start Talk again.");
      };
      pc.onconnectionstatechange = () => {
        if (!stale() && pc.connectionState === "failed")
          fail("The voice connection dropped. Start Talk again.");
      };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      let response: Response;
      try {
        response = await fetch(CALLS_URL, {
          method: "POST",
          body: offer.sdp,
          credentials: "omit",
          cache: "no-store",
          redirect: "error",
          headers: {
            Authorization: `Bearer ${session.clientSecret}`,
            "Content-Type": "application/sdp",
          },
        });
      } catch {
        if (!stale()) fail("Could not reach OpenAI. Check your connection, then start Talk again.");
        return;
      }
      if (stale()) return;
      if (!response.ok) {
        fail(`OpenAI did not accept the voice call (HTTP ${response.status}). Start Talk again.`);
        return;
      }
      await pc.setRemoteDescription({ type: "answer", sdp: await response.text() });
      if (stale()) return;
      startLimits();
    } catch (cause) {
      if (stale()) return;
      fail(
        cause instanceof ApiError
          ? cause.message
          : "Talk could not start. Try again, or type your message.",
      );
    }
  }, [botId, name, end, fail]);

  useEffect(() => {
    // Only a live Talk has anything to end. Ending an idle one would report "Talk ended" for a call that never ran.
    const leave = () => {
      if (parts.current.live) end();
    };
    const hidden = () => {
      if (document.visibilityState === "hidden" && phone() && parts.current.live)
        end("Talk ended when the app went to the background.");
    };
    window.addEventListener("pagehide", leave);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("pagehide", leave);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [end]);
  // A different assistant, or leaving the chat, ends the conversation.
  useEffect(() => () => release(), [botId, release]);

  const toggleMute = useCallback(() => {
    const tracks = parts.current.stream?.getAudioTracks() ?? [];
    if (!tracks.length) return;
    const next = tracks[0]!.enabled;
    for (const track of tracks) track.enabled = !next;
    parts.current.muted = next;
    setMuted(next);
  }, []);
  const actions = useMemo(
    () => ({
      start: () => void start(),
      end: () => end(),
      toggleMute,
      dismiss: () => {
        setError("");
        setNotice("");
      },
      explain: (message: string) => {
        setNotice("");
        setError(message);
      },
    }),
    [start, end, toggleMute],
  );
  return { status, captions, muted, error, notice, ...actions };
}
