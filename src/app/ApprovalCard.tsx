import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { Approval, ApprovalScope } from "../shared/types";
import { ApiError, request as apiRequest } from "../client-api";
import { Icon } from "../components/Icon";
import { When } from "../components/When";
import { Button } from "../components/ui/button";
import { Dialog } from "../components/ui/dialog";
import { reactAvatar } from "../components/avatar-attention";
import { approvalAttempt, sameAttempt, type ApprovalAttempt } from "./approval-attempt";
import { rememberDecline } from "./decline-handoff";
import { attentionAnchor } from "./transcript-logic";

type Decision = ApprovalAttempt["decision"];
const quoted = (patterns: string[]) => patterns.map(pattern => `“${pattern}”`).join(", ");
/** What a sent approval granted, in the words its button used. */
const grantedText = (scope: ApprovalScope | undefined, name: string, scoped: boolean) =>
  !scoped ? "Approval sent." : scope === "session" ? "Allowed for this conversation." : scope === "always" ? `Always allowed for ${name}.` : "Allowed once.";

/**
 * One approval Hermes is waiting on. Hermes says which choices this request allows: a guardian-denied
 * or one-time request offers only Allow once and Decline, and an older Hermes offers no list, which
 * keeps the original Approve and Decline. A decline hands the next step to the composer.
 */
export function ApprovalCard({ approval, botId, userId, assistantName, disconnected, supported, unavailableReason, report, leaving = false }: {
  approval: Approval; botId: string; userId: string; assistantName: string; disconnected: boolean; supported: boolean; unavailableReason?: string;
  report(message: string): void;
  /** Hermes no longer lists it; the card folds away for a moment before it goes. */
  leaving?: boolean;
}) {
  const card = useRef<HTMLElement>(null);
  // The fold starts from the card's own height, measured as it begins.
  useLayoutEffect(() => {
    if (leaving && card.current) card.current.style.setProperty("--leave-height", `${card.current.offsetHeight}px`);
  }, [leaving]);
  const saved = approvalAttempt(userId, botId, approval.id);
  const [attempt, setAttempt] = useState<ApprovalAttempt | undefined>(() => saved.read());
  const [sending, setSending] = useState(false);
  const [menu, setMenu] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const pending = useRef(false);
  const menuId = useId();
  const scoped = !!approval.choices;
  const offered = (choice: "once" | "session" | "always") => (approval.choices ?? ["once"]).includes(choice);
  const patterns = approval.patterns ?? [];
  useEffect(() => {
    if (!menu) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setMenu(false); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [menu]);
  async function decide(value: Decision, scope?: ApprovalScope) {
    const previous = saved.read();
    if (!supported || disconnected || pending.current || previous && (previous.state !== "unconfirmed" || !sameAttempt(previous, value, scope))) return;
    report("");
    setMenu(false);
    pending.current = true;
    setSending(true);
    const reach = value === "approved" && scope && scope !== "once" ? scope : undefined;
    const next: ApprovalAttempt = { decision: value, ...(reach ? { scope: reach } : {}), state: "unconfirmed" };
    // Save before sending: leaving this chat while the POST is in flight must
    // never offer a different decision when the person returns.
    saved.save(next); setAttempt(next);
    try {
      await apiRequest("POST /bots/:id/approvals/:approvalId", { params: { id: botId, approvalId: approval.id }, body: { decision: value, ...(reach ? { scope: reach } : {}) } });
      const sent: ApprovalAttempt = { ...next, state: "sent" };
      saved.save(sent); setAttempt(sent);
      reactAvatar(botId, value === "approved" ? "cheer" : "nod");
      if (value === "denied") {
        rememberDecline(botId, approval.id);
        // The person says what to do instead in the message box, which now asks for it.
        requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>("#message")?.focus());
      }
    } catch (error) {
      // A refused choice never reached Hermes, like any other definite refusal before it.
      const refused = error instanceof ApiError && error.status < 500
        && (error.status !== 409 || error.code === "hermes_maintenance" || error.code === "approval_choice_unavailable");
      if (refused && !previous) {
        saved.save(undefined); setAttempt(undefined); report(error.code === "hermes_maintenance" ? "Hermes is being updated. Try your decision again when the update finishes." : error.message);
      } else {
        const retained: ApprovalAttempt = { ...next, state: error instanceof ApiError && error.status === 409 && error.code !== "hermes_maintenance" ? "closed" : "unconfirmed" };
        saved.save(retained); setAttempt(retained);
        // Refreshes can remove a resolved card, but a still-pending read cannot
        // prove an earlier answer isn't still being processed. Never auto-send.
        window.dispatchEvent(new Event("agent-interface:reconnect"));
      }
    } finally { pending.current = false; setSending(false); }
  }
  const anchor = leaving ? {} : attentionAnchor("approval", approval.id);
  if (attempt?.state === "sent" && attempt.decision === "denied")
    return <article ref={card} className={`approval-card decision-card decision-declined${leaving ? " leaving" : ""}`} inert={leaving} data-settled="denied" {...anchor}>
      <p role="status">Declined. {assistantName} stopped that step.</p>
    </article>;
  const busy = !supported || disconnected || sending;
  /** One choice's button: it stays usable only for resending the same unconfirmed decision. */
  const choice = (value: Decision, scope: ApprovalScope | undefined, label: string, sendingLabel: string, primary = false) => {
    const mine = !!attempt && sameAttempt(attempt, value, scope);
    return <button key={`${value}:${scope ?? ""}`} type="button" className={primary ? "primary" : undefined}
      disabled={busy || !!attempt && (attempt.state !== "unconfirmed" || !mine)}
      onClick={() => void decide(value, scope)}>
      {mine && (sending || attempt!.state === "sent") && <Icon name={sending ? "spinner" : "check"} className={sending ? "spin" : undefined} size={16} />}
      {mine ? sending ? sendingLabel
        : attempt!.state === "sent" ? scoped ? grantedText(attempt!.scope, assistantName, scoped).replace(/\.$/, "") : "Approved"
        : value === "approved" ? "Send approval again" : "Send decline again" : label}
    </button>;
  };
  const alwaysSent = attempt?.decision === "approved" && attempt.scope === "always";
  return <article ref={card} className={`approval-card decision-card${leaving ? " leaving" : ""}`} aria-busy={sending} inert={leaving}
    data-settled={attempt?.state === "sent" ? attempt.decision : undefined} {...anchor}>
    <p className="eyebrow">{attempt?.state === "closed" ? "Decision status" : "Your decision needed"}</p><h2>{approval.title}</h2><p>{approval.detail}</p>
    {approval.command && <pre className="approval-command" role="region" tabIndex={0} aria-label="Command">{approval.command}</pre>}
    {approval.expiresAt && <small>Expires <When value={approval.expiresAt} inline /></small>}
    {attempt?.state !== "closed" && <div className="actions">
      {choice("approved", undefined, scoped ? "Allow once" : "Approve", scoped ? "Allowing…" : "Approving…", true)}
      {offered("session") && choice("approved", "session", "Allow for this conversation", "Allowing…")}
      {choice("denied", undefined, "Decline", "Declining…")}
      {offered("always") && (alwaysSent ? choice("approved", "always", "Always allow…", "Allowing…") : <span className="approval-more">
        <button type="button" className="icon-button" aria-label="More choices" aria-expanded={menu} aria-controls={menuId}
          disabled={busy || !!attempt} onClick={() => setMenu(open => !open)}><Icon name="more" size={20} /></button>
        {menu && <span className="approval-menu" id={menuId} role="menu">
          <button type="button" role="menuitem" onClick={() => { setMenu(false); setConfirming(true); }}>Always allow…</button>
        </span>}
      </span>)}
    </div>}
    {scoped && patterns.length > 0 && (offered("session") || offered("always")) && !attempt && <p className="approval-scope-note">
      Allowing for longer than once covers every command Hermes flags as {quoted(patterns)}, not only this one.</p>}
    {!supported && <p className="approval-unavailable">{unavailableReason || "This Hermes connection does not support approval decisions. Open the official Hermes interface to answer."}</p>}
    {disconnected && !attempt && supported && <p className="decision-status" role="status">Reconnect to Hermes to answer.</p>}
    {attempt && <p className="decision-status" role="status">{sending ? "Sending decision…"
      : attempt.state === "sent" ? grantedText(attempt.scope, assistantName, scoped)
      : attempt.state === "closed" ? "This request is no longer available to answer. Its status will update with the conversation."
      : `Hermes hasn't confirmed your ${attempt.decision === "approved" ? "approval" : "decline"}. It may still go through, so the other choices stay off. After reconnecting, you can send the same decision again.`}</p>}
    {confirming && <AlwaysAllowConfirm name={assistantName} patterns={patterns} command={approval.command ?? approval.detail}
      onClose={() => setConfirming(false)} onAllow={() => { setConfirming(false); void decide("approved", "always"); }} />}
  </article>;
}

