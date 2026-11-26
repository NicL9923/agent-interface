import { useEffect, useRef, useState } from "react";
import type { RuntimeStatus } from "../shared/types";
import { Avatar } from "./Avatar";
import { Icon } from "./Icon";
import { When } from "./When";
import { fire } from "../app/fire";
import type { StreamsLive } from "../app/stream-health";

type Copy = { title: string; detail?: string; setup?: boolean };
/** What waiting cannot fix: someone has to set the installation up or repair it. */
const setups: Record<string, Copy> = {
  not_configured: {
    title: "Connect your household to Hermes",
    detail:
      "Set up the connection once on the computer running this app. Your existing assistants will appear here automatically.",
    setup: true,
  },
  invalid_config: {
    title: "The connection needs a small correction",
    detail:
      "The saved Hermes address or token is incomplete. Run setup on the computer hosting this app to correct it.",
    setup: true,
  },
  unauthorized: {
    title: "Hermes didn't accept the connection",
    detail:
      "The saved connection token needs to be updated. Your conversations are still with Hermes.",
    setup: true,
  },
  addon_missing: {
    title: "Hermes is reachable. One step remains.",
    detail:
      "This installation needs the compatible connection add-on before it can safely send messages or recover work.",
    setup: true,
  },
  incompatible: {
    title: "Hermes and this app need matching versions",
    detail:
      "Run the connection check on the app's computer for the required version and update instructions.",
    setup: true,
  },
};
/** Whether Hermes is down in a way that needs a person, so no retry of the app's own will bring it back. */
export const needsSetup = (connection: RuntimeStatus) =>
  !connection.connected && Object.hasOwn(setups, connection.code ?? "");

export function SetupCommand() {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <div className="setup-command">
      <code>pnpm run setup</code>
      <button
        type="button"
        onClick={fire(async () => {
          setCopied(false);
          setFailed(false);
          try {
            await navigator.clipboard.writeText("pnpm run setup");
            setCopied(true);
            setFailed(false);
          } catch {
            setFailed(true);
          }
        })}
      >
        {copied ? "Copied" : "Copy command"}
      </button>
      {failed && <span role="status">Select the command to copy it.</span>}
    </div>
  );
}

export type ConnectionState = {
  connection: RuntimeStatus;
  offline?: boolean;
  appUnavailable?: boolean;
  /** The app and Hermes answer, and only the open chat's reads fail. */
  chatOnly?: boolean;
  /** The app and Hermes answer, but live updates stopped: replies and changes show late until they return. */
  liveOnly?: boolean;
  /** The loss has lasted, or is certain: the notice names its reason. Until then it is one plain line. See `useOutage`. */
  lasting?: boolean;
  /** Words or files wait in the message box. Only then does the notice say the draft is kept. */
  hasDraft?: boolean;
};
/** What the connection notice says, and what the app's one connection live region announces. */
export function connectionCopy({
  connection,
  offline = false,
  appUnavailable = false,
  chatOnly = false,
  liveOnly = false,
  lasting = false,
  hasDraft = false,
}: ConnectionState): Copy {
  const kept = hasDraft ? "Your draft is kept. " : "";
  if (offline)
    return {
      title: "You're offline",
      detail: `${hasDraft ? "Your draft is kept on this device. " : ""}We'll reconnect when you're back online.`,
    };
  if (liveOnly)
    return {
      title: "Live updates are delayed",
      detail: "New replies may take up to 30 seconds to show. Messages still send.",
    };
  const hermes = !appUnavailable && !chatOnly;
  if (hermes && needsSetup(connection)) return setups[connection.code!]!;
  // A server that just started is connecting for the first time; to the person every other loss is a reconnect.
  const connecting = hermes && connection.code === "connecting";
  if (!lasting) return { title: connecting ? "Connecting…" : "Reconnecting…" };
  if (appUnavailable) return { title: "Can't reach the app", detail: `${kept}We'll keep trying.` };
  if (chatOnly)
    return {
      title: "Can't refresh this chat",
      detail: `New messages may not show yet. ${kept}We'll keep trying.`,
    };
  if (connecting)
    return {
      title: "Connecting to Hermes",
      detail: "Checking the connection and restoring your assistants.",
    };
  return {
    title: "Hermes isn't answering",
    detail: `Messages can't be sent until it's back. ${kept}We'll keep trying.`,
  };
}
/** The copy as one announcement. A title that already ends its sentence, as "Reconnecting…" does, gets no period. */
const spoken = ({ title, detail }: Copy) =>
  [/[.…]$/.test(title) ? title : `${title}.`, detail].filter(Boolean).join(" ");

