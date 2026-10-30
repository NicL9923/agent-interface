import { useRef, useState } from "react";
import { write } from "../client-api";
import { useAction } from "../app/use-action";
import { useResource } from "../app/use-resource";
import { Avatar } from "./Avatar";
import { Button } from "./ui/button";
import { NativeSelect } from "./ui/native-select";
import { SetupCommand } from "./ConnectionPanel";
import { useGoogleButton } from "./google-identity";
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
    {/* Distinct names give each its own idle gesture timing. */}
    {trio.map((avatar, i) => <Avatar key={i} avatar={avatar} size={i === 1 ? 84 : 64} name={`Welcome ${i + 1}`} />)}
  </div>;
}

export function SignIn({ onSuccess }: { onSuccess: () => void }) {
  const [member, setMember] = useState("one");
  const [attempt, setAttempt] = useState(0);
  const google = useRef<HTMLDivElement>(null);
  const success = useRef(onSuccess);
  success.current = onSuccess;
  // Checked again while the page is shown, so finishing setup elsewhere shows up here.
  const auth = useResource<AuthConfig>("/auth/config", { deps: [attempt], pollMs: 8000, wake: true });
  const { data: config, error: configError } = auth;
  const signing = useAction();
  const { busy } = signing;
  const signIn = (path: string, body: unknown) => signing.run(async ({ current }) => {
    await write(path, body);
    if (current()) success.current();
  });
  const button = useGoogleButton(google, config?.googleClientId, attempt, credential => void signIn("/auth/google", { credential }));
  const googleLoading = button.loading;
  const error = signing.error || button.error;
  const needsSetup = config && !config.googleClientId && !config.localDevAuth;
  return <main className={`welcome sign-in${needsSetup ? " needs-setup" : ""}`}>
    <header className="sign-in-brand"><span className="brand-mark" aria-hidden="true">w.</span>WildBots</header>
    {/* One centered column on every screen: who is waiting, then one way in. */}
    <div className="sign-in-content">
      <div className="sign-in-intro">
        <AvatarTrio />
        <h1>{needsSetup ? "Let's get your household ready." : "Your assistants are waiting."}</h1>
        <p>{needsSetup
          ? "Set up this installation once. Then everyone can sign in and return to the same conversations."
          : "Sign in to pick up your household conversations right where you left them."}</p>
      </div>
      <div className="sign-in-access" aria-busy={!config && !configError}>
        {!config && !configError && <p className="sign-in-status" role="status">Checking sign-in…</p>}
        {needsSetup && <div className="sign-in-setup">
          <h2>Start on the computer running this app</h2>
          <p>Open the WildBots project folder and run the guided setup:</p>
          <SetupCommand />
          <p>It checks Hermes and saves your connection privately. Choose Google sign-in for the household, or local test accounts for development.</p>
          <p className="muted">After saving, restart the app server. This page checks again automatically.</p>
          <Button onClick={() => setAttempt(value => value + 1)}>Check now</Button>
        </div>}
        <div ref={google} className="google-sign-in" aria-busy={googleLoading || busy} />
        {googleLoading && <p className="sign-in-status" role="status">Loading Google sign-in…</p>}
        {busy && <p className="sign-in-status" role="status">Signing you in…</p>}
        {config?.localDevAuth && <form onSubmit={event => {
          event.preventDefault();
          void signIn("/auth/local", { member });
        }}>
          <label>Sign in as
            <NativeSelect value={member} onChange={event => setMember(event.target.value)}>
              <option value="one">Household member one</option>
              <option value="two">Household member two</option>
            </NativeSelect>
          </label>
          <Button type="submit" className="primary" disabled={busy}>Enter local workspace</Button>
          <p className="sign-in-note">Local test accounts are turned on for this computer.</p>
        </form>}
        {(error || configError) && <div className="sign-in-error">
          <p role="alert">{error || configError}</p>
          <Button onClick={() => { signing.setError(""); setAttempt(value => value + 1); }}>Try again</Button>
        </div>}
      </div>
    </div>
  </main>;
}
