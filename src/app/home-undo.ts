import type { Preferences } from "../shared/types";
import { sectionOf } from "./preferences-editing";

type Edit = (preferences: Preferences) => Preferences;
/** A home change and the edit that puts things back where they were. */
export type UndoableEdit = { apply: Edit; undo: Edit; message: string };

/** Pins or unpins; undo returns the assistant to its old place among the pins. */
export function togglePinEdit(preferences: Preferences, botId: string, name: string): UndoableEdit {
  const index = preferences.favorites.indexOf(botId);
  const pinned = index >= 0;
  const without = (value: Preferences) => ({ ...value, favorites: value.favorites.filter(id => id !== botId) });
  const at = (value: Preferences, position: number) => {
    const favorites = value.favorites.filter(id => id !== botId);
    favorites.splice(Math.min(position, favorites.length), 0, botId);
    return { ...value, favorites };
  };
  return pinned
    ? { apply: without, undo: value => at(value, index), message: `Unpinned ${name}` }
    : { apply: value => at(value, value.favorites.length), undo: without, message: `Pinned ${name}` };
}

/** Moves to a home section; undo returns the assistant to its old section and position. */
export function moveSectionEdit(preferences: Preferences, botId: string, name: string, sectionId: string | null): UndoableEdit {
  const before = sectionOf(preferences, botId);
  const index = before?.botIds.indexOf(botId) ?? -1;
  const place = (value: Preferences, target: string | null, position: number) => ({
    ...value,
    sections: value.sections.map(section => {
      const rest = section.botIds.filter(id => id !== botId);
      if (section.id !== target) return { ...section, botIds: rest };
      rest.splice(position < 0 ? rest.length : Math.min(position, rest.length), 0, botId);
      return { ...section, botIds: rest };
    }),
  });
  const target = preferences.sections.find(section => section.id === sectionId);
  return {
    apply: value => place(value, sectionId, -1),
    undo: value => place(value, before?.id ?? null, index),
    message: target ? `Moved ${name} to ${target.name}` : `Removed ${name} from ${before?.name ?? "its section"}`,
  };
}
