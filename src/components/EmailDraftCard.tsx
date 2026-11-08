import { createContext, useContext, useMemo, useState } from "react";
import { emailGmailUrl, emailMailtoUrl, emailText } from "../shared/reply-cards";
import type { EmailCard } from "../shared/reply-cards";
import { draftChanges, draftKey, type AddressPart, type DiffPart } from "../shared/draft-diff";
import { Button } from "./ui/button";
import { Icon } from "./Icon";

/** The earlier draft each email card in the conversation revises, by draftKey; see draftRevisions. */
export const DraftRevisions = createContext<Map<string, EmailCard>>(new Map());
/** The draft this card revises, when the conversation holds it. */
export const useRevisedDraft = (messageId: string | undefined, cardId: string) => {
  const revisions = useContext(DraftRevisions);
  return messageId ? revisions.get(draftKey(messageId, cardId)) : undefined;
};

const blank = (text: string) => !/[^ \t\r\n]/.test(text);
/** Changed words marked in place. Screen readers hear "added" and "removed" before each change. */
function DiffText({ parts }: { parts: DiffPart[] }) {
  return <>{parts.map((part, index) => part.kind === "same" ? <span key={index}>{part.text}</span>
    : part.kind === "added" ? <ins key={index} className={`draft-added${blank(part.text) ? " draft-space" : ""}`}><span className="sr-only">Added: </span>{part.text}</ins>
    : <del key={index} className={`draft-removed${blank(part.text) ? " draft-space" : ""}`}><span className="sr-only">Removed: </span>{part.text}</del>)}</>;
}
function Addresses({ parts }: { parts: AddressPart[] }) {
  return <>{parts.map((part, index) => <span key={index}>{index > 0 && ", "}{part.kind === "same" ? part.address
    : part.kind === "added" ? <ins className="draft-added"><span className="sr-only">Added: </span>{part.address}</ins>
    : <del className="draft-removed"><span className="sr-only">Removed: </span>{part.address}</del>}</span>)}</>;
}

/**
 * An email the assistant drafted. It only ever leaves through the person's own mail app or Gmail's
 * compose window, where they review it and press Send themselves. A draft that revises an earlier
 * one in the conversation marks what changed, until the person hides the changes.
 */
export function EmailDraftCard({ card, previous }: { card: EmailCard; previous?: EmailCard }) {
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const changes = useMemo(() => previous && draftChanges(previous, card), [previous, card]);
  const [hidden, setHidden] = useState(false);
  const marked = !!changes?.changed && !hidden;
  async function copyDraft() {
    try {
      await navigator.clipboard.writeText(emailText(card));
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
  }
  return <>
    {changes && <div className="email-draft-revision">
      <span className="muted">{changes.changed ? `Revises “${previous!.title}”` : `Same as “${previous!.title}”`}</span>
      {changes.changed && <Button type="button" onClick={() => setHidden(value => !value)}>
        <Icon name={hidden ? "pencil" : "check"} size={16} /> {hidden ? "Show changes" : "Hide changes"}</Button>}
    </div>}
    <dl className="email-draft-headers">
      {(marked ? changes.to.length > 0 : card.to) && <div><dt>To</dt><dd>{marked ? <Addresses parts={changes.to} /> : card.to!.join(", ")}</dd></div>}
      {(marked ? changes.cc.length > 0 : card.cc) && <div><dt>Cc</dt><dd>{marked ? <Addresses parts={changes.cc} /> : card.cc!.join(", ")}</dd></div>}
      <div><dt>Subject</dt><dd>{marked && changes.subject.length ? <DiffText parts={changes.subject} /> : card.subject ?? <span className="muted">No subject</span>}</dd></div>
    </dl>
    <div className="email-draft-body preserve-lines" role="region" tabIndex={0} aria-label={`Body of ${card.title}${marked ? ", with changes marked" : ""}`}>
      {marked ? <DiffText parts={changes.body} /> : card.body}
    </div>
    <div className="actions">
      <a className="button-link primary" href={emailMailtoUrl(card)}><Icon name="mail" size={16} /> Open in Mail</a>
      <a className="button-link" href={emailGmailUrl(card)} target="_blank" rel="noopener noreferrer"><Icon name="external" size={16} /> Open in Gmail</a>
      <Button type="button" onClick={() => void copyDraft()}><Icon name={copy === "copied" ? "check" : "copy"} size={16} /> {copy === "copied" ? "Copied" : "Copy"}</Button>
    </div>
    {copy === "failed" && <p role="alert" className="form-error">This browser didn't allow copying. Select the text to copy it instead.</p>}
    <small className="muted">Nothing has been sent. Your mail app opens with this draft so you can review it first.</small>
  </>;
}
