import type { IconName } from "../components/Icon";
import type { ToolCall } from "../shared/types";
import { avatarProp } from "../components/avatar-motion";
import { usesComputer } from "../components/ComputerHandoffCard";

/** The most steps the tape draws; earlier ones fold into a count at its start. */
export const TAPE_LENGTH = 12;

/** A glyph for a tool, from the same families that choose the avatar's held prop. */
export function toolGlyph(name: string): IconName {
  if (usesComputer(name)) return "computer";
  switch (avatarProp(name)) {
    case "search": return "search";
    case "computer": return "terminal";
    case "read": return "file";
    case "write": return "pencil";
    default: return /agent|delegate|subagent/i.test(name) ? "robot" : "sparkle";
  }
}

/** The steps the tape shows, newest last, and how many earlier ones it folds away. */
export function tapeSteps(calls: ToolCall[], length = TAPE_LENGTH) {
  const shown = calls.slice(-length);
  return { shown, folded: calls.length - shown.length };
}

export const stepStatus: Record<ToolCall["status"], string> = { running: "running", completed: "done", failed: "failed" };
