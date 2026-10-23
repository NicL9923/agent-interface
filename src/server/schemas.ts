import { z } from "zod";
import { avatarAccessories, avatarEyes, avatarShapes, mascotFamilies } from "../shared/types.js";
import type { Avatar, BotInput, Preferences } from "../shared/types.js";

// Request schemas whose output is a shared type. Only the server validates, so zod stays out of
// the client bundle; the checks at the end keep each schema and its type in step.
export const id = z.string().min(1).max(200);
export const apnsToken = z.string().regex(/^(?:[0-9a-fA-F]{2}){16,256}$/);
const scale = z.number().min(0.6).max(1.5).optional();
const face = {
  color: z.string().regex(/^#[0-9a-f]{6}$/i),
  eyes: z.enum(avatarEyes),
  accessory: z.enum(avatarAccessories),
  eyeWidth: scale,
  eyeHeight: scale,
  eyeSpacing: scale,
};
export const avatar = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("geometric"), shape: z.enum(avatarShapes), ...face }),
  z.object({ mode: z.literal("mascot"), family: z.enum(mascotFamilies), ...face }),
  z.object({
    mode: z.literal("portrait"),
    src: z.string().regex(/^\/api\/files\//),
    origin: z.enum(["uploaded", "generated"]),
  }),
]);
export const botInput = z.object({
  confirmModel: z.boolean().optional(),
  name: z.string().min(1).max(100),
  description: z.string().max(1000).optional(),
  instructions: z.string().max(50000),
  model: z.string().min(1).max(200),
  provider: z.string().min(1).max(200).optional(),
  enabledMcpServers: z.array(id).max(100).optional(),
  shared: z.boolean(),
  enabledTools: z.array(id).optional(),
  enabledSkills: z.array(id).optional(),
});
export const botSaveRequest = botInput.extend({
  // Making an assistant personal hides it from everyone else, so the person confirms that.
  confirmPrivate: z.boolean().optional(),
});
const quietTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional();
const validTimezone = (value: string) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
};
export const modelFavoriteList = z.array(z.object({ provider: id, model: id })).max(100);
export const preferences = z.object({
  presentation: z.enum(["simple", "advanced"]),
  theme: z.enum(["system", "light", "dark"]),
  favorites: z.array(id).max(100),
  modelFavorites: modelFavoriteList.optional(),
  defaultBotId: id.optional(),
  sections: z.array(z.object({ id, name: z.string().max(100), botIds: z.array(id).max(100) })).max(30),
  followBots: z.array(id).max(100),
  startPage: z.enum(["today", "assistant"]).optional(),
  notifications: z
    .object({
      timezone: z.string().max(100).refine(validTimezone),
      quietStart: quietTime,
      quietEnd: quietTime,
      batchMinutes: z.number().int().min(0).max(60),
    })
    .refine(
      value => !!value.quietStart === !!value.quietEnd && (!value.quietStart || value.quietStart !== value.quietEnd),
      "Choose different quiet start and end times.",
    )
    .optional(),
});

type Keys<T> = T extends unknown ? keyof T : never;
/** True when each type is assignable to the other and every union member has the same field names. */
type Same<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? [Exclude<Keys<A>, Keys<B>> | Exclude<Keys<B>, Keys<A>>] extends [never] ? true : false
    : false
  : false;
type Assert<T extends true> = T;
// A field added to a shared type but not its schema, or the reverse, fails to compile here.
export type SchemaChecks = [
  Assert<Same<z.infer<typeof avatar>, Avatar>>,
  Assert<Same<z.infer<typeof botInput>, BotInput>>,
  Assert<Same<z.infer<typeof preferences>, Preferences>>,
];
