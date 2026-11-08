import { useContext, useEffect, useId, useRef, useState } from "react";
import { ApiError, request } from "../client-api";
import { MAX_MESSAGE_TEXT } from "../shared/api";
import { fieldEntry, formAnswerText, formProblems, formStart } from "../shared/reply-cards";
import type { FormAnswers, FormCard, FormField, FormValue } from "../shared/reply-cards";
import { formRequestId } from "../shared/retry-id";
import type { SubmissionReceipt } from "../shared/types";
import { formReplyKey, localRead, localSave } from "../app/storage";
import { TranscriptTools } from "../app/ReplyActions";
import { useReceiptCheck } from "../app/use-receipt-check";
import { reactAvatar } from "./avatar-attention";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { NativeSelect } from "./ui/native-select";
import { Textarea } from "./ui/textarea";
import { Icon } from "./Icon";

/**
 * What this browser keeps for one form: the answers as the person left them, which attempt they
 * are on, and whether that attempt is on its way, sent, or caught by a Hermes restart. A checking
 * attempt keeps the exact request ID it went under. `elsewhere` marks an attempt another tab or
 * device sent, whose answers this one never saw.
 */
export type Saved = { attempt: number; answers: FormAnswers; state: "editing" | "checking" | "sent" | "interrupted"; requestId?: string; elsewhere?: boolean };
type Status = "looking" | "editing" | "sending" | "checking" | "sent" | "interrupted";
/** The one request a check follows: its ID, attempt and the answers it carried. */
type Pending = { id: string; attempt: number; answers: FormAnswers; elsewhere: boolean };
const isAnswers = (value: unknown): value is FormAnswers => typeof value === "object" && value !== null && !Array.isArray(value)
  && Object.values(value).every(entry => typeof entry === "string" || typeof entry === "boolean" || Array.isArray(entry) && entry.every(item => typeof item === "string"));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The saved record, or null. A checking record whose ID is missing or malformed keeps its answers and derives the ID again. */
function readSaved(key: string): Saved | null {
  const value = localRead<Partial<Saved>>(key);
  if (!value || !Number.isInteger(value.attempt) || value.attempt! < 0 || !isAnswers(value.answers)
    || !["editing", "checking", "sent", "interrupted"].includes(value.state!)) return null;
  const { requestId, ...rest } = value as Saved;
  return typeof requestId === "string" && uuid.test(requestId) ? { ...rest, requestId } : rest;
}
// Answers saved for an earlier version of the card keep only the fields it still has.
const restore = (card: FormCard, answers: FormAnswers): FormAnswers => {
  const start = formStart(card);
  return Object.fromEntries(card.fields.map(field => [field.id, fieldEntry(answers, field.id) ?? fieldEntry(start, field.id)!]));
};
/** How far a record has got within its attempt. Only its own request's refusal moves one back. */
// A Hermes restart turns an accepted request into an interrupted one and never the reverse, so
// interrupted is the later word on a request.
const progress: Record<Saved["state"], number> = { editing: 0, checking: 1, sent: 2, interrupted: 3 };
/**
 * What a write says about itself: `from`, the attempt it happened to when it moves the form on to
 * the next one, and `owns`, the request it settles.
 */
type Change = { from?: number; owns?: string };
/**
 * Whether `next` may replace the saved record. Several copies of a card, in other tabs or left open
 * while a request was out, share one record, so a stale copy must never undo another's progress:
 * - a later attempt's record is never overwritten by what happened to an earlier one, and moving on
 *   from attempt `from` counts as happening to `from`;
 * - within an attempt a record never goes back, from checking, sent or interrupted to editing,
 *   except when the copy that owns the checking request learns the server refused it outright;
 * - at the same point, a record that only knows the answers went from elsewhere never replaces
 *   one that holds them.
 * iOS applies the same rule in `FormRecords.mayReplace`.
 */
export function mayReplace(stored: Saved | null, next: Saved, { from = next.attempt, owns }: Change = {}): boolean {
  if (!stored) return true;
  if (stored.attempt > from) return false;
  if (stored.attempt !== next.attempt) return true;
  const ahead = progress[next.state] - progress[stored.state];
  if (ahead > 0) return true;
  // At the same point, a record that knows the answers outranks one that only knows they went.
  if (ahead === 0) return !next.elsewhere || !!stored.elsewhere;
  return stored.state === "checking" && owns !== undefined && stored.requestId === owns;
}
/**
 * A record that only knows the answers went from elsewhere keeps the answers another copy saw
 * admitted for the same attempt, so learning of a restart, say, never loses them.
 */
