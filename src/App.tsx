import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  AttentionRequest,
  Bootstrap,
  Bot,
  Conversation,
  FileRef,
  Preferences,
  SubmissionReceipt,
  ToolCall,
} from "./shared/types";
import { api, ApiError, setCsrf, write } from "./client-api";
import { Avatar, stateLabels } from "./components/Avatar";
import { ArtifactsButton } from "./components/Artifacts";
import { BotSettings } from "./BotSettings";
import { MessageMarkdown } from "./components/MessageMarkdown";
import { ConnectionPanel } from "./components/ConnectionPanel";
import { AvatarTrio, SignIn } from "./components/SignIn";
import { IntegrationsPanel } from "./components/IntegrationsPanel";
import { HermesUpgradePanel } from "./components/HermesUpgradePanel";
import { ComputerPanel } from "./components/ComputerPanel";
import { Icon } from "./components/Icon";
import { useDeviceNotifications } from "./components/use-device-notifications";
import { NotificationSettings, NotificationOnboarding } from "./components/DeviceNotifications";
import { TodayPanel } from "./components/TodayPanel";
import { VoiceControls } from "./components/VoiceControls";
import type { VoiceState } from "./shared/voice";
import { SecureRequestCard } from "./components/SecureRequestCard";
type SavedConversation = Conversation & {
  draft?: { text: string; attachments: FileRef[] };
  readPosition?: { scrollTop?: number; messageId?: string };
};
type Draft = {
  text: string;
  attachments: FileRef[];
  botId?: string;
  userId?: string;
  dirty?: boolean;
};
type Pending = {
  requestId: string;
  botId: string;
  text: string;
  attachments: FileRef[];
  reviewedInterruption: boolean;
};
const draftKey = (user: string, bot: string) =>
  `agent-interface:draft:${user}:${bot}`;
