import { useState } from "react";
import { emailGmailUrl, emailMailtoUrl, emailText } from "../shared/reply-cards";
import type { EmailCard } from "../shared/reply-cards";
import { Button } from "./ui/button";
import { Icon } from "./Icon";

/**
 * An email the assistant drafted. It only ever leaves through the person's own mail app or Gmail's
 * compose window, where they review it and press Send themselves.
 */
export function EmailDraftCard({ card }: { card: EmailCard }) {
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  async function copyDraft() {
    try {
      await navigator.clipboard.writeText(emailText(card));
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
  }
  return <>
    <dl className="email-draft-headers">
      {card.to && <div><dt>To</dt><dd>{card.to.join(", ")}</dd></div>}
      {card.cc && <div><dt>Cc</dt><dd>{card.cc.join(", ")}</dd></div>}
      <div><dt>Subject</dt><dd>{card.subject ?? <span className="muted">No subject</span>}</dd></div>
    </dl>
    <div className="email-draft-body preserve-lines" role="region" tabIndex={0} aria-label={`Body of ${card.title}`}>{card.body}</div>
    <div className="actions">
      <a className="button-link primary" href={emailMailtoUrl(card)}><Icon name="mail" size={16} /> Open in Mail</a>
      <a className="button-link" href={emailGmailUrl(card)} target="_blank" rel="noopener noreferrer"><Icon name="external" size={16} /> Open in Gmail</a>
      <Button type="button" onClick={() => void copyDraft()}><Icon name={copy === "copied" ? "check" : "copy"} size={16} /> {copy === "copied" ? "Copied" : "Copy"}</Button>
    </div>
    {copy === "failed" && <p role="alert" className="form-error">This browser didn't allow copying. Select the text to copy it instead.</p>}
    <small className="muted">Nothing has been sent. Your mail app opens with this draft so you can review it first.</small>
  </>;
}