/**
 * Shows the connection state. It is not a live region: the app announces each change once, through
 * `ConnectionAnnouncer`, however many places show it.
 *
 * `compact` is the notice above the composer. While the loss may still end on its own it is one line,
 * because the app is already retrying and there is nothing to do; once it lasts, or when it needs a
 * person, it names the reason and adds the retry and the details. The full panel stands in for a whole
 * view, so it always says everything.
 */
export function ConnectionPanel({
  busy,
  retry,
  compact = false,
  ...state
}: ConnectionState & {
  busy: boolean;
  retry: () => void;
  compact?: boolean;
}) {
  const { connection, offline = false, liveOnly = false } = state;
  const copy = connectionCopy({ ...state, lasting: !compact || state.lasting });
  const action = !offline && (
    <button className={compact ? undefined : "primary"} disabled={busy} onClick={retry}>
      {busy ? "Checking connection…" : copy.setup ? "Check connection" : "Reconnect now"}
    </button>
  );
  const help = (
    <details className="connection-help">
      <summary>{copy.setup ? "Set up this installation" : "Connection details"}</summary>
      {connection.address && (
        <p>
          Hermes address: <code>{connection.address}</code>
        </p>
      )}
      {connection.detail && <p>{connection.detail}</p>}
      {connection.lastConnectedAt && (
        <p>
          Last connected <When value={connection.lastConnectedAt} inline />.
        </p>
      )}
      {copy.setup && (
        <>
          <p>On the computer running WildBots, open its project folder and run:</p>
          <SetupCommand />
          <p>
            Setup keeps the connection token on that computer. Restart this app after saving;
            everyone else can simply sign in.
          </p>
        </>
      )}
      <p>
        For a read-only connection check on that computer, run <code>pnpm run doctor</code>.
      </p>
    </details>
  );
  if (compact) {
    // A line with a reason has something to act on; the one-line "Reconnecting…" does not. The details
    // are Hermes's, so they stay out of a notice about the network, live updates or one chat.
    const explained = !!copy.detail;
    return (
      <section className="connection-panel compact" aria-label="Hermes connection">
        <div className="connection-line">
          <Icon
            name={offline ? "offline" : copy.setup ? "alert" : "spinner"}
            size={17}
            className={offline || copy.setup ? undefined : "spin"}
          />
          <div className="connection-copy">
            <h2>{copy.title}</h2>
            {copy.detail && <p>{copy.detail}</p>}
          </div>
          {explained && action}
        </div>
        {explained && !offline && !liveOnly && !state.chatOnly && help}
      </section>
    );
  }
  return (
    <section className="connection-panel setup" aria-label="Hermes connection">
      <Avatar size={84} state="disconnected" offline={offline} />
      <div className="connection-copy">
        <p className="eyebrow">Your household workspace</p>
        <h2>{copy.title}</h2>
        <p>{copy.detail}</p>
        {copy.setup && (
          <ol className="setup-steps">
            <li>
              <span aria-hidden="true">✓</span>
              <div>
                <strong>You're signed in</strong>
                <small>Your household account is ready.</small>
              </div>
            </li>
            <li>
              <span aria-hidden="true">2</span>
              <div>
                <strong>Connect the app to Hermes</strong>
                <small>
                  Guided setup checks the address, access and compatibility before saving.
                </small>
              </div>
            </li>
            <li>
              <span aria-hidden="true">3</span>
              <div>
                <strong>Pick up with your assistants</strong>
                <small>Their existing conversations stay in Hermes.</small>
              </div>
            </li>
          </ol>
        )}
        {action && <div className="connection-actions">{action}</div>}
        {help}
      </div>
    </section>
  );
}

