import type { ActivityState } from './types.js';

/** The verb each state reads as in "Ada is working...". ios/AgentInterface/ConversationView.swift ActivitySentence mirrors this. */
export const activityActions: Record<ActivityState, string> = {
  idle: "ready", thinking: "thinking", working: "working", waiting: "waiting for approval",
  blocked: "waiting for your input", done: "done", failed: "having trouble", interrupted: "stopped", disconnected: "reconnecting",
};

/**
 * What an assistant is doing, as the working line says it after "is": the current step while working,
 * such as "using web_search", and a plain verb for every other state.
 */
export function activityAction(state: ActivityState, detail?: string, options: { offline?: boolean; connectionLost?: boolean } = {}): string {
  if (options.offline) return "offline";
  const step = detail?.trim().replace(/[.…]+$/, "");
  if (!options.connectionLost && state === "working" && step) return step.charAt(0).toLowerCase() + step.slice(1);
  return activityActions[options.connectionLost ? "disconnected" : state];
}
