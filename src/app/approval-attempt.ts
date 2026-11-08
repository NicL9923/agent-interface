import { approvalDecisionKey } from "./storage";

export type ApprovalAttempt = { decision: "approved" | "denied"; state: "unconfirmed" | "sent" | "closed" };
// Fallback when browser storage is unavailable. Neither navigation nor a failed read
// proves an earlier decision did not reach Hermes.
const memory = new Map<string, ApprovalAttempt>();
export function approvalAttempt(user: string, bot: string, approval: string) {
  const key = approvalDecisionKey(user, bot, approval);
  function read(): ApprovalAttempt | undefined {
    try {
      const value = JSON.parse(sessionStorage.getItem(key) || "null");
      if (value && ["approved", "denied"].includes(value.decision) && ["unconfirmed", "sent", "closed"].includes(value.state)) return value;
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
