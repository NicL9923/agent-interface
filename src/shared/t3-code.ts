/**
 * T3 Code threads an assistant starts through T3 Code's MCP server. Hermes names an MCP tool
 * `mcp_<server>_<tool>`, so `t3_thread_launch` arrives as, say, `mcp_t3code_t3_thread_launch`
 * whatever the server was called. Hermes wraps the tool's text as `{"result": "<JSON>"}` and adds
 * `structuredContent` when the server sends it; T3 Code's own answer is
 * `{threadId, link?, projectId, modelSelection, runId, status}`.
 *
 * T3 Code gives an MCP client that it did not launch a hosted link,
 * `https://app.t3.codes/threads/<environment>/<thread>`, which offers the desktop app, the
 * mobile app or the browser. Its own agents get `t3-thread://v2/<environment>/<thread>`, which only
 * T3 Code can open, so that form is rewritten to the hosted link.
 */
import type { ToolCall } from "./types.js";
import { formatModelSlugName } from "./model-name.js";

export const T3_HOSTED_APP_URL = "https://app.t3.codes";

export interface T3Thread {
  /** The tool call this came from, for keys. */
  callId: string;
  state: "starting" | "started" | "failed";
  title: string;
  /** The start of the first prompt, if the thread was given one. */
  prompt?: string;
  /** The model's display name. */
  model?: string;
  /** Where the thread works: a new worktree and its branch, an existing one, the project checkout or a scratch folder. */
  workspace?: string;
  /** True for a thread that starts by planning rather than editing. */
  plan?: boolean;
  /** Opens the thread in T3 Code. Absent when T3 Code sent no link this app can open. */
  url?: string;
  error?: string;
}

type Fields = Record<string, unknown>;
const isFields = (value: unknown): value is Fields => typeof value === "object" && value !== null && !Array.isArray(value);
const json = (text: string | undefined): unknown => {
  if (text === undefined) return undefined;
  try { return JSON.parse(text); } catch { return text; }
};
const words = (value: unknown, max: number) => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1).trimEnd()}…` : trimmed;
};

/** Whether a tool name is T3 Code's thread launch, called directly or through an MCP prefix. */
export const isT3ThreadLaunch = (name: string) => /(?:^|_)t3_thread_launch$/.test(name);

/** T3 Code's answer inside Hermes's wrapping: the first object that names a thread, at most three layers down. */
function launchResult(text: string | undefined): Fields | undefined {
  let value = json(text);
  for (let depth = 0; depth < 3 && isFields(value); depth++) {
    if (typeof value.threadId === "string") return value;
    if (isFields(value.structuredContent) && typeof value.structuredContent.threadId === "string") return value.structuredContent;
    if (!Object.hasOwn(value, "result")) return undefined;
    value = typeof value.result === "string" ? json(value.result) : value.result;
  }
  return undefined;
}
/** The error T3 Code or Hermes reported, if the answer is one. */
function launchError(call: ToolCall): string | undefined {
  if (call.error) return words(call.error, 300);
  let value = json(call.result);
  for (let depth = 0; depth < 3 && isFields(value); depth++) {
    if (typeof value.error === "string") return words(value.error, 300);
    if (isFields(value.error) && typeof value.error.message === "string") return words(value.error.message, 300);
    value = typeof value.result === "string" ? json(value.result) : value.result;
  }
  return undefined;
}

// T3 Code escapes even URL-safe punctuation in a hosted link, so a sentence's period never joins an ID.
const segment = (id: string) => encodeURIComponent(id).replace(/[.!~*'()]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
const hostedPath = /^\/threads\/[A-Za-z0-9_%-]+\/[A-Za-z0-9_%-]+\/?$/;
/**
 * A link that opens the thread: T3 Code's hosted link as given, or a `t3-thread://v2/` link
 * rewritten to one. Anything else, including a v1 link that names no machine, opens nothing.
 */
export function t3ThreadUrl(link: unknown): string | undefined {
  if (typeof link !== "string") return undefined;
  const written = link.trim().replace(/^<(.*)>$/, "$1");
  const v2 = /^t3-thread:\/\/v2\/([^/\s]+)\/([^/\s]+)$/.exec(written);
  if (v2) {
    try { return `${T3_HOSTED_APP_URL}/threads/${segment(decodeURIComponent(v2[1]))}/${segment(decodeURIComponent(v2[2]))}`; }
    catch { return `${T3_HOSTED_APP_URL}/threads/${segment(v2[1])}/${segment(v2[2])}`; }
  }
  try {
    const url = new URL(written);
    // A self-hosted T3 Code can serve the app at another HTTPS origin, with the same path.
    return url.protocol === "https:" && hostedPath.test(url.pathname) && !url.username && !url.password ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function workspace(args: Fields): string | undefined {
  if (args.scratch === true) return "Scratch folder";
  const strategy = isFields(args.workspaceStrategy) ? args.workspaceStrategy : undefined;
  switch (strategy?.type) {
    case "worktree": {
      const branch = words(strategy.branch, 80);
      return branch ? `New worktree on ${branch}` : "New worktree";
    }
    case "existing_worktree": return "Existing worktree";
    case "root": return "Project checkout";
    default: return undefined;
  }
}
const modelName = (selection: unknown) => {
  const model = isFields(selection) ? words(selection.model, 120) : undefined;
  return model ? formatModelSlugName(model) : undefined;
};

/** The thread a `t3_thread_launch` call started, is starting, or failed to start. Null for any other tool. */
export function t3ThreadLaunch(call: ToolCall): T3Thread | null {
  if (!isT3ThreadLaunch(call.name)) return null;
  const parsedArgs = json(call.arguments);
  const args = isFields(parsedArgs) ? parsedArgs : {};
  const result = call.status === "completed" ? launchResult(call.result) : undefined;
  const failed = call.status === "failed" || call.status === "completed" && !result;
  const thread: T3Thread = {
    callId: call.id,
    state: call.status === "running" ? "starting" : failed ? "failed" : "started",
    title: words(args.title, 200) ?? "New thread",
  };
  const prompt = words(args.message, 280), model = modelName(result?.modelSelection) ?? modelName(args.modelSelection), place = workspace(args);
  if (prompt) thread.prompt = prompt;
  if (model) thread.model = model;
  if (place) thread.workspace = place;
  if (args.interactionMode === "plan") thread.plan = true;
  if (thread.state === "started") {
    const url = t3ThreadUrl(result?.link);
    if (url) thread.url = url;
  }
  if (thread.state === "failed") thread.error = launchError(call) ?? "T3 Code didn't report the new thread.";
  return thread;
}
