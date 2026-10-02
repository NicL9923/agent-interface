import { useEffect, useId, useRef, useState } from "react";
import { api, write } from "../client-api";
import { eventCalendarFile, eventGoogleCalendarUrl } from "../shared/reply-cards";
import type { EventCard, ReplyCard, ReplyCardState, ReplyDocument } from "../shared/reply-cards";
import "./experience.css";

const emptyState = (): ReplyCardState => ({ checkedIds: [], notes: {} });
function CalendarProposal({ card }: { card: EventCard }) {
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => { if (open) dialog.current?.showModal(); else dialog.current?.close(); }, [open]);
  function download() {
    const url = URL.createObjectURL(new Blob([eventCalendarFile(card)], { type: "text/calendar;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = `${card.id}.ics`;
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <>
    <p>{new Date(card.start).toLocaleString()}{card.end && ` to ${new Date(card.end).toLocaleString()}`}</p>
    {card.location && <p>{card.location}</p>}
    <button type="button" onClick={() => setOpen(true)}>Review calendar event</button>
    <dialog ref={dialog} className="event-proposal-dialog" aria-labelledby={titleId} onCancel={() => setOpen(false)} onClose={() => setOpen(false)}>
      <header><h2 id={titleId}>{card.title}</h2><button type="button" onClick={() => setOpen(false)}>Close</button></header>
      <dl><dt>Starts</dt><dd>{new Date(card.start).toLocaleString()}</dd>
        {card.end && <><dt>Ends</dt><dd>{new Date(card.end).toLocaleString()}</dd></>}
        {card.location && <><dt>Location</dt><dd>{card.location}</dd></>}
      </dl>
      {card.description && <p className="preserve-lines">{card.description}</p>}
      <p className="muted">Review the details before saving. This proposal has not added anything to your calendar.</p>
      <div className="actions"><a className="button-link" href={eventGoogleCalendarUrl(card)} target="_blank" rel="noopener noreferrer">Open in Google Calendar</a>
        <button type="button" onClick={download}>Download calendar file</button></div>
    </dialog>
  </>;
}
function InteractiveCard({ card, botId, messageId, userId, unavailable }: { card: ReplyCard; botId?: string; messageId?: string; userId?: string; unavailable?: boolean }) {
  const [saved, setSaved] = useState<ReplyCardState>(emptyState);
  const [draft, setDraft] = useState<ReplyCardState>(emptyState);
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const path = botId && messageId && userId ? `/bots/${encodeURIComponent(botId)}/messages/${encodeURIComponent(messageId)}/cards/${encodeURIComponent(card.id)}/state` : undefined;
  useEffect(() => {
    if (!path || card.type === "event") { setStatus("ready"); return; }
    let current = true;
    setStatus("loading"); setError("");
    void api<ReplyCardState>(path).then(state => { if (current) { setSaved(state); setDraft(state); setStatus("ready"); } })
      .catch(e => { if (current) { setError(e.message); setStatus("error"); } });
    return () => { current = false; };
  }, [path, card.type]);
  async function save(next: ReplyCardState) {
    if (!path) return;
    setDraft(next); setStatus("saving"); setError("");
    try { const result = await write<ReplyCardState>(path, next, "PUT"); setSaved(result); setDraft(result); setStatus("ready"); setEditing(null); }
    catch (e) { setError((e as Error).message); setStatus("error"); }
  }
  const busy = status === "loading" || status === "saving" || unavailable || !path;
  const failedSave = status === "error" && JSON.stringify(saved) !== JSON.stringify(draft);
  return <section className={`reply-card reply-card-${card.type}`} aria-label={card.title}>
    <div className="reply-card-heading"><span className="eyebrow">{card.type === "event" ? "Calendar proposal" : card.type === "itinerary" ? "Itinerary" : "Checklist"}</span>
      {card.type === "checklist" && <span className="muted">{saved.checkedIds.length} / {card.items.length}</span>}</div>
    <h3>{card.title}</h3>
    {card.type === "checklist" && <ul className="reply-checklist">{card.items.map(item => <li key={item.id}><label>
      <input type="checkbox" checked={draft.checkedIds.includes(item.id)} disabled={busy || status === "error"} onChange={e => void save({ ...draft,
        checkedIds: e.target.checked ? [...draft.checkedIds, item.id] : draft.checkedIds.filter(id => id !== item.id) })} />
      <span>{item.text}</span></label></li>)}</ul>}
    {card.type === "itinerary" && <ol className="reply-itinerary">{card.items.map(item => <li key={item.id}>
      {item.time && <span className="eyebrow">{item.time}</span>}<h4>{item.title}</h4>
      {item.detail && <p>{item.detail}</p>}{draft.notes[item.id] && editing !== item.id && <p className="preserve-lines">Your note: {draft.notes[item.id]}</p>}
      {item.url && <a href={item.url} target="_blank" rel="noopener noreferrer">Open details</a>}
      {editing === item.id ? <div className="itinerary-edit"><label>Your itinerary note<textarea maxLength={2000} rows={3}
        value={draft.notes[item.id] || ""} onChange={e => setDraft({ ...draft, notes: { ...draft.notes, [item.id]: e.target.value } })} /></label>
        <div className="actions"><button type="button" disabled={busy} onClick={() => void save(draft)}>Save note</button><button type="button" disabled={busy}
          onClick={() => { setDraft(saved); setEditing(null); }}>Cancel</button></div></div>
        : <button type="button" className="itinerary-note-button" disabled={busy || status === "error"} onClick={() => setEditing(item.id)}>{draft.notes[item.id] ? "Edit note" : "Add note"}</button>}
    </li>)}</ol>}
    {card.type === "event" && <CalendarProposal card={card} />}
    {card.type !== "event" && <small className="muted">Checks and notes are saved for your account. The assistant's proposal stays in the conversation.</small>}
    {error && <div role="alert" className="form-error"><p>{error}</p>{failedSave ? <button type="button" disabled={unavailable} onClick={() => void save(draft)}>Retry saving</button>
      : <button type="button" disabled={unavailable} onClick={() => { if (path) { setStatus("loading"); void api<ReplyCardState>(path).then(state => { setSaved(state); setDraft(state); setStatus("ready"); setError(""); }).catch(e => { setStatus("error"); setError(e.message); }); } }}>Reload saved state</button>}</div>}
    {status === "saving" && <span role="status">Saving...</span>}
  </section>;
}
export function ReplyCards({ document, botId, messageId, userId, unavailable }: { document: ReplyDocument; botId?: string; messageId?: string; userId?: string; unavailable?: boolean }) {
  return <div className="reply-cards">{document.cards.map(card => <InteractiveCard key={`${userId}:${botId}:${messageId}:${card.id}`} card={card} botId={botId} messageId={messageId} userId={userId} unavailable={unavailable} />)}</div>;
}
