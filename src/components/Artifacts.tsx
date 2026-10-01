import { useEffect, useId, useMemo, useRef, useState } from "react";
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
function artifactsFor(conversation?: Conversation | null): Artifact[] {
  if (!conversation) return [];
  const files = new Map<string, Artifact>();
  for (const file of conversation.files) files.set(file.id, { file, source: "Artifact" });
  for (const message of conversation.messages) for (const file of message.files || []) {
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
  bot: Bot; conversation?: Conversation | null; unavailable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const current = conversation?.botId === bot.id ? conversation : undefined;
  const artifacts = useMemo(() => artifactsFor(current), [current]);
  return <>
    <button className="icon-button artifacts-button" aria-label={`Artifacts (${artifacts.length})`}
      title="Browse artifacts" aria-haspopup="dialog" onClick={() => setOpen(true)}>
      <Icon name="file" />
      <span className="artifacts-button-label">Artifacts</span>
      {!!artifacts.length && <span className="artifacts-count" aria-hidden="true">{artifacts.length}</span>}
    </button>
    {open && <ArtifactsView bot={bot} artifacts={artifacts} loading={!current && !unavailable}
      unavailable={unavailable} onClose={() => setOpen(false)} />}
  </>;
}

function ArtifactsView({ bot, artifacts, loading, unavailable, onClose }: {
  bot: Bot; artifacts: Artifact[]; loading: boolean; unavailable: boolean; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const searchId = useId();
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<FileKind | "all">("all");
  const [selectedId, setSelectedId] = useState(artifacts[0]?.file.id);
  const filtered = artifacts.filter(({ file }) => file.name.toLowerCase().includes(query.trim().toLowerCase())
    && (kind === "all" || fileKind(file) === kind));
  // Polling can add/remove files. Keep a selection only while it is in the current results.
  const selected = filtered.find(({ file }) => file.id === selectedId) || filtered[0];
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = dialog.current;
    element?.showModal();
    return () => { element?.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  return <dialog ref={dialog} className="artifacts-dialog" aria-labelledby={titleId}
    onCancel={onClose} onClose={onClose}>
    <header className="artifacts-header">
      <div><p className="eyebrow">{bot.name}</p><h2 id={titleId}>Artifacts <span>{artifacts.length}</span></h2></div>
      <button className="icon-button" aria-label="Close artifacts" onClick={onClose}><Icon name="close" /></button>
    </header>
    <div className="artifacts-toolbar">
      <label htmlFor={searchId}>Search files<input id={searchId} type="search" value={query}
        placeholder="Find a filename" onChange={event => setQuery(event.target.value)} /></label>
      <label>File type<select value={kind} onChange={event => setKind(event.target.value as FileKind | "all")}>
        {kinds.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select></label>
    </div>
    {unavailable && <p className="artifacts-notice" role="status">{artifacts.length
      ? "The connection is unavailable. These are the last reported files; opening one may need a reconnect."
      : "Files are unavailable until your assistant reconnects."}</p>}
    {loading ? <div className="artifacts-empty" role="status">Loading your conversation’s files…</div>
      : !artifacts.length ? <div className="artifacts-empty"><Icon name="file" size={36} />
        <h3>No artifacts yet</h3><p>Generated outputs and files shared in this conversation will appear here.</p></div>
      : !filtered.length ? <div className="artifacts-empty" role="status"><h3>No matching files</h3>
        <p>Try another filename or file type.</p><button onClick={() => { setQuery(""); setKind("all"); }}>Clear filters</button></div>
      : <div className="artifacts-browser">
        <nav className="artifacts-list" aria-label="Conversation files">
          {filtered.map(artifact => <button key={artifact.file.id}
            className={`artifact-item ${selected?.file.id === artifact.file.id ? "selected" : ""}`}
            aria-current={selected?.file.id === artifact.file.id ? "true" : undefined}
            onClick={() => setSelectedId(artifact.file.id)}>
            <Icon name="file" size={19} /><span><strong>{artifact.file.name}</strong>
              <small>{artifact.source}{fileSize(artifact.file.size) && ` · ${fileSize(artifact.file.size)}`}</small></span>
          </button>)}
        </nav>
        {selected && <ArtifactDetail key={`${selected.file.id}:${selected.file.url}:${selected.file.mime}`} artifact={selected} />}
      </div>}
  </dialog>;
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
      <button onClick={retry}>Retry preview</button></div> : kind === "image"
      ? <img key={attempt} src={url} alt={file.name} onLoad={loaded} onError={error} />
      : kind === "audio" ? <audio key={attempt} src={url} controls preload="metadata" onLoadedMetadata={loaded} onError={error} aria-label={file.name} />
        : <video key={attempt} src={url} controls preload="metadata" playsInline onLoadedMetadata={loaded} onError={error} aria-label={file.name} />}
  </>;
}

const textPreviewLimit = 256 * 1024;
function TextPreview({ file, url }: { file: FileRef; url: string }) {
  const [attempt, setAttempt] = useState(0);
  const [preview, setPreview] = useState<{ text?: string; truncated?: boolean; error?: string }>({});
  useEffect(() => {
    const controller = new AbortController();
    let live = true;
    setPreview({});
    const timer = setTimeout(() => controller.abort(), 20_000);
    const load = async () => {
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
        if (live) setPreview({ text: new TextDecoder().decode(bytes), truncated });
      } catch (error) {
        if (live) setPreview({ error: controller.signal.aborted ? "The preview took too long to load. Try again."
          : error instanceof Error ? error.message : "The preview could not be loaded." });
      } finally { clearTimeout(timer); }
    };
    void load();
    return () => { live = false; controller.abort(); clearTimeout(timer); };
  }, [url, attempt]);
  return preview.error ? <div className="artifact-preview-error" role="alert"><p>{preview.error}</p>
    <button onClick={() => setAttempt(value => value + 1)}>Retry preview</button></div>
    : preview.text === undefined ? <p role="status">Loading preview…</p>
      : <div className="artifact-text-preview"><pre aria-label={`Contents of ${file.name}`}>{preview.text || "This file is empty."}</pre>
        {preview.truncated && <p className="artifact-preview-status">Showing the first 256 KB. Download the file to read the rest.</p>}</div>;
}
