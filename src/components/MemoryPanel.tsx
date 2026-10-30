import { routeUrl } from "../shared/api";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { TextareaHTMLAttributes } from "react";
import { ApiError, request } from "../client-api";
import { useAction } from "../app/use-action";
import { useResource } from "../app/use-resource";
import { FormMessage } from "./ui/form-message";
import { SettingsConfirmation } from "./SettingsConfirmation";
import { Icon } from "./Icon";
import type { MemoryDocument, MemoryEntry, ProfileMemory } from "../shared/experience";
import "./experience.css";

/** Hermes counts Unicode scalars and includes its entry delimiter. Infer only known overhead. */
export function memoryDraftSize(document: MemoryDocument, entries: MemoryEntry[]): number | undefined {
  const lengths = (texts: string[]) => texts.reduce((sum, text) => sum + [...text].length, 0);
  const texts = entries.map(entry => entry.text.trim());
  const textSize = lengths(texts);
  if (texts.length <= 1) return textSize;
  if (document.entries.length < 2) return undefined;
  const overhead = (document.charCount - lengths(document.entries.map(entry => entry.text))) / (document.entries.length - 1);
  return Number.isInteger(overhead) && overhead >= 0 ? textSize + overhead * (texts.length - 1) : undefined;
}

function MemoryText({ value, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & { value: string }) {
  const field = useRef<HTMLTextAreaElement>(null);
  const [clipped, setClipped] = useState(false);
  const hint = useId();
  const fit = useCallback(() => {
    const element = field.current;
    if (!element) return;
    const scroll = element.scrollTop;
    element.style.height = "auto";
    const border = element.offsetHeight - element.clientHeight;
    element.style.height = `${element.scrollHeight + border}px`;
    element.scrollTop = scroll;
    setClipped(element.scrollHeight > element.clientHeight + 1);
  }, []);
  useLayoutEffect(fit, [value, fit]);
  useEffect(() => {
    let width = field.current?.clientWidth;
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => {
      const next = field.current?.clientWidth;
      if (next !== width) { width = next; fit(); }
    });
    if (field.current) observer?.observe(field.current);
    window.addEventListener("resize", fit);
    return () => { observer?.disconnect(); window.removeEventListener("resize", fit); };
  }, [fit]);
  return <><textarea {...props} ref={field} value={value} rows={3}
    aria-describedby={[props["aria-describedby"], clipped ? hint : ""].filter(Boolean).join(" ")} />
    {clipped && <span id={hint} className="memory-scroll-hint">Scroll within this entry to read more.</span>}</>;
}

