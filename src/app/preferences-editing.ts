import type { Preferences } from "../shared/types";

// Follow and home-section edits as pure functions over the saved preferences. Every
// result keeps the invariant the home list relies on: a bot belongs to at most one section.

export type Section = Preferences["sections"][number];
export const sectionNameLimit = 100;

/** The section a bot sits in on home, if any. */
export function sectionOf(preferences: Preferences, botId: string): Section | undefined {
  return preferences.sections.find(section => section.botIds.includes(botId));
}

export function setFollowing(preferences: Preferences, botId: string, following: boolean): Preferences {
  const rest = preferences.followBots.filter(id => id !== botId);
  return { ...preferences, followBots: following ? [...rest, botId] : rest };
}

/** Replaces the followed set, keeping the order of bots already followed. */
export function setFollowedBots(preferences: Preferences, botIds: string[]): Preferences {
  const wanted = new Set(botIds);
  const kept = preferences.followBots.filter(id => wanted.has(id));
  return { ...preferences, followBots: [...kept, ...botIds.filter(id => !kept.includes(id))] };
}

/** Puts a bot in one section, or in none with `null`, taking it out of any other. */
export function moveBotToSection(preferences: Preferences, botId: string, sectionId: string | null): Preferences {
  return {
    ...preferences,
    sections: preferences.sections.map(section => {
      const rest = section.botIds.filter(id => id !== botId);
      return { ...section, botIds: section.id === sectionId ? [...rest, botId] : rest };
    }),
  };
}

/** Sets a section's members; bots chosen here leave the section they were in. */
export function setSectionBots(preferences: Preferences, sectionId: string, botIds: string[]): Preferences {
  const chosen = new Set(botIds);
  return {
    ...preferences,
    sections: preferences.sections.map(section => {
      if (section.id !== sectionId) return { ...section, botIds: section.botIds.filter(id => !chosen.has(id)) };
      const kept = section.botIds.filter(id => chosen.has(id));
      return { ...section, botIds: [...kept, ...botIds.filter(id => !kept.includes(id))] };
    }),
  };
}

/** A usable section name, or why it is not one. */
export function checkSectionName(preferences: Preferences, name: string, exceptId?: string): { name: string } | { error: string } {
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (!trimmed) return { error: "Enter a section name." };
  if (trimmed.length > sectionNameLimit) return { error: `Use ${sectionNameLimit} characters or fewer.` };
  const taken = preferences.sections.some(section => section.id !== exceptId && section.name.toLocaleLowerCase() === trimmed.toLocaleLowerCase());
  return taken ? { error: `You already have a section called ${trimmed}.` } : { name: trimmed };
}

/** Adds a section at the end. With a bot, that bot moves into it. */
/**
 * Takes the new section's ID rather than making one: an edit can run twice, once on screen and
 * once in the save queue, and both runs must name the same section.
 */
export function addSection(preferences: Preferences, name: string, id: string, botId?: string): Preferences {
  const added = { ...preferences, sections: [...preferences.sections, { id, name: name.trim(), botIds: [] }] };
  return botId ? moveBotToSection(added, botId, id) : added;
}

export function renameSection(preferences: Preferences, sectionId: string, name: string): Preferences {
  return { ...preferences, sections: preferences.sections.map(section => section.id === sectionId ? { ...section, name: name.trim() } : section) };
}

/** Deleting a section keeps its bots; they return to the general list. */
export function removeSection(preferences: Preferences, sectionId: string): Preferences {
  return { ...preferences, sections: preferences.sections.filter(section => section.id !== sectionId) };
}

export function moveSection(preferences: Preferences, sectionId: string, offset: -1 | 1): Preferences {
  const index = preferences.sections.findIndex(section => section.id === sectionId);
  const target = index + offset;
  if (index < 0 || target < 0 || target >= preferences.sections.length) return preferences;
  const sections = [...preferences.sections];
  [sections[index], sections[target]] = [sections[target], sections[index]];
  return { ...preferences, sections };
}

// Plain-HTTP origins, such as a LAN address, have no crypto.randomUUID.
export function newSectionId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `section-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
