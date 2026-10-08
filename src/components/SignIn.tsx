import { useEffect, useRef, useState } from "react";
import { api, write } from "../client-api";
import { Avatar } from "./Avatar";
import { SetupCommand } from "./ConnectionPanel";
import { loadGoogleIdentity, renderGoogleButton } from "./google-identity";
import "./sign-in.css";

export type AuthConfig = { localDevAuth: boolean; googleClientId?: string };

const trio = [
  { mode: "geometric", shape: "blob", color: "#1084FE", eyes: "oval", accessory: "none" },
  { mode: "mascot", family: "bear", color: "#FF9800", eyes: "round", accessory: "none" },
  { mode: "geometric", shape: "triangle", color: "#FF309B", eyes: "oval", accessory: "none" },
] as const;
/** A small household of assistants, so the first screen shows who is waiting. */
export function AvatarTrio() {
  return <div className="avatar-trio" aria-hidden="true">
    {trio.map((avatar, i) => <Avatar key={i} avatar={avatar} size={i === 1 ? 84 : 64} />)}
  </div>;
}

export function SignIn({ onSuccess }: { onSuccess: () => void }) {
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [error, setError] = useState("");
  const [configError, setConfigError] = useState("");
  const [member, setMember] = useState("one");
  const [attempt, setAttempt] = useState(0);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const google = useRef<HTMLDivElement>(null);
  const success = useRef(onSuccess);
  success.current = onSuccess;
  useEffect(() => {
    let live = true;
    let loading = false;
    const load = async () => {
      if (loading || document.visibilityState === "hidden") return;
      loading = true;
      try {
        const next = await api<AuthConfig>("/auth/config");
        if (live) { setConfig(next); setConfigError(""); }
      } catch (e) {
        if (live) setConfigError((e as Error).message);
      } finally { loading = false; }
    };
    void load();
    const timer = setInterval(() => void load(), 8000);
    window.addEventListener("online", load);
    document.addEventListener("visibilitychange", load);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener("online", load);
      document.removeEventListener("visibilitychange", load);
    };
  }, [attempt]);
  useEffect(() => {
    if (!config?.googleClientId) return;
    const clientId = config.googleClientId;
    let live = true;
    setGoogleLoading(true);
    loadGoogleIdentity().then(client => {
      if (!live || !google.current) return;
      renderGoogleButton(client, google.current, clientId, async credential => {
        if (!live) return;
        setBusy(true); setError("");
        try {
          await write("/auth/google", { credential });
          if (live) success.current();
        } catch (e) {
          if (live) setError((e as Error).message);
        } finally { if (live) setBusy(false); }
      });
      setGoogleLoading(false);
    }, (e: Error) => {
      if (live) { setGoogleLoading(false); setError(e.message); }
    });
    return () => { live = false; };
  }, [config?.googleClientId, attempt]);
  const needsSetup = config && !config.googleClientId && !config.localDevAuth;
  return <main className="welcome sign-in">
    <p className="eyebrow">WildBots</p>
    <div className="sign-in-content">
      <div className="sign-in-intro">
        <AvatarTrio />
        <h1>{needsSetup ? "Let's get your household ready." : "Your assistants are waiting."}</h1>
        <p>{needsSetup
          ? "Set up this installation once. Then everyone can sign in and return to the same conversations."
          : "Sign in to return to your household conversations."}</p>
      </div>
      <div className="sign-in-access">
    {!config && !configError && <p role="status">Checking sign-in…</p>}
    {needsSetup && <div className="sign-in-setup">
      <h2>Start on the computer running this app</h2>
      <p>Open the WildBots project folder and run the guided setup:</p>
      <SetupCommand />
      <p>It checks Hermes and saves your connection privately. Choose Google sign-in for the household, or local test accounts for development.</p>
      <p className="muted">After saving, restart the app. This page will pick up the new settings automatically.</p>
      <button onClick={() => setAttempt(value => value + 1)}>Check setup again</button>
    </div>}
    <div ref={google} className="google-sign-in" aria-busy={googleLoading || busy} />
    {googleLoading && <p role="status">Loading Google sign-in…</p>}
    {busy && <p role="status">Signing you in…</p>}
    {config?.localDevAuth && <form onSubmit={event => {
      event.preventDefault();
      if (busy) return;
      setBusy(true); setError("");
      void write("/auth/local", { member }).then(() => success.current())
        .catch(e => setError(e.message)).finally(() => setBusy(false));
    }}>
      <label>Local household member
        <select value={member} onChange={event => setMember(event.target.value)}>
          <option value="one">Household member one</option>
          <option value="two">Household member two</option>
        </select>
      </label>
      <button className="primary" disabled={busy}>Enter local workspace</button>
      <p className="muted">Local test accounts are enabled on this computer.</p>
    </form>}
    {(error || configError) && <div className="sign-in-error">
      <p role="alert">{error || configError}</p>
      <button onClick={() => { setError(""); setAttempt(value => value + 1); }}>Try again</button>
    </div>}
      </div>
    </div>
  </main>;
}
