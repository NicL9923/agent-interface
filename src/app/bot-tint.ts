import type { CSSProperties } from "react";
import type { Bot } from "../shared/types";

const hex = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** The color an assistant's chat is tinted with: its drawn avatar's color. Photos keep the app's green. */
export function botTint(bot?: Bot): string | undefined {
  const avatar = bot?.avatar;
  return avatar && avatar.mode !== "portrait" && hex.test(avatar.color) ? avatar.color : undefined;
}

/** Props that tint a chat's surfaces; the CSS derives readable washes from the one color. */
export function tintProps(bot?: Bot): { "data-tint"?: string; style?: CSSProperties } {
  const tint = botTint(bot);
  return tint ? { "data-tint": "", style: { ["--bot-tint" as string]: tint } } : {};
}
