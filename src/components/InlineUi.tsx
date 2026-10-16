import { useLayoutEffect, useRef, useState } from "react";
import type { InlineDocument } from "../shared/inline-ui";
import "./inline-ui.css";

export function InlineUi({ document }: { document: InlineDocument }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(240);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [generation, setGeneration] = useState(0);
  useLayoutEffect(() => {
    setState("loading"); setHeight(240);
    const send = (data: unknown) => frame.current?.contentWindow?.postMessage(data, "*");
    const theme = () => {
      const style = getComputedStyle(window.document.documentElement);
      const names = { "--background": "--surface", "--foreground": "--ink", "--muted-foreground": "--muted", "--card": "--raised", "--border": "--line", "--primary": "--accent", "--primary-foreground": "--surface" };
      send({ type: "wildbots-theme", colorScheme: style.colorScheme, variables: { ...Object.fromEntries(Object.entries(names).map(([name, source]) => [name, style.getPropertyValue(source).trim()])), "--radius": "12px" } });
    };
    const timeout = window.setTimeout(() => setState("failed"), 10000);
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      if (event.data?.type === "wildbots-ready") send({ type: "wildbots-init", html: document.html });
      if (event.data?.type === "wildbots-loaded") { clearTimeout(timeout); setState("ready"); theme(); }
      if (event.data?.type === "wildbots-size" && typeof event.data.height === "number" && Number.isFinite(event.data.height)) setHeight(Math.max(80, Math.min(1600, Math.ceil(event.data.height))));
    };
    window.addEventListener("message", receive);
    const observer = new MutationObserver(theme);
    observer.observe(window.document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style", "class"] });
    const media = matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", theme);
    return () => { clearTimeout(timeout); window.removeEventListener("message", receive); observer.disconnect(); media.removeEventListener("change", theme); };
  }, [document.html, generation]);
  return <div className="inline-ui">
    {state === "loading" && <p className="muted" role="status">Loading interactive view…</p>}
    {state === "failed" && <p role="status">This view couldn't load. You can retry or inspect its source.</p>}
    <iframe key={generation} ref={frame} src="/inline-ui" title={document.title} sandbox="allow-scripts" referrerPolicy="no-referrer" allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'" style={{ height }} />
    <div className="inline-ui-controls"><span>{document.title} · Generated view</span><button type="button" onClick={() => setGeneration(value => value + 1)}>{state === "failed" ? "Retry view" : "Reset view"}</button></div>
    <details><summary>View source</summary><pre tabIndex={0}>{document.html}</pre></details>
  </div>;
}
