import type { Preferences } from "../shared/types";
import type { PreferenceField } from "./preference-queue";
import { sectionOf } from "./preferences-editing";

type Edit = (preferences: Preferences) => Preferences;
/** A home change, the edit that puts things back where they were, and the fields both set. */
export type UndoableEdit = {
  apply: Edit;
  undo: Edit;
  message: string;
  fields: readonly PreferenceField[];
  /** Shown instead of `message` when `apply` finds nothing to change. */
  unchanged?: string;
};

/** Pins or unpins; undo returns the assistant to its old place among the pins. */
export function togglePinEdit(preferences: Preferences, botId: string, name: string): UndoableEdit {
  const index = preferences.favorites.indexOf(botId);
  const pinned = index >= 0;
  // Each returns the value it was given when there is nothing to do, so running one twice changes nothing.
  const without = (value: Preferences) =>
    value.favorites.includes(botId)
      ? { ...value, favorites: value.favorites.filter((id) => id !== botId) }
      : value;
  const at = (value: Preferences, position: number) => {
    if (value.favorites.includes(botId)) return value;
    const favorites = [...value.favorites];
    favorites.splice(Math.min(position, favorites.length), 0, botId);
    return { ...value, favorites };
  };
  const fields = ["favorites"] as const;
  return pinned
    ? { apply: without, undo: (value) => at(value, index), message: `Unpinned ${name}`, fields }
    : {
        apply: (value) => at(value, value.favorites.length),
        undo: without,
        message: `Pinned ${name}`,
        fields,
      };
}

/** Moves to a home section; undo returns the assistant to its old section and position. */
export function moveSectionEdit(
  preferences: Preferences,
  botId: string,
  name: string,
  sectionId: string | null,
): UndoableEdit {
  const before = sectionOf(preferences, botId);
  const index = before?.botIds.indexOf(botId) ?? -1;
  // A section that is gone leaves the assistant where it is.
  const place = (value: Preferences, target: string | null, position: number) => {
    if (target !== null && !value.sections.some((section) => section.id === target)) return value;
    return {
      ...value,
      sections: value.sections.map((section) => {
        const rest = section.botIds.filter((id) => id !== botId);
        if (section.id !== target) return { ...section, botIds: rest };
        rest.splice(position < 0 ? rest.length : Math.min(position, rest.length), 0, botId);
        return { ...section, botIds: rest };
      }),
    };
  };
  const target = preferences.sections.find((section) => section.id === sectionId);
  return {
    apply: (value) => place(value, sectionId, -1),
    undo: (value) => place(value, before?.id ?? null, index),
    message: target
      ? `Moved ${name} to ${target.name}`
      : `Removed ${name} from ${before?.name ?? "its section"}`,
    fields: ["sections"],
    unchanged: target
      ? `${target.name} is no longer a section, so ${name} stayed where it was`
      : undefined,
  };
}
