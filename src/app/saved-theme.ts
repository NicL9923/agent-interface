import type { Preferences } from "../shared/types";
import { hintedUser } from "./account-epoch";
import { localRead, localRemove, localSave, savedThemeKey } from "./storage";

/**
 * The theme this device last showed, kept so public/boot.js can apply it before the bundle loads and a
 * dark theme never opens light. It names its account, and boot.js applies it only while the sign-in
 * hint names that same account; it goes with the hint (see accountKeys). Raising the version makes
 * boot.js ignore what an older release saved.
 */
export const SAVED_THEME_VERSION = 1;
type SavedTheme = { v: typeof SAVED_THEME_VERSION; user: string; theme: Preferences["theme"] };

/** The theme public/boot.js applies: the saved one while the sign-in hint names its account. */
export function savedTheme(): Preferences["theme"] | null {
  const user = hintedUser(), saved = localRead<Partial<SavedTheme>>(savedThemeKey);
  return user && saved?.v === SAVED_THEME_VERSION && saved.user === user && (saved.theme === "light" || saved.theme === "dark" || saved.theme === "system")
    ? saved.theme : null;
}

export function rememberTheme(user: string, theme: Preferences["theme"]) {
  // Without a sign-in this browser saw for this account, boot.js would never apply it.
  if (hintedUser() !== user) return localRemove(savedThemeKey);
  const saved = localRead<Partial<SavedTheme>>(savedThemeKey);
  if (saved?.v === SAVED_THEME_VERSION && saved.user === user && saved.theme === theme) return;
  localSave(savedThemeKey, { v: SAVED_THEME_VERSION, user, theme } satisfies SavedTheme);
}