/** How long the live region says the connection is back before it empties again. */
export const RESTORED_MS = 5_000;
/**
 * The app's one connection live region. It stays in the page, outside the sidebar and the view, so a
 * change is announced on every view and at every width, including a phone's home list, which makes the
 * view behind it inert. It is empty while the connection and live updates are well, except for a few
 * seconds after one comes back: someone who heard "Reconnecting…" hears that it is over.
 *
 * It speaks when the connection changes and at no other time. `shown` is the loss itself, without the
 * second its notice lingers on screen. `recoveries` and `liveRecoveries` count the losses, and the
 * stretches without live updates, that were on screen and came back (see `useOutage`), so a notice that
 * goes because the person opened another chat is no news. Live updates count as back only while
 * `live` is `up`: their notice also goes when a stream is closed, as on a hidden page, or when the
 * stream that returned leaves another still down. That one is said once the others are back, as long
 * as the same streams stay open and nothing else is being warned of meanwhile. Something that comes back while another
 * warning is being said is not kept to say later: by then it would be old news, said as that warning
 * went. Typing the first word of a draft adds a sentence to the notice on screen, and the announcement
 * stays as it was said.
 */
export function ConnectionAnnouncer({
  shown,
  recoveries = 0,
  liveRecoveries = 0,
  live = "closed",
  liveScope = "",
  ...state
}: ConnectionState & {
  shown: boolean;
  recoveries?: number;
  liveRecoveries?: number;
  /** Where the streams the live-updates notice watches stand (see `useStreamsLive`). */
  live?: StreamsLive;
  /** Which streams those are, so a return that waits on the rest is dropped when they change. */
  liveScope?: string;
}) {
  // What is said, held from the moment the connection's own news last changed.
  const news = shown ? spoken(connectionCopy({ ...state, hasDraft: false })) : "";
  const said = useRef({ news: "", text: "" });
  if (said.current.news !== news)
    said.current = { news, text: shown ? spoken(connectionCopy(state)) : "" };
  const [restored, setRestored] = useState("");
  const clear = useRef<ReturnType<typeof setTimeout>>(undefined);
  const counted = useRef({ recoveries, liveRecoveries });
  // The streams whose notice ended while one of them had still to be heard from.
  const partly = useRef<string | undefined>(undefined);
  useEffect(() => {
    const was = counted.current;
    counted.current = { recoveries, liveRecoveries };
    if (liveRecoveries > was.liveRecoveries && live === "waiting") partly.current = liveScope;
    if (shown || live === "closed" || partly.current !== liveScope) partly.current = undefined;
    const back =
      recoveries > was.recoveries
        ? "Connected again."
        : (liveRecoveries > was.liveRecoveries || partly.current !== undefined) && live === "up"
          ? "Live updates are back."
          : "";
    if (back) partly.current = undefined;
    if (!back && !shown) return;
    clearTimeout(clear.current);
    // A warning being said now takes the place of anything that came back.
    setRestored(shown ? "" : back);
    if (!shown) clear.current = setTimeout(() => setRestored(""), RESTORED_MS);
  }, [shown, recoveries, liveRecoveries, live, liveScope]);
  useEffect(() => () => clearTimeout(clear.current), []);
  return (
    <p className="sr-only" role="status" data-connection-announcer="">
      {shown ? said.current.text : restored}
    </p>
  );
}
