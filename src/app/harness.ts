import type {
  Bootstrap,
  Bot,
  BotInput,
  Capability,
  HarnessId,
  HarnessOption,
} from "../shared/types";

/**
 * The bot settings form. `harness` travels beside BotInput until the server's bot schema carries it;
 * a server from before harnesses drops the field and keeps Hermes.
 */
export type BotForm = BotInput & { harness?: string };

const labels: Record<HarnessId, string> = {
  antigravity: "Antigravity",
  codex: "Codex",
  "claude-code": "Claude Code",
  grok: "Grok",
  pi: "Pi",
};
const native: HarnessId[] = ["antigravity", "codex", "claude-code", "grok", "pi"];

/** A readable name. An id this client does not know shows as sent. */
export const harnessLabel = (id: string) => labels[id as HarnessId] ?? id;
/** The harness a bot runs on, defaulting to Antigravity when omitted. */
export const harnessOf = (bot: Pick<Bot, "harness">) => bot.harness || "antigravity";

export type HarnessChoice = { id: string; label: string; available: boolean; reason?: string };

/**
 * The picker's options: the native harnesses, with any the server cannot run turned off, then any
 * other harness the server advertises.
 */
export function harnessChoices(
  advertised: HarnessOption[] | undefined,
  saved: string | undefined,
): HarnessChoice[] {
  const offered = new Map((advertised ?? []).map((option) => [option.id, option]));
  const ids = [...native, ...offered.keys(), ...(saved ? [saved] : [])].filter(
    (id, index, all) => id && all.indexOf(id) === index,
  );
  return ids.map((id) => {
    const option = offered.get(id);
    return {
      id,
      label: harnessLabel(id),
      available: !!option?.available,
      reason: option ? option.reason : "Not set up on this server yet.",
    };
  });
}

/** The harness a new bot starts on: the first available native harness, else Antigravity. */
export function defaultHarness(boot: Pick<Bootstrap, "harnesses">) {
  return (
    harnessChoices(boot.harnesses, undefined).find((choice) => choice.available)?.id ?? native[0]
  );
}

/** A capability for one bot: its own value when its harness differs from the bootstrap's runtime. */
export function botCapability(
  boot: Pick<Bootstrap, "capabilities">,
  bot: Pick<Bot, "capabilities">,
  key: "queueManagement",
): Capability | undefined {
  return bot.capabilities?.[key] ?? boot.capabilities[key];
}