export function keepKnownAnswers(stored: Saved | null, next: Saved): Saved {
  if (!next.elsewhere || !stored || stored.elsewhere || stored.attempt !== next.attempt || progress[stored.state] < progress.sent) return next;
  const { elsewhere: _, ...known } = next;
  return { ...known, answers: stored.answers };
}
/**
 * What to save when `next` arrives: `next` itself when it may replace the record, with any answers
 * the record already knew; otherwise, when `next` holds admitted answers the record lacks, the record
 * as it stands with those answers in it, since its status may not go back but the answers still
 * belong to it; otherwise nothing.
 */
export function nextRecord(stored: Saved | null, next: Saved, change: Change = {}): Saved | null {
  if (mayReplace(stored, next, change)) return keepKnownAnswers(stored, next);
  if (!stored?.elsewhere || next.elsewhere || stored.attempt !== next.attempt || progress[next.state] < progress.sent) return null;
  const { elsewhere: _, ...known } = stored;
  return { ...known, answers: next.answers };
}
const refused = "Hermes didn't take your answers.";
const unconfirmed = "Hermes hasn't confirmed your answers yet. They're being checked and won't be sent twice.";
/**
 * Attempts checked on open. Each attempt past the first exists only because Hermes refused the one
 * before, so a real form never comes near this. Stopping here is still safe: Send uses this
 * attempt's ID, which the server admits at most once.
 */
const lookupLimit = 100;

/**
 * A form the assistant asked the person to fill in. Send posts the answers as the person's own
 * message through the message box's admission path, never reading or changing the draft. The
 * request ID comes from the person, message, card and attempt, so every tab and device sends the
 * same request and the server admits it once. An answer that may have reached Hermes is checked by
 * that ID until a receipt settles it. Only a refusal from Hermes moves the form to a new attempt on
 * its own. A Hermes restart marks an admitted request interrupted, so the answers may have arrived:
 * the person checks the conversation and chooses to send them again.
 */
