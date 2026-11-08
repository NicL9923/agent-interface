import { useEffect, useRef, useState } from "react";
import type RFB from "@novnc/novnc";
import { api } from "../client-api";
import type { ComputerStreamTicket } from "../shared/computer";
import { computerSocketUrl } from "../lib/socket-url";
import { openComputer } from "./ComputerHandoffCard";
import { Icon } from "./Icon";

/**
 * A small live view of the shared desktop, docked in the transcript's corner while an assistant
 * uses the computer. It watches only, with its own attachment that never takes control, and
 * opening it shows the full computer view. Hidden, failed or dismissed, it holds no connection.
 */
export function ComputerPeek({ name }: { name: string }) {
  const screen = useRef<HTMLSpanElement>(null);
  const [state, setState] = useState<"connecting" | "live" | "gone">("connecting");
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    if (dismissed) return;
    const controller = new AbortController();
    let client: RFB | null = null;
    void (async () => {
      try {
        const [{ default: RemoteFrameBuffer }, ticket] = await Promise.all([
          import("@novnc/novnc"),
          api<ComputerStreamTicket>("/computer/desktop", { method: "POST", body: JSON.stringify({}), signal: controller.signal }),
        ]);
        if (controller.signal.aborted || !screen.current) return;
        client = new RemoteFrameBuffer(screen.current, computerSocketUrl(ticket.path));
        client.viewOnly = true;
        client.scaleViewport = true;
        client.resizeSession = false;
        client.addEventListener("connect", () => setState("live"));
        client.addEventListener("disconnect", () => setState("gone"));
        client.addEventListener("securityfailure", () => setState("gone"));
      } catch {
        if (!controller.signal.aborted) setState("gone");
      }
    })();
    return () => {
      controller.abort();
      client?.disconnect();
    };
  }, [dismissed]);
  if (dismissed || state === "gone") return null;
  return <div className="computer-peek" data-state={state}>
    <button type="button" className="computer-peek-screen" aria-label={`Watch ${name} on the computer`} title="Open the computer" onClick={() => openComputer()}>
      <span ref={screen} className="computer-peek-canvas" aria-hidden="true" />
      {state === "connecting" && <span className="computer-peek-wait" aria-hidden="true"><Icon name="spinner" className="spin" size={16} /></span>}
      <span className="computer-peek-label" aria-hidden="true"><Icon name="computer" size={12} />Live</span>
    </button>
    <button type="button" className="computer-peek-close" aria-label="Hide the computer preview" onClick={() => setDismissed(true)}>
      <Icon name="close" size={14} />
    </button>
  </div>;
}
