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
