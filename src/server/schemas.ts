import { z } from "zod";
import { legacyMascotFamilies, mascotShape } from "../shared/avatar-legacy.js";
import { avatarAccessories, avatarEyes, avatarShapes } from "../shared/types.js";
import type { Avatar, BotInput, FileRef, Preferences, PreferencesPatch } from "../shared/types.js";

// Request schemas whose output is a shared type. Only the server validates, so zod stays out of
// the client bundle; the checks at the end keep each schema and its type in step.
export const id = z.string().min(1).max(200);
export const fileRef = z.object({
  id: z
    .string()
    .min(1)
    .max(8192)
    // `v2.<key id>.<body>.<signature>` since the app signs with its own key, or the earlier `<body>.<signature>`.
    .regex(
      /^(?:v2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/,
    ),
  name: z.string().max(255),
  mime: z.string().max(100),
  size: z.number().optional(),
  url: z.string().optional(),
});
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
  // iOS builds from before mascots were retired still save one. A mascot that release could have
  // sent is stored as its shape; any other is refused like every other bad avatar.
  z
    .object({ mode: z.literal("mascot"), family: z.enum(legacyMascotFamilies), ...face })
    .transform(mascotShape),
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
  harness: z.string().min(1).max(64).optional(),
  enabledMcpServers: z.array(id).max(100).optional(),
  shared: z.boolean(),
  enabledTools: z.array(id).optional(),
  enabledSkills: z.array(id).optional(),
});
export const botSaveRequest = botInput.extend({
  // Making an assistant personal hides it from everyone else, so the person confirms that.
  confirmPrivate: z.boolean().optional(),
  // Sharing someone's main assistant ends it being their main one and stops its check-ins.
  confirmMainCleared: z.boolean().optional(),
});
const quietClock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const quietTime = quietClock.optional();
const validTimezone = (value: string) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
};
const notificationTimezone = z.string().max(100).refine(validTimezone);
const batchMinutes = z.number().int().min(0).max(60);
/** Notification settings as saved: a partial save's merged settings must pass this too. */
export const notifications = z
  .object({
    timezone: notificationTimezone,
    quietStart: quietTime,
    quietEnd: quietTime,
    batchMinutes,
  })
  .refine(
    (value) =>
      !!value.quietStart === !!value.quietEnd &&
      (!value.quietStart || value.quietStart !== value.quietEnd),
    "Choose different quiet start and end times.",
  );
export const modelFavoriteList = z.array(z.object({ provider: id, model: id })).max(100);
export const preferences = z.object({
  presentation: z.enum(["simple", "advanced"]),
  theme: z.enum(["system", "light", "dark"]),
  favorites: z.array(id).max(100),
  modelFavorites: modelFavoriteList.optional(),
  defaultBotId: id.optional(),
  sections: z
    .array(z.object({ id, name: z.string().max(100), botIds: z.array(id).max(100) }))
    .max(30),
  followBots: z.array(id).max(100),
  startPage: z.enum(["today", "assistant"]).optional(),
  chatStyle: z.enum(["bubbles", "classic"]).optional(),
  ownBubble: z.enum(["tint", "solid"]).optional(),
  notifications: notifications.optional(),
  hiddenRoutineRuns: z
    .array(z.object({ botId: id, routineId: id }).strict())
    .max(500)
    .optional(),
  // --- Main assistant: server-owned, so PATCH /preferences ignores what a client sends for these. ---
  mainBotId: id.optional(),
  checkIns: z
    .object({ enabled: z.boolean(), everyHours: z.number(), timezone: z.string() })
    .strict()
    .optional(),
  morningBrief: z
    .object({ enabled: z.boolean(), timeOfDay: z.string(), timezone: z.string() })
    .strict()
    .optional(),
  mainSuggestionDismissed: z.boolean().optional(),
});
const shape = preferences.shape;
/**
 * A partial save (`application/merge-patch+json`): every field optional, `null` only where clearing is
 * allowed. The routed fields are left out, so a partial save ignores them as zod drops unknown keys.
 */
export const preferencesPatch = z.object({
  presentation: shape.presentation.optional(),
  theme: shape.theme.optional(),
  favorites: shape.favorites.optional(),
  defaultBotId: shape.defaultBotId.nullable(),
  sections: shape.sections.optional(),
  followBots: shape.followBots.optional(),
  startPage: shape.startPage.nullable(),
  chatStyle: shape.chatStyle.nullable(),
  ownBubble: shape.ownBubble.nullable(),
  // Merged into the saved settings key by key; the result is checked against `notifications`.
  notifications: z
    .object({
      timezone: notificationTimezone.optional(),
      quietStart: quietClock.nullable().optional(),
      quietEnd: quietClock.nullable().optional(),
      batchMinutes: batchMinutes.optional(),
    })
    .nullable()
    .optional(),
  hiddenRoutineRuns: shape.hiddenRoutineRuns.nullable(),
  mainSuggestionDismissed: shape.mainSuggestionDismissed.nullable(),
});
// --- Main assistant ---
export const timezone = z.string().max(100).refine(validTimezone, "Choose a valid timezone.");
// --- End main assistant ---

type Keys<T> = T extends unknown ? keyof T : never;
/** True when each type is assignable to the other and every union member has the same field names. */
type Same<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? [Exclude<Keys<A>, Keys<B>> | Exclude<Keys<B>, Keys<A>>] extends [never]
      ? true
      : false
    : false
  : false;
type Assert<T extends true> = T;
// A field added to a shared type but not its schema, or the reverse, fails to compile here.
export type SchemaChecks = [
  Assert<Same<z.infer<typeof avatar>, Avatar>>,
  Assert<Same<z.infer<typeof botInput>, BotInput>>,
  Assert<Same<z.infer<typeof fileRef>, FileRef>>,
  Assert<Same<z.infer<typeof preferences>, Preferences>>,
  Assert<Same<z.input<typeof preferencesPatch>, PreferencesPatch>>,
];
