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
 * are on, and whether that attempt is on its way or sent. `elsewhere` marks an attempt another
 * tab or device sent, whose answers this one never saw.
 */
type Saved = { attempt: number; answers: FormAnswers; state: "editing" | "checking" | "sent"; elsewhere?: boolean };
type Status = "looking" | "editing" | "sending" | "checking" | "sent";
const isAnswers = (value: unknown): value is FormAnswers => typeof value === "object" && value !== null && !Array.isArray(value)
  && Object.values(value).every(entry => typeof entry === "string" || typeof entry === "boolean" || Array.isArray(entry) && entry.every(item => typeof item === "string"));
function readSaved(key: string): Saved | null {
  const value = localRead<Partial<Saved>>(key);
  return value && Number.isInteger(value.attempt) && value.attempt! >= 0 && isAnswers(value.answers)
    && (value.state === "editing" || value.state === "checking" || value.state === "sent") ? value as Saved : null;
}
// Answers saved for an earlier version of the card keep only the fields it still has.
const restore = (card: FormCard, answers: FormAnswers): FormAnswers => {
  const start = formStart(card);
  return Object.fromEntries(card.fields.map(field => [field.id, fieldEntry(answers, field.id) ?? fieldEntry(start, field.id)!]));
};
const refused = "Hermes didn't take your answers.";
const unconfirmed = "Hermes hasn't confirmed your answers yet. They're being checked and won't be sent twice.";
// A form refused this many times by Hermes is past any lookup worth making on open.
const lookups = 5;

/**
 * A form the assistant asked the person to fill in. Send posts the answers as the person's own
 * message through the message box's admission path, never reading or changing the draft. The
 * request ID comes from the person, message, card and attempt, so every tab and device sends the
 * same request and the server admits it once. An answer that may have reached Hermes is checked by
 * that ID until a receipt settles it. Only a refusal from Hermes moves the form to a new attempt.
 */
export function FormReplyCard({ card, botId, messageId, userId, unavailable }: { card: FormCard; botId: string; messageId: string; userId: string; unavailable?: boolean }) {
  const key = formReplyKey(userId, botId, messageId, card.id);
  const tools = useContext(TranscriptTools);
  const [first] = useState(() => readSaved(key));
  const [answers, setAnswers] = useState<FormAnswers>(() => first ? restore(card, first.answers) : formStart(card));
  const [attempt, setAttempt] = useState(first?.attempt ?? 0);
  const [elsewhere, setElsewhere] = useState(!!first?.elsewhere);
  // With nothing saved here, another tab or device may already have sent this form.
  const [status, setStatus] = useState<Status>(first ? first.state : "looking");
  const [requestId, setRequestId] = useState<string>();
  const [problems, setProblems] = useState<Record<string, string>>(() => Object.create(null));
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const formId = useId();
  const save = (next: Saved) => localSave(key, next);

  useEffect(() => {
    let live = true;
    void formRequestId(userId, botId, messageId, card.id, attempt).then(id => { if (live) setRequestId(id); });
    return () => { live = false; };
  }, [userId, botId, messageId, card.id, attempt]);

  // Each attempt Hermes refused is skipped; the first one accepted means the form was sent.
  const looking = status === "looking";
  useEffect(() => {
    if (!looking) return;
    let live = true;
    void (async () => {
      let next = 0;
      for (; next < lookups; next++) {
        let receipt: SubmissionReceipt | null = null;
        try { receipt = await request("GET /submissions/:id", { params: { id: await formRequestId(userId, botId, messageId, card.id, next) } }); }
        catch { /* Unknown: the person may send, and the server admits the request once. */ }
        if (!live) return;
        if (receipt?.status === "accepted") {
          setAttempt(next); setElsewhere(true); setStatus("sent");
          save({ attempt: next, answers: formStart(card), state: "sent", elsewhere: true });
          return;
        }
        if (receipt?.status !== "rejected" && receipt?.status !== "interrupted") break;
      }
      setAttempt(next); setStatus("editing");
    })();
    return () => { live = false; };
  }, [looking]);

  const settle = (from: { attempt: number; answers: FormAnswers }, receipt: SubmissionReceipt, sentElsewhere: boolean) => {
    if (receipt.status === "accepted") {
      setStatus("sent"); setError(""); save({ ...from, state: "sent", ...(sentElsewhere && { elsewhere: true }) });
      reactAvatar(botId, "cheer");
    } else if (receipt.status === "rejected" || receipt.status === "interrupted") {
      // A refused ID stays refused, so the person's next Send is a new attempt.
      setAttempt(from.attempt + 1); setStatus("editing"); setElsewhere(false); setAnswers(from.answers);
      setError(receipt.message ? `${refused} ${receipt.message}` : refused);
      save({ attempt: from.attempt + 1, answers: from.answers, state: "editing" });
    } else {
      setStatus("checking"); setError(unconfirmed); save({ ...from, state: "checking", ...(sentElsewhere && { elsewhere: true }) });
    }
  };
  useReceiptCheck(status === "checking" ? requestId : undefined, receipt => settle({ attempt, answers }, receipt, elsewhere));

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
    const from = { attempt, answers };
    // Saved first, so leaving while the request is out checks it on return. If saving fails, the
    // same request ID still keeps a second Send from being admitted.
    save({ ...from, state: "checking" });
    try {
      const id = await formRequestId(userId, botId, messageId, card.id, attempt);
      settle(from, await request("POST /bots/:id/messages", { params: { id: botId },
        body: { requestId: id, text, attachments: [], ...(tools?.reviewedInterruption && { reviewedInterruption: true }) } }), false);
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "submission_conflict") {
        // Another tab or device sent different answers under this attempt's ID. Follow that one.
        setElsewhere(true); setStatus("checking"); setError(""); save({ ...from, state: "checking", elsewhere: true });
      } else if (cause instanceof ApiError && cause.status < 500) {
        // Refused before Hermes saw it, so this attempt's ID is still free.
        setStatus("editing"); setError(cause.message || refused); save({ ...from, state: "editing" });
      } else {
        setStatus("checking"); setError(unconfirmed);
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
