import { interactiveReplyInstructions } from "./reply-cards.js";
export const routinePresets = [
  { id: "morning", name: "Morning brief", schedule: "0 7 * * *", description: "A short start to the day from connected sources.",
    prompt: "Prepare a concise morning brief from connected sources. Include today's calendar, relevant weather and pending household tasks only when those sources are available. State freshness and missing sources. Do not modify anything. Avoid repeating yesterday's unchanged items." },
  { id: "meals", name: "Weekly meal plan", schedule: "0 16 * * 0", description: "Dinner ideas and a grocery checklist on Sunday.",
    prompt: `Propose a practical weeknight dinner plan for the coming week using saved household preferences. Include a grocery checklist in an agent-ui card, with a short meal-by-meal explanation. Ask about allergies or dietary constraints if unknown. Do not buy anything or change calendar events.\n\n${interactiveReplyInstructions}` },
  { id: "health", name: "VPS health digest", schedule: "0 8 * * *", description: "Report service health. Make no server changes.",
    prompt: "Inspect accessible VPS service health and produce a brief digest. Report actionable failures, disk pressure and relevant changes since the last report when previous results are available. If access is unavailable, say so. Do not restart services, install updates or change configuration." },
] as const;
