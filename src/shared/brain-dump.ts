export const MAX_BRAIN_DUMP_TEXT = 20_000;

/**
 * Formats a raw mobile/quick-capture brain dump into a structured triage turn for the member's
 * main assistant. The assistant breaks it into tracked tasks, specialist hand-offs (asking before
 * messaging shared household assistants), and ready-to-review cards before taking external actions.
 */
export function buildBrainDumpPrompt(rawText: string): string {
  const cleaned = rawText.trim();
  return [
    "[Brain dump triage]",
    "Please triage this brain dump into a calm, concrete action plan:",
    "1. Create tracked tasks (`task_create`) for multi-step items you should work on in the background.",
    "2. Identify any specialist assistants to hand work to (`message_bot` for my personal assistants; ask before messaging any shared household assistant).",
    "3. Attach ready-to-review `agent-ui` cards (`email`, `event`, or `checklist`) for replies, calendar items, or action lists mentioned below.",
    "4. Summarize what you created, what you drafted, and ask one concise confirmation question before any external side effect.",
    "",
    "Brain dump:",
    cleaned,
  ].join("\n");
}
