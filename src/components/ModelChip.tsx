import type { Bot } from "../shared/types";
import { Icon } from "./Icon";
import { ProviderIcon } from "./ProviderIcon";

/** The provider mark and the model's display name, which the server fills. The raw slug is the fallback for an older server. */
export function ModelChipFace({ bot }: { bot: Pick<Bot, "model" | "modelName" | "provider"> }) {
  return <>
    <ProviderIcon provider={bot.provider} size={14} />
    <span className="model-chip-name">{bot.modelName || bot.model}</span>
    <Icon name="chevron-down" size={12} className="model-chip-caret" />
  </>;
}
/** The exact provider and model identifiers, for someone who needs them. */
export const modelChipTitle = (bot: Pick<Bot, "model" | "provider">) => bot.provider ? `${bot.provider} / ${bot.model}` : bot.model;
