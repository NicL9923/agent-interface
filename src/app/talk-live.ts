import { useSyncExternalStore } from "react";

// One live Talk per page. Recording and reading replies aloud check this, so neither
// can start while the microphone and speaker belong to a live conversation.
let talking = false;
const listeners = new Set<() => void>();
export function setTalkLive(value: boolean) {
  if (talking === value) return;
  talking = value;
  for (const listener of listeners) listener();
}
export const talkLive = () => talking;
export function useTalkLive() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, talkLive, talkLive);
}
