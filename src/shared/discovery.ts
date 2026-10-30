import type { Message, Routine, ToolCall } from './types.js';
export interface SearchHit { botId: string; botName: string; sessionId: string; title: string; snippet: string; messageId?: string; offset?: number; routineId?: string; resultId?: string; updatedAt?: string }
export interface HistoryPage { botId: string; sessionId: string; messages: Message[]; offset: number; hasMore: boolean; targetMessageId?: string }
export interface SavedItem { id: string; botId: string; kind: 'session' | 'routine'; sessionId?: string; routineId?: string; resultId?: string; messageId?: string; offset?: number; title: string; createdAt: string }
export interface UsageSummary { botId: string; days: number; sessions: number; inputTokens: number; outputTokens: number; actualCost: number | null; estimatedCost: number | null; partial: boolean; notice: string }
export interface AutomationOverview { routines: Routine[]; usage: UsageSummary[]; unavailableBots: string[] }
export interface Starter { id: string; title: string; prompt: string }
export function receipt(call: ToolCall) {
  let result: unknown = call.result;
  if (typeof result === 'string') { try { result = JSON.parse(result); } catch { /* Preserve the owner's actual text. */ } }
  const data = result && typeof result === 'object' ? result as Record<string, unknown> : {};
  const failed = call.status === 'failed' || data.success === false || data.ok === false || !!data.error || typeof data.exit_code === 'number' && data.exit_code !== 0;
  const label = failed ? 'Tool failed' : call.status === 'running' ? 'Action in progress' : data.success === true || data.ok === true ? 'Tool reported success' : 'Tool finished';
  const text = call.error || (typeof call.result === 'string' ? call.result : call.result === undefined ? 'Hermes did not report an outcome.' : JSON.stringify(call.result, null, 2));
  const links = Object.entries(data).filter(([key, value]) => /^(url|html_url|web_url|link)$/.test(key) && typeof value === 'string' && /^https?:\/\//i.test(value)).map(([, value]) => String(value));
  return { label, failed, text, links };
}


/** Keep unfamiliar Hermes statuses visible rather than guessing their outcome. */
export function routineResultLabel(status: string): string {
  const labels: Record<string, string> = { ok: "Succeeded", success: "Succeeded", succeeded: "Succeeded", error: "Failed", failed: "Failed", delivery_failed: "Delivery failed", running: "Running", pending: "Pending", skipped: "Skipped", cancelled: "Canceled" };
  return Object.hasOwn(labels, status) ? labels[status] : status;
}
export function savedReplyTitle(text: string): string {
  // Keep identifier underscores and punctuation next to inline code intact.
  const first = text.split(/\r?\n/).find(line => line.trim()) || "";
  const title = first.replace(/^\s*(?:#{1,6}\s+|[-+*]\s+|\d+[.)]\s+)/, "")
    .replace(/[`*]/g, "").replace(/\s+/g, " ").trim();
  if (!title) return "Saved reply";
  const characters = Array.from(title);
  if (characters.length <= 80) return title;
  const prefix = characters.slice(0, 79).join("");
  const boundary = prefix.lastIndexOf(" ");
  return (boundary > 0 ? prefix.slice(0, boundary) : prefix) + "…";
}
