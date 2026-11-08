/** A Mac linked with WildBots for Mac, as its owner sees it. See docs/MacLink.md. */
export interface LinkedMac {
  id: string;
  name: string;
  model: string | null;
  osVersion: string | null;
  appVersion: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  online: boolean;
  /** Only while online. */
  state: { paused: boolean; screenLocked: boolean } | null;
}
/** The signed-in person's Macs. Unavailable when the server has no Mac link key. */
export type LinkedMacs = { available: true; devices: LinkedMac[] } | { available: false; reason: string; devices: [] };