export function FormReplyCard({ card, botId, messageId, userId, unavailable }: { card: FormCard; botId: string; messageId: string; userId: string; unavailable?: boolean }) {
  const key = formReplyKey(userId, botId, messageId, card.id);
  const tools = useContext(TranscriptTools);
  // Every client of this server has the key. Outside a conversation, as in a lone preview, the ID
  // falls back to the person's ID: still one per person, though not private.
  const personKey = tools?.formKey ?? userId;
  const [first] = useState(() => readSaved(key));
  const [answers, setAnswers] = useState<FormAnswers>(() => first ? restore(card, first.answers) : formStart(card));
  const [attempt, setAttempt] = useState(first?.attempt ?? 0);
  const [elsewhere, setElsewhere] = useState(!!first?.elsewhere);
  // With nothing saved here, another tab or device may already have sent this form.
  const [status, setStatus] = useState<Status>(first ? first.state : "looking");
  const [pending, setPending] = useState<Pending | null>(() => first?.state === "checking" && first.requestId
    ? { id: first.requestId, attempt: first.attempt, answers: first.answers, elsewhere: !!first.elsewhere } : null);
  const [problems, setProblems] = useState<Record<string, string>>(() => Object.create(null));
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const formId = useId();
  const save = (next: Saved, change: Change = {}) => {
    const record = nextRecord(readSaved(key), next, change);
    if (record) localSave(key, record);
  };
  // A checking record saved without a usable ID follows the ID its attempt derives.
  const recovering = status === "checking" && !pending;
  useEffect(() => {
    if (!recovering || !first) return;
    let live = true;
    void formRequestId(personKey, botId, messageId, card.id, first.attempt).then(id => {
      if (live) setPending({ id, attempt: first.attempt, answers: restore(card, first.answers), elsewhere: !!first.elsewhere });
    });
    return () => { live = false; };
  }, [recovering]);

  // Attempts run in order and each one only after Hermes refused the one before, so the lookup
  // skips refusals until the first attempt that was not refused, which tells where the form stands.
  const looking = status === "looking";
  useEffect(() => {
    if (!looking) return;
    let live = true;
    void (async () => {
      for (let next = 0; ; next++) {
        if (next === lookupLimit) { setAttempt(next); setStatus("editing"); return; }
        let receipt: SubmissionReceipt | null = null;
        try { receipt = await request("GET /submissions/:id", { params: { id: await formRequestId(personKey, botId, messageId, card.id, next) } }); }
        catch { /* Unknown: the person may send, and the server admits the request once. */ }
        if (!live) return;
        if (receipt?.status === "rejected") continue;
        const found: Saved = { attempt: next, answers: formStart(card), state: receipt?.status === "accepted" ? "sent" : receipt?.status === "interrupted" ? "interrupted" : "editing",
          ...(receipt?.status === "accepted" || receipt?.status === "interrupted" ? { elsewhere: true } : {}) };
        setAttempt(next); setElsewhere(!!found.elsewhere); setStatus(found.state);
        if (found.state !== "editing") save(found);
        return;
      }
    })();
    return () => { live = false; };
  }, [looking]);

  /** Settles the one request `from` names, with the attempt and answers it carried. */
  const settle = (from: Pending, receipt: SubmissionReceipt) => {
    // Another copy may have sent different answers under the same ID. The server's record of the
    // text says whose went; only matching text makes these answers the ones that were sent.
    const theirs = from.elsewhere || receipt.text !== undefined && receipt.text !== formAnswerText(card, from.answers);
    const kept = theirs ? { attempt: from.attempt, answers: formStart(card), elsewhere: true } : { attempt: from.attempt, answers: from.answers };
    if (theirs) setElsewhere(true);
    if (receipt.status === "accepted") {
      setPending(null); setStatus("sent"); setError(""); save({ ...kept, state: "sent" });
      reactAvatar(botId, "cheer");
    } else if (receipt.status === "rejected") {
      // A refused ID stays refused, so the person's next Send is a new attempt.
      setPending(null); setAttempt(from.attempt + 1); setStatus("editing"); setElsewhere(false); setAnswers(from.answers);
      setError(receipt.message ? `${refused} ${receipt.message}` : refused);
      save({ attempt: from.attempt + 1, answers: from.answers, state: "editing" }, { from: from.attempt });
    } else if (receipt.status === "interrupted") {
      setPending(null); setStatus("interrupted"); setError(""); save({ ...kept, state: "interrupted" });
    } else {
      setPending(from); setStatus("checking"); setError(unconfirmed); save({ ...kept, state: "checking", requestId: from.id });
    }
  };
  useReceiptCheck(status === "checking" ? pending?.id : undefined, receipt => { if (pending) settle(pending, receipt); });
  // After a restart, the person decides whether the answers arrived; sending again is a new attempt.
  const sendAgain = () => {
    setAttempt(attempt + 1); setElsewhere(false); setStatus("editing"); setError("");
    save({ attempt: attempt + 1, answers, state: "editing" }, { from: attempt });
  };

  async function send() {
    if (inFlight.current || status !== "editing" || unavailable) return;
    const found = formProblems(card, answers);
    setProblems(found);
    const invalid = card.fields.find(field => fieldEntry(found, field.id));
    if (invalid) {
      setError("");
      document.getElementById(`${formId}-${invalid.id}`)?.focus();
      return;
    }
    const text = formAnswerText(card, answers);
    if (text.length > MAX_MESSAGE_TEXT) {
      setError(`Your answers are ${(text.length - MAX_MESSAGE_TEXT).toLocaleString("en-US")} characters too long to send. Shorten the longest one.`);
      return;
    }
    inFlight.current = true; setStatus("sending"); setError("");
    try {
      const from: Pending = { id: await formRequestId(personKey, botId, messageId, card.id, attempt), attempt, answers, elsewhere: false };
      // Saved first, so leaving while the request is out checks it on return. If saving fails, the
      // same request ID still keeps a second Send from being admitted.
      save({ attempt, answers, state: "checking", requestId: from.id });
      try {
        settle(from, await request("POST /bots/:id/messages", { params: { id: botId },
          body: { requestId: from.id, text, attachments: [], ...(tools?.reviewedInterruption && { reviewedInterruption: true }) } }));
      } catch (cause) {
        if (cause instanceof ApiError && cause.code === "submission_conflict") {
          // Another tab or device sent different answers under this attempt's ID. Follow that one.
          const theirs = { ...from, elsewhere: true };
          setElsewhere(true); setPending(theirs); setStatus("checking"); setError("");
          save({ attempt, answers, state: "checking", requestId: from.id, elsewhere: true });
        } else if (cause instanceof ApiError && cause.status < 500) {
          // Refused before Hermes saw it, so this attempt's ID is still free.
          setStatus("editing"); setError(cause.message || refused); save({ attempt, answers, state: "editing" }, { owns: from.id });
        } else {
          setPending(from); setStatus("checking"); setError(unconfirmed);
        }
      }
    } finally {
      inFlight.current = false;
    }
  }

  const set = (field: FormField, value: FormValue) => {
    const next = { ...answers, [field.id]: value };
    setAnswers(next);
    if (status === "editing") save({ attempt, answers: next, state: "editing" });
    if (fieldEntry(problems, field.id)) setProblems(current => {
      const rest: Record<string, string> = Object.create(null);
      for (const [id, problem] of Object.entries(current)) if (id !== field.id) rest[id] = problem;
      return rest;
    });
  };
  if (status === "interrupted") return <>
    {card.description && <p className="preserve-lines">{card.description}</p>}
    <p role="status">Hermes restarted while it had {elsewhere ? "answers to this form" : "your answers"}, so they may or may not have arrived. Check the conversation above.</p>
    <div className="actions"><Button type="button" disabled={unavailable} onClick={sendAgain}>They didn't arrive. Edit and send again</Button></div>
  </>;
  if (status === "sent") return <>
    {card.description && <p className="preserve-lines">{card.description}</p>}
    {elsewhere ? <p className="muted">Your answers were sent from another tab or device.</p>
      : <dl className="form-reply-answers">{card.fields.map(field => <div key={field.id}><dt>{field.label}</dt><dd className="preserve-lines">{shown(fieldEntry(answers, field.id))}</dd></div>)}</dl>}
    <p className="form-reply-sent" role="status"><Icon name="check" size={16} /> Sent</p>
  </>;
  const locked = status !== "editing";
  return <form className="form-reply" noValidate aria-busy={status === "sending" || status === "looking"} onSubmit={event => { event.preventDefault(); void send(); }}>
    {card.description && <p className="preserve-lines">{card.description}</p>}
    {card.fields.map(field => <FieldInput key={field.id} id={`${formId}-${field.id}`} field={field} value={fieldEntry(answers, field.id)} problem={fieldEntry(problems, field.id)}
      disabled={locked} onChange={value => set(field, value)} />)}
    {error && <p role="alert" className="form-error">{error}</p>}
    <div className="actions">
      <Button type="submit" className="primary with-progress" disabled={locked || unavailable}>
        {status !== "editing" && <Icon name="spinner" className="spin" size={16} />}
        {status === "sending" ? "Sending…" : status === "checking" ? "Checking…" : card.submitLabel ?? "Send answers"}
      </Button>
    </div>
    {unavailable && status === "editing" && <small className="muted">Reconnect to send your answers.</small>}
  </form>;
}
function shown(value: FormValue | undefined) {
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "No answer";
  return value?.trim() || "No answer";
}

