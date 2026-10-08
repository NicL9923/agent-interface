import { useCallback, useEffect, useRef, useState } from "react";
import type RFB from "@novnc/novnc";
import type { Terminal } from "@xterm/xterm";
import { api, ApiError, write } from "../client-api";
import type { ComputerStatus, ComputerStreamTicket } from "../shared/computer";
import { loadGoogleIdentity, renderGoogleButton } from "./google-identity";
import { Icon } from "./Icon";
import type { AuthConfig } from "./SignIn";
import "@xterm/xterm/css/xterm.css";
import "./computer.css";

type Connection = "connecting" | "connected" | "reconnecting" | "ended" | "failed";
type Tab = "desktop" | "terminal";
const RETRY_DELAY = 2500;

function socketUrl(path: string) {
  const url = new URL(path, location.href);
  if (url.origin !== location.origin || !url.pathname.startsWith("/api/computer/")) {
    throw new Error("The computer returned an invalid connection address.");
  }
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}
function failure(cause: unknown, fallback: string) {
  // The general request helper discusses chat drafts. Computer errors need their own context.
  return cause instanceof ApiError && cause.code === "CONNECTION_UNAVAILABLE"
    ? fallback : cause instanceof Error ? cause.message : fallback;
}
const reauthenticate = (cause: unknown) => cause instanceof ApiError && cause.code === "reauthentication_required";
function retryable(cause: unknown) {
  return !(cause instanceof ApiError && [401, 403].includes(cause.status));
}
function ownerLabel(status: ComputerStatus | null, controlling: boolean) {
  if (controlling) return "You have control";
  if (status?.control.kind === "human") return status.control.mine
    ? "Watching. Take over to control the desktop."
    : `${status.control.name || "A household member"} has control`;
  if (status?.control.kind === "bot") return `${status.control.name || "An assistant"} is using the computer`;
  return "Watching. Assistants can use this computer.";
}