/** Names exactly what "Always allow" saves: Hermes's pattern, for this assistant, in every conversation. */
function AlwaysAllowConfirm({ name, patterns, command, onAllow, onClose }: { name: string; patterns: string[]; command: string; onAllow(): void; onClose(): void }) {
  const titleId = useId(), detailId = useId();
  return <Dialog className="confirm-dialog always-allow-confirm" role="alertdialog" aria-labelledby={titleId} aria-describedby={detailId}
    initialFocus="[data-confirm-default]" onCancel={onClose} onClose={onClose}>
    <h2 id={titleId}>Always allow this for {name}?</h2>
    <div id={detailId}>
      <p>{patterns.length
        ? <>From now on, {name} can run any command Hermes flags as {quoted(patterns)} without asking, in every conversation. That includes commands other than this one:</>
        : <>From now on, {name} can run this command without asking, in every conversation:</>}</p>
      <pre className="approval-command">{command}</pre>
      <p>Remove it anytime in {name}'s settings, under Always-allowed commands.</p>
    </div>
    <div className="actions">
      <Button data-confirm-default onClick={onClose}>Cancel</Button>
      <Button className="primary" onClick={onAllow}>Always allow</Button>
    </div>
  </Dialog>;
}

/** What stays in the transcript once Hermes stops listing a declined approval, until the person's next message. */
export function DeclinedStep({ name }: { name: string }) {
  return <article className="approval-card decision-card decision-declined" data-settled="denied">
    <p role="status">Declined. {name} stopped that step.</p>
  </article>;
}
