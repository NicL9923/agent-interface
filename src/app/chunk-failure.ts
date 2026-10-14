import { useState } from "react";

// Browsers word a failed dynamic import differently: Chrome and Firefox name the module, Safari does not.
const chunkFailure = /dynamically imported module|importing a module script/i;
export const isChunkFailure = (cause: unknown) => cause instanceof Error && chunkFailure.test(cause.message);

/** Throws an error from render, so a screen's error boundary shows it instead of the screen retrying forever. */
export function useRaise() {
  const [, set] = useState();
  return (cause: unknown) => set(() => { throw cause; });
}