export function ComputerPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("desktop");
  const [terminalOpened, setTerminalOpened] = useState(false);
  // Chosen once, so an open shell is not replaced when its confirmation ages past two hours.
  const [terminalStep, setTerminalStep] = useState<"confirm" | "shell" | null>(null);
  const [status, setStatus] = useState<ComputerStatus | null>(null);
  const [statusError, setStatusError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  // This is an attachment identity, never an authorization token. It lasts only for this signed-in user.
  const viewerId = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const element = dialog.current;
    element?.showModal();
    return () => {
      element?.close();
      if (previous?.isConnected && !previous.closest("[inert]")) previous.focus();
      else (document.querySelector<HTMLButtonElement>(".bot-rail:not([inert]) [aria-label='Settings']")
        ?? document.querySelector<HTMLButtonElement>("[aria-label='Back to assistants']"))?.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let loading = false;
    const refresh = async () => {
      if (loading || navigator.onLine === false) return;
      loading = true;
      try {
        const next = await api<ComputerStatus>("/computer", { signal: controller.signal });
        if (controller.signal.aborted) return;
        setStatus(next);
        setStatusError("");
      } catch {
        if (!controller.signal.aborted) setStatusError("Can't reach the shared computer. We'll keep trying.");
      } finally { loading = false; }
    };
    void refresh();
    const interval = setInterval(() => void refresh(), 3000);
    const wake = () => { if (document.visibilityState !== "hidden") void refresh(); };
    window.addEventListener("online", wake);
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      controller.abort();
      clearInterval(interval);
      window.removeEventListener("online", wake);
      window.removeEventListener("focus", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [open]);

  const terminal = status?.terminal;
  useEffect(() => {
    if (terminalOpened && terminalStep === null && terminal?.available)
      setTerminalStep(terminal.confirmationRequired ? "confirm" : "shell");
  }, [terminalOpened, terminalStep, terminal?.available, terminal?.confirmationRequired]);
  const confirmTerminal = useCallback(() => setTerminalStep("confirm"), []);

  const changeTab = (next: Tab) => {
    setTab(next);
    if (next === "terminal") setTerminalOpened(true);
  };

  return <dialog ref={dialog} className="computer-panel" aria-labelledby="computer-title"
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <header>
      <div>
        <p className="eyebrow">Shared workspace</p>
        <h2 id="computer-title">Computer</h2>
        <p className="computer-subtitle">One desktop for your assistants. Your own persistent shell.</p>
      </div>
      <button className="icon-button" aria-label="Close computer" onClick={onClose}><Icon name="close" /></button>
    </header>
    <div className="computer-tabs" role="tablist" aria-label="Computer views">
      {(["desktop", "terminal"] as const).map(value => <button key={value} id={`computer-tab-${value}`}
        role="tab" aria-selected={tab === value} aria-controls={`computer-${value}`} tabIndex={tab === value ? 0 : -1}
        onClick={() => changeTab(value)} onKeyDown={event => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const next = event.key === "Home" ? "desktop" : event.key === "End" ? "terminal" : tab === "desktop" ? "terminal" : "desktop";
          changeTab(next);
          document.getElementById(`computer-tab-${next}`)?.focus();
        }}><Icon name={value === "desktop" ? "computer" : "terminal"} size={18} />{value === "desktop" ? "Desktop" : "Terminal"}</button>)}
      <span className="computer-host">{status?.label || "Hermes host"}</span>
    </div>
    {statusError && <p role="status" className="computer-notice">{statusError}</p>}
    <section id="computer-desktop" role="tabpanel" aria-labelledby="computer-tab-desktop" hidden={tab !== "desktop"}>
      {open && status?.available ? <DesktopView status={status} onStatus={setStatus} viewerId={viewerId} />
        : <Unavailable icon="computer" title={!status ? "Connecting to the computer" : "Desktop unavailable"}
          detail={status?.reason || (!status ? "Checking the shared desktop on the Hermes host." : "The shared desktop needs to be started on the Hermes host.")} />}
    </section>
    <section id="computer-terminal" role="tabpanel" aria-labelledby="computer-tab-terminal" hidden={tab !== "terminal"}>
      {open && terminalOpened && terminal?.available && terminalStep === "confirm"
        ? <ConfirmIdentity onConfirmed={() => setTerminalStep("shell")} />
        : open && terminalOpened && terminal?.available && terminalStep === "shell"
          ? <TerminalView target={terminal.target} active={tab === "terminal"} onReauthenticate={confirmTerminal} />
          : <Unavailable icon="terminal" title={!status || terminal?.available ? "Checking the terminal" : "Terminal unavailable"}
            detail={terminal?.reason || (terminal?.available ? "Checking your access to the system terminal."
              : "The system terminal is not available on this Hermes host yet.")} />}
    </section>
  </dialog>;
}

function Unavailable({ icon, title, detail }: { icon: "computer" | "terminal"; title: string; detail: string }) {
  return <div className="computer-unavailable" role="status">
    <span className="computer-empty-icon"><Icon name={icon} size={34} /></span>
    <h3>{title}</h3><p>{detail}</p>
  </div>;
}

