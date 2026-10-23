import { Dialog } from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { useId, useState } from "react";
import { write } from "../client-api";
import { useAction } from "../app/use-action";
import { useResource } from "../app/use-resource";
import { eventCalendarFile, eventGoogleCalendarUrl } from "../shared/reply-cards";
import type { EventCard, ReplyCard, ReplyCardState, ReplyDocument } from "../shared/reply-cards";
import "./experience.css";
import { When } from "./When";

const emptyState = (): ReplyCardState => ({ checkedIds: [], notes: {} });
function CalendarProposal({ card }: { card: EventCard }) {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  function download() {
    const url = URL.createObjectURL(new Blob([eventCalendarFile(card)], { type: "text/calendar;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = `${card.id}.ics`;
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <>
    <p><When value={card.start} relative={false} />{card.end && <> to <When value={card.end} relative={false} from={card.start} /></>}</p>
    {card.location && <p>{card.location}</p>}
    <Button type="button" onClick={() => setOpen(true)}>Review calendar event</Button>
    <Dialog open={open} className="event-proposal-dialog" aria-labelledby={titleId} onCancel={() => setOpen(false)} onClose={() => setOpen(false)}>
      <header><h2 id={titleId}>{card.title}</h2><Button type="button" onClick={() => setOpen(false)}>Close</Button></header>
      <dl><dt>Starts</dt><dd><When value={card.start} relative={false} /></dd>
        {card.end && <><dt>Ends</dt><dd><When value={card.end} relative={false} /></dd></>}
        {card.location && <><dt>Location</dt><dd>{card.location}</dd></>}
      </dl>
      {card.description && <p className="preserve-lines">{card.description}</p>}
      <p className="muted">Review the details before saving. This proposal has not added anything to your calendar.</p>
      <div className="actions"><a className="button-link" href={eventGoogleCalendarUrl(card)} target="_blank" rel="noopener noreferrer">Open in Google Calendar</a>
        <Button type="button" onClick={download}>Download calendar file</Button></div>
    </Dialog>
  </>;
}
function InteractiveCard({ card, botId, messageId, userId, unavailable }: { card: ReplyCard; botId?: string; messageId?: string; userId?: string; unavailable?: boolean }) {
  const [saved, setSaved] = useState<ReplyCardState>(emptyState);
  const [draft, setDraft] = useState<ReplyCardState>(emptyState);
  const [editing, setEditing] = useState<string | null>(null);
  const path = botId && messageId && userId ? `/bots/${encodeURIComponent(botId)}/messages/${encodeURIComponent(messageId)}/cards/${encodeURIComponent(card.id)}/state` : undefined;
  const accept = (state: ReplyCardState) => { setSaved(state); setDraft(state); };
  const stored = useResource<ReplyCardState>(card.type === "event" ? null : path ?? null, { onData: accept });
  const saving = useAction();
  function save(next: ReplyCardState) {
    if (!path || saving.busy) return;
    setDraft(next);
    void saving.run(async ({ current }) => {
      const result = await write<ReplyCardState>(path, next, "PUT");
      if (current()) { accept(result); setEditing(null); }
    });
  }
  const reload = () => { saving.setError(""); void stored.reload(); };
  const error = saving.error || stored.error;
  const busy = stored.loading || saving.busy || unavailable || !path;
  const failedSave = !!saving.error && JSON.stringify(saved) !== JSON.stringify(draft);
  return <section className={`reply-card reply-card-${card.type}`} aria-label={card.title}>
    <div className="reply-card-heading"><span className="eyebrow">{card.type === "event" ? "Calendar proposal" : card.type === "itinerary" ? "Itinerary" : "Checklist"}</span>
      {card.type === "checklist" && <span className="muted">{saved.checkedIds.length} / {card.items.length}</span>}</div>
    <h3>{card.title}</h3>
    {card.type === "checklist" && <ul className="reply-checklist">{card.items.map(item => <li key={item.id}><label>
      <Input type="checkbox" checked={draft.checkedIds.includes(item.id)} disabled={busy || !!error} onChange={e => void save({ ...draft,
        checkedIds: e.target.checked ? [...draft.checkedIds, item.id] : draft.checkedIds.filter(id => id !== item.id) })} />
      <span>{item.text}</span></label></li>)}</ul>}
    {card.type === "itinerary" && <ol className="reply-itinerary">{card.items.map(item => <li key={item.id}>
      {item.time && <span className="eyebrow">{item.time}</span>}<h4>{item.title}</h4>
      {item.detail && <p>{item.detail}</p>}{draft.notes[item.id] && editing !== item.id && <p className="preserve-lines">Your note: {draft.notes[item.id]}</p>}
      {item.url && <a href={item.url} target="_blank" rel="noopener noreferrer">Open details</a>}
      {editing === item.id ? <div className="itinerary-edit"><label>Your itinerary note<Textarea maxLength={2000} rows={3}
        value={draft.notes[item.id] || ""} onChange={e => setDraft({ ...draft, notes: { ...draft.notes, [item.id]: e.target.value } })} /></label>
        <div className="actions"><Button type="button" disabled={busy} onClick={() => void save(draft)}>Save note</Button><Button type="button" disabled={busy}
          onClick={() => { setDraft(saved); setEditing(null); }}>Cancel</Button></div></div>
        : <Button type="button" className="itinerary-note-button" disabled={busy || !!error} onClick={() => setEditing(item.id)}>{draft.notes[item.id] ? "Edit note" : "Add note"}</Button>}
    </li>)}</ol>}
    {card.type === "event" && <CalendarProposal card={card} />}
    {card.type !== "event" && <small className="muted">Checks and notes are saved for your account. The assistant's proposal stays in the conversation.</small>}
    {error && <div role="alert" className="form-error"><p>{error}</p>{failedSave ? <Button type="button" disabled={unavailable} onClick={() => void save(draft)}>Retry saving</Button>
      : <Button type="button" disabled={unavailable} onClick={reload}>Reload saved state</Button>}</div>}
    {saving.busy && <span role="status">Saving...</span>}
  </section>;
}
export function ReplyCards({ document, botId, messageId, userId, unavailable }: { document: ReplyDocument; botId?: string; messageId?: string; userId?: string; unavailable?: boolean }) {
  return <div className="reply-cards">{document.cards.map(card => <InteractiveCard key={`${userId}:${botId}:${messageId}:${card.id}`} card={card} botId={botId} messageId={messageId} userId={userId} unavailable={unavailable} />)}</div>;
}
