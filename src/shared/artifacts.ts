import type { EarlierFiles } from "./history";
import { isConversationReply, messageOrigin, withMessageOrigins } from "./message-origin";
import type { FileRef, Message } from "./types";

/**
 * Which files a conversation holds and which reply each one came with. The Artifacts panel and the
 * file chips under replies both read this, so a chip always names a file the panel lists, with the
 * same source. iOS mirrors it in `Artifacts.list` and `Artifacts.replyFiles`; the shared vectors in
 * ios/AgentInterfaceTests/Vectors/reply-artifacts.json hold both to the same answers.
 */
export type ArtifactSource = "Generated" | "Shared" | "Artifact";
export type Artifact = { file: FileRef; source: ArtifactSource };
export type FileKind = "image" | "text" | "document" | "audio" | "video" | "other";
const rasterTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif", "image/bmp"]);
const textTypes = new Set(["text/plain", "text/markdown", "text/csv", "application/json"]);
const audioTypes = new Set(["audio/mpeg", "audio/mp4", "audio/ogg", "audio/wav", "audio/x-wav", "audio/webm", "audio/flac"]);
const videoTypes = new Set(["video/mp4", "video/webm", "video/ogg"]);
/** Exact types only: HTML is not text and SVG is not an image, so neither previews as one. */
export function fileKind(file: Pick<FileRef, "mime">): FileKind {
  const mime = file.mime.split(";", 1)[0]!.trim().toLowerCase();
  if (rasterTypes.has(mime)) return "image";
  if (textTypes.has(mime)) return "text";
  if (mime === "application/pdf") return "document";
  if (audioTypes.has(mime)) return "audio";
  if (videoTypes.has(mime)) return "video";
  return "other";
}
export const fileTypeNames: Record<FileKind, string> = { image: "Image", text: "Text", document: "PDF", audio: "Audio", video: "Video", other: "File" };
/** Chips under one reply; past this many the last chip opens the whole list. */
export const REPLY_CHIP_LIMIT = 4;

/** Every file in the conversation, earlier pages first, in conversation order. A person's file is Shared; the assistant's or a tool's is Generated. */
export function conversationArtifacts(messages: Pick<Message, "role" | "files">[], earlier: EarlierFiles["messages"] = [], files: FileRef[] = []): Artifact[] {
  const byId = new Map<string, Artifact>();
  // Earlier files go first, keeping the list in conversation order.
  for (const message of earlier) for (const file of message.files || []) byId.set(file.id, { file, source: "Artifact" });
  for (const file of files) if (!byId.has(file.id)) byId.set(file.id, { file, source: "Artifact" });
  for (const message of [...earlier, ...messages]) for (const file of message.files || []) {
    const previous = byId.get(file.id);
    const source = message.role === "user" || previous?.source === "Shared" ? "Shared"
      : message.role === "assistant" || message.role === "tool" ? "Generated" : previous?.source || "Artifact";
    byId.set(file.id, { file: { ...file, ...previous?.file }, source });
  }
  return [...byId.values()];
}

/** A person's message or a scheduled prompt starts a turn; subagent and agent rows filed as user messages do not. */
const startsTurn = (message: Message) => message.role === "user" && [undefined, "human", "scheduled"].includes(messageOrigin(message)?.kind);

/**
 * The files each turn generated, keyed by the ID of the turn's last reply, where its chips go. A file
 * belongs to the turn it first appears in, and only Generated files count: a file the person shared
 * is theirs, even when the assistant hands it back. Files a reply row of the turn already shows as
 * its attachments are left out, so chips list only what the turn's work made out of sight. A turn with no reply yet has no chips. `earlier`
 * holds the file-bearing messages before `messages`, as the panel reads them.
 */
export function replyArtifacts(messages: Message[], artifacts: Artifact[], earlier: EarlierFiles["messages"] = []): Map<string, Artifact[]> {
  const listed = new Map(artifacts.map(artifact => [artifact.file.id, artifact]));
  // A file that first appeared before these messages belongs to that earlier turn.
  const seen = new Set(earlier.flatMap(message => (message.files ?? []).map(file => file.id))), result = new Map<string, Artifact[]>();
  let files: Artifact[] = [], shown = new Set<string>(), reply: string | undefined;
  const close = () => {
    // A reply row shows its own files as attachments, so a chip would repeat them.
    const chips = files.filter(artifact => !shown.has(artifact.file.id));
    if (reply && chips.length) result.set(reply, chips);
    files = []; shown = new Set(); reply = undefined;
  };
  for (const message of withMessageOrigins(messages)) {
    if (startsTurn(message)) close();
    for (const file of message.files || []) {
      if (seen.has(file.id)) continue;
      seen.add(file.id);
      const artifact = listed.get(file.id);
      if (artifact?.source === "Generated") files.push(artifact);
    }
    if (isConversationReply(message)) {
      reply = message.id;
      for (const file of message.files || []) shown.add(file.id);
    }
  }
  close();
  return result;
}

/**
 * The chips for a loaded window of a conversation, attributed exactly as the panel lists the same
 * files. A window that starts after the beginning needs the file-bearing messages before it
 * (`earlier`): until they are known it has no chips, since a file there may be the person's or an
 * earlier turn's.
 */
export function windowReplyArtifacts(window: { messages: Message[]; files: FileRef[]; earlier?: number; earlierFiles?: number }, earlier?: EarlierFiles["messages"]): Map<string, Artifact[]> {
  if (((window.earlier ?? 0) > 0 || (window.earlierFiles ?? 0) > 0) && !earlier) return new Map();
  const older = earlier ?? [];
  return replyArtifacts(window.messages, conversationArtifacts(window.messages, older, window.files), older);
}