function ConfirmIdentity({ onConfirmed }: { onConfirmed: () => void }) {
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [member, setMember] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const button = useRef<HTMLDivElement>(null);
  const confirmed = useRef(onConfirmed);
  confirmed.current = onConfirmed;
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);

  const confirm = useCallback(async (body: { credential: string } | { member: string }) => {
    setBusy(true); setError("");
    try {
      await write("/auth/confirm", body);
      if (live.current) confirmed.current();
    } catch (cause) {
      if (live.current) setError(failure(cause, "Couldn't confirm it's you. Check your connection and try again."));
    } finally { if (live.current) setBusy(false); }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    api<AuthConfig>("/auth/config", { signal: controller.signal }).then(setConfig, cause => {
      if (!controller.signal.aborted) setError(failure(cause, "Can't check sign-in options. Try again."));
    });
    return () => controller.abort();
  }, [attempt]);

  // Local test accounts confirm as the signed-in member; the server checks it is the same one.
  useEffect(() => {
    if (!config?.localDevAuth) return;
    const controller = new AbortController();
    api<{ user: { id: string } }>("/bootstrap", { signal: controller.signal })
      .then(boot => setMember(/^local-(one|two)$/.exec(boot.user.id)?.[1] ?? null), () => {});
    return () => controller.abort();
  }, [config?.localDevAuth]);

  useEffect(() => {
    const clientId = config?.googleClientId;
    if (!clientId) return;
    let current = true;
    setGoogleLoading(true);
    loadGoogleIdentity().then(client => {
      if (!current || !button.current) return;
      renderGoogleButton(client, button.current, clientId, credential => { if (current) void confirm({ credential }); });
      setGoogleLoading(false);
    }, (cause: Error) => {
      if (current) { setGoogleLoading(false); setError(cause.message); }
    });
    return () => { current = false; };
  }, [config?.googleClientId, attempt, confirm]);

  return <div className="computer-unavailable computer-confirm">
    <span className="computer-empty-icon"><Icon name="terminal" size={34} /></span>
    <h3>Confirm it's you</h3>
    <p>The terminal is a real shell on the Hermes host. Sign in again to open it. This lasts 2 hours.</p>
    <div ref={button} className="computer-google" aria-busy={googleLoading || busy} />
    {!config && !error && <p role="status">Checking sign-in…</p>}
    {googleLoading && <p role="status">Loading Google sign-in…</p>}
    {busy && <p role="status">Confirming…</p>}
    {member && <button className="primary" disabled={busy} onClick={() => void confirm({ member })}>Confirm local member {member}</button>}
    {error && <div className="computer-confirm-error">
      <p role="alert">{error}</p>
      <button onClick={() => { setError(""); setAttempt(value => value + 1); }}>Try again</button>
    </div>}
  </div>;
}

