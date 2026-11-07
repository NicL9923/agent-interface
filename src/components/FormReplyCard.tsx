import { useId, useRef, useState } from "react";
import { ApiError, request } from "../client-api";
import { formAnswerText, formProblems, formStart } from "../shared/reply-cards";
import type { FormAnswers, FormCard, FormField, FormValue } from "../shared/reply-cards";
import type { SubmissionReceipt } from "../shared/types";
import { formReplyKey, localRead, localRemove, localSave } from "../app/storage";
import { useReceiptCheck } from "../app/use-receipt-check";
import { reactAvatar } from "./avatar-attention";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { NativeSelect } from "./ui/native-select";
import { Textarea } from "./ui/textarea";
import { Icon } from "./Icon";

/**
 * Answers on their way, or sent. Saved before the request goes, so a reload, a crash or a second
 * look checks the same request by its ID and never sends the answers twice.
 */
type Attempt = { requestId: string; answers: FormAnswers; state: "checking" | "sent" };
const validAttempt = (value: unknown): value is Attempt => {
  const attempt = value as Attempt | null;
  return !!attempt && typeof attempt.requestId === "string" && typeof attempt.answers === "object" && attempt.answers !== null
    && (attempt.state === "checking" || attempt.state === "sent");
};
const refused = "Hermes didn't take your answers.";
const unconfirmed = "Hermes hasn't confirmed your answers yet. They're being checked and won't be sent twice.";

/**
 * A form the assistant asked the person to fill in. Send posts the answers as the person's own
 * message through the same admission path as the message box, with its own request ID, so the
 * person's draft is never read or changed. An answer that may have reached Hermes is checked by
 * its ID until a receipt settles it, never sent again.
 */
export function FormReplyCard({ card, botId, messageId, userId, unavailable }: { card: FormCard; botId: string; messageId: string; userId: string; unavailable?: boolean }) {
  const key = formReplyKey(userId, botId, messageId, card.id);
  const [attempt, setAttempt] = useState<Attempt | null>(() => { const saved = localRead<unknown>(key); return validAttempt(saved) ? saved : null; });
  const [answers, setAnswers] = useState<FormAnswers>(() => attempt?.answers ?? formStart(card));
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const inFlight = useRef(false);
  const formId = useId();
  const record = (next: Attempt | null) => {
    if (next) localSave(key, next); else localRemove(key);
    setAttempt(next);
  };
  // A refused answer comes back to the form as the person left it, with the reason.
  const refuse = (from: Attempt, reason: string) => { record(null); setAnswers(from.answers); setError(reason); };
  const settle = (from: Attempt, receipt: SubmissionReceipt) => {
    if (receipt.status === "accepted") { record({ ...from, state: "sent" }); setError(""); reactAvatar(botId, "cheer"); }
    else if (receipt.status === "rejected" || receipt.status === "interrupted") refuse(from, receipt.message ? `${refused} ${receipt.message}` : refused);
    else { record(from); setError(unconfirmed); }
  };
  // A request that may have reached Hermes is checked by its ID once nothing is sending it.
  const checking = attempt?.state === "checking" && !sending ? attempt : null;
  useReceiptCheck(checking?.requestId, receipt => { if (checking) settle(checking, receipt); });

  async function send() {
    if (inFlight.current || attempt || unavailable) return;
    const found = formProblems(card, answers);
    setProblems(found);
    const first = card.fields.find(field => found[field.id]);
    if (first) {
      setError("");
      document.getElementById(`${formId}-${first.id}`)?.focus();
      return;
    }
    inFlight.current = true; setSending(true); setError("");
    const next: Attempt = { requestId: crypto.randomUUID(), answers, state: "checking" };
    // Saved before sending: leaving while the request is in flight must check it, not send it again.
    record(next);
    try {
      settle(next, await request("POST /bots/:id/messages", { params: { id: botId }, body: { requestId: next.requestId, text: formAnswerText(card, answers), attachments: [] } }));
    } catch (cause) {
      // Only a request the server refused outright never reached Hermes.
      if (cause instanceof ApiError && cause.status < 500) refuse(next, cause.message || refused);
      else setError(unconfirmed);
    } finally {
      inFlight.current = false; setSending(false);
    }
  }

  const set = (field: FormField, value: FormValue) => {
    setAnswers(current => ({ ...current, [field.id]: value }));
    if (problems[field.id]) setProblems(({ [field.id]: _, ...rest }) => rest);
  };
  if (attempt?.state === "sent") return <>
    {card.description && <p className="preserve-lines">{card.description}</p>}
    <dl className="form-reply-answers">{card.fields.map(field => <div key={field.id}><dt>{field.label}</dt><dd className="preserve-lines">{shown(attempt.answers[field.id])}</dd></div>)}</dl>
    <p className="form-reply-sent" role="status"><Icon name="check" size={16} /> Sent</p>
  </>;
  const locked = !!attempt || sending;
  return <form className="form-reply" noValidate aria-busy={sending} onSubmit={event => { event.preventDefault(); void send(); }}>
    {card.description && <p className="preserve-lines">{card.description}</p>}
    {card.fields.map(field => <FieldInput key={field.id} id={`${formId}-${field.id}`} field={field} value={answers[field.id]} problem={problems[field.id]} disabled={locked} onChange={value => set(field, value)} />)}
    {error && <p role="alert" className="form-error">{error}</p>}
    <div className="actions">
      <Button type="submit" className="primary with-progress" disabled={locked || unavailable}>
        {(sending || attempt) && <Icon name="spinner" className="spin" size={16} />}
        {sending ? "Sending…" : attempt ? "Checking…" : card.submitLabel ?? "Send answers"}
      </Button>
    </div>
    {unavailable && !attempt && <small className="muted">Reconnect to send your answers.</small>}
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
  const label = <>{field.label}{field.required && <span className="form-reply-required" aria-hidden="true"> *</span>}</>;
  const shared = { id, disabled, required: field.required, "aria-invalid": !!problem || undefined, "aria-describedby": described };
  if (field.kind === "choice" || field.kind === "multi") {
    const chosen = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
    return <fieldset className="form-reply-field form-reply-options" aria-describedby={described} aria-invalid={!!problem || undefined}>
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