function FieldInput({ id, field, value, problem, disabled, onChange }: {
  id: string; field: FormField; value: FormValue | undefined; problem?: string; disabled: boolean; onChange(value: FormValue): void;
}) {
  const help = field.help ? `${id}-help` : undefined, error = problem ? `${id}-error` : undefined;
  const described = [help, error].filter(Boolean).join(" ") || undefined;
  const notes = <>{field.help && <small id={help} className="muted">{field.help}</small>}{problem && <small id={error} className="form-reply-problem">{problem}</small>}</>;
  // The star is for the eye; a screen reader hears "required" with the label.
  const label = <>{field.label}{field.required && <><span className="form-reply-required" aria-hidden="true"> *</span><span className="sr-only"> (required)</span></>}</>;
  const shared = { id, disabled, required: field.required, "aria-invalid": !!problem || undefined, "aria-describedby": described };
  if (field.kind === "choice" || field.kind === "multi") {
    const chosen = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
    return <fieldset className="form-reply-field form-reply-options" role={field.kind === "choice" ? "radiogroup" : "group"}
      aria-required={field.kind === "choice" && field.required ? true : undefined} aria-describedby={described} aria-invalid={!!problem || undefined}>
      <legend className="form-reply-label">{label}</legend>{notes}
      {field.options!.map((option, index) => <label key={option} className="form-reply-option">
        <Input type={field.kind === "choice" ? "radio" : "checkbox"} id={index === 0 ? id : undefined} name={id} disabled={disabled} checked={chosen.includes(option)}
          onChange={event => onChange(field.kind === "choice" ? option : event.target.checked ? [...chosen, option] : chosen.filter(entry => entry !== option))} />
        <span>{option}</span>
      </label>)}
    </fieldset>;
  }
  if (field.kind === "toggle") return <div className="form-reply-field form-reply-toggle">
    <label><Input type="checkbox" role="switch" {...shared} checked={value === true} onChange={event => onChange(event.target.checked)} /><span>{label}</span></label>{notes}
  </div>;
  const text = typeof value === "string" ? value : "";
  return <div className="form-reply-field">
    <label className="form-reply-label" htmlFor={id}>{label}</label>
    {field.kind === "textarea" ? <Textarea {...shared} rows={3} maxLength={4000} placeholder={field.placeholder} value={text} onChange={event => onChange(event.target.value)} />
      : field.kind === "select" ? <NativeSelect {...shared} value={text} onChange={event => onChange(event.target.value)}>
        <option value="">Choose…</option>{field.options!.map(option => <option key={option} value={option}>{option}</option>)}
      </NativeSelect>
      : <Input {...shared} type={field.kind === "number" ? "number" : field.kind === "date" ? "date" : "text"} inputMode={field.kind === "number" ? "decimal" : undefined}
        maxLength={field.kind === "text" ? 4000 : undefined} placeholder={field.placeholder} value={text} onChange={event => onChange(event.target.value)} />}
    {notes}
  </div>;
}