function MemoryEditor({ document, botId, busy, notice, onSaved, onDirty, onEdit, onSaving }: {
  document: MemoryDocument; botId: string; busy: boolean; notice?: string;
  onSaved: (target: string, memory: ProfileMemory) => void;
  onDirty: (target: string, dirty: boolean) => void;
  onEdit: (target: string) => void;
  onSaving: (target: string, saving: boolean) => void;
}) {
  const [entries, setEntries] = useState(document.entries.map(entry => ({ ...entry })));
  const { busy: saving, error, run, setError } = useAction();
  const [conflict, setConflict] = useState(false);
  const [forget, setForget] = useState<string | null>(null);
  const headingId = useId(), countId = useId(), limitId = useId(), dirtyHintId = useId();
  const pendingEntryFocus = useRef<number | null>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const changed = JSON.stringify(entries) !== JSON.stringify(document.entries);
  const size = memoryDraftSize(document, entries);
  const over = size !== undefined && size > document.charLimit;
  const label = document.target === "user" ? "About this profile" : document.label;
  const locked = saving || busy || conflict || !document.enabled;
  const canMoveFocus = () => {
    const section = sectionRef.current, active = section?.ownerDocument.activeElement;
    return !!section && (active === section.ownerDocument.body || !!active && section.contains(active));
  };
  useEffect(() => {
    if (pendingEntryFocus.current === null) return;
    const field = sectionRef.current?.querySelectorAll("textarea")[pendingEntryFocus.current];
    field?.focus(); pendingEntryFocus.current = null;
  }, [entries.length]);
  useEffect(() => { onSaving(document.target, saving); }, [document.target, saving, onSaving]);
  useEffect(() => () => onSaving(document.target, false), [document.target, onSaving]);
  useEffect(() => { if (forget) keepRef.current?.focus(); }, [forget]);
  useEffect(() => { if (notice && !changed && canMoveFocus()) { noticeRef.current?.focus(); noticeRef.current?.scrollIntoView({ block: "nearest" }); } }, [notice, changed]);
  const restoreHeading = () => requestAnimationFrame(() => {
    headingRef.current?.focus(); headingRef.current?.scrollIntoView({ block: "start" });
  });
  useEffect(() => { onDirty(document.target, changed); }, [document.target, changed, onDirty]);
  useEffect(() => () => onDirty(document.target, false), [document.target, onDirty]);
  useEffect(() => {
    if (!error || !canMoveFocus()) return;
    const message = errorRef.current;
    if (!message) return;
    message.focus({ preventScroll: true });
    const box = message.getBoundingClientRect(), view = message.closest(".settings-content")?.getBoundingClientRect();
    if (!view || box.top < view.top + 12 || box.bottom > view.bottom - 12) message.scrollIntoView({ block: "start" });
  }, [error]);
  const edit = (next: MemoryEntry[]) => { setEntries(next); onEdit(document.target); };
  const params = { id: botId, target: document.target };
  const mutate = (work: () => Promise<ProfileMemory>) => run(work, {
    onSuccess: result => onSaved(document.target, result),
    onError: cause => { if (cause instanceof ApiError && cause.status === 409) setConflict(true); },
  });
  return <section ref={sectionRef} className="memory-document" data-memory-target={document.target} aria-labelledby={headingId}>
    <div className="memory-heading">
      <h3 id={headingId} ref={headingRef} tabIndex={-1}>{label}</h3>
      <small id={countId} className={over ? "memory-count-over" : undefined}>
        {size === undefined ? `Saved size: ${document.charCount.toLocaleString()}` : size.toLocaleString()} / {document.charLimit.toLocaleString()} characters
      </small>
    </div>
    {error && conflict && <FormMessage tone="error" ref={errorRef} tabIndex={-1}>{error}{changed ? " Your edits are kept. Copy any text you want to keep, then reload profile memory to continue." : " Reload profile memory before editing again."}</FormMessage>}
    {!document.enabled && <p className="memory-note">Editing is disabled in this Hermes profile. You can still read and copy these notes.</p>}
    {changed && !locked && <p id={dirtyHintId} className="memory-note">Save or discard your edits before forgetting a saved entry.</p>}
    {!entries.length && <p className="memory-empty">Nothing saved here yet. Add a fact you want this profile to remember.</p>}
    {entries.map((entry, index) => <div className="memory-entry" key={entry.id || `new-${index}`}>
      <label>{document.target === "user" ? "Profile fact" : "Assistant note"} {index + 1}
        <MemoryText value={entry.text} readOnly={locked} aria-label={`${document.target === "user" ? "Profile fact" : "Assistant note"} ${index + 1}`}
          aria-describedby={`${countId}${over ? ` ${limitId}` : ""}`}
          onChange={event => edit(entries.map((item, i) => i === index ? { ...item, text: event.target.value } : item))} />
      </label>
      {entry.id && forget === entry.id ? <div className="memory-forget" role="group" aria-label="Confirm forgetting this entry">
        <p>Forget this entry from the profile?</p>
        <div className="actions">
          <button type="button" className="danger" disabled={locked || changed}
            onClick={() => void mutate(() => request("DELETE /bots/:id/memory/:target", { params, body: { revision: document.revision, entryId: entry.id } }))}>Forget entry</button>
          <button type="button" ref={keepRef} disabled={saving} onClick={() => { setForget(null); restoreHeading(); }}>Keep it</button>
        </div>
      </div> : <button type="button" className="memory-entry-action" aria-describedby={changed && !locked && entry.id ? dirtyHintId : undefined}
        disabled={locked || (!!entry.id && changed)} onClick={() => {
        if (entry.id) setForget(entry.id); else { edit(entries.filter((_, i) => i !== index)); restoreHeading(); }
      }}>{entry.id ? "Forget..." : "Remove new entry"}</button>}
    </div>)}
    {size !== undefined && over && <p className="memory-limit" id={limitId}>This document is {(size - document.charLimit).toLocaleString()} characters over the limit. Shorten or remove an entry before saving.</p>}
    <div className="actions memory-actions">
      <button type="button" disabled={locked || entries.length >= 100} onClick={() => { pendingEntryFocus.current = entries.length; edit([...entries, { id: "", text: "" }]); }}><Icon name="plus" size={18} />Add memory</button>
      <button type="button" className="primary" disabled={locked || !changed || over || entries.some(entry => !entry.text.trim())}
        onClick={() => void mutate(() => request("PATCH /bots/:id/memory/:target", { params, body: { revision: document.revision,
          entries: entries.map(entry => ({ ...(entry.id ? { id: entry.id } : {}), text: entry.text })) } }))}>Save memories</button>
      {changed && <button type="button" disabled={saving} onClick={() => { edit(document.entries.map(entry => ({ ...entry }))); if (!conflict) setError(""); restoreHeading(); }}>Discard edits</button>}
    </div>
    <p role="status" className="memory-progress">{saving ? "Saving memories in Hermes..." : ""}</p>
    {error && !conflict && <FormMessage tone="error" ref={errorRef} tabIndex={-1}>{error}</FormMessage>}
    {notice && !changed && <FormMessage tone="notice" ref={noticeRef} tabIndex={-1}>{notice}</FormMessage>}
  </section>;
}

