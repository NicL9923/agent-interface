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
      const resume = (result as AutomationOverview | undefined)?.goals?.resume;
      if (resume?.status === "uncertain") {
        setUncertain(true);
        action.setError(
          "The goal's start is uncertain. Refresh status and review the conversation before trying again.",
        );
        return result;
      }
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
      if (resume?.status === "rejected")
        action.setError(
          resume.message || "Hermes refused to start this goal. Review its status before resuming.",
        );
      else action.setNotice(successNotice);
      return result;
    });
  };
  const changeTask = <T,>(
    send: () => Promise<T>,
  ): Promise<
    | {
        kind: "saved" | "refused";
        message: string;
        overview: AutomationOverview;
        refreshed?: boolean;
        result?: T;
      }
    | undefined
  > => {
    if (uncertain || loading) return Promise.resolve(undefined);
    return action.run(async ({ current }) => {
      let refusal = "";
      let result: T | undefined;
      try {
        result = await send();
      } catch (cause) {
        if (!current()) throw cause;
        if (cause instanceof ApiError && cause.status < 500) refusal = cause.message;
        else {
          setUncertain(true);
          throw new Error(
            "We couldn't confirm this change. Refresh status and review it before trying again. Nothing will be sent again automatically.",
          );
        }
      }
      if (!current()) return undefined;
      let next: AutomationOverview;
      try {
        next = await request("GET /bots/:id/automation", { params: { id: botId } });
      } catch {
        if (current()) {
          setUncertain(true);
          action.setError(
            refusal
              ? "Status could not refresh. Refresh status before making another change."
              : "The change could not be confirmed because status could not refresh. Refresh status before making another change.",
          );
        }
        if (refusal && value)
          return {
            kind: "refused" as const,
            message: `${refusal} Status could not refresh.`,
            overview: value,
            refreshed: false,
          };
        return undefined;
      }
      if (!current()) return undefined;
      overview.setData(next);
      return {
        kind: refusal ? ("refused" as const) : ("saved" as const),
        message: refusal,
        overview: next,
        result,
      };
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
    changeTask,
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

export function Status({ control, work = false }: { control: Controls; work?: boolean }) {
  const receipt = work ? control.value?.goals.resume : undefined;
  const rejectedMessage =
    receipt?.status === "rejected"
      ? receipt.message || "Hermes refused to start this goal. Review its status before resuming."
      : undefined;
  const receiptAnnounced = !!rejectedMessage && control.error === rejectedMessage;
  const receiptAnnouncement =
    receipt?.status === "rejected"
      ? rejectedMessage
      : receipt?.status === "uncertain"
        ? receipt.message ||
          "Hermes could not confirm this goal continuation. Review the conversation before trying again."
        : "";
  const receiptKey = receipt ? `${receipt.requestId}:${receipt.status}` : "";
  const [resultKey, setResultKey] = useState("");
  if (receiptAnnounced && resultKey !== receiptKey) setResultKey(receiptKey);
  const statusText = receiptAnnounced || receiptKey === resultKey ? "" : receiptAnnouncement;
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
      {work && (
        <>
          <p
            className="sr-only"
            role="status"
            aria-label="Resume status"
            aria-live="polite"
            aria-atomic="true"
          >
            {statusText}
          </p>
          <p
            className="sr-only"
            role="status"
            aria-label="Resume result"
            aria-live="polite"
            aria-atomic="true"
          >
            {receiptAnnounced ? control.error : ""}
          </p>
        </>
      )}
      {control.error && !receiptAnnounced && (
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
