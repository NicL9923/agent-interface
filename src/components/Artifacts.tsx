import { Dialog } from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { NativeSelect } from "./ui/native-select";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { request as apiRequest } from "../client-api";
import { useResource } from "../app/use-resource";
import type { EarlierFiles } from "../shared/history";
import type { Bot, Conversation, FileRef } from "../shared/types";
import { Icon } from "./Icon";
import "./artifacts.css";

type Artifact = { file: FileRef; source: "Generated" | "Shared" | "Artifact" };
type FileKind = "image" | "text" | "document" | "audio" | "video" | "other";
const kinds: { value: FileKind | "all"; label: string }[] = [
  { value: "all", label: "All types" }, { value: "image", label: "Images" },
  { value: "text", label: "Text" }, { value: "document", label: "Documents" },
  { value: "audio", label: "Audio" }, { value: "video", label: "Video" },
  { value: "other", label: "Other files" },
];
const rasterTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif", "image/bmp"]);
const textTypes = new Set(["text/plain", "text/markdown", "text/csv", "application/json"]);
const audioTypes = new Set(["audio/mpeg", "audio/mp4", "audio/ogg", "audio/wav", "audio/x-wav", "audio/webm", "audio/flac"]);
const videoTypes = new Set(["video/mp4", "video/webm", "video/ogg"]);
const mimeType = (file: FileRef) => file.mime.split(";", 1)[0]!.trim().toLowerCase();
function fileKind(file: FileRef): FileKind {
  const mime = mimeType(file);
  if (rasterTypes.has(mime)) return "image";
  if (textTypes.has(mime)) return "text";
  if (mime === "application/pdf") return "document";
  if (audioTypes.has(mime)) return "audio";
  if (videoTypes.has(mime)) return "video";
  return "other";
}
/** A conversation window, which may count files that only its earlier, unloaded messages carry. */
type ConversationWindow = Conversation & { earlierFiles?: number };
function artifactsFor(conversation?: ConversationWindow | null, earlier: EarlierFiles["messages"] = []): Artifact[] {
  if (!conversation) return [];
  const files = new Map<string, Artifact>();
  // Earlier files go first, keeping the list in conversation order.
  for (const message of earlier) for (const file of message.files || []) files.set(file.id, { file, source: "Artifact" });
  for (const file of conversation.files) if (!files.has(file.id)) files.set(file.id, { file, source: "Artifact" });
  for (const message of [...earlier, ...conversation.messages]) for (const file of message.files || []) {
    const previous = files.get(file.id);
    const source = message.role === "user" || previous?.source === "Shared" ? "Shared"
      : message.role === "assistant" || message.role === "tool" ? "Generated" : previous?.source || "Artifact";
    files.set(file.id, { file: { ...file, ...previous?.file }, source });
  }
  return [...files.values()];
}
/** Only the app's authenticated file route can load a preview automatically. */
function managedFileUrl(file: FileRef): string | undefined {
  const path = `/api/files/${encodeURIComponent(file.id)}`;
  try {
    const url = new URL(file.url || path, location.origin);
    return url.origin === location.origin && url.pathname === path && !url.search && !url.hash
      && !url.username && !url.password ? path : undefined;
  } catch { return undefined; }
}
function sourceUrl(file: FileRef): string | undefined {
  if (!file.url) return undefined;
  try {
    const url = new URL(file.url, location.origin);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}
function fileSize(size?: number) {
  if (size === undefined || !Number.isFinite(size) || size < 0) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function ArtifactsButton({ bot, conversation, unavailable = false }: {
  bot: Bot; conversation?: ConversationWindow | null; unavailable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  // Files of history before the loaded window, fetched while the list is open. They belong
  // to one session and window start, so history that replaces either fetches them again.
  const [earlier, setEarlier] = useState<{ session?: string; before?: string; messages?: EarlierFiles["messages"]; loading?: boolean; failed?: boolean }>({});
  const request = useRef(0);
  const current = conversation?.botId === bot.id ? conversation : undefined;
  const session = current?.sessionId ?? "", before = current?.messages[0]?.id;
  const fetched = !!current && earlier.session === session
    && (!earlier.before || current.messages.some(message => message.id === earlier.before));
  const older = fetched ? earlier.messages : undefined;
  const artifacts = useMemo(() => artifactsFor(current, older), [current, older]);
  const count = artifacts.length + (older ? 0 : current?.earlierFiles ?? 0);
  useEffect(() => {
    if (!open || !current?.earlierFiles || fetched) return;
    const id = ++request.current;
    const settle = (value: typeof earlier) => { if (request.current === id) setEarlier({ session, before, ...value }); };
    settle({ loading: true });
    apiRequest("GET /bots/:id/files", { params: { id: bot.id }, query: { before } })
      .then(value => settle({ messages: value.messages }), () => settle({ failed: true }));
  }, [open, bot.id, session, before, !!current?.earlierFiles, fetched]);
  const show = () => {
    // Reopening retries a failed fetch.
    if (earlier.failed) setEarlier({});
    setOpen(true);
  };
  return <>
    <Button className="icon-button artifacts-button" aria-label={`Artifacts (${count})`}
      title="Browse artifacts" aria-haspopup="dialog" onClick={show}>
      <Icon name="file" />
      <span className="artifacts-button-label">Artifacts</span>
      {!!count && <span className="artifacts-count" aria-hidden="true">{count}</span>}
    </Button>
    {open && <ArtifactsView bot={bot} artifacts={artifacts} loading={!current && !unavailable}
      earlier={!fetched ? undefined : earlier.loading ? "loading" : earlier.failed ? "failed" : undefined}
      unavailable={unavailable} onClose={() => setOpen(false)} />}
  </>;
}

function ArtifactsView({ bot, artifacts, loading, earlier, unavailable, onClose }: {
  bot: Bot; artifacts: Artifact[]; loading: boolean; earlier?: "loading" | "failed"; unavailable: boolean; onClose: () => void;
}) {
  const titleId = useId();
  const searchId = useId();
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<FileKind | "all">("all");
  const [selectedId, setSelectedId] = useState(artifacts[0]?.file.id);
  const filtered = artifacts.filter(({ file }) => file.name.toLowerCase().includes(query.trim().toLowerCase())
    && (kind === "all" || fileKind(file) === kind));
  // Polling can add/remove files. Keep a selection only while it is in the current results.
  const selected = filtered.find(({ file }) => file.id === selectedId) || filtered[0];
  return <Dialog className="artifacts-dialog" aria-labelledby={titleId}
    onCancel={onClose} onClose={onClose}>
    <header className="artifacts-header">
      <div><p className="eyebrow">{bot.name}</p><h2 id={titleId}>Artifacts <span>{artifacts.length}</span></h2></div>
      <Button className="icon-button" aria-label="Close artifacts" onClick={onClose}><Icon name="close" /></Button>
    </header>
    <div className="artifacts-toolbar">
      <label htmlFor={searchId}>Search files<Input id={searchId} type="search" value={query}
        placeholder="Find a filename" onChange={event => setQuery(event.target.value)} /></label>
      <label>File type<NativeSelect value={kind} onChange={event => setKind(event.target.value as FileKind | "all")}>
        {kinds.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </NativeSelect></label>
    </div>
    {unavailable && <p className="artifacts-notice" role="status">{artifacts.length
      ? "The connection is unavailable. These are the last reported files; opening one may need a reconnect."
      : "Files are unavailable until your assistant reconnects."}</p>}
    {earlier && <p className="artifacts-notice" role="status">{earlier === "loading"
      ? "Loading files from earlier in the conversation…"
      : "Files from earlier in the conversation could not be loaded. Close and reopen this list to try again."}</p>}
    {loading ? <div className="artifacts-empty" role="status">Loading your conversation’s files…</div>
      : !artifacts.length ? <div className="artifacts-empty"><Icon name="file" size={36} />
        <h3>No artifacts yet</h3><p>Generated outputs and files shared in this conversation will appear here.</p></div>
      : !filtered.length ? <div className="artifacts-empty" role="status"><h3>No matching files</h3>
        <p>Try another filename or file type.</p><Button onClick={() => { setQuery(""); setKind("all"); }}>Clear filters</Button></div>
      : <div className="artifacts-browser">
        <nav className="artifacts-list" aria-label="Conversation files">
          {filtered.map(artifact => <Button key={artifact.file.id}
            className={`artifact-item ${selected?.file.id === artifact.file.id ? "selected" : ""}`}
            aria-current={selected?.file.id === artifact.file.id ? "true" : undefined}
            onClick={() => setSelectedId(artifact.file.id)}>
            <Icon name="file" size={19} /><span><strong>{artifact.file.name}</strong>
              <small>{artifact.source}{fileSize(artifact.file.size) && ` · ${fileSize(artifact.file.size)}`}</small></span>
          </Button>)}
        </nav>
        {selected && <ArtifactDetail key={`${selected.file.id}:${selected.file.url}:${selected.file.mime}`} artifact={selected} />}
      </div>}
  </Dialog>;
}

function ArtifactDetail({ artifact }: { artifact: Artifact }) {
  const { file, source } = artifact;
  const url = managedFileUrl(file);
  const external = url ? undefined : sourceUrl(file);
  return <section className="artifact-detail" aria-label={`Preview of ${file.name}`}>
    <header><h3>{file.name}</h3><p>{source} · {file.mime}{fileSize(file.size) && ` · ${fileSize(file.size)}`}</p></header>
    <div className="artifact-preview">
      {!url ? <p>{external ? "This file is hosted outside the app. Open its source to view it."
        : "This file has no supported download address."}</p>
        : <FilePreview file={file} url={url} />}
    </div>
    <div className="artifact-actions">
      {url && <><a href={url} download={file.name}><Icon name="download" size={17} /> Download</a>
        <a href={url} target="_blank" rel="noopener noreferrer"><Icon name="external" size={17} /> Open file</a></>}
      {external && <a href={external} target="_blank" rel="noopener noreferrer"><Icon name="external" size={17} /> Open source</a>}
    </div>
  </section>;
}

function FilePreview({ file, url }: { file: FileRef; url: string }) {
  const kind = fileKind(file);
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const retry = () => { setFailed(false); setLoading(true); setAttempt(value => value + 1); };
  const loaded = () => setLoading(false);
  const error = () => { setLoading(false); setFailed(true); };
  if (kind === "text") return <TextPreview file={file} url={url} />;
  if (kind === "document") return <div className="artifact-placeholder"><Icon name="file" size={48} />
    <p>Open this PDF in a new tab to view the document, or download a copy.</p></div>;
  if (kind === "other") return <div className="artifact-placeholder"><Icon name="file" size={48} />
    <p>A preview is not available for this file type. Download it to use it in another app.</p></div>;
  return <>
    {loading && <p className="artifact-preview-status" role="status">Loading preview…</p>}
    {failed ? <div className="artifact-preview-error" role="alert"><p>We couldn’t load this preview. The file may be unavailable or your connection may have changed.</p>
      <Button onClick={retry}>Retry preview</Button></div> : kind === "image"
      ? <img key={attempt} src={url} alt={file.name} decoding="async" onLoad={loaded} onError={error} />
      : kind === "audio" ? <audio key={attempt} src={url} controls preload="metadata" onLoadedMetadata={loaded} onError={error} aria-label={file.name} />
        : <video key={attempt} src={url} controls preload="metadata" playsInline onLoadedMetadata={loaded} onError={error} aria-label={file.name} />}
  </>;
}

const textPreviewLimit = 256 * 1024;
type TextContent = { text: string; truncated: boolean };
/** Reads the start of a file as text, up to the preview limit, and gives up after 20 seconds. */
async function readTextPreview(url: string, signal: AbortSignal): Promise<TextContent> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  let late = false;
  const timer = setTimeout(() => { late = true; controller.abort(); }, 20_000);
  signal.addEventListener("abort", stop);
  try {
    const response = await fetch(url, { credentials: "same-origin", cache: "no-store", redirect: "error", signal: controller.signal });
    if (!response.ok) throw new Error(response.status === 401 ? "Sign in again to open this file." : "This file could not be loaded. Try again when the connection is restored.");
    const chunks: Uint8Array[] = [];
    let length = 0;
    let truncated = false;
    if (response.body) {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const remaining = textPreviewLimit - length;
        chunks.push(value.slice(0, remaining));
        length += Math.min(value.length, remaining);
        if (value.length > remaining || length === textPreviewLimit) { truncated = true; await reader.cancel(); break; }
      }
    } else {
      const value = new TextEncoder().encode(await response.text());
      chunks.push(value.slice(0, textPreviewLimit)); length = Math.min(value.length, textPreviewLimit);
      truncated = value.length > textPreviewLimit;
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return { text: new TextDecoder().decode(bytes), truncated };
  } catch (error) {
    throw late ? new Error("The preview took too long to load. Try again.") : error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
  }
}
function TextPreview({ file, url }: { file: FileRef; url: string }) {
  const preview = useResource<TextContent>(url, {
    load: readTextPreview,
    errorMessage: cause => cause instanceof Error ? cause.message : "The preview could not be loaded.",
  });
  return preview.error ? <div className="artifact-preview-error" role="alert"><p>{preview.error}</p>
    <Button onClick={() => void preview.reload()}>Retry preview</Button></div>
    : !preview.data ? <p role="status">Loading preview…</p>
      : <div className="artifact-text-preview"><pre aria-label={`Contents of ${file.name}`}>{preview.data.text || "This file is empty."}</pre>
        {preview.data.truncated && <p className="artifact-preview-status">Showing the first 256 KB. Download the file to read the rest.</p>}</div>;
}