function DesktopView({ status, onStatus, viewerId }: {
  status: ComputerStatus; onStatus: (status: ComputerStatus) => void;
  viewerId: React.RefObject<string | undefined>;
}) {
  const screen = useRef<HTMLDivElement>(null);
  const rfb = useRef<RFB | null>(null);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [controlling, setControlling] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [textOpen, setTextOpen] = useState(false);
  const [typedText, setTypedText] = useState("");
  const attachmentEpoch = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let client: RFB | null = null;
    const detached = () => {
      attachmentEpoch.current++;
      setControlling(false);
      if (client) client.viewOnly = true;
    };
    const retry = (message: string) => {
      if (controller.signal.aborted) return;
      detached();
      setError(message);
      setConnection("reconnecting");
      clearTimeout(timer);
      timer = setTimeout(() => setAttempt(value => value + 1), RETRY_DELAY);
    };
    const connect = async () => {
      setControlling(false);
      setConnection("connecting");
      try {
        const [{ default: RemoteFrameBuffer }, ticket] = await Promise.all([
          import("@novnc/novnc"),
          api<ComputerStreamTicket>("/computer/desktop", {
            method: "POST", body: JSON.stringify({ viewerId: viewerId.current }), signal: controller.signal,
          }),
        ]);
        if (controller.signal.aborted || !screen.current) return;
        if (!ticket.viewerId) throw new Error("The desktop did not provide an attachment identity.");
        viewerId.current = ticket.viewerId;
        client = new RemoteFrameBuffer(screen.current, socketUrl(ticket.path));
        rfb.current = client;
        client.viewOnly = true;
        client.scaleViewport = true;
        client.resizeSession = false;
        client.addEventListener("connect", () => {
          if (controller.signal.aborted) return;
          setConnection("connected"); setError("");
        });
        client.addEventListener("disconnect", () => retry("Desktop disconnected. Reconnecting in watch mode."));
        client.addEventListener("securityfailure", () => retry("The desktop connection was rejected. Reconnecting in watch mode."));
      } catch (cause) {
        if (controller.signal.aborted) return;
        const message = failure(cause, "Can't connect to the desktop. We'll keep trying.");
        if (retryable(cause)) retry(message);
        else { setConnection("failed"); setError(message); }
      }
    };
    void connect();
    return () => {
      controller.abort(); clearTimeout(timer);
      attachmentEpoch.current++;
      rfb.current = null;
      client?.disconnect();
    };
  }, [attempt, viewerId]);

  // Losing ownership must immediately remove local input, even before the server fences it.
  useEffect(() => {
    if (status.control.kind !== "human" || !status.control.mine) {
      setControlling(false);
      if (rfb.current) rfb.current.viewOnly = true;
    }
  }, [status.control.kind, status.control.mine]);
  useEffect(() => {
    if (!controlling) { setTextOpen(false); setTypedText(""); }
  }, [controlling]);

  const key = (keysym: number) => {
    if (controlling && connection === "connected") rfb.current?.sendKey(keysym);
  };

  const control = async (requestedAction?: "take" | "release") => {
    if (submitting || connection !== "connected" || !viewerId.current || !rfb.current) return;
    const epoch = attachmentEpoch.current;
    const client = rfb.current;
    const action = requestedAction || (controlling ? "release" : "take");
    setSubmitting(true); setError("");
    // A failed release also returns this client to watch mode. Never replay a takeover.
    client.viewOnly = true;
    setControlling(false);
    try {
      const next = await write<ComputerStatus>("/computer/control", { action, viewerId: viewerId.current });
      if (epoch !== attachmentEpoch.current || client !== rfb.current) return;
      onStatus(next);
      const taken = action === "take" && next.control.kind === "human" && !!next.control.mine;
      setControlling(taken);
      client.viewOnly = !taken;
    } catch (cause) {
      if (epoch === attachmentEpoch.current) setError(failure(cause, "Couldn't confirm control. You are watching. Try Take over again."));
    } finally { setSubmitting(false); }
  };

  return <div className="computer-view">
    <div className="computer-toolbar">
      <div className="computer-ownership" role="status"><span className={`computer-state-dot ${connection === "connected" ? "ready" : ""}`} />
        <strong>{ownerLabel(status, controlling)}</strong><span>{controlling ? "Assistants are paused while you use the desktop." : "Take over to use the mouse and keyboard."}</span></div>
      <div className="computer-control-actions">
        {!controlling && status.control.kind === "human" && status.control.mine && <button disabled={connection !== "connected" || submitting} onClick={() => void control("release")}>Hand back</button>}
        <button className={controlling ? "" : "primary"} disabled={connection !== "connected" || submitting || status.control.kind === "human" && !status.control.mine}
          onClick={() => void control()}>{submitting ? "Updating control…" : controlling ? "Hand back" : "Take over"}</button>
      </div>
    </div>
    {(error || status.reason) && <p className="computer-notice" role="status">{error || status.reason}</p>}
    <div className="computer-screen-wrap">
      <div className="computer-screen" ref={screen} aria-label={controlling ? "Shared desktop. You have control." : "Shared desktop. Watching."} />
      {connection !== "connected" && <div className="computer-connection-overlay" role="status">
        <Icon name="computer" size={30} /><strong>{connection === "failed" ? "Desktop connection unavailable" : connection === "reconnecting" ? "Reconnecting desktop" : "Opening desktop"}</strong>
        {connection === "failed" && <button onClick={() => setAttempt(value => value + 1)}>Reconnect</button>}
      </div>}
    </div>
    <div className="terminal-tools">
      <button disabled={!controlling} aria-expanded={textOpen} aria-controls="desktop-text" onClick={() => setTextOpen(value => !value)}>Type text</button>
      <button disabled={!controlling} onClick={() => key(0xff0d)}>Enter</button>
      <button disabled={!controlling} onClick={() => key(0xff09)}>Tab</button>
      <button disabled={!controlling} onClick={() => key(0xff08)}>Backspace</button>
    </div>
    {textOpen && <form id="desktop-text" className="terminal-paste" onSubmit={event => {
      event.preventDefault();
      if (!controlling || connection !== "connected") return;
      for (const character of typedText) {
        const point = character.codePointAt(0)!;
        key(point === 10 || point === 13 ? 0xff0d : point === 9 ? 0xff09 : point <= 255 ? point : 0x01000000 | point);
      }
      setTypedText(""); setTextOpen(false); rfb.current?.focus();
    }}><label htmlFor="desktop-text-input">Type into the selected desktop field</label>
      <textarea id="desktop-text-input" autoFocus autoCapitalize="none" autoComplete="off" autoCorrect="off" spellCheck={false} maxLength={8192} rows={2} value={typedText} onChange={event => setTypedText(event.target.value)} />
      <div className="actions"><small>Click a field on the desktop first. Text is cleared after sending.</small><button type="submit" disabled={!controlling || !typedText}>Send text</button></div>
    </form>}
    <p className="computer-footnote">The desktop and browser logins stay on the server when you close this panel.</p>
  </div>;
}