export function MemoryPanel({ botId, onDirtyChange, onSavingChange }: { botId: string; onDirtyChange?: (dirty: boolean) => void; onSavingChange?: (saving: boolean) => void }) {
  const [generation, setGeneration] = useState(0);
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [saveGenerations, setSaveGenerations] = useState<Record<string, number>>({});
  const [notices, setNotices] = useState<Record<string, string>>({});
  const [confirmReload, setConfirmReload] = useState(false);
  const reloadButton = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const resource = useResource(routeUrl("GET /bots/:id/memory", { id: botId }), {
    load: (_, signal) => request("GET /bots/:id/memory", { params: { id: botId }, signal }),
    onData: () => { setGeneration(value => value + 1); setNotices({}); },
  });
  const { data: memory, error, loading, setData: setMemory } = resource;
  const changed = Object.values(dirty).some(Boolean);
  const writing = Object.values(saving).some(Boolean);
  useEffect(() => { onSavingChange?.(writing); }, [writing, onSavingChange]);
  useEffect(() => () => onSavingChange?.(false), [onSavingChange]);
  useEffect(() => { onDirtyChange?.(changed); }, [changed, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  const reportDirty = useCallback((target: string, value: boolean) => setDirty(previous => previous[target] === value ? previous : { ...previous, [target]: value }), []);
  const reportSaving = useCallback((target: string, value: boolean) => setSaving(previous => previous[target] === value ? previous : { ...previous, [target]: value }), []);
  const clearNotice = useCallback((target: string) => setNotices(previous => previous[target] ? { ...previous, [target]: "" } : previous), []);
  const saved = (target: string, result: ProfileMemory) => {
    setSaveGenerations(previous => ({ ...previous, [target]: (previous[target] || 0) + 1 }));
    setNotices(previous => ({ ...previous, [target]: result.refresh?.message || "Saved in Hermes." }));
    setMemory(previous => previous ? { ...previous, refresh: result.refresh, notice: result.notice,
      documents: previous.documents.map(document => document.target === target ? result.documents.find(updated => updated.target === target) || document : document) } : result);
  };
  const reload = () => { setConfirmReload(false); heading.current?.focus(); heading.current?.scrollIntoView({ block: "start" }); void resource.reload(); };
  const requestReload = () => changed ? setConfirmReload(true) : reload();
  return <div className="memory-panel">
    <header className="memory-intro"><h2 ref={heading} tabIndex={-1}>What Hermes remembers</h2><p>Review and correct the facts saved in this Hermes profile.</p></header>
    {memory && <div className="memory-scope"><strong>Shared profile: {memory.profile}</strong>
      <p>Changes apply at the next safe turn boundary. Chat history stays unchanged.</p>
      <p>Anyone with Hermes dashboard access can reach this memory.</p>
    </div>}
    {loading && <p role="status">Loading profile memory...</p>}
    {error && <div className="memory-load-error"><FormMessage tone="error">{error}</FormMessage>
      <button type="button" className="primary" disabled={loading || writing} onClick={requestReload}>Try loading again</button>
    </div>}
    {memory?.refresh?.revision && memory.refresh.busy && !Object.values(notices).some(Boolean) && <FormMessage tone="notice">{memory.refresh.message}</FormMessage>}
    {memory?.documents.map(document => <MemoryEditor key={`${document.target}:${document.revision}:${generation}:${saveGenerations[document.target] || 0}`} document={document} botId={botId} busy={loading}
      notice={notices[document.target]} onSaved={saved} onDirty={reportDirty} onEdit={clearNotice} onSaving={reportSaving} />)}
    {memory && !error && <button type="button" ref={reloadButton} disabled={loading || writing} onClick={requestReload}>Reload profile memory</button>}
    {confirmReload && <SettingsConfirmation title="Reload profile memory?" detail="Your unsaved edits will be discarded when the latest memory loads. Copy anything you want to keep first."
      confirmLabel="Reload and discard edits" danger busy={writing || loading} onConfirm={reload} onCancel={() => setConfirmReload(false)} fallbackFocus={heading} />}
  </div>;
}
