import { Component, lazy, Suspense, useState } from "react";
import type { ReactNode } from "react";
import { useDelayedStatus } from "./use-delayed-status";

// Raw chunk loaders, shared with intent-prefetch.ts so preloaded chunks hit the exact same graph.
export const loadBotSettings = () => import("../BotSettings");
export const loadRoutineResults = () => import("../components/RoutineResults");
export const loadUsagePanel = () => import("../components/UsagePanel");
export const loadComputerPanel = () => import("../components/ComputerPanel");
export const loadBotDetails = () => import("./BotDetails");
export const loadPreferencesDialog = () => import("./PreferencesDialog");
export const loadChatModelPicker = () => import("../components/ChatModelPicker");
export const loadDiscoveryPanel = () => import("../components/DiscoveryPanel");
export const loadGroupRoomView = () => import("../components/GroupChats");
export const loadGroupCreate = () => import("../components/GroupCreate");
export const loadTodayPanel = () => import("../components/TodayPanel");
export const loadCommandPalette = () => import("./CommandPalette");
export const loadMainAssistantPicker = () => import("./MainAssistantPicker");
export const loadShortcutsDialog = () => import("./ShortcutsDialog");

// Screens most visits never open load on first use, so they stay out of the code every launch parses.
export const BotSettings = lazy(() =>
  loadBotSettings().then((module) => ({ default: module.BotSettings })),
);
export const RoutineResults = lazy(() =>
  loadRoutineResults().then((module) => ({ default: module.RoutineResults })),
);
export const UsagePanel = lazy(() =>
  loadUsagePanel().then((module) => ({ default: module.UsagePanel })),
);
export const ComputerPanel = lazy(() =>
  loadComputerPanel().then((module) => ({ default: module.ComputerPanel })),
);
export const BotDetails = lazy(() =>
  loadBotDetails().then((module) => ({ default: module.BotDetails })),
);
export const PreferencesDialog = lazy(() =>
  loadPreferencesDialog().then((module) => ({ default: module.PreferencesDialog })),
);
export const ChatModelPicker = lazy(() =>
  loadChatModelPicker().then((module) => ({ default: module.ChatModelPicker })),
);
export const DiscoveryPanel = lazy(() =>
  loadDiscoveryPanel().then((module) => ({ default: module.DiscoveryPanel })),
);
export const GroupRoomView = lazy(() =>
  loadGroupRoomView().then((module) => ({ default: module.GroupRoomView })),
);
export const GroupCreate = lazy(() =>
  loadGroupCreate().then((module) => ({ default: module.GroupCreate })),
);
export const TodayPanel = lazy(() =>
  loadTodayPanel().then((module) => ({ default: module.TodayPanel })),
);
export const CommandPalette = lazy(() =>
  loadCommandPalette().then((module) => ({ default: module.CommandPalette })),
);
export const MainAssistantPicker = lazy(() =>
  loadMainAssistantPicker().then((module) => ({ default: module.MainAssistantPicker })),
);
export const ShortcutsDialog = lazy(() =>
  loadShortcutsDialog().then((module) => ({ default: module.ShortcutsDialog })),
);

/** True once `active` has been, for panels that keep their state while closed but need not load until first use. */
export function useOnceActive(active: boolean) {
  const [seen, setSeen] = useState(active);
  if (active && !seen) setSeen(true);
  return seen || active;
}

// A screen that cannot load, offline or because a release replaced its file, must not take the whole app down.
class LoadFailure extends Component<
  { children: ReactNode; fallback?: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed
      ? (this.props.fallback ?? (
          <div className="notice error panel-failure" role="alert">
            <span>
              This screen could not load. The app may have been updated, or the connection dropped.
              Reload to try again.
            </span>
            <button type="button" onClick={() => location.reload()}>
              Reload
            </button>
          </div>
        ))
      : this.props.children;
  }
}

function DelayedOpening() {
  const shown = useDelayedStatus(true);
  return shown ? (
    <p className="panel-loading" role="status">
      Opening…
    </p>
  ) : null;
}

/** Shows a quiet status while a lazy screen loads slowly, and a reload notice if it cannot. */
export function Loading({
  children,
  loadingFallback,
  errorFallback,
}: {
  children: ReactNode;
  loadingFallback?: ReactNode;
  errorFallback?: ReactNode;
}) {
  return (
    <LoadFailure fallback={errorFallback}>
      <Suspense fallback={loadingFallback ?? <DelayedOpening />}>{children}</Suspense>
    </LoadFailure>
  );
}
