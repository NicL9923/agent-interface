import { useEffect, useState } from "react";
import { api, ApiError, write } from "../client-api";
import type { MemoryDocument, ProfileMemory } from "../shared/experience";
import "./experience.css";

function MemoryEditor({ document, botId, busy, onChange }: { document: MemoryDocument; botId: string; busy: boolean; onChange: (memory: ProfileMemory) => void }) {
  const [entries, setEntries] = useState(document.entries.map(entry => ({ ...entry })));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState(false);
  const [forget, setForget] = useState<string | null>(null);
  const changed = JSON.stringify(entries) !== JSON.stringify(document.entries);
  const path = `/bots/${encodeURIComponent(botId)}/memory/${document.target}`;
  async function mutate(action: () => Promise<ProfileMemory>) {
    setSaving(true); setError(""); setNotice("");
    try { onChange(await action()); setNotice("Saved in Hermes."); }
    catch (e) { setError((e as Error).message); if (e instanceof ApiError && e.status === 409) setConflict(true); }
    finally { setSaving(false); }
  }
  return <section className="memory-document">
    <div className="memory-heading"><h3>{document.label}</h3><small>{document.charCount} / {document.charLimit} characters</small></div>
    {!document.enabled && <p className="capability-note">This memory is disabled in the Hermes profile.</p>}
    {!entries.length && <p className="muted">Nothing saved here yet.</p>}
    {entries.map((entry, index) => <div className="memory-entry" key={entry.id || `new-${index}`}>
      <label>Memory {index + 1}<textarea rows={3} maxLength={document.charLimit} value={entry.text} disabled={saving || busy || conflict || !document.enabled}
        onChange={e => setEntries(entries.map((item, i) => i === index ? { ...item, text: e.target.value } : item))} /></label>
      {entry.id && forget === entry.id ? <div className="actions"><span>Forget this entry in the profile?</span><button type="button" className="danger" disabled={saving || changed}
        onClick={() => void mutate(() => write<ProfileMemory>(path, { revision: document.revision, entryId: entry.id }, "DELETE"))}>Forget entry</button>
        <button type="button" disabled={saving} onClick={() => setForget(null)}>Keep it</button></div>
        : <button type="button" disabled={saving || busy || conflict || (!!entry.id && changed) || !document.enabled} onClick={() => {
          if (entry.id) setForget(entry.id); else setEntries(entries.filter((_, i) => i !== index));
        }}>{entry.id ? "Forget..." : "Remove new entry"}</button>}
    </div>)}
    <div className="actions"><button type="button" disabled={saving || busy || conflict || !document.enabled || entries.length >= 100}
      onClick={() => setEntries([...entries, { id: "", text: "" }])}>Add memory</button>
      <button type="button" className="primary" disabled={saving || busy || conflict || !document.enabled || !changed || entries.some(entry => !entry.text.trim())}
        onClick={() => void mutate(() => write<ProfileMemory>(path, { revision: document.revision,
          entries: entries.map(entry => ({ ...(entry.id ? { id: entry.id } : {}), text: entry.text })) }, "PATCH"))}>{saving ? "Saving..." : "Save memories"}</button>
      {changed && <button type="button" disabled={saving} onClick={() => { setEntries(document.entries.map(entry => ({ ...entry }))); setError(""); }}>Discard edits</button>}</div>
    {error && <p className="form-error" role="alert">{error}{conflict && " Your edits are kept. Copy them before reloading the newer profile memory."}</p>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
export function MemoryPanel({ botId }: { botId: string }) {
  const [memory, setMemory] = useState<ProfileMemory | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let current = true; setLoading(true); setError("");
    void api<ProfileMemory>(`/bots/${encodeURIComponent(botId)}/memory`).then(result => { if (current) setMemory(result); })
      .catch(e => { if (current) setError(e.message); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [botId, retry]);
  return <div className="memory-panel"><h2>What Hermes remembers</h2>
    <p className="muted">Inspect and correct the facts saved in the assistant's Hermes profile.</p>
    {loading && <p role="status">Loading profile memory...</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {memory && <><p className="capability-note"><strong>Profile: {memory.profile}.</strong> {memory.notice}</p>
      {memory.documents.map(document => <MemoryEditor key={`${document.target}:${document.revision}`} document={document} botId={botId} busy={loading}
        onChange={result => setMemory(previous => previous ? { ...previous,
          documents: previous.documents.map(saved => saved.target === document.target
            ? result.documents.find(updated => updated.target === saved.target) || saved : saved) } : result)} />)}</>}
    <button type="button" disabled={loading} onClick={() => setRetry(retry + 1)}>{error ? "Try loading again" : "Reload profile memory"}</button>
  </div>;
}
