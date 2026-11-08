import type { ApprovalScope } from "../shared/types";
import { approvalDecisionKey } from "./storage";

/** `scope` is how far an approval reaches; absent means one command, as every earlier attempt was. */
export type ApprovalAttempt = { decision: "approved" | "denied"; scope?: ApprovalScope; state: "unconfirmed" | "sent" | "closed" };
const scopes: readonly (ApprovalScope | undefined)[] = [undefined, "once", "session", "always"];
// Fallback when browser storage is unavailable. Neither navigation nor a failed read
// proves an earlier decision did not reach Hermes.
const memory = new Map<string, ApprovalAttempt>();
export function approvalAttempt(user: string, bot: string, approval: string) {
  const key = approvalDecisionKey(user, bot, approval);
  function read(): ApprovalAttempt | undefined {
    try {
      const value = JSON.parse(sessionStorage.getItem(key) || "null");
      if (value && ["approved", "denied"].includes(value.decision) && ["unconfirmed", "sent", "closed"].includes(value.state)
        && scopes.includes(value.scope) && !(value.decision === "denied" && value.scope !== undefined)) return value;
    } catch { return memory.get(key); }
  }
  function save(value: ApprovalAttempt | undefined) {
    if (value) memory.set(key, value); else memory.delete(key);
    try {
      if (value) sessionStorage.setItem(key, JSON.stringify(value)); else sessionStorage.removeItem(key);
    } catch { /* The in-memory attempt still fences this tab's navigation. */ }
  }
  return { read, save };
}
/** The same decision: a retry may only resend exactly what may already have reached Hermes. */
export const sameAttempt = (attempt: ApprovalAttempt, decision: ApprovalAttempt["decision"], scope?: ApprovalScope) =>
  attempt.decision === decision && (attempt.scope ?? "once") === (decision === "denied" ? "once" : scope ?? "once");
