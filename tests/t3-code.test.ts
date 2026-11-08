import { describe, expect, it } from "vitest";
import { isT3ThreadLaunch, t3ThreadLaunch, t3ThreadUrl } from "../src/shared/t3-code";
import type { ToolCall } from "../src/shared/types";

// T3 Code's answer to t3_thread_launch, as its tool schema declares it
// (apps/server/src/mcp/toolkits/project/tools.ts), with the hosted link an outside MCP client gets.
const answer = {
  threadId: "c74e07af-b751-4d20-b36f-dd6bbea60bbf",
  link: "https://app.t3.codes/threads/43531f19-4b42-4e0e-8409-7565df58f525/c74e07af-b751-4d20-b36f-dd6bbea60bbf",
  projectId: "37b6d1d3-a57a-416d-8afb-74503d3fbdc1",
  modelSelection: { provider: "claudeAgent", model: "claude-opus-5-5" },
  runId: "run:thread:c74e07af:ordinal:1",
  status: "queued",
};
const args = { title: "Fix the gate sensor", message: "The north gate sensor reports open when it is shut.\nFind out why.", projectId: answer.projectId,
  workspaceStrategy: { type: "worktree", baseRef: "origin/main", branch: "fix/gate-sensor", startFromOrigin: true } };
// Hermes's MCP tool returns {"result": "<the server's text>"}, and adds structuredContent when the server sends one.
const call = (change: Partial<ToolCall> = {}): ToolCall => ({ id: "c1", name: "mcp_t3code_t3_thread_launch", status: "completed",
  arguments: JSON.stringify(args), result: JSON.stringify({ result: JSON.stringify(answer) }), ...change });

describe("T3 Code thread launches", () => {
  it("recognizes the launch tool under any MCP server name and nothing else", () => {
    for (const name of ["t3_thread_launch", "mcp_t3code_t3_thread_launch", "mcp_t3_code_t3_thread_launch", "mcp__t3-code__t3_thread_launch"])
      expect(isT3ThreadLaunch(name)).toBe(true);
    for (const name of ["t3_thread_launcher", "mcp_t3code_t3_thread_launch_now", "xt3_thread_launch", "t3_thread_list", "terminal"])
      expect(isT3ThreadLaunch(name)).toBe(false);
    expect(t3ThreadLaunch(call({ name: "mcp_t3code_t3_thread_list" }))).toBeNull();
  });

  it("reads a started thread from Hermes's wrapping: title, prompt, model, workspace and its hosted link", () => {
    expect(t3ThreadLaunch(call())).toEqual({
      callId: "c1", state: "started", title: "Fix the gate sensor",
      prompt: "The north gate sensor reports open when it is shut. Find out why.",
      model: "Claude Opus 5.5", workspace: "New worktree on fix/gate-sensor", url: answer.link,
    });
  });

  it("reads the answer from structuredContent when Hermes sends both, and from an object result", () => {
    const both = JSON.stringify({ result: "Started the thread.", structuredContent: answer });
    expect(t3ThreadLaunch(call({ result: both }))?.url).toBe(answer.link);
    expect(t3ThreadLaunch(call({ result: JSON.stringify({ result: answer }) }))?.url).toBe(answer.link);
    expect(t3ThreadLaunch(call({ result: JSON.stringify(answer) }))?.url).toBe(answer.link);
  });

  it("shows a launch in flight from its arguments alone, with no link yet", () => {
    const starting = t3ThreadLaunch(call({ status: "running", result: undefined }));
    expect(starting).toMatchObject({ state: "starting", title: "Fix the gate sensor" });
    expect(starting).not.toHaveProperty("url");
  });

  it("reports why a launch failed, from the call or from T3 Code's answer", () => {
    expect(t3ThreadLaunch(call({ status: "failed", error: "Project not found", result: undefined }))).toMatchObject({ state: "failed", error: "Project not found" });
    // Hermes's MCP wrapper reports a tool error as {"error": "..."}.
    expect(t3ThreadLaunch(call({ result: JSON.stringify({ error: "Runtime mode exceeds this client's ceiling" }) })))
      .toMatchObject({ state: "failed", error: "Runtime mode exceeds this client's ceiling" });
    // A finished call whose answer names no thread did not start one.
    expect(t3ThreadLaunch(call({ result: JSON.stringify({ result: "Done" }) }))).toMatchObject({ state: "failed", error: "T3 Code didn't report the new thread." });
  });

  it("names the workspace for each strategy, a plan-mode start, and falls back to a neutral title", () => {
    const launch = (change: object) => t3ThreadLaunch(call({ arguments: JSON.stringify({ ...args, ...change }) }));
    expect(launch({ workspaceStrategy: { type: "root" } })?.workspace).toBe("Project checkout");
    expect(launch({ workspaceStrategy: { type: "existing_worktree", worktreePath: "/w" } })?.workspace).toBe("Existing worktree");
    expect(launch({ workspaceStrategy: { type: "worktree", baseRef: "main" } })?.workspace).toBe("New worktree");
    expect(launch({ workspaceStrategy: undefined, scratch: true })?.workspace).toBe("Scratch folder");
    expect(launch({ interactionMode: "plan" })?.plan).toBe(true);
    expect(t3ThreadLaunch(call({ arguments: "not JSON" }))).toMatchObject({ title: "New thread", state: "started", url: answer.link });
  });

  it("opens T3 Code's own thread links through the hosted app, escaped the way T3 Code escapes them", () => {
    expect(t3ThreadUrl("<t3-thread://v2/env-1/thread.1>")).toBe("https://app.t3.codes/threads/env-1/thread%2E1");
    expect(t3ThreadUrl("t3-thread://v2/env%201/t(2)")).toBe("https://app.t3.codes/threads/env%201/t%282%29");
    expect(t3ThreadUrl("https://t3.example.com/threads/env/thread")).toBe("https://t3.example.com/threads/env/thread");
  });

  it("opens nothing for a link this app cannot trust or T3 Code cannot open", () => {
    for (const link of ["t3-thread://v1/thread_1", "http://app.t3.codes/threads/env/thread", "javascript:alert(1)//threads/a/b",
      "https://app.t3.codes/settings", "https://user:secret@app.t3.codes/threads/env/thread", "https://app.t3.codes/threads/env/thread/extra", 42, undefined])
      expect(t3ThreadUrl(link)).toBeUndefined();
    expect(t3ThreadLaunch(call({ result: JSON.stringify({ result: JSON.stringify({ ...answer, link: "javascript:alert(1)" }) }) })))
      .not.toHaveProperty("url");
  });
});