function localRead<T>(key: string): T | null {
  try {
    return JSON.parse(localStorage.getItem(key) || "null");
  } catch {
    return null;
  }
}
function localRemove(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {}
}
function localSave(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Server persistence still applies when browser storage is full. */
  }
}
function clearSavedDraft(user: string, submission: Pending) {
  const key = draftKey(user, submission.botId);
  const saved = localRead<Draft>(key);
  if (
    saved &&
    saved.text === submission.text &&
    JSON.stringify(saved.attachments) === JSON.stringify(submission.attachments)
  ) {
    const cleared = {
      text: "",
      attachments: [],
      botId: submission.botId,
      userId: user,
    };
    localSave(key, cleared);
    return cleared;
  }
  return null;
}
export function App() {
  const [todayOpen, setTodayOpen] = useState(() => new URLSearchParams(location.search).get("view") === "today");
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  useEffect(() => {
    const url = new URL(location.href);
    if (todayOpen) url.searchParams.set("view", "today"); else url.searchParams.delete("view");
    history.replaceState(null, "", url);
  }, [todayOpen]);
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const notifications = useDeviceNotifications(boot?.user.id, boot?.vapidPublicKey);
  const [auth, setAuth] = useState(false);
  const [error, setError] = useState("");
  const [botId, setBotId] = useState(
    () => new URLSearchParams(location.search).get("bot") || "",
  );
  const [conversation, setConversation] = useState<SavedConversation | null>(
    null,
  );
  const [draft, setDraft] = useState<Draft>({ text: "", attachments: [] });
  const [draftReady, setDraftReady] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [receipt, setReceipt] = useState<SubmissionReceipt | null>(null);
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [disconnected, setDisconnected] = useState(false);
  const [conversationDisconnected, setConversationDisconnected] = useState(false);
  const [appUnavailable, setAppUnavailable] = useState(false);
  const [offline, setOffline] = useState(() => navigator.onLine === false);
  const [checkingConnection, setCheckingConnection] = useState(false);
  const connectionLost = disconnected || conversationDisconnected || offline;
  const bootstrapRequest = useRef<Promise<Bootstrap | null> | null>(null);
  const identityEpoch = useRef(0);
  const bootRef = useRef(boot);
  bootRef.current = boot;
  const authRef = useRef(auth);
  authRef.current = auth;
  const [settings, setSettings] = useState<Bot | "new" | null>(null);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [integrationsOpen, setIntegrationsOpen] = useState(false);
  const [computerOpen, setComputerOpen] = useState(() => new URLSearchParams(location.search).get("computer") === "1");
  const [railOpen, setRailOpen] = useState(false);
  const [mobile, setMobile] = useState(() => matchMedia("(max-width: 620px)").matches);
  const rail = useRef<HTMLElement>(null);
  const preferencesDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const query = matchMedia("(max-width: 620px)");
    const update = () => setMobile(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (!preferencesOpen) return;
    const dialog = preferencesDialog.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (mobile) document.querySelector<HTMLButtonElement>("[aria-label='Open assistants']")?.focus();
    };
  }, [preferencesOpen, mobile]);
  useEffect(() => {
    if (!mobile || !railOpen || !rail.current) return;
    const drawer = rail.current;
    const previous = document.activeElement as HTMLElement | null;
    const controls = () => Array.from(drawer.querySelectorAll<HTMLElement>(
      "button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), [tabindex='0']",
    )).filter((element) => element.getClientRects().length > 0);
    controls()[0]?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setRailOpen(false);
      } else if (event.key === "Tab") {
        const items = controls();
        const first = items[0];
        const last = items.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    drawer.addEventListener("keydown", keydown);
    return () => {
      drawer.removeEventListener("keydown", keydown);
      previous?.focus();
    };
  }, [mobile, railOpen]);
  const [reviewed, setReviewed] = useState(false);
  useEffect(() => setReviewed(false), [conversation?.activity.state, conversation?.activity.runId]);
  const [workerUpdate, setWorkerUpdate] = useState<ServiceWorker | null>(null);
  const [installEvent, setInstallEvent] = useState<
    (Event & { prompt: () => Promise<void> }) | null
  >(null);
  const [notice, setNotice] = useState("");
  const positionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (positionTimer.current) clearTimeout(positionTimer.current);
  }, [boot?.user.id]);
  const scroll = useRef<HTMLDivElement>(null);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const fitComposer = useCallback(() => {
    // Grow the composer with its draft up to the CSS max-height, then scroll.
    const input = composerInput.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
  }, []);
  useLayoutEffect(fitComposer, [draft.text, botId, fitComposer]);
  const composerRef = useCallback((input: HTMLTextAreaElement | null) => {
    composerInput.current = input;
    if (!input || typeof ResizeObserver === "undefined") return;
    // Rotation or a narrower window rewraps the same draft.
    let width = input.clientWidth;
    const observer = new ResizeObserver(() => {
      if (input.clientWidth === width) return;
      width = input.clientWidth;
      fitComposer();
    });
    observer.observe(input);
    return () => {
      observer.disconnect();
      composerInput.current = null;
    };
  }, [fitComposer]);
  const bottom = useRef(true);
  const activeBotRef = useRef(botId);
  activeBotRef.current = botId;
  const refresh = useCallback((): Promise<Bootstrap | null> => {
    if (bootstrapRequest.current) return bootstrapRequest.current;
    const epoch = identityEpoch.current;
    const request = (async () => {
      try {
        const next = await api<Bootstrap>("/bootstrap");
        if (epoch !== identityEpoch.current) return null;
        if (bootRef.current && bootRef.current.user.id !== next.user.id) {
          identityEpoch.current++;
          setSending(false); setUploading(false); setPending(null); setReceipt(null);
          setSettings(null); setPreferencesOpen(false); setUpgradeOpen(false); setIntegrationsOpen(false); setComputerOpen(false); setError("");
        }
        setCsrf(next.csrfToken ?? "");
        setBoot((previous) => ({ ...next,
          bots: !next.connection.connected && !next.bots.length && previous?.user.id === next.user.id
            ? previous.bots : next.bots,
        }));
        setAuth(false);
        setAppUnavailable(false);
        setDisconnected(!next.connection.connected);
        setBotId((previous) => {
          if (!next.connection.connected) return previous;
          if (next.bots.some(bot => bot.id === previous)) return previous;
          return next.bots.find(bot => bot.id === next.preferences.defaultBotId)?.id || next.bots[0]?.id || "";
        });
        return next;
      } catch (e) {
        if (epoch !== identityEpoch.current) return null;
        if (e instanceof ApiError && e.status === 401) {
          identityEpoch.current++;
          setSending(false); setUploading(false); setPending(null); setReceipt(null);
          setSettings(null); setPreferencesOpen(false); setUpgradeOpen(false); setIntegrationsOpen(false); setComputerOpen(false); setError("");
          setAuth(true); setBoot(null); setCsrf("");
        } else {
          setDisconnected(true); setAppUnavailable(true);
        }
        return null;
      }
    })();
    bootstrapRequest.current = request;
    void request.finally(() => {
      if (bootstrapRequest.current === request) bootstrapRequest.current = null;
    });
    return request;
  }, []);
  const reconnect = useCallback(async () => {
    if (checkingConnection) return;
    setCheckingConnection(true);
    try {
      await write("/connection/retry", {});
      await refresh();
      window.dispatchEvent(new Event("agent-interface:reconnect"));
    } catch {
      setDisconnected(true); setAppUnavailable(true);
    } finally {
      setCheckingConnection(false);
    }
  }, [checkingConnection, refresh]);
  useEffect(() => {
    void refresh();
    const id = setInterval(() => {
      if (!authRef.current && document.visibilityState !== "hidden" && navigator.onLine !== false) void refresh();
    }, 8000);
    const wake = () => {
      setOffline(navigator.onLine === false);
      if (navigator.onLine !== false && document.visibilityState !== "hidden") void refresh();
    };
    const lost = () => { setOffline(true); };
    window.addEventListener("online", wake);
    window.addEventListener("offline", lost);
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      clearInterval(id);
      window.removeEventListener("online", wake);
      window.removeEventListener("offline", lost);
      window.removeEventListener("focus", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [refresh]);
  useEffect(() => {
    const theme = boot?.preferences.theme || "system";
    document.documentElement.dataset.theme = theme;
  }, [boot?.preferences.theme]);
  useEffect(() => {
    if (!botId || !boot) return;
    let live = true;
    const userId = boot.user.id;
    setConversation(null);
    setConversationDisconnected(false);
    setDraftReady(false);
    setReviewed(false);
    setReceipt(null);
    setPending(
      localRead<Pending>(`agent-interface:submission:${userId}:${botId}`),
    );
    const cached = localRead<Draft>(draftKey(userId, botId));
    let draftLoaded = !!cached?.dirty;
    let loadingDraft = false;
    let loadingConversation = false;
    let firstConversation = true;
    let secureRequestIds = new Set<string>();
    setDraft({ ...(cached || { text: "", attachments: [] }), botId, userId });
    if (cached) setDraftReady(true);
    // Personal drafts remain available even when the separate executor is down.
    const loadDraft = async () => {
      if (draftLoaded || loadingDraft) return;
      loadingDraft = true;
      try {
        const saved = await api<Draft | null>(`/bots/${encodeURIComponent(botId)}/draft`);
        if (!live) return;
        draftLoaded = true;
        setDraft(current => current.dirty ? current : { ...(saved || { text: "", attachments: [] }), botId, userId });
        setDraftReady(true);
        setError(previous => previous.startsWith("Your saved draft could not be loaded.") ? "" : previous);
      } catch (e) {
        if (live) setError(`Your saved draft could not be loaded. Retrying. ${(e as Error).message}`);
      } finally {
        loadingDraft = false;
      }
    };
    const load = async () => {
      if (loadingConversation) return;
      loadingConversation = true;
      try {
        const result = await api<SavedConversation>(
          `/bots/${encodeURIComponent(botId)}/conversation`,
        );
        if (!live) return;
        setConversation(result);
        setConversationDisconnected(false);
        const secureRequests = (result.attention ?? []).filter(request => request.kind === "secure");
        const newSecureRequest = secureRequests.find(request => !secureRequestIds.has(request.id));
        secureRequestIds = new Set(secureRequests.map(request => request.id));
        if (newSecureRequest && (firstConversation || bottom.current)) {
          firstConversation = false;
          requestAnimationFrame(() => {
            if (!live || !scroll.current) return;
            const card = [...scroll.current.querySelectorAll<HTMLElement>('.secure-request')]
              .find(element => element.dataset.requestId === newSecureRequest.id);
            if (card) scroll.current.scrollTop += card.getBoundingClientRect().top - scroll.current.getBoundingClientRect().top;
            bottom.current = false;
          });
        } else if (firstConversation) {
          firstConversation = false;
          requestAnimationFrame(() => {
            if (!live || !scroll.current) return;
            const saved = localRead<number>(`agent-interface:scroll:${userId}:${botId}`);
            const messages = [...scroll.current.querySelectorAll<HTMLElement>('[data-message-id]')];
            const anchorIndex = result.messages.findIndex(message => message.id === result.readPosition?.messageId);
            const anchor = messages.find(element => element.dataset.messageId === result.readPosition?.messageId)
              ?? (anchorIndex >= 0 ? messages.find(element => result.messages.findIndex(message => message.id === element.dataset.messageId) >= anchorIndex) : undefined);
            scroll.current.scrollTop = saved ?? (anchor
              ? scroll.current.scrollTop + anchor.getBoundingClientRect().top - scroll.current.getBoundingClientRect().top
              : result.readPosition?.scrollTop ?? scroll.current.scrollHeight);
            bottom.current = scroll.current.scrollHeight - scroll.current.scrollTop
              - scroll.current.clientHeight < 100;
          });
        } else if (bottom.current) {
          requestAnimationFrame(() => {
            if (live && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
          });
        }
      } catch {
        if (live) {
          setConversationDisconnected(true);
        }
      } finally {
        loadingConversation = false;
      }
    };
    void loadDraft();
    void load();
    const wake = () => {
      if (navigator.onLine !== false && document.visibilityState !== "hidden") {
        void loadDraft(); void load();
      }
    };
    const timer = setInterval(wake, 1500);
    window.addEventListener("online", wake);
    window.addEventListener("agent-interface:reconnect", wake);
    document.addEventListener("visibilitychange", wake);
    const url = new URL(location.href);
    url.searchParams.set("bot", botId);
    history.replaceState(null, "", url);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener("online", wake);
      window.removeEventListener("agent-interface:reconnect", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [botId, boot?.user.id]);
  useEffect(() => {
    if (
      !boot ||
      !botId ||
      !draftReady ||
      draft.botId !== botId ||
      draft.userId !== boot.user.id
    )
      return;
    const user = boot.user.id;
    localSave(draftKey(user, botId), draft);
    if (!draft.dirty || offline || appUnavailable || pending && pending.botId === botId &&
      pending.text === draft.text && JSON.stringify(pending.attachments) === JSON.stringify(draft.attachments)) return;
    const epoch = identityEpoch.current;
    const timer = setTimeout(
      () =>
        void write(
          `/bots/${encodeURIComponent(botId)}/draft`,
          draft,
          "PUT",
        ).then(() => {
          if (epoch !== identityEpoch.current) return;
          const key = draftKey(user, botId);
          const cached = localRead<Draft>(key);
          if (cached?.text === draft.text && JSON.stringify(cached.attachments) === JSON.stringify(draft.attachments))
            localSave(key, {...cached, dirty: false});
          setDraft(current => current === draft ? {...current, dirty: false} : current);
        }).catch(() => {}),
      350,
    );
    return () => clearTimeout(timer);
  }, [draft, botId, draftReady, boot?.user.id, offline, appUnavailable, pending]);
  useEffect(() => {
    if (!pending || !boot || sending) return;
    let live = true;
    let loading = false;
    const epoch = identityEpoch.current;
    const key = `agent-interface:submission:${boot.user.id}:${pending.botId}`;
    const reconcile = async () => {
      if (loading || navigator.onLine === false || document.visibilityState === "hidden") return;
      loading = true;
      try {
        const result = await api<SubmissionReceipt>(
          `/submissions/${pending.requestId}`,
        );
        if (!live || epoch !== identityEpoch.current) return;
        setReceipt(result);
        if (result.status === "accepted") {
          clearSavedDraft(boot.user.id, pending);
          setPending(null);
          localRemove(key);
          setDraft((current) =>
            current.botId === pending.botId &&
            current.userId === boot.user.id &&
            current.text === pending.text &&
            JSON.stringify(current.attachments) ===
              JSON.stringify(pending.attachments)
              ? {
                  text: "",
                  attachments: [],
                  botId: current.botId,
                  userId: current.userId,
                }
              : current,
          );
        } else if (
          result.status === "rejected" ||
          result.status === "interrupted"
        ) {
          setPending(null);
          localRemove(key);
        }
      } catch {
        /* Unknown submission stays pending until a reliable reconciliation. */
      } finally { loading = false; }
    };
    void reconcile();
    const timer = setInterval(() => void reconcile(), 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [pending, boot?.user.id, sending]);
  useEffect(() => {
    if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
    let cancelled = false;
    void navigator.serviceWorker
      .register("/sw.js")
      .then((registration) => {
        if (cancelled) return;
        if (registration.waiting) setWorkerUpdate(registration.waiting);
        registration.addEventListener("updatefound", () => {
          const worker = registration.installing;
          worker?.addEventListener("statechange", () => {
            if (
              worker.state === "installed" &&
              navigator.serviceWorker.controller
            )
              setWorkerUpdate(registration.waiting);
          });
        });
      })
      .catch(() =>
        setNotice("Offline installation is unavailable in this browser."),
      );
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    const handler = (event: Event) => {
      event.preventDefault();
      setInstallEvent(event as Event & { prompt: () => Promise<void> });
    };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);
  const savePreferences = async (value: Preferences) => {
    const epoch = identityEpoch.current;
    try {
      const saved = await write<Preferences>("/preferences", value, "PATCH");
      if (epoch !== identityEpoch.current) return;
      setBoot((previous) =>
        previous ? { ...previous, preferences: saved } : previous,
      );
    } catch (e) {
      if (epoch === identityEpoch.current) setError((e as Error).message);
    }
  };
  const persistPosition = () => {
    if (!boot || !botId || !scroll.current) return;
    const top = scroll.current.scrollTop;
    bottom.current =
      scroll.current.scrollHeight - top - scroll.current.clientHeight < 100;
    localSave(`agent-interface:scroll:${boot.user.id}:${botId}`, top);
    if (positionTimer.current) clearTimeout(positionTimer.current);
    const positionBot = botId;
    const viewportTop = scroll.current.getBoundingClientRect().top;
    const visibleMessage = [...scroll.current.querySelectorAll<HTMLElement>('[data-message-id]')]
      .find(element => element.getBoundingClientRect().bottom > viewportTop + 8);
    const messageId = bottom.current ? conversation?.messages.at(-1)?.id : visibleMessage?.dataset.messageId;
    positionTimer.current = setTimeout(
      () =>
        void write(
          `/bots/${encodeURIComponent(positionBot)}/read-position`,
          { scrollTop: top, messageId },
          "PUT",
        ).catch(() => {}),
      300,
    );
  };
  const selectBot = (id: string) => {
    persistPosition();
    setTodayOpen(false);
    setBotId(id);
    setRailOpen(false);
    setError("");
  };
  const send = async () => {
    if (
      !boot ||
      connectionLost ||
      pending ||
      sending ||
      !draftReady ||
      !botId ||
      draft.botId !== botId ||
      draft.userId !== boot.user.id
    )
      return;
    setError("");
    const epoch = identityEpoch.current;
    const request: Pending = {
      requestId: crypto.randomUUID(),
      botId,
      text: draft.text,
      attachments: draft.attachments,
      reviewedInterruption: reviewed,
    };
    localSave(`agent-interface:submission:${boot.user.id}:${botId}`, request);
    setPending(request);
    setSending(true);
    try {
      const result = await write<SubmissionReceipt>(
        `/bots/${encodeURIComponent(botId)}/messages`,
        request,
      );
      if (epoch !== identityEpoch.current) return;
      if (activeBotRef.current === request.botId) setReceipt(result);
      if (result.status === "accepted") {
        clearSavedDraft(boot.user.id, request);
        setDraft((current) =>
          current.botId === request.botId &&
          current.userId === boot.user.id &&
          current.text === request.text &&
          JSON.stringify(current.attachments) ===
            JSON.stringify(request.attachments)
            ? {
                text: "",
                attachments: [],
                botId: current.botId,
                userId: current.userId,
              }
            : current,
        );
        if (activeBotRef.current === request.botId) setPending(null);
        localRemove(
          `agent-interface:submission:${boot.user.id}:${request.botId}`,
        );
      } else if (
        result.status === "rejected" ||
        result.status === "interrupted"
      ) {
        if (activeBotRef.current === request.botId) setPending(null);
        localRemove(
          `agent-interface:submission:${boot.user.id}:${request.botId}`,
        );
      }
    } catch (e) {
      if (epoch !== identityEpoch.current) return;
      if (e instanceof ApiError && e.status < 500) {
        if (activeBotRef.current === request.botId) setPending(null);
        localRemove(
          `agent-interface:submission:${boot.user.id}:${request.botId}`,
        );
      }
      setError((e as Error).message);
    } finally {
      if (epoch === identityEpoch.current) setSending(false);
    }
  };
  const upload = async (files: FileList | null) => {
    if (!files || !boot) return;
    const uploadBot = botId;
    const uploadUser = boot.user.id;
    const epoch = identityEpoch.current;
    let targetDraft = { ...draft };
    setUploading(true);
    setError("");
    try {
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.append("file", file);
        const result = await api<FileRef>(
          `/bots/${encodeURIComponent(uploadBot)}/uploads`,
          { method: "POST", body: form },
        );
        if (epoch !== identityEpoch.current) return;
        targetDraft =
          localRead<Draft>(draftKey(uploadUser, uploadBot)) || targetDraft;
        targetDraft = {
          ...targetDraft,
          attachments: [...targetDraft.attachments, result],
          dirty: true,
        };
        localSave(draftKey(uploadUser, uploadBot), targetDraft);
        void write(
          `/bots/${encodeURIComponent(uploadBot)}/draft`,
          targetDraft,
          "PUT",
        ).catch(() => {});
        setDraft((current) =>
          current.botId === uploadBot && current.userId === uploadUser
            ? { ...current, attachments: [...current.attachments, result], dirty: true }
            : current,
        );
      }
    } catch (e) {
      if (epoch === identityEpoch.current) setError((e as Error).message);
    } finally {
      if (epoch === identityEpoch.current) setUploading(false);
    }
  };
  if (auth) return <SignIn onSuccess={() => {
    identityEpoch.current++;
    bootstrapRequest.current = null;
    void refresh();
  }} />;
  if (!boot)
    return (
      <main className="welcome">
        <p className="eyebrow">Agent Interface</p>
        <AvatarTrio />
        <h1>
          Your assistants,
          <br />
          in one familiar place.
        </h1>
        <p role="status">{appUnavailable ? "Can't reach the app right now. We'll keep trying." : "Connecting to your household…"}</p>
        {appUnavailable && <button onClick={() => void refresh()}>Try again</button>}
      </main>
    );
  const selected = boot.bots.find((bot) => bot.id === botId);
  const state = connectionLost
    ? "disconnected"
    : conversation?.activity.state || selected?.activity || "idle";
  const active = ["thinking", "working", "waiting", "blocked"].includes(state);
  const showActivity = state !== "idle" && state !== "done";
  const avatarState = state === "done" ? "idle" : state;
  const allBots = boot.bots;
  const prefs = boot.preferences;
  const advanced = prefs.presentation === "advanced";
  const historicalToolIds = new Set(conversation?.messages.flatMap(message => message.toolCall ? [message.toolCall.id] : []) || []);
  const liveTools = conversation?.toolCalls?.filter(call => !historicalToolIds.has(call.id)) || [];
  const ordered = [...allBots].sort(
    (a, b) =>
      Number(prefs.favorites.includes(b.id)) -
      Number(prefs.favorites.includes(a.id)),
  );
  const renderBot = (bot: Bot) => {
    const botState = connectionLost
      ? "disconnected"
      : bot.id === botId
        ? state
        : bot.activity;
    // The rail says what each assistant is doing in words, not only through motion.
    const reportsActivity = !connectionLost && botState !== "idle" && botState !== "done";
    return (
      <button
        className={`bot-item ${bot.id === botId && !todayOpen ? "selected" : ""}`}
        key={bot.id}
        aria-current={bot.id === botId && !todayOpen ? "page" : undefined}
        onClick={() => selectBot(bot.id)}
      >
        <Avatar avatar={bot.avatar} state={botState === "done" ? "idle" : botState} size={40} name={bot.name} />
        <span>
          <strong>{bot.name}</strong>
          <small className={reportsActivity ? `bot-activity state-${botState}` : undefined}>
            {reportsActivity
              ? stateLabels[botState]
              : bot.shared
                ? "Shared assistant"
                : "Personal assistant"}
          </small>
        </span>
        {prefs.favorites.includes(bot.id) && (
          <span className="favorite-star" role="img" aria-label="Favorite">
            <Icon name="star" size={15} filled />
          </span>
        )}
      </button>
    );
  };
  return (
    <div className="app-shell">
      <aside
        ref={rail}
        id="assistant-navigation"
        className={`bot-rail ${railOpen ? "open" : ""}`}
        aria-label="Assistants"
        role={mobile ? "dialog" : undefined}
        aria-modal={mobile && railOpen ? true : undefined}
        inert={mobile && !railOpen}
      >
        <div className="rail-brand">
          <span className="brand-mark" aria-hidden="true">a.</span>
          <strong>Agent Interface</strong>
          <button
            className="mobile-only icon-button"
            aria-label="Close assistants"
            onClick={() => setRailOpen(false)}
          >
            <Icon name="close" />
          </button>
        </div>
        <div className="household-label">
          <span className="online-dot" />
          {boot.user.name}'s home
        </div>
        <div className="rail-scroll">
          <button className="today-navigation" type="button" aria-current={todayOpen ? "page" : undefined}
            onClick={() => { setTodayOpen(true); setRailOpen(false); }}><Icon name="today" size={20} /> Today</button>
          {prefs.sections.map((section) => (
            <section className="bot-section" key={section.id}>
              <h2>{section.name}</h2>
              {ordered
                .filter((bot) => section.botIds.includes(bot.id))
                .map(renderBot)}
            </section>
          ))}
          <section className="bot-section">
            <h2>
              {prefs.sections.length ? "More assistants" : "Your assistants"}
            </h2>
            {ordered
              .filter(
                (bot) =>
                  !prefs.sections.some((section) =>
                    section.botIds.includes(bot.id),
                  ),
              )
              .map(renderBot)}
            {!allBots.length && (
              <p className="muted rail-empty">
                No assistants are available from Hermes yet.
              </p>
            )}
          </section>
        </div>
        <button className="new-bot" onClick={() => {
          setRailOpen(false);
          setSettings("new");
        }}>
          <Icon name="plus" size={18} /> New assistant
        </button>
        <div className="rail-footer">
          <button onClick={() => { setRailOpen(false); setComputerOpen(true); }}>
            <Icon name="computer" size={18} /> Computer
          </button>
          <button
            onClick={() => {
              setRailOpen(false);
              setPreferencesOpen(!preferencesOpen);
            }}
          >
            <Icon name="sliders" size={18} /> Preferences
          </button>
          <button onClick={() => { setRailOpen(false); setIntegrationsOpen(true); }}><Icon name="plug" size={18} /> Integrations</button>
          <button className={`connection connection-button ${connectionLost ? "attention" : ""}`}
            aria-label="Hermes connection and updates" onClick={() => { setRailOpen(false); setUpgradeOpen(true); }}>
            <span className="connection-dot" aria-hidden="true" />
            {connectionLost ? offline ? "Offline" : "Reconnecting" : "Connected to Hermes"}
            <Icon name="chevron" size={16} className="connection-chevron" />
          </button>
        </div>
      </aside>
      {railOpen && (
        <button
          className="rail-scrim"
          aria-label="Close assistants"
          onClick={() => setRailOpen(false)}
        />
      )}
      <main className="conversation-panel" inert={mobile && railOpen}>
        <header className="chat-header">
          <button
            className="mobile-only icon-button"
            aria-label="Open assistants"
            aria-expanded={railOpen}
            aria-controls="assistant-navigation"
            onClick={() => {
              setPreferencesOpen(false);
              setRailOpen(true);
            }}
          >
            <Icon name="menu" />
          </button>
          {todayOpen ? <div className="chat-title"><h1>Today</h1><p>Your assistants, at a glance</p></div> : selected ? (
            <>
              <Avatar
                avatar={selected.avatar}
                state={avatarState}
                size={42}
                name={selected.name}
              />
              <div className="chat-title">
                <h1>{selected.name}</h1>
                <p>{`${selected.shared ? "Shared with your household" : "Your personal assistant"} · ${selected.provider ? selected.provider + " / " : ""}${selected.model}`}</p>
              </div>
              <ArtifactsButton key={`${boot.user.id}:${selected.id}`} bot={selected} conversation={conversation} unavailable={connectionLost} />
              <button
                className="icon-button"
                aria-label="Edit assistant"
                title="Assistant settings"
                onClick={() => setSettings(selected)}
              >
                <Icon name="gear" />
              </button>
              <button
                className={`icon-button favorite-toggle ${prefs.favorites.includes(selected.id) ? "on" : ""}`}
                aria-label={
                  prefs.favorites.includes(selected.id)
                    ? "Remove favorite"
                    : "Favorite assistant"
                }
                aria-pressed={prefs.favorites.includes(selected.id)}
                title={prefs.favorites.includes(selected.id) ? "Remove favorite" : "Favorite"}
                onClick={() =>
                  void savePreferences({
                    ...prefs,
                    favorites: prefs.favorites.includes(selected.id)
                      ? prefs.favorites.filter((id) => id !== selected.id)
                      : [...prefs.favorites, selected.id],
                  })
                }
              >
                <Icon name="star" filled={prefs.favorites.includes(selected.id)} />
              </button>
            </>
          ) : (
            <div className="chat-title">
              <h1>Welcome home</h1>
              <p>Your assistants will appear here when Hermes is connected.</p>
            </div>
          )}
        </header>
        {todayOpen ? <TodayPanel key={boot.user.id} bootstrap={boot} onOpen={selectBot} /> : <>
        {workerUpdate && (
          <div className="notice">
            An app update is ready.
            <button
              onClick={() => {
                navigator.serviceWorker.addEventListener(
                  "controllerchange",
                  () => location.reload(),
                  { once: true },
                );
                workerUpdate.postMessage({ type: "SKIP_WAITING" });
              }}
            >
              Reload when ready
            </button>
          </div>
        )}
        {connectionLost && selected && (
          <ConnectionPanel compact connection={boot.connection} offline={offline}
            appUnavailable={appUnavailable} busy={checkingConnection} retry={() => void reconnect()} />
        )}
        {error && (
          <div className="notice error" role="alert">
            {error}
            <button aria-label="Dismiss error" onClick={() => setError("")}>
              <Icon name="close" size={16} />
            </button>
          </div>
        )}
        <NotificationOnboarding notifications={notifications} />
        <div
          className="transcript"
          ref={scroll}
          onScroll={persistPosition}
          aria-label="Conversation"
          tabIndex={0}
        >
          {!selected && connectionLost ? (
            <ConnectionPanel connection={boot.connection} offline={offline}
              appUnavailable={appUnavailable} busy={checkingConnection} retry={() => void reconnect()} />
          ) : !selected ? (
            <div className="empty-state">
              <Avatar size={100} />
              <h2>A little less to carry.</h2>
              <p>
                Return to the same assistants, with the context and
                conversations you share.
              </p>
              <button
                className="primary"
                disabled={!boot.capabilities.botConfiguration.supported}
                title={boot.capabilities.botConfiguration.reason}
                onClick={() => setSettings("new")}
              >
                Create an assistant
              </button>
              {!boot.capabilities.botConfiguration.supported && (
                <p className="muted">
                  Assistant setup is unavailable while Hermes is disconnected.
                </p>
              )}
              {prefs.presentation === "advanced" && (
                <details className="activity-details">
                  <summary>Connection details</summary>
                  <p>{boot.connection.detail}</p>
                </details>
              )}
            </div>
          ) : !conversation && !connectionLost ? (
            <div className="empty-state" role="status"><p>Opening your conversation…</p></div>
          ) : conversation?.messages.length ? (
            <>
              {conversation.messages
                .filter((message) => message.role !== "tool" || advanced || message.files?.length)
                .map((message) => (
                  <article
                    className={`message message-${message.role}`}
                    key={message.id}
                    data-message-id={message.id}
                  >
                    <div className="message-attribution">
                      {message.role === "user"
                        ? message.sender?.name || "Household member"
                        : message.role === "assistant" || message.role === "tool"
                          ? selected.name
                          : message.toolName || message.role}
                      {message.createdAt && (
                        <time dateTime={message.createdAt}>
                          {new Date(message.createdAt).toLocaleTimeString([], {
                            hour: "numeric",
                            minute: "2-digit",
                          })}
                        </time>
                      )}
                    </div>
                    {message.role === "assistant" ? (
                      <MessageMarkdown text={message.text} botId={botId} messageId={message.id} userId={boot.user.id} unavailable={connectionLost} />
                    ) : message.role !== "tool" && (
                      <div className="message-text">{message.text}</div>
                    )}
                    {advanced && message.reasoning && (
                      <details className="message-detail">
                        <summary>Reasoning</summary>
                        <p>{message.reasoning}</p>
                      </details>
                    )}
                    {advanced && message.toolCall && <ToolCallDetail call={message.toolCall} disconnected={connectionLost} />}
                    {advanced && message.role === "tool" && !message.toolCall && (
                      <details className="message-detail tool-call-detail">
                        <summary>{message.toolName || "Tool result"}</summary>
                        <pre>{message.text || "No result was exposed by Hermes."}</pre>
                      </details>
                    )}
                    {message.files?.map((file) => (
                      <FileLink file={file} key={file.id} />
                    ))}
                  </article>
                ))}
            </>
          ) : !showActivity ? (
            <div className="empty-state">
              <Avatar
                avatar={selected.avatar}
                state={avatarState}
                size={112}
                name={selected.name}
              />
              <h2>What’s on your mind?</h2>
              <p>
                Ask a question, share a file, or hand over something from your
                to-do list.
              </p>
              {!boot.capabilities.chat.supported && (
                <p className="muted">{boot.capabilities.chat.reason}</p>
              )}
            </div>
          ) : null}
          {advanced && liveTools.map(call => <article className="message message-tool" key={`tool-${call.id}`}>
            <ToolCallDetail call={call} disconnected={connectionLost} />
          </article>)}
          {selected && showActivity && (
            <div className={`activity-status conversation-activity message-activity state-${state}`}>
              <Avatar avatar={selected.avatar} state={state} size={52} name={selected.name} />
              <div className="activity-copy" role="status">
                <strong>{stateLabels[state]}</strong>
                <p>{connectionLost ? "Restoring activity when Hermes reconnects."
                  : conversation?.activity.detail || (state === "thinking" ? "Considering your message."
                    : state === "working" ? "Working on your request." : "")}</p>
              </div>
              {active && (
                <button
                  disabled={!boot.capabilities.stop.supported}
                  title={boot.capabilities.stop.reason}
                  onClick={() =>
                    void write(
                      `/bots/${encodeURIComponent(botId)}/stop`,
                      {},
                    ).catch((e) => setError(e.message))
                  }
                >
                  <Icon name="stop" size={14} /> Stop
                </button>
              )}
            </div>
          )}
          {conversation?.attention?.map((request) => (
            request.kind === "secure" && request.secure ? <SecureRequestCard
              key={`${boot.user.id}:${botId}:${request.id}:${JSON.stringify(request.secure)}`}
              request={request.secure} requestId={request.id} botId={botId} ownerId={boot.user.id}
              title={request.title} detail={request.detail}
            /> : <AttentionCard
              key={request.id}
              request={request}
              botId={botId}
              report={setError}
            />
          ))}
          {conversation?.approvals
            .filter((approval) => approval.status === "pending")
            .map((approval) => (
              <article className="approval-card" key={approval.id}>
                <p className="eyebrow">Your decision needed</p>
                <h2>{approval.title}</h2>
                <p>{approval.detail}</p>
                {approval.expiresAt && (
                  <small>
                    Expires {new Date(approval.expiresAt).toLocaleString()}
                  </small>
                )}
                <div className="actions">
                  <button
                    className="primary"
                    disabled={!boot.capabilities.approvals.supported}
                    onClick={() =>
                      void write(
                        `/bots/${encodeURIComponent(botId)}/approvals/${encodeURIComponent(approval.id)}`,
                        { decision: "approved" },
                      ).catch((e) => setError(e.message))
                    }
                  >
                    Approve
                  </button>
                  <button
                    disabled={!boot.capabilities.approvals.supported}
                    onClick={() =>
                      void write(
                        `/bots/${encodeURIComponent(botId)}/approvals/${encodeURIComponent(approval.id)}`,
                        { decision: "denied" },
                      ).catch((e) => setError(e.message))
                    }
                  >
                    Decline
                  </button>
                </div>
                <small>
                  Either household member can decide. Hermes checks whether this
                  request is still pending.
                </small>
              </article>
            ))}
        </div>
        {selected && (
          <footer className="composer-area">
            {state === "interrupted" && (
              <label className="interruption-review">
                <input
                  type="checkbox"
                  checked={reviewed}
                  onChange={(event) => setReviewed(event.target.checked)}
                />{" "}
                I reviewed the interrupted task and its last actions before
                continuing.
              </label>
            )}
            {conversation && advanced && showActivity && (
                <details className="activity-details">
                  <summary>Activity details</summary>
                  <p>{connectionLost ? "Activity is unknown until Hermes reconnects." : conversation.activity.detail || stateLabels[state]}</p>
                  {conversation.activity.updatedAt && <p>Last reported <time dateTime={conversation.activity.updatedAt}>{new Date(conversation.activity.updatedAt).toLocaleString()}</time></p>}
                  {conversation.activity.runId && <p>Run <code>{conversation.activity.runId}</code></p>}
                </details>
              )}
            {pending && (
              <div className="notice" role="status">
                Checking whether Hermes accepted your message. Your draft is
                preserved; sending stays paused to prevent duplicates.
                <button
                  disabled={sending || !boot.capabilities.idempotency.supported}
                  title={boot.capabilities.idempotency.reason}
                  onClick={() => {
                    const epoch = identityEpoch.current;
                    const requestBot = pending.botId;
                    const current = () => epoch === identityEpoch.current &&
                      activeBotRef.current === requestBot;
                    setSending(true);
                    void write<SubmissionReceipt>(
                      `/bots/${encodeURIComponent(pending.botId)}/messages`,
                      { ...pending, reviewedUncertain: true },
                    )
                      .then((result) => { if (current()) setReceipt(result); })
                      .catch((e) => { if (current()) setError(e.message); })
                      .finally(() => {
                        if (epoch === identityEpoch.current) setSending(false);
                      });
                  }}
                >
                  Retry this saved message
                </button>
              </div>
            )}
            {receipt?.status === "rejected" && (
              <div className="notice attention" role="alert">
                {receipt.message || "Hermes did not accept this message. Your draft is saved."}
              </div>
            )}
            {receipt?.status === "interrupted" && (
              <div className="notice attention">
                This submission was interrupted. Review its last actions before
                trying again.
              </div>
            )}
            <form
              className="composer"
              onSubmit={(event) => {
                event.preventDefault();
                void send();
              }}
            >
              <div className="attachment-list">
                {draft.attachments.map((file) => (
                  <span key={file.id}>
                    {file.name}
                    <button
                      type="button"
                      aria-label={`Remove ${file.name}`}
                      onClick={() =>
                        setDraft((previous) => ({
                          ...previous,
                          dirty: true,
                          attachments: previous.attachments.filter(
                            (f) => f.id !== file.id,
                          ),
                        }))
                      }
                    >
                      <Icon name="close" size={14} />
                    </button>
                  </span>
                ))}
              </div>
              <label className="sr-only" htmlFor="message">
                Message {selected.name}
              </label>
              <textarea
                ref={composerRef}
                id="message"
                value={draft.botId === botId ? draft.text : ""}
                placeholder={
                  active
                    ? `Guide ${selected.name} while they work…`
                    : `Message ${selected.name}…`
                }
                onChange={(event) =>
                  setDraft((previous) => ({
                    ...previous,
                    dirty: true,
                    text: event.target.value,
                  }))
                }
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    if (
                      !(
                        pending ||
                        sending ||
                        uploading ||
                        connectionLost ||
                        !boot.capabilities.chat.supported ||
                        (state === "interrupted" && !reviewed) ||
                        (active && !boot.capabilities.steering.supported)
                      ) &&
                      (draft.text.trim() || draft.attachments.length)
                    )
                      void send();
                  }
                }}
                rows={2}
                disabled={!draftReady || draft.botId !== botId}
              />
              <div className="composer-voice">
                {voiceState !== "idle" && <span className={`voice-avatar voice-${voiceState}`}><Avatar avatar={selected.avatar} state="idle" size={32} name={selected.name} /></span>}
                <VoiceControls key={`${boot.user.id}:${botId}`} botId={botId}
                  reply={!active ? conversation?.messages.findLast(message => message.role === "assistant") : undefined}
                  disabled={!draftReady || draft.botId !== botId || pending !== null || sending || connectionLost}
                  onStateChange={setVoiceState} onTranscript={(text) => setDraft(previous => ({ ...previous, dirty: true,
                    text: previous.text.trim() ? `${previous.text}\n${text}` : text }))} />
              </div>
              <div className="composer-tools">
                <label
                  className={`attach-control ${!boot.capabilities.uploads.supported ? "disabled" : ""}`}
                  title={boot.capabilities.uploads.reason}
                >
                  <Icon name="attach" size={18} />
                  <span>Attach</span>
                  <input
                    aria-label="Attach images, PDFs, or text"
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain"
                    multiple
                    disabled={
                      !draftReady ||
                      !boot.capabilities.uploads.supported ||
                      uploading ||
                      draft.attachments.length >= 10
                    }
                    onChange={(event) => {
                      void upload(event.target.files);
                      event.target.value = "";
                    }}
                  />
                </label>
                <span className="composer-hint">
                  {uploading
                    ? "Uploading…"
                    : active
                      ? "New messages guide the current work"
                      : "Enter to send · Shift + Enter for a new line"}
                </span>
                <button
                  className="send-button"
                  aria-label={active ? "Send guidance" : "Send message"}
                  disabled={
                    !draftReady ||
                    pending !== null ||
                    sending ||
                    uploading ||
                    connectionLost ||
                    !boot.capabilities.chat.supported ||
                    (active && !boot.capabilities.steering.supported) ||
                    (state === "interrupted" && !reviewed) ||
                    (!draft.text.trim() && !draft.attachments.length)
                  }
                >
                  <Icon name="send" size={19} />
                </button>
              </div>
            </form>
            <p className="shared-note">
              {selected.shared
                ? "One shared conversation. Messages and decisions keep their sender."
                : "Personal organization does not create a privacy boundary."}
            </p>
          </footer>
        )}
        </>}
      </main>
      {settings && (
        <BotSettings
          bot={settings}
          bootstrap={boot}
          onClose={() => setSettings(null)}
          onSaved={() => void refresh()}
        />
      )}
      {integrationsOpen && <IntegrationsPanel key={`integrations:${boot.user.id}`} bots={allBots} accountScope={boot.user.id} onClose={() => setIntegrationsOpen(false)} />}
      <ComputerPanel key={`computer:${boot.user.id}`} open={computerOpen} onClose={() => setComputerOpen(false)} />
      <HermesUpgradePanel key={`upgrades:${boot.user.id}`} open={upgradeOpen} onClose={() => setUpgradeOpen(false)}
        bots={allBots} currentVersion={boot.connection.version} />
      {preferencesOpen && (
        <dialog
          ref={preferencesDialog}
          className="preferences-panel"
          aria-labelledby="preferences-title"
          onCancel={() => setPreferencesOpen(false)}
          onClose={() => setPreferencesOpen(false)}
        >
          <header>
            <h2 id="preferences-title">Your preferences</h2>
            <button
              className="icon-button"
              aria-label="Close preferences"
              onClick={() => setPreferencesOpen(false)}
            >
              <Icon name="close" />
            </button>
          </header>
          <label>
            Appearance
            <select
              value={prefs.theme}
              onChange={(e) =>
                void savePreferences({
                  ...prefs,
                  theme: e.target.value as Preferences["theme"],
                })
              }
            >
              <option value="system">Follow device</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
          <label>
            Presentation
            <select
              value={prefs.presentation}
              onChange={(e) =>
                void savePreferences({
                  ...prefs,
                  presentation: e.target.value as Preferences["presentation"],
                })
              }
            >
              <option value="simple">Simple</option>
              <option value="advanced">Advanced</option>
            </select>
          </label>
          <label>
            Open by default
            <select
              value={prefs.defaultBotId || ""}
              onChange={(e) =>
                void savePreferences({
                  ...prefs,
                  defaultBotId: e.target.value || undefined,
                })
              }
            >
              <option value="">First assistant</option>
              {allBots.map((bot) => (
                <option value={bot.id} key={bot.id}>
                  {bot.name}
                </option>
              ))}
            </select>
          </label>
          <fieldset>
            <legend>Follow all activity</legend>
            <p className="muted">
              Shared-task notifications already go to participants. Follow an
              assistant to receive all their activity.
            </p>
            {allBots.map((bot) => (
              <label className="checkbox-label" key={bot.id}>
                <input
                  type="checkbox"
                  checked={prefs.followBots.includes(bot.id)}
                  onChange={(e) =>
                    void savePreferences({
                      ...prefs,
                      followBots: e.target.checked
                        ? [...prefs.followBots, bot.id]
                        : prefs.followBots.filter((id) => id !== bot.id),
                    })
                  }
                />
                {bot.name}
              </label>
            ))}
          </fieldset>
          <SectionEditor
            preferences={prefs}
            bots={allBots}
            save={savePreferences}
          />
          <NotificationSettings notifications={notifications} />
          <div className="actions">
            <button
              disabled={notifications.busy}
              onClick={() =>
                void (async () => {
                  try {
                    await notifications.disable();
                    await write("/auth/logout", {});
                    identityEpoch.current++;
                    bootstrapRequest.current = null;
                    setCsrf("");
                    setBoot(null);
                    setConversation(null);
                    setDraft({ text: "", attachments: [] });
                    setPending(null);
                    setSettings(null);
                    setRailOpen(false);
                    setReceipt(null);
                    setPreferencesOpen(false);
                    setUpgradeOpen(false);
                    setIntegrationsOpen(false);
                    setAuth(true);
                  } catch (e) {
                    setNotice((e as Error).message);
                  }
                })()
              }
            >
              Sign out
            </button>
            {installEvent && (
              <button onClick={() => void installEvent.prompt()}>
                Install app
              </button>
            )}
          </div>
          <p className="muted">
            On iPhone, choose Share, then Add to Home Screen. Install before
            enabling notifications.
          </p>
          {notice && <p role="status">{notice}</p>}
        </dialog>
      )}
    </div>
  );
}
function ToolCallDetail({ call, disconnected }: { call: ToolCall; disconnected?: boolean }) {
  return <details className="message-detail tool-call-detail" data-tool-call-id={call.id}>
    <summary><span>{call.name}</span><span className={`tool-call-status tool-call-${call.status}`}>{call.status === "running" ? disconnected ? "Last seen running" : "Running" : call.status === "failed" ? "Failed" : "Completed"}</span></summary>
    <dl>
      <div><dt>Call</dt><dd><code>{call.id}</code></dd></div>
      {call.startedAt && <div><dt>Started</dt><dd><time dateTime={call.startedAt}>{new Date(call.startedAt).toLocaleString()}</time></dd></div>}
      {call.completedAt && <div><dt>Finished</dt><dd><time dateTime={call.completedAt}>{new Date(call.completedAt).toLocaleString()}</time></dd></div>}
    </dl>
    {call.arguments !== undefined && <><h3>Arguments</h3><pre>{call.arguments}</pre></>}
    {call.result !== undefined && <><h3>Result</h3><pre>{call.result}</pre></>}
    {call.error && <><h3 className="danger">Error</h3><pre className="danger">{call.error}</pre></>}
    {call.status === "running" && call.result === undefined && <p>{disconnected ? "The current tool status will be checked when Hermes reconnects." : "Waiting for the result from Hermes."}</p>}
  </details>;
}
function FileLink({ file }: { file: FileRef }) {
  return (
    <a
      className="file-link"
      href={file.url || `/api/files/${encodeURIComponent(file.id)}`}
      target="_blank"
      rel="noreferrer"
    >
      {file.mime.startsWith("image/") && (
        <img
          src={file.url || `/api/files/${encodeURIComponent(file.id)}`}
          alt={file.name}
          loading="lazy"
        />
      )}
      <span><Icon name={file.mime.startsWith("image/") ? "download" : "file"} size={16} /> {file.name}</span>
    </a>
  );
}
function SectionEditor({
  preferences,
  bots,
  save,
}: {
  preferences: Preferences;
  bots: Bot[];
  save: (v: Preferences) => Promise<void>;
}) {
  const [name, setName] = useState("");
  return (
    <fieldset>
      <legend>Assistant sections</legend>
      {preferences.sections.map((section) => (
        <div className="section-editor" key={section.id}>
          <div className="actions">
            <strong>{section.name}</strong>
            <button
              className="icon-button"
              aria-label={`Remove section ${section.name}`}
              onClick={() =>
                void save({
                  ...preferences,
                  sections: preferences.sections.filter(
                    (s) => s.id !== section.id,
                  ),
                })
              }
            >
              <Icon name="close" size={16} />
            </button>
          </div>
          {bots.map((bot) => (
            <label className="checkbox-label" key={bot.id}>
              <input
                type="checkbox"
                checked={section.botIds.includes(bot.id)}
                onChange={(e) =>
                  void save({
                    ...preferences,
                    sections: preferences.sections.map((s) =>
                      s.id === section.id
                        ? {
                            ...s,
                            botIds: e.target.checked
                              ? [...s.botIds, bot.id]
                              : s.botIds.filter((id) => id !== bot.id),
                          }
                        : s,
                    ),
                  })
                }
              />
              {bot.name}
            </label>
          ))}
        </div>
      ))}
      <div className="actions">
        <input
          aria-label="New section name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Section name"
        />
        <button
          disabled={!name.trim()}
          onClick={() => {
            void save({
              ...preferences,
              sections: [
                ...preferences.sections,
                { id: crypto.randomUUID(), name: name.trim(), botIds: [] },
              ],
            });
            setName("");
          }}
        >
          Add
        </button>
      </div>
    </fieldset>
  );
}

function AttentionCard({
  request,
  botId,
  report,
}: {
  request: AttentionRequest;
  botId: string;
  report: (s: string) => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  return (
    <article className="approval-card">
      <p className="eyebrow">
        {request.kind === "clarify"
          ? "A question for you"
          : "Continue in Hermes"}
      </p>
      <h2>{request.title}</h2>
      <p>{request.detail}</p>
      {request.kind === "clarify" && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setBusy(true);
            void write(
              `/bots/${encodeURIComponent(botId)}/requests/${encodeURIComponent(request.id)}`,
              { answers },
            )
              .catch((error) => report(error.message))
              .finally(() => setBusy(false));
          }}
        >
          {request.questions?.map((question) => (
            <label key={question.id}>
              {question.prompt}
              {question.options?.length ? (
                <select
                  required
                  value={answers[question.id] || ""}
                  onChange={(event) =>
                    setAnswers({
                      ...answers,
                      [question.id]: event.target.value,
                    })
                  }
                >
                  <option value="">Choose an answer</option>
                  {question.options.map((option) => (
                    <option key={option}>{option}</option>
                  ))}
                </select>
              ) : (
                <input
                  required
                  value={answers[question.id] || ""}
                  onChange={(event) =>
                    setAnswers({
                      ...answers,
                      [question.id]: event.target.value,
                    })
                  }
                />
              )}
            </label>
          ))}
          <button className="primary" disabled={busy}>
            Send answers
          </button>
        </form>
      )}
      {request.kind === "official" && (
        <p className="muted">
          Open the official Hermes interface to handle this request. Return here
          when it is complete.
        </p>
      )}
    </article>
  );
}
