import { Component, lazy, Suspense, useState } from "react";
import type { ReactNode } from "react";

// Screens most visits never open load on first use, so they stay out of the code every launch parses.
export const BotSettings = lazy(() => import("../BotSettings").then(module => ({ default: module.BotSettings })));
export const RoutineResults = lazy(() => import("../components/RoutineResults").then(module => ({ default: module.RoutineResults })));
export const IntegrationsPanel = lazy(() => import("../components/IntegrationsPanel").then(module => ({ default: module.IntegrationsPanel })));
export const ComputerPanel = lazy(() => import("../components/ComputerPanel").then(module => ({ default: module.ComputerPanel })));
export const HermesUpgradePanel = lazy(() => import("../components/HermesUpgradePanel").then(module => ({ default: module.HermesUpgradePanel })));
export const PreferencesDialog = lazy(() => import("./PreferencesDialog").then(module => ({ default: module.PreferencesDialog })));
export const ComposerModelPicker = lazy(() => import("../components/ComposerModelPicker").then(module => ({ default: module.ComposerModelPicker })));
export const DiscoveryPanel = lazy(() => import("../components/DiscoveryPanel").then(module => ({ default: module.DiscoveryPanel })));
export const GroupChats = lazy(() => import("../components/GroupChats").then(module => ({ default: module.GroupChats })));

/** True once `active` has been, for panels that keep their state while closed but need not load until first use. */
export function useOnceActive(active: boolean) {
  const [seen, setSeen] = useState(active);
  if (active && !seen) setSeen(true);
  return seen || active;
}

// A screen that cannot load, offline or because a release replaced its file, must not take the whole app down.
class LoadFailure extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed
      ? <div className="notice error panel-failure" role="alert">
        <span>This screen could not load. Check your connection, then reload to try again.</span>
        <button type="button" onClick={() => location.reload()}>Reload</button>
      </div>
      : this.props.children;
  }
}

/** Shows a quiet status while a lazy screen loads, and a reload notice if it cannot. */
export function Loading({ children }: { children: ReactNode }) {
  return <LoadFailure>
    <Suspense fallback={<p className="panel-loading" role="status">Opening…</p>}>{children}</Suspense>
  </LoadFailure>;
}
