import { useEffect, useRef, useState } from "react";
import type { FileRef } from "../shared/types";
import { formatBytes, MAX_UPLOAD_BYTES } from "../shared/uploads";
import { Icon } from "../components/Icon";
import type { LocalUpload } from "./storage";
import "./attachments.css";

type Preview = { name: string; url: string; size?: number };
const kindLabel = (name: string, mime: string) =>
  mime === "application/pdf" ? "PDF" : mime.startsWith("image/") ? "Image" : name.includes(".") ? name.split(".").pop()!.toUpperCase().slice(0, 4) : "Text";

// Uploaded attachments first, then files still on their way, in the order they were added.
export function AttachmentTray({ attachments, uploads, previews, canOpen, onRemove, onCancel, onRetry }: {
  attachments: FileRef[];
  uploads: LocalUpload[];
  previews: Record<string, { url: string }>;
  canOpen: boolean;
  onRemove(id: string): void;
  onCancel(id: string): void;
  onRetry(id: string): void;
}) {
  const [opened, setPreview] = useState<Preview | null>(null);
  const urlOf = (file: FileRef) => previews[file.id]?.url ?? (canOpen ? file.url || `/api/files/${encodeURIComponent(file.id)}` : undefined);
  // A preview closes once its file leaves the tray, by removal or by sending. Its local image survives the upload finishing.
  const preview = opened && [...attachments.map(urlOf), ...uploads.map(item => item.preview)].includes(opened.url) ? opened : null;
  useEffect(() => { if (opened && !preview) setPreview(null); }, [opened, preview]);
  if (!attachments.length && !uploads.length) return null;
  const failed = uploads.filter(item => item.status === "failed");
  const busy = uploads.length - failed.length;
  return <div className="attachment-tray">
    <ul className="attachment-list" aria-label="Attachments">
      {attachments.map(file => {
        const url = urlOf(file);
        return <AttachmentChip key={file.id} name={file.name} mime={file.mime} url={url}
          meta={[kindLabel(file.name, file.mime), file.size !== undefined && formatBytes(file.size)].filter(Boolean).join(" · ")}
          onOpen={url ? () => file.mime.startsWith("image/") ? setPreview({ name: file.name, url, size: file.size }) : window.open(url, "_blank", "noopener") : undefined}
          onRemove={() => onRemove(file.id)} removeLabel={`Remove ${file.name}`} />;
      })}
      {uploads.map(item => <AttachmentChip key={item.id} name={item.file.name} mime={item.file.type} url={item.preview}
        meta={item.status === "failed" ? "Didn't upload" : item.status === "queued" ? "Waiting…"
          : item.status === "processing" ? "Finishing…" : `Uploading ${Math.round(item.progress * 100)}%`}
        upload={item}
        onOpen={item.preview ? () => setPreview({ name: item.file.name, url: item.preview!, size: item.file.size }) : undefined}
        onRetry={item.status === "failed" ? () => onRetry(item.id) : undefined}
        onRemove={() => onCancel(item.id)}
        removeLabel={item.status === "failed" ? `Remove ${item.file.name}` : `Cancel uploading ${item.file.name}`} />)}
    </ul>
    {failed.map(item => <p className="attachment-error" role="alert" key={item.id}>
      <Icon name="alert" size={14} /><span><strong>{item.file.name}</strong> didn't upload. {item.error} Retry or remove it to send.</span>
    </p>)}
    <span className="sr-only" role="status">{busy ? `Uploading ${busy} ${busy === 1 ? "file" : "files"}` : ""}</span>
    {preview && <AttachmentPreview preview={preview} onClose={() => setPreview(null)} />}
  </div>;
}

function AttachmentChip({ name, mime, url, meta, upload, onOpen, onRetry, onRemove, removeLabel }: {
  name: string;
  mime: string;
  url?: string;
  meta: string;
  upload?: LocalUpload;
  onOpen?(): void;
  onRetry?(): void;
  onRemove(): void;
  removeLabel: string;
}) {
  const image = mime.startsWith("image/") && !!url;
  const state = upload?.status ?? "ready";
  const thumb = <>
    {image ? <img src={url} alt="" draggable={false} /> : <span className="attachment-badge"><Icon name="file" size={20} /><small>{kindLabel(name, mime)}</small></span>}
    {upload && upload.status !== "failed" && <span className="attachment-progress" aria-hidden="true">
      {upload.status === "processing" ? <Icon name="spinner" className="spin" size={22} />
        : <svg viewBox="0 0 36 36" width={30} height={30}>
          <circle cx="18" cy="18" r="15" pathLength={100} className="track" />
          <circle cx="18" cy="18" r="15" pathLength={100} className="bar" strokeDasharray={`${Math.max(upload.progress * 100, 2)} 100`} />
        </svg>}
    </span>}
    {state === "failed" && <span className="attachment-progress failed" aria-hidden="true"><Icon name="alert" size={22} /></span>}
  </>;
  return <li className={`attachment attachment-${state}${image ? " attachment-image" : ""}`} title={`${name}\n${meta}`}>
    {onOpen ? <button type="button" className="attachment-thumb" aria-label={`Preview ${name}`} onClick={onOpen}>{thumb}</button>
      : <span className="attachment-thumb">{thumb}</span>}
    {!image && <span className="attachment-label"><span>{name}</span><small>{meta}</small></span>}
    {image && upload && <span className="sr-only">{name}, {meta}</span>}
    {onRetry && <button type="button" className="attachment-retry" aria-label={`Retry uploading ${name}`} onClick={onRetry}>
      <Icon name="refresh" size={14} />Retry</button>}
    <button type="button" className="attachment-remove" aria-label={removeLabel} onClick={onRemove}><Icon name="close" size={12} /></button>
  </li>;
}

function AttachmentPreview({ preview, onClose }: { preview: Preview; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = dialog.current;
    element?.showModal?.();
    return () => { element?.close?.(); if (previous?.isConnected) previous.focus(); };
  }, []);
  return <dialog ref={dialog} className="attachment-preview" aria-label={`Preview of ${preview.name}`}
    onCancel={onClose} onClose={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <img src={preview.url} alt={preview.name} />
    <footer>
      <span>{preview.name}{preview.size !== undefined && <small> · {formatBytes(preview.size)}</small>}</span>
      <button type="button" className="icon-button" aria-label="Close preview" onClick={onClose}><Icon name="close" size={18} /></button>
    </footer>
  </dialog>;
}

// Covers the conversation while files are dragged over it, so it is obvious where to drop them.
export function DropOverlay({ botName, unavailable }: { botName: string; unavailable?: string }) {
  return <div className={`drop-overlay${unavailable ? " drop-unavailable" : ""}`} aria-hidden="true">
    <div>
      <Icon name={unavailable ? "alert" : "attach"} size={28} />
      <strong>{unavailable ? "Attachments are unavailable" : `Drop to attach for ${botName}`}</strong>
      <span>{unavailable || `Images, PDFs, or text · up to ${formatBytes(MAX_UPLOAD_BYTES)} each`}</span>
    </div>
  </div>;
}
