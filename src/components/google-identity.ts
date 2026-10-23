import { useEffect, useRef, useState, type RefObject } from "react";

export type GoogleIdentity = { accounts: { id: {
  initialize: (options: unknown) => void;
  renderButton: (element: HTMLElement, options: unknown) => void;
} } };

const source = "https://accounts.google.com/gsi/client";
let loading: Promise<GoogleIdentity> | undefined;
const loaded = () => (window as unknown as { google?: GoogleIdentity }).google;

/** Loads Google Identity Services once and reuses it. A failed load can be retried. */
export function loadGoogleIdentity(timeout = 12_000): Promise<GoogleIdentity> {
  const ready = loaded();
  if (ready?.accounts?.id) return Promise.resolve(ready);
  loading ??= new Promise<GoogleIdentity>((resolve, reject) => {
    const script = document.createElement("script");
    const finish = (client?: GoogleIdentity) => {
      clearTimeout(timer);
      loading = undefined;
      if (client?.accounts?.id) resolve(client);
      else { script.remove(); reject(new Error("Google sign-in couldn't load. Check your connection and try again.")); }
    };
    const timer = setTimeout(() => finish(), timeout);
    script.src = source;
    script.async = true;
    script.onerror = () => finish();
    script.onload = () => finish(loaded());
    document.head.appendChild(script);
  });
  return loading;
}

/**
 * Renders the Google button inside element. Use only the button: One Tap attaches
 * its iframe to <body>, which is inert behind a modal dialog.
 */
export function renderGoogleButton(client: GoogleIdentity, element: HTMLElement, clientId: string,
  onCredential: (credential: string) => void) {
  client.accounts.id.initialize({
    client_id: clientId,
    callback: ({ credential }: { credential: string }) => onCredential(credential),
  });
  element.replaceChildren();
  client.accounts.id.renderButton(element, { theme: "outline", size: "large" });
}

/**
 * Renders the Google button into element while clientId is set, and loads again when attempt
 * changes. onCredential hears only the current button: a load that finishes after clientId
 * changed or the component unmounted renders nothing and reports nothing.
 */
export function useGoogleButton(element: RefObject<HTMLElement | null>, clientId: string | undefined, attempt: number,
  onCredential: (credential: string) => void) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const latest = useRef(onCredential);
  latest.current = onCredential;
  useEffect(() => {
    if (!clientId) return;
    let live = true;
    setLoading(true); setError("");
    loadGoogleIdentity().then(client => {
      if (!live || !element.current) return;
      renderGoogleButton(client, element.current, clientId, credential => { if (live) latest.current(credential); });
      setLoading(false);
    }, (cause: Error) => {
      if (live) { setLoading(false); setError(cause.message); }
    });
    return () => { live = false; };
  }, [clientId, attempt, element]);
  return { loading, error };
}
