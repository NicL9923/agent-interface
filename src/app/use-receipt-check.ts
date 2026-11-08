import { useEffect, useRef } from "react";
import type { SubmissionReceipt } from "../shared/types";
import { request as apiRequest } from "../client-api";

// Receipt checks start every 2 seconds and slow to every 30 while nothing settles them.
const firstCheck = 2000, slowestCheck = 30000;

/**
 * Checks a message request whose outcome is unknown by its ID, never sending it again, until a
 * receipt settles it. Skips checks while offline or hidden. `requestId` undefined stops checking;
 * a new `scope` with the same ID starts over, as when the same request is followed for another turn.
 */
export function useReceiptCheck(requestId: string | undefined, settle: (receipt: SubmissionReceipt) => void, scope?: string) {
  const settleRef = useRef(settle);
  settleRef.current = settle;
  useEffect(() => {
    if (!requestId) return;
    let live = true, delay = firstCheck, timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      if (navigator.onLine !== false && document.visibilityState !== "hidden") {
        try {
          const result = await apiRequest("GET /submissions/:id", { params: { id: requestId } });
          if (!live) return;
          if (result.status !== "uncertain") { settleRef.current(result); return; }
        } catch {
          /* Unconfirmed until a reliable receipt. */
        }
      }
      if (!live) return;
      timer = setTimeout(() => void check(), delay);
      delay = Math.min(delay * 2, slowestCheck);
    };
    void check();
    return () => { live = false; clearTimeout(timer); };
  }, [requestId, scope]);
}
