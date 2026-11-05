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
/** One stretch of a search snippet, marked when it matched the search. */
export interface SnippetPart { text: string; match: boolean }

/**
 * A search snippet with its matches marked. The server has already made it plain text and kept
 * Hermes's >>>match<<< markers. Markers count only in order, an opening one then its closing one,
 * so a stray marker stays as written. Reads at most `limit` characters.
 */
export function snippetParts(snippet: string, limit = 300): SnippetPart[] {
  const text = snippet.slice(0, limit * 4);
  const pieces: SnippetPart[] = [];
  for (let at = 0; at < text.length;) {
    const open = text.indexOf(">>>", at), close = open < 0 ? -1 : text.indexOf("<<<", open + 3);
    if (close < 0) { pieces.push({ text: text.slice(at), match: false }); break; }
    pieces.push({ text: text.slice(at, open), match: false }, { text: text.slice(open + 3, close), match: true });
    at = close + 3;
  }
  const parts: SnippetPart[] = [];
  let used = 0;
  for (const piece of pieces) {
    let words = piece.text.replace(/\s+/g, " ");
    if (!parts.length) words = words.trimStart();
    if (!words) continue;
    if (used >= limit) break;
    if (used + words.length > limit) words = `${words.slice(0, limit - used).trimEnd()}…`;
    used += words.length;
    const last = parts.at(-1);
    if (last && last.match === piece.match) last.text += words;
    else parts.push({ text: words, match: piece.match });
  }
  return parts;
}
