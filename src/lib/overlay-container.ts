import { createContext, useContext } from "react";

// Body portals are inert and behind the top layer while a native dialog is open.
// Overlay wrappers inherit the owning dialog as their portal destination.
export const OverlayContainerContext = createContext<HTMLElement | null>(null);
export function useOverlayContainer() {
  return useContext(OverlayContainerContext);
}
