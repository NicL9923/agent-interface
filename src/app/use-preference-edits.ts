import type { Preferences } from "../shared/types";
import type { PreferenceField, SaveResult } from "./preference-queue";

/** An edit to whole preferences. The session's save queue runs it once, on the preferences on screen. */
export type PreferenceEdit = (value: Preferences) => Preferences;

/**
 * Runs an edit on the preferences every screen shows, which are the server's last answer with the saves
 * still waiting laid over them, puts the result on screen at once, and saves the fields `chosen` names
 * and any the edit changed. A sheet reads the session's preferences rather than keeping a copy of its
 * own, so it always offers what the next edit builds on.
 */
export type EditPreferences = (
  edit: PreferenceEdit,
  chosen: readonly PreferenceField[],
) => Promise<SaveResult>;
