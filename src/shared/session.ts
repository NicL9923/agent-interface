/**
 * How long a browser sign-in lasts. The server gives the session and its cookie this lifetime, and
 * the web app uses it to tell, without asking, that this browser's sign-in has lapsed.
 */
export const SESSION_MAX_AGE_MS = 7 * 86_400_000;