function TerminalView({ target, active, onReauthenticate }: { target: string; active: boolean; onReauthenticate: () => void }) {
  const surface = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const fit = useRef<(() => void) | null>(null);
  const sessionId = useRef<string | undefined>(undefined);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [ending, setEnding] = useState(false);
  const stopped = useRef(false);

  const send = useCallback((message: unknown) => {
    // Never queue input. Replaying shell commands after reconnection can execute them twice.
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(message));
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let client: WebSocket | undefined;
    let emulator: Terminal | undefined;
    let observer: ResizeObserver | undefined;
    let resize: (() => void) | undefined;
    stopped.current = false;
    const retry = (message: string) => {
      if (controller.signal.aborted || stopped.current) return;
      setError(message); setConnection("reconnecting");
      clearTimeout(timer);
      timer = setTimeout(() => setAttempt(value => value + 1), RETRY_DELAY);
    };
    const connect = async () => {
      setConnection("connecting");
      try {
        const [{ Terminal: Emulator }, { FitAddon }, ticket] = await Promise.all([
          import("@xterm/xterm"), import("@xterm/addon-fit"),
          api<ComputerStreamTicket>("/computer/terminal", { method: "POST", body: "{}", signal: controller.signal }),
        ]);
        if (controller.signal.aborted || !surface.current) return;
        if (!ticket.sessionId) throw new Error("The terminal did not provide a shell session.");
        sessionId.current = ticket.sessionId;
        emulator = new Emulator({ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 14,
          cursorBlink: true, screenReaderMode: true, scrollback: 3000, theme: { background: "#151c18", foreground: "#f1efdf", cursor: "#8bd2b2", selectionBackground: "#3a5947" } });
        terminal.current = emulator;
        const fitting = new FitAddon();
        emulator.loadAddon(fitting);
        emulator.open(surface.current);
        resize = () => {
          if (!surface.current?.clientWidth || !surface.current.clientHeight) return;
          fitting.fit();
          send({ type: "resize", columns: emulator!.cols, rows: emulator!.rows });
        };
        fit.current = resize;
        resize();
        emulator.onData(data => {
          // xterm emits an entire paste at once. Keep each wire message bounded
          // without splitting Unicode code points or queueing disconnected input.
          let chunk = "", bytes = 0;
          const encoder = new TextEncoder();
          for (const character of data) {
            const size = encoder.encode(character).length;
            if (bytes + size > 16384) { send({type: "input", data: chunk}); chunk = ""; bytes = 0; }
            chunk += character; bytes += size;
          }
          if (chunk) send({type: "input", data: chunk});
        });
        client = new WebSocket(socketUrl(ticket.path));
        socket.current = client;
        client.addEventListener("open", () => {
          if (controller.signal.aborted || stopped.current) return;
          setConnection("connected"); setError(""); resize?.();
        });
        client.addEventListener("message", event => {
          if (controller.signal.aborted || stopped.current) return;
          try {
            const message = JSON.parse(String(event.data));
            if (message.type === "output" && typeof message.data === "string") emulator?.write(message.data);
            else if (message.type === "error") setError(typeof message.message === "string" ? message.message : "The shell reported an error.");
            else if (message.type === "exit") {
              stopped.current = true;
              setConnection("ended"); setError("");
              client?.close();
            }
          } catch { setError("The terminal returned an unreadable response."); }
        });
        client.addEventListener("close", () => retry("Terminal disconnected. Reconnecting to your shell."));
        client.addEventListener("error", () => retry("Can't reach the terminal. Reconnecting to your shell."));
        if (typeof ResizeObserver !== "undefined") {
          observer = new ResizeObserver(resize);
          observer.observe(surface.current);
        }
        window.addEventListener("resize", resize);
      } catch (cause) {
        if (controller.signal.aborted) return;
        if (reauthenticate(cause)) { onReauthenticate(); return; }
        const message = failure(cause, "Can't connect to the terminal. We'll keep trying.");
        if (retryable(cause)) retry(message);
        else { setConnection("failed"); setError(message); }
      }
    };
    void connect();
    return () => {
      controller.abort(); clearTimeout(timer);
      observer?.disconnect();
      if (resize) window.removeEventListener("resize", resize);
      socket.current = null; terminal.current = null; fit.current = null;
      client?.close(); emulator?.dispose();
      // The server-side tmux session intentionally continues after this attachment closes.
    };
  }, [attempt, send, onReauthenticate]);

  useEffect(() => {
    if (active) fit.current?.();
  }, [active]);

  const end = async () => {
    if (!sessionId.current || ending) return;
    setEnding(true);
    try {
      await write("/computer/terminal/end", { sessionId: sessionId.current });
      stopped.current = true;
      socket.current?.close();
      setConnection("ended"); setConfirmEnd(false); setError("");
    } catch (cause) { setError(failure(cause, "Couldn't confirm whether your shell ended. Check the connection before trying again.")); }
    finally { setEnding(false); }
  };
  const connected = connection === "connected";

  return <div className="computer-view">
    <div className="computer-toolbar">
      <div className="computer-ownership" role="status"><span className={`computer-state-dot ${connected ? "ready" : ""}`} />
        <strong>{connection === "ended" ? "Shell ended" : connected ? "Your system terminal" : "Connecting to your terminal"}</strong><span>{target}</span></div>
      <button disabled={!sessionId.current || connection === "ended" || ending} onClick={() => setConfirmEnd(true)}>End shell</button>
    </div>
    {confirmEnd && <div className="computer-end-confirmation" role="alert">
      <span>End this shell? Running commands will stop.</span>
      <button disabled={ending} onClick={() => setConfirmEnd(false)}>Keep shell</button>
      <button disabled={ending} className="danger" onClick={() => void end()}>{ending ? "Ending…" : "End this shell"}</button>
    </div>}
    {error && <p className="computer-notice" role="status">{error}</p>}
    <div className="computer-screen-wrap terminal-wrap">
      <div ref={surface} className="computer-terminal" aria-label="System terminal" />
      {connection !== "connected" && <div className="computer-connection-overlay" role="status">
        <Icon name="terminal" size={30} /><strong>{connection === "ended" ? "Your shell has ended" : connection === "failed" ? "Terminal connection unavailable" : connection === "reconnecting" ? "Reconnecting terminal" : "Opening your shell"}</strong>
        {(connection === "ended" || connection === "failed") && <button onClick={() => { setConfirmEnd(false); setAttempt(value => value + 1); }}>{connection === "ended" ? "Start terminal" : "Reconnect"}</button>}
      </div>}
    </div>
    <div className="terminal-tools">
      <button disabled={!connected} onClick={() => terminal.current?.focus()}>Keyboard</button>
      <button disabled={!connected} aria-label="Send Ctrl+C" onClick={() => send({ type: "input", data: "\u0003" })}>Ctrl+C</button>
      <button disabled={!connected} aria-expanded={pasteOpen} aria-controls="terminal-paste" onClick={() => setPasteOpen(value => !value)}>Paste text</button>
      <span>Closing this panel keeps your shell running.</span>
    </div>
    {pasteOpen && <form id="terminal-paste" className="terminal-paste" onSubmit={event => {
      event.preventDefault();
      if (!connected || !pasteText) return;
      terminal.current?.paste(pasteText);
      setPasteText(""); setPasteOpen(false); terminal.current?.focus();
    }}><label htmlFor="terminal-paste-text">Paste into your terminal</label>
      <textarea id="terminal-paste-text" autoFocus autoCapitalize="none" autoComplete="off" autoCorrect="off" spellCheck={false} rows={2} value={pasteText} onChange={event => setPasteText(event.target.value)} />
      <div className="actions"><small>Text is sent as typed. It is not saved in this browser.</small><button type="submit" disabled={!connected || !pasteText}>Send text</button></div>
    </form>}
  </div>;
}
