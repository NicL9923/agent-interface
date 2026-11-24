import { useState } from "react";
import { ApiError, request } from "../../client-api";
import { useAction } from "../../app/use-action";
import { routeUrl } from "../../shared/api";
import { useResource } from "../../app/use-resource";
import type { AutomationOverview } from "../../shared/automation";
import { Button } from "../ui/button";

export function useAutomation(botId: string) {
  const path = routeUrl("GET /bots/:id/automation", { id: botId });
  const action = useAction();
  const [uncertain, setUncertain] = useState(false);
  const [refreshCount, setRefreshCount] = useState(0);
  // A status someone loaded answers "Refresh status before trying again", so it retires that warning.
  const overview = useResource(path, {
    load: (_, signal) => request("GET /bots/:id/automation", { params: { id: botId }, signal }),
    onData: () => {
      setUncertain(false);
      action.setError("");
    },
  });
  const { data: value, loading } = overview;
  const change = <T,>(
    send: () => Promise<T>,
    onRefused?: () => void,
    successNotice = "Saved in Hermes.",
  ): Promise<T | undefined> => {
    if (uncertain || loading) return Promise.resolve(undefined);
    return action.run(async ({ current }) => {
      let result: T;
      try {
        result = await send();
      } catch (cause) {
        if (!current()) throw cause;
        if (cause instanceof ApiError && cause.status < 500) onRefused?.();
        const unknown = !(cause instanceof ApiError) || cause.status >= 500;
        setUncertain(unknown || (cause instanceof ApiError && cause.status === 409));
        throw unknown
          ? new Error(
              "We couldn't confirm this change. Refresh status and review it before trying again. Nothing will be sent again automatically.",
            )
          : cause;
      }
      if (!current()) return result;
      let next: AutomationOverview;
      try {
        next = await request("GET /bots/:id/automation", { params: { id: botId } });
      } catch {
        if (current()) {
          setUncertain(true);
          action.setError(
            "The change was accepted, but status could not refresh. Refresh status before making another change.",
          );
        }
        return result;
      }
      if (!current()) return result;
      // Fresher than any load still running, which is dropped.
      overview.setData(next);
      action.setNotice(successNotice);
      return result;
    });
  };
  const refresh = () => {
    setRefreshCount((count) => count + 1);
    return overview.reload();
  };
  return {
    value: value ?? undefined,
    botId,
    change,
    refresh,
    refreshCount,
    busy: action.busy,
    disabled: action.busy || loading || uncertain,
    loading,
    error: action.error || overview.error,
    notice: action.notice,
    clearNotice: () => action.setNotice(""),
    uncertain,
  };
}
export type Controls = ReturnType<typeof useAutomation>;

export function Status({ control }: { control: Controls }) {
  return (
    <>
      <div className="automation-toolbar">
        <span className="muted">Managed by Hermes</span>
        {/* aria-disabled, not disabled: a disabled button can't take focus, and keyboard users wait on this one while a change or refresh is busy. */}
        <Button
          aria-disabled={control.loading || control.busy || undefined}
          onClick={() => {
            if (!control.loading && !control.busy) void control.refresh();
          }}
        >
          {control.loading ? "Refreshing..." : "Refresh status"}
        </Button>
      </div>
      {control.error && (
        <p className="form-error" role="alert">
          {control.error}
        </p>
      )}
      {control.notice && (
        <p className="form-notice" role="status">
          {control.notice}
        </p>
      )}
      {!control.value && control.loading && <p role="status">Loading assistant controls...</p>}
    </>
  );
}
