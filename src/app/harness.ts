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
  hermes: "Hermes",
};
const native: HarnessId[] = ["antigravity", "codex", "claude-code", "grok", "pi"];

/** A readable name. An id this client does not know shows as sent. */
export const harnessLabel = (id: string) => labels[id as HarnessId] ?? id;
/** Every bot from a server before harnesses runs on Hermes. */
export const harnessOf = (bot: Pick<Bot, "harness">) => bot.harness || "hermes";
export const runsOnHermes = (bot: Pick<Bot, "harness">) => harnessOf(bot) === "hermes";

/**
 * Whether Hermes updates still matter. Only a server that runs harnesses, with a roster it knows, can
 * show that no assistant runs on Hermes; during a Hermes outage the roster can be empty, and the update
 * screen holds the restart that recovers it.
 */
export const showsHermesUpdates = (boot: Pick<Bootstrap, "harnesses" | "rosterUnknown" | "bots">) =>
  !boot.harnesses || !!boot.rosterUnknown || boot.bots.some(runsOnHermes);

export type HarnessChoice = { id: string; label: string; available: boolean; reason?: string };

/**
 * The picker's options: the four native harnesses, with any the server cannot run turned off, then any
 * other harness the server advertises. Hermes is offered only to a bot already on it, or while no native
 * harness is available, so nobody moves a bot onto the runtime being retired.
 */
export function harnessChoices(
  advertised: HarnessOption[] | undefined,
  saved: string | undefined,
): HarnessChoice[] {
  const offered = new Map((advertised ?? []).map((option) => [option.id, option]));
  const choices: HarnessChoice[] = [...native, ...offered.keys()]
    .filter((id, index, all) => id !== "hermes" && all.indexOf(id) === index)
    .map((id) => {
      const option = offered.get(id);
      return {
        id,
        label: harnessLabel(id),
        available: !!option?.available,
        reason: option ? option.reason : "Not set up on this server yet.",
      };
    });
  if (saved === "hermes" || !choices.some((choice) => choice.available))
    choices.push({ id: "hermes", label: labels.hermes, available: true });
  return choices;
}

/** The harness a new bot starts on: the first native one available, else Hermes. */
export function defaultHarness(boot: Pick<Bootstrap, "harnesses">) {
  return harnessChoices(boot.harnesses, undefined).find((choice) => choice.available)!.id;
}

/** A capability for one bot: its own value when its harness differs from the bootstrap's runtime. */
export function botCapability(
  boot: Pick<Bootstrap, "capabilities">,
  bot: Pick<Bot, "capabilities">,
  key: "queueManagement",
): Capability | undefined {
  return bot.capabilities?.[key] ?? boot.capabilities[key];
}
