import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ActivityState, Bot, FileRef, Preferences } from "./shared/types";
import { MAX_ATTACHMENTS } from "./shared/uploads";
import { api } from "./client-api";
import type { GroupCatalog, GroupRoom } from "./shared/collaboration";
import { AvatarTrio, SignIn } from "./components/SignIn";
import { useDeviceNotifications } from "./components/use-device-notifications";
import { TodayPanel } from "./components/TodayPanel";
import "./components/discovery.css";
import { hasDestination, initialPanel, initialRoom, initialView, startsOnToday, useUrlSync } from "./app/view";
import type { Panel, View } from "./app/view";
import { chatStream, STREAM_NOTICE_MS, useStreamsDown } from "./app/stream-health";
import { GROUP_FALLBACK_POLL_MS, GROUP_UNNOTIFIED_POLL_MS, GROUPS_EVENT, useSession } from "./app/use-session";
import { useDraft, useDraftPersistence } from "./app/use-draft";
import { useConversation } from "./app/use-conversation";
import { useChatPresence } from "./app/use-chat-presence";
import { useDeviceActivity } from "./app/use-device-activity";
import { useSubmission } from "./app/use-submission";
import { awaitingTurn, ownSentRows, sendingDraft, useSentEchoes, withEchoes } from "./app/sent-echo";
import { moveSectionEdit, togglePinEdit, type UndoableEdit } from "./app/home-undo";
import { withRunsShown } from "./shared/routine-runs";
import { useAppInstall, useMobile } from "./app/use-browser";
import { latestMessageAt, useReadThrough } from "./app/unread";
import { useStableCallback } from "./app/use-stable-callback";
import { useResource } from "./app/use-resource";
import { orderRooms, pendingGroup } from "./app/home-rooms";
import { UpdateNotice } from "./app/UpdateNotice";
import { Sidebar, type HomeGroups } from "./app/Sidebar";
import { ChatHeader } from "./app/ChatHeader";
import { Conversation } from "./app/Conversation";
import { Composer, useOwnPrompts, useStopResponse } from "./app/Composer";
import { CommandPalette, paletteBots } from "./app/CommandPalette";
import { MainAssistantPicker } from "./app/MainAssistantPicker";
import { chooseMain, saveCheckIns } from "./app/main-assistant";
import { OPEN_CHAT_EVENT } from "./components/AgentExchange";
import { ShortcutsDialog } from "./app/ShortcutsDialog";
import { StopConfirm } from "./app/StopConfirm";
import { Toast, useToast } from "./app/Toast";
import { useShortcuts } from "./app/shortcuts";
import { headerAvatar, morphNavigate, railAvatar } from "./app/navigation-morph";
import { tintProps } from "./app/bot-tint";
import { waitingPlaceholder } from "./app/waiting-input";
import { badgeCount, useAppBadge } from "./app/badge";
import { ConnectionAnnouncer, ConnectionPanel } from "./components/ConnectionPanel";
import { DecisionsNotice, reviewFirstDecision, StatusDock, type DockItem } from "./app/StatusDock";
import { useWorkerOpens, type Destination } from "./app/worker-opens";
import { waitingOnClose, type SheetClose } from "./app/close-request";
import { rememberTheme, savedTheme } from "./app/saved-theme";
import { readSavedRoster, rememberRoster, savedHome, savedRooms } from "./app/saved-roster";
import { prefetchLinkedChat } from "./app/linked-chat";
import { BotDetails, BotSettings, ComputerPanel, DiscoveryPanel, UsagePanel, GroupCreate, GroupRoomView, HermesUpgradePanel, IntegrationsPanel, Loading, PreferencesDialog, RoutineResults, useOnceActive } from "./app/panels";
import { accountGeneration, accountStart, checkHintExpiry, drawingAccount, hintUntil, uncoverEnded, watchAccount } from "./app/account-epoch";
import { signOutHere, signOutOf } from "./app/account-change";

/**
 * The app for one account generation at a time (see account-epoch.ts). A sign-in, sign-out, refused
 * session, another account or a lapsed sign-in hint, in this tab or another, unmounts everything the
 * previous generation held, its streams, timers and reads included, before anything draws again.
 * While another tab's sign-in or sign-out is on its way this shows the connecting screen and asks
 * nothing; then the new generation starts from bootstrap, or from sign-in after a sign-out.
 */
export function App() {
  const [changes, setChanges] = useState(0);
  const [shown, setShown] = useState(() => ({ changes: 0, start: accountStart(), generation: accountGeneration() }));
  useEffect(() => watchAccount(() => setChanges(value => value + 1)), []);
  // A change first unmounts the generation shown, in a commit of its own, so the cleanups it runs
  // still act under the old record and every request they make is refused. Only then does this
  // tab take the stored record as its own and draw the next generation.
  const pending = changes !== shown.changes;
  useEffect(() => {
    if (!pending) return;
    const start = accountStart();
    // An address that named the last account's chat, panel, room or message opens nothing of it for the next.
    if ("start" in start && start.leftAccount && (location.search || location.hash || location.pathname !== "/")) history.replaceState(null, "", "/");
    setShown({ changes, start, generation: accountGeneration() });
  }, [pending, changes]);
  // Each generation's first draw, before it paints, shows the theme this device saved only while the
  // sign-in hint still names that theme's account and no other tab's sign-in or sign-out is under way,
  // which may bring another account; otherwise the system's. public/boot.js applied it by the same rule,
  // but a change can finish after boot.js ran and before this first draw, as after it in another tab.
  // Bootstrap's own answer replaces it in AccountApp.
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = "wait" in shown.start ? "system" : savedTheme() ?? "system";
  }, [shown]);
  // A page covered for the back-forward cache shows again once nothing of an ended generation is drawn.
  useLayoutEffect(uncoverEnded, [pending, shown]);
  const { start, generation } = shown;
  const wait = "wait" in start ? start.wait : undefined;
  useEffect(() => {
    if (wait === undefined) return;
    // A tab that closed mid-request never settles its mark; once it is stale, bootstrap decides.
    const timer = setTimeout(() => setChanges(value => value + 1), Math.max(0, wait - Date.now()));
    return () => clearTimeout(timer);
  }, [wait]);
  useEffect(() => {
    const until = hintUntil();
    if (until === undefined) return;
    const timer = setTimeout(checkHintExpiry, Math.max(0, until - Date.now()));
    return () => clearTimeout(timer);
  }, [generation]);
  if (pending || "wait" in start) return <Connecting />;
  return <AccountApp key={generation} start={start.start} />;
}

function Connecting({ unavailable = false, retry }: { unavailable?: boolean; retry?: () => void }) {
  return (
    <main className="welcome">
      <p className="eyebrow">WildBots</p>
      <AvatarTrio />
      <h1>
        Your assistants,
        <br />
        in one familiar place.
      </h1>
      <p role="status">{unavailable ? "Can't reach the app right now. We'll keep trying." : "Connecting to your household…"}</p>
      {unavailable && retry && <button onClick={retry}>Try again</button>}
    </main>
  );
}

function AccountApp({ start }: { start: "bootstrap" | "signed-out" }) {
  const [view, setView] = useState<View>(initialView);
  // The group chat open in the main pane when the view is "group".
  const [roomId, setRoomId] = useState(initialRoom);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [panel, setPanel] = useState<Panel | null>(initialPanel);
  const closePanels = (...kinds: Panel["kind"][]) =>
    setPanel(current => current && kinds.includes(current.kind) ? null : current);
  const [error, setError] = useState("");
  // Phones open on the home list unless a link names a destination.
  const [railOpen, setRailOpen] = useState(() => matchMedia("(max-width: 620px)").matches && !hasDestination());
  const mobile = useMobile();
  // The home this device last showed, drawn until bootstrap answers. Read once per account generation:
  // whatever ends it, a change of account in any tab, a sign-out, a refused session, cleared storage
  // or the sign-in hint's lapse, ends the generation and this copy with it (see App).
  const [saved] = useState(readSavedRoster);
  // The saved home draws its account, so the address may name its chats, and the next account clears it.
  useLayoutEffect(() => { if (saved) drawingAccount(saved.user); }, [saved]);
  /** Set once the person picks a chat or view on the saved home, so the start page does not replace it. */
  const chosenEarly = useRef(false);
  // An assistant this person just deleted leaves quietly; any other one explains itself.
  const deleted = useRef("");
  const gone = (id: string) => {
    setPanel(current => (current?.kind === "routine" || current?.kind === "details") && current.botId === id || current?.kind === "settings" && current.bot !== "new" && current.bot.id === id ? null : current);
    if (deleted.current === id) return;
    setError("That assistant is no longer available to you.");
    setRailOpen(mobile);
  };
  const session = useSession({
    // A place chosen on the saved home before bootstrap answered stays chosen.
    onFirstBootstrap: next => { if (!chosenEarly.current && startsOnToday(next.preferences)) setView("today"); },
    onError: setError,
    onBotGone: gone,
  }, start);
  const { boot, botId, setBotId, identityEpoch, offline, appUnavailable } = session;
  const userId = boot?.user.id;
  const toast = useToast(session.auth ? undefined : userId);
  useUrlSync(view, panel, botId, userId, roomId);
  // Home lists the household's group chats beside its assistants. The catalog carries each room's
  // newest message, so one read serves every row; no room's log is read from here. The household
  // stream's notices drive reads; the slow poll only covers one it missed.
  // A read that finds nothing new returns the copy already held, so home does not redraw for it.
  const groupsHeld = useRef<{ json: string; value: { userId: string; catalog: GroupCatalog } }>(undefined);
  const groupLoad = useResource<{ userId: string; catalog: GroupCatalog }>(userId ? "/groups" : null, {
    // A server that never sends `groups` notices gets the 30-second poll home always had, unless its catalog
    // says group chats are unsupported: that changes only with the server, so the slow poll is enough.
    deps: [userId], pollMs: session.groupsNotified || groupsHeld.current?.value.catalog?.supported === false
      ? GROUP_FALLBACK_POLL_MS : GROUP_UNNOTIFIED_POLL_MS, wake: true,
    load: async (path, signal) => {
      const catalog = await api<GroupCatalog>(path, { signal });
      const json = JSON.stringify([userId, catalog]);
      if (groupsHeld.current?.json === json) return groupsHeld.current.value;
      groupsHeld.current = { json, value: { userId: userId!, catalog } };
      return groupsHeld.current.value;
    },
  });
  // Another account's rooms never show while this one's load.
  const catalog = userId && groupLoad.data?.userId === userId ? groupLoad.data.catalog : null;
  // Until the catalog answers, home keeps this account's saved rooms in place (see saved-roster.ts).
  const roomsSaved = !catalog && !groupLoad.error && !!saved && (!userId || saved.user === userId);
  // Once bootstrap has reached Hermes, a saved room with an assistant no longer in the roster goes at once.
  const verifiedBots = boot?.connection.connected ? boot.bots : undefined;
  const rooms = useMemo(() => roomsSaved && saved ? savedRooms(saved, verifiedBots) : orderRooms(catalog?.rooms ?? []), [catalog, roomsSaved, saved, verifiedBots]);
  const reloadGroups = useStableCallback(() => void groupLoad.reload());
  useEffect(() => {
    if (!userId) return;
    window.addEventListener(GROUPS_EVENT, reloadGroups);
    window.addEventListener("agent-interface:reconnect", reloadGroups);
    return () => {
      window.removeEventListener(GROUPS_EVENT, reloadGroups);
      window.removeEventListener("agent-interface:reconnect", reloadGroups);
    };
  }, [userId, reloadGroups]);
  const pendingCreate = useMemo(() => userId && !creatingGroup ? pendingGroup(userId) : null, [userId, creatingGroup]);
  const notifications = useDeviceNotifications(userId, boot?.vapidPublicKey);
  const { draft, setDraft, draftReady, uploads, previews, uploading, upload, retryUpload, cancelUpload } = useDraft({ botId, userId, identityEpoch, setError });
  const { conversation, disconnected: conversationDisconnected, readFailed: conversationReadFailed, reply, reviewed, setReviewed, scroll, endSpace, content, history, persistPosition } = useConversation(botId, userId, id => {
    gone(id);
    setBotId("");
    void session.refresh();
  }, boot?.bots.find(bot => bot.id === botId)?.sessionId);
  // The chat counts as on screen only when nothing covers it: no panel, and on a phone, not the home list.
  const shownBotId = view === "conversation" && !panel && !(mobile && railOpen) && boot?.bots.some(bot => bot.id === botId) ? botId : undefined;
  useChatPresence(shownBotId, userId);
  useDeviceActivity(userId);
  const readThrough = useReadThrough(userId, shownBotId, shownBotId
    ? latestMessageAt(boot?.bots.find(bot => bot.id === shownBotId), conversation?.botId === shownBotId ? conversation.messages : undefined) : undefined);
  // A failed conversation read refuses anything that needs the connection at once (`connectionLost`),
  // but the chat shows it is disconnected (`connectionShown`) only once the connection is really down.
  const connectionLost = session.disconnected || conversationReadFailed || offline;
  const connectionShown = session.disconnected || conversationDisconnected || offline;
  const { pending, receipt, sending, send, retry, discard } = useSubmission({
    botId, userId, identityEpoch, draft, setDraft, draftReady, reviewed, connectionLost, setError,
  });
  useDraftPersistence({ draft, setDraft, draftReady, botId, userId, identityEpoch, offline, appUnavailable, pending });
  // The anchored send follows the ID Hermes gave its message, once the receipt names one.
  const { sentAs } = history;
  useEffect(() => { if (receipt?.messageId) sentAs(receipt.requestId, receipt.messageId); }, [receipt, sentAs]);
  // A handoff card's Take over, a terminal card's Open terminal and the live row's Watch open the computer from the transcript.
  useEffect(() => {
    const opened = (event: Event) => {
      const detail = (event as CustomEvent<{ take?: boolean; terminal?: { command?: string } }>).detail;
      setPanel({ kind: "computer", ...(detail?.take ? { take: Date.now() } : {}),
        ...(detail?.terminal ? { tab: "terminal" as const, terminal: { at: Date.now(), ...(detail.terminal.command ? { command: detail.terminal.command } : {}) } } : {}) });
    };
    window.addEventListener("wildbots:computer", opened);
    return () => window.removeEventListener("wildbots:computer", opened);
  }, []);
  // A sent message shows in the transcript at once; Send keeps spinning until Hermes answers.
  const { echoes, sends } = useSentEchoes({ pending, receipt, sending, conversation, sender: boot?.user });
  const ownRows = useMemo(() => ownSentRows(sends, conversation), [sends, conversation]);
  const transcript = useMemo(() => withEchoes(conversation, echoes), [conversation, echoes]);
  // At most one message is on its way; accepted ones read as ordinary messages.
  const outgoing = echoes.find(echo => echo.status !== "accepted") ?? null;
  const theme = boot?.preferences.theme || "system";
  useEffect(() => {
    // Until bootstrap answers, the theme public/boot.js applied from this device stays. Signed out, the system's.
    if (!userId && !session.auth) return;
    document.documentElement.dataset.theme = userId ? theme : "system";
    if (userId) rememberTheme(userId, theme);
  }, [theme, userId, session.auth]);
  // The connecting and sign-in screens that follow this account show the theme a signed-out page has.
  useEffect(() => () => { document.documentElement.dataset.theme = "system"; }, []);
  const { update, installEvent, notice, setNotice } = useAppInstall();
  // These keep their state while closed (a running update, a terminal), so once opened they stay mounted.
  const computerLoaded = useOnceActive(panel?.kind === "computer");
  const upgradeLoaded = useOnceActive(panel?.kind === "upgrade");
  // Phone navigation hides one screen behind inert, so move focus to the one shown.
  const shownRail = useRef(railOpen);
  useEffect(() => {
    if (!mobile || shownRail.current === railOpen) return;
    shownRail.current = railOpen;
    (railOpen
      ? document.querySelector<HTMLElement>(".bot-rail [aria-current='page']") ?? document.querySelector<HTMLElement>(".bot-rail .home-account")
      : document.querySelector<HTMLElement>("[aria-label='Back to assistants']"))?.focus();
  }, [railOpen, mobile]);
  const selectBot = useStableCallback((id: string) => {
    persistPosition(true);
    setView("conversation");
    setBotId(id);
    setRailOpen(false);
    setError("");
  });
  // On a phone, choosing an assistant on home pushes its chat in, carrying the avatar to the header.
  const selectFromHome = useStableCallback((id: string) => {
    if (!mobile || !railOpen) return selectBot(id);
    morphNavigate(() => selectBot(id), railAvatar(id), headerAvatar, "forward");
  });
  // Back reverses it, returning the avatar to its place on home.
  const backToHome = useStableCallback(() => {
    if (!mobile || railOpen || view !== "conversation" || !botId) return setRailOpen(true);
    morphNavigate(() => setRailOpen(true), headerAvatar, railAvatar(botId), "back");
  });
  const selectRoom = useStableCallback((id: string) => {
    persistPosition(true);
    setView("group");
    setRoomId(id);
    setRailOpen(false);
    setError("");
  });
  // A sign-out that the server takes starts the app again at sign-in, in every tab.
  const signOut = async () => {
    if (!userId) return;
    try {
      await notifications.disable();
      await signOutOf(userId);
    } catch (e) {
      setNotice((e as Error).message);
    }
  };
  // Home is memoized, so its handlers keep one identity across renders.
  const scrolled = useCallback(() => persistPosition(), [persistPosition]);
  const showView = useStableCallback((next: View) => { setView(next); setRailOpen(false); });
  const openPanel = useStableCallback((next: Panel) => setPanel(next));
  const newBot = useStableCallback(() => setPanel({ kind: "settings", bot: "new" }));
  const newGroup = useStableCallback(() => setCreatingGroup(true));
  const groupCreated = useStableCallback((room: GroupRoom) => {
    setCreatingGroup(false);
    // The new room shows at once; the next read of the catalog replaces this copy.
    groupLoad.setData(current => current && { ...current, catalog: { ...current.catalog, rooms: [...current.catalog.rooms.filter(item => item.room_id !== room.room_id), room] } });
    selectRoom(room.room_id);
    reloadGroups();
  });
  const openPreferences = useStableCallback(() => setPanel({ kind: "preferences" }));
  const openUsage = useStableCallback(() => setPanel({ kind: "usage" }));
  // Sign out keeps its confirmation in Settings, so the profile menu opens Settings at that step.
  const confirmSignOut = useStableCallback(() => setPanel({ kind: "preferences", destination: { kind: "signout" } }));
  // Home menu changes can be taken back for a few seconds, by the toast's Undo or Cmd+Z. The
  // toast belongs to whoever made the change; useToast drops it for anyone else.
  const undoable = (change: UndoableEdit) => {
    void session.editPreferences(change.apply);
    toast.show(change.message, () => void session.editPreferences(change.undo));
  };
  const togglePin = useStableCallback((bot: Bot) => { if (boot) undoable(togglePinEdit(boot.preferences, bot.id, bot.name)); });
  const botSettings = useStableCallback((bot: Bot) => setPanel({ kind: "settings", bot }));
  // --- Main assistant ---
  const [choosingMain, setChoosingMain] = useState(false);
  // A refusal that comes after the server saved the change still shows what it saved.
  const setMain = useStableCallback((id: string | null) => chooseMain(id, session.applyPreferences));
  const setCheckIns = useStableCallback((change: Parameters<typeof saveCheckIns>[1]) =>
    saveCheckIns(boot?.preferences.checkIns, change, session.applyPreferences));
  const chooseMainFromHome = useStableCallback(() => setChoosingMain(true));
  const dismissMainSuggestion = useStableCallback(() => void session.editPreferences(value => ({ ...value, mainSuggestionDismissed: true })));
  // "Ask Sage…" from the palette opens the main assistant's chat with the question in its draft, once that draft has loaded.
  const asking = useRef<{ botId: string; text: string } | null>(null);
  const askMain = useStableCallback((id: string, text: string) => { asking.current = { botId: id, text }; setPanel(null); selectBot(id); });
  useEffect(() => {
    const ask = asking.current;
    if (!ask || ask.botId !== botId || !draftReady) return;
    asking.current = null;
    setDraft(previous => ({ ...previous, dirty: true, text: previous.text.trim() ? `${previous.text.trimEnd()}\n\n${ask.text}` : ask.text }));
  }, [botId, draftReady, setDraft]);
  // A handoff in a transcript opens the other assistant's chat.
  useEffect(() => {
    const opened = (event: Event) => { const id = (event as CustomEvent<{ botId?: string }>).detail?.botId; if (id) { setPanel(null); selectBot(id); } };
    window.addEventListener(OPEN_CHAT_EVENT, opened);
    return () => window.removeEventListener(OPEN_CHAT_EVENT, opened);
  }, [selectBot]);
  // --- End main assistant ---
  const moveToSection = useStableCallback((bot: Bot, sectionId: string | null) => {
    if (boot) undoable(moveSectionEdit(boot.preferences, bot.id, bot.name, sectionId));
  });
  const newSection = useStableCallback((bot: Bot) => setPanel({ kind: "details", botId: bot.id, newSection: true }));
  const openRoutineRun = useStableCallback((routineId: string, resultId: string) => setPanel({ kind: "routine", botId, routineId, resultId }));
  // Hiding a routine's runs from the chat can be taken back from the toast, or in its routine settings.
  const hideRoutineRuns = useStableCallback((routineId: string, name: string) => undoable({
    apply: value => withRunsShown(value, botId, routineId, false), undo: value => withRunsShown(value, botId, routineId, true),
    message: `Hid ${name} runs from this chat`,
  }));
  // Home is memoized, so its group props keep one identity until something they show changes.
  const homeGroups = useMemo<HomeGroups>(() => {
    // Making a group needs Hermes to host them and two assistants to put in one.
    const choosable = boot?.bots.filter(bot => !["all", "everyone"].includes(bot.id.toLowerCase())).length ?? 0;
    return {
      rooms, roomId, pending: pendingCreate, onSelect: selectRoom, onCreate: newGroup, saved: roomsSaved,
      canCreate: !!pendingCreate || catalog?.supported === true && choosable >= 2,
      hint: pendingCreate ? undefined : !catalog?.canSend ? catalog?.reason ?? "The Hermes group coordinator must be running to make a group chat."
        : boot && !boot.connection.connected ? "Reconnect to Hermes to make a group chat." : undefined,
    };
  }, [rooms, roomId, pendingCreate, selectRoom, newGroup, catalog, boot, roomsSaved]);
  const [overlay, setOverlay] = useState<"palette" | "shortcuts" | "stop" | null>(null);
  const closeOverlay = useCallback(() => setOverlay(null), []);
  // Search from the palette opens Search & saved with the words already searched.
  const [findQuery, setFindQuery] = useState<{ text: string; id: number }>();
  const searchMessages = useStableCallback((text: string) => { setFindQuery(previous => ({ text, id: (previous?.id ?? 0) + 1 })); showView("find"); });
  const setTheme = useStableCallback((theme: Preferences["theme"]) => void session.editPreferences(preferences => ({ ...preferences, theme })));
  const showShortcuts = useStableCallback(() => setOverlay("shortcuts"));
  // Find in chat belongs to the transcript, which listens for this once the chat is on screen.
  const findInChat = useStableCallback((id: string) => {
    closePanels("details");
    if (id !== botId || view !== "conversation") selectBot(id);
    requestAnimationFrame(() => window.dispatchEvent(new CustomEvent("wildbots:find", { detail: { botId: id } })));
  });
  // A search hit in the live conversation opens the chat at that message, which the transcript loads.
  const openMessage = useStableCallback((id: string, messageId: string) => {
    history.openAt(id, messageId);
    selectBot(id);
  });
  const goTo = (destination: Destination) => {
    if ("view" in destination) return showView(destination.view);
    if (destination.messageId) return openMessage(destination.botId, destination.messageId);
    selectBot(destination.botId);
    if (destination.routineId) setPanel({ kind: "routine", botId: destination.botId, routineId: destination.routineId });
  };
  // The open sheet's own close, when it is one that can hold unsaved work. See close-request.ts.
  const panelClose = useRef<SheetClose | null>(null);
  // Where a tapped notification goes once that sheet has closed, for the account it came to.
  const [leaving] = useState(waitingOnClose<Destination>);
  /** A sheet with its own close closed; a notification waiting on that sheet opens now. */
  const sheetClosed = (kind: Panel["kind"]) => {
    const next = leaving.take(panelClose.current?.sheet, userId);
    closePanels(kind);
    if (next) goTo(next);
  };
  // A notification tapped while this window is open switches it in place, as a click here would.
  // The palette, shortcuts and the stop question hold nothing to lose. Assistant settings and
  // Settings close the way their close buttons do, so an edited form asks first, and the chat opens
  // only once the sheet has closed: not at all if the person keeps editing.
  const openFromWorker = useStableCallback((destination: Destination) => {
    setOverlay(null);
    const offered = panelClose.current;
    if (!offered) {
      setPanel(null);
      return goTo(destination);
    }
    offered.close(leaving.wait(destination, offered.sheet, userId));
  });
  useWorkerOpens(openFromWorker);
  const { stopping, stop } = useStopResponse(botId, setError);
  // The composer is memoized, so these keep one identity while a reply streams.
  const sendMessage = useStableCallback(() => send(request => history.anchorSend(request.requestId)));
  const refreshSession = useStableCallback(() => void session.refresh());
  const reconnect = useStableCallback(() => void session.reconnect());
  const uploadFiles = useStableCallback(upload);
  const retryUploadFile = useStableCallback(retryUpload);
  const cancelUploadFile = useStableCallback(cancelUpload);
  const retrySend = useStableCallback(retry);
  const discardSend = useStableCallback(discard);
  // The transcript is memoized too, so a keystroke in the composer does not re-render it through this.
  const addToDraft = useStableCallback((text: string, files: FileRef[] = []) => {
    // Drafts are known by their text, so one on its way must not change.
    if (sendingDraft(draft, pending, sending)) return false;
    // Files join those already there, as many as a message can carry.
    const missing = files.filter(file => !draft.attachments.some(kept => kept.id === file.id));
    const added = missing.slice(0, Math.max(0, MAX_ATTACHMENTS - draft.attachments.length - uploads.length));
    setDraft(previous => ({ ...previous, dirty: true, text: previous.text.trim() ? `${previous.text.trimEnd()}\n\n${text}` : text,
      attachments: [...previous.attachments, ...added.filter(file => !previous.attachments.some(kept => kept.id === file.id))] }));
    return missing.length - added.length;
  });
  const ownConversation = conversation?.botId === botId ? conversation : null;
  const prompts = useOwnPrompts(ownConversation?.messages, userId);
  const decisions = (ownConversation?.attention?.length ?? 0) + (ownConversation?.approvals.filter(approval => approval.status === "pending").length ?? 0);
  const checkingConnection = session.checkingConnection;
  // Live updates stopped for long enough to matter: the household stream or this chat's has been down for
  // STREAM_NOTICE_MS without a break. The polls stand in meanwhile, so the notice is a quiet one.
  const liveDown = useStreamsDown(useMemo(() => ["household", ...botId ? [chatStream(botId)] : []], [botId]), STREAM_NOTICE_MS);
  // Notices from the rest of the app, rebuilt only when one of them changes.
  const dock = useMemo(() => {
    const items: DockItem[] = [];
    if (!boot) return items;
    // One notice either way: a lost connection says so, and otherwise a stopped stream says updates are late.
    if (connectionShown || liveDown) items.push({ id: "connection", kind: "connection", node: <ConnectionPanel compact connection={boot.connection} offline={offline}
      appUnavailable={appUnavailable} liveOnly={!connectionShown} busy={checkingConnection} retry={reconnect} /> });
    if (decisions) items.push({ id: "decisions", kind: "decisions", node: <DecisionsNotice disconnected={connectionShown} count={decisions} onReview={() => reviewFirstDecision()} /> });
    if (mobile && update) items.push({ id: "update", kind: "update", node: <UpdateNotice update={update} /> });
    return items;
  }, [boot, connectionShown, liveDown, offline, appUnavailable, checkingConnection, reconnect, decisions, mobile, update]);
  // Today, Find, a group chat and a chat with no assistant have no composer, so the same connection item
  // shows at the top of the view instead. A chat with no assistant shows its own full panel once the
  // connection is lost, so there it adds only the live-updates notice.
  const inChat = view !== "find" && view !== "group" && view !== "today";
  const liveBot = boot?.bots.find(bot => bot.id === botId);
  const viewDock = useMemo(() => inChat && liveBot ? [] : dock.filter(item => item.kind === "connection" && !(inChat && connectionShown)),
    [inChat, liveBot, dock, connectionShown]);
  const liveState = conversation?.botId === botId ? conversation.activity.state : liveBot?.activity;
  const canStop = !!liveBot && view === "conversation" && !connectionLost && !!boot?.capabilities.stop.supported
    && ["thinking", "working", "waiting", "blocked"].includes(liveState ?? "idle");
  useShortcuts({
    palette: () => { if (!boot) return false; setOverlay(current => current === "palette" ? null : "palette"); },
    pinned: ({ digit }) => {
      const bot = boot && paletteBots(boot).filter(item => boot.preferences.favorites.includes(item.id))[digit! - 1];
      if (!bot) return false;
      setOverlay(null); setPanel(null); selectBot(bot.id);
    },
    stop: () => { if (!canStop) return false; setOverlay("stop"); },
    help: () => { if (!boot) return false; setOverlay("shortcuts"); },
    undo: () => toast.undo(),
  });
  useAppBadge(boot ? badgeCount(boot.bots, shownBotId, readThrough) : 0, boot?.user.id);
  // Home as it stands, for the next visit to draw at once. A bootstrap that missed Hermes lists no live roster.
  const connected = !!boot?.connection.connected;
  useEffect(() => {
    if (boot && connected) rememberRoster(boot, catalog ? rooms : null);
  }, [boot, connected, catalog, rooms]);
  // Read for the account the sign-in hint names (see readSavedRoster), once per account generation:
  // every change of account, in this tab or another, mounts a new one (see App).
  const early = !boot && saved ? saved : null;
  const earlyHome = useMemo(() => early && savedHome(early), [early]);
  const chooseEarly = useStableCallback((id: string) => {
    chosenEarly.current = true;
    // The chat starts reading now, as a linked chat does, and opens once bootstrap names this account.
    prefetchLinkedChat(id);
    selectFromHome(id);
  });
  const showEarly = useStableCallback((next: View) => { chosenEarly.current = true; showView(next); });
  const pickRoomEarly = useStableCallback((id: string) => { chosenEarly.current = true; selectRoom(id); });
  const earlyGroups = useMemo(() => ({ ...homeGroups, onSelect: pickRoomEarly }), [homeGroups, pickRoomEarly]);
  // An offline sign-out that storage would not keep leaves the person signed in here, and says so.
  const [signOutUnkept, setSignOutUnkept] = useState(false);
  const signOutEarly = useStableCallback(() => {
    if (!earlyHome) return;
    setSignOutUnkept(false);
    // A tab that has not yet seen another tab's change is refused; that change draws this tab again.
    void signOutHere(earlyHome.user.id).then(done => { if (!done) setSignOutUnkept(true); }, () => {});
  });
  if (session.auth) return <SignIn />;
  // The same tree as the full app below, so bootstrap's answer redraws home in place: rows, scroll and focus stay.
  if (!boot && earlyHome)
    return (
      <div className="app-shell">
        {/* The app's one connection live region, in the same place as below, so the swap keeps the tree. */}
        <ConnectionAnnouncer shown={appUnavailable || offline} connection={{ connected: false }} offline={offline} appUnavailable={appUnavailable} />
        <Sidebar boot={earlyHome} saved botId={botId} readThrough={readThrough} groups={earlyGroups} view={view} state="idle"
          connectionLost={appUnavailable || offline} offline={offline} mobile={mobile} open={railOpen} update={null}
          onSelectBot={chooseEarly} onView={showEarly} onNewBot={newBot} onSettings={openPreferences} onUsage={openUsage} onSignOut={confirmSignOut} onPin={togglePin}
          onBotSettings={botSettings} onMoveToSection={moveToSection} onNewSection={newSection}
          onChooseMain={chooseMainFromHome} onDismissMainSuggestion={dismissMainSuggestion} />
        <main className="conversation-panel saved-home-wait" inert={mobile && railOpen}>
          <p>{appUnavailable ? "Can't reach the app right now. We'll keep trying." : "Connecting to your household…"}</p>
          {appUnavailable && <button onClick={refreshSession}>Try again</button>}
          {/* Account is disabled until the app answers, so this is the way out for someone else at this browser. */}
          {appUnavailable && <button onClick={signOutEarly}>Sign out of this device</button>}
          {signOutUnkept && <p role="alert">Couldn't sign out of this device. This browser didn't save the change, so you're still signed in here.</p>}
        </main>
      </div>
    );
  if (!boot) return <Connecting unavailable={appUnavailable} retry={refreshSession} />;
  const selected = boot.bots.find((bot) => bot.id === botId);
  const reported: ActivityState = connectionShown
    ? "disconnected"
    : conversation?.activity.state || selected?.activity || "idle";
  // A message that starts a turn shows the assistant thinking from the moment it is sent; Hermes's
  // report takes over the same row. Stop and the message box follow only what Hermes reports. The row's bounds
  // are read from the clock here, so a render never paints a bound that passed while another chat was open.
  const state: ActivityState = !connectionShown && conversation?.botId === botId && awaitingTurn(echoes, conversation, Date.now()) ? "thinking" : reported;
  const active = ["thinking", "working", "waiting", "blocked"].includes(reported);
  const showActivity = state !== "idle" && state !== "done";
  const avatarState = state === "done" ? "idle" : state;
  const open = openPanel;
  const detailsBot = panel?.kind === "details" ? boot.bots.find(bot => bot.id === panel.botId) : undefined;

  return (
    <div className="app-shell">
      <ConnectionAnnouncer shown={connectionShown || liveDown} connection={boot.connection} offline={offline} appUnavailable={appUnavailable} liveOnly={!connectionShown} />
      <Sidebar boot={boot} botId={botId} shownBotId={shownBotId} readThrough={readThrough} groups={homeGroups} view={view} state={state}
        connectionLost={connectionShown} offline={offline} mobile={mobile} open={railOpen} update={update}
        onSelectBot={selectFromHome} onView={showView} onNewBot={newBot} onSettings={openPreferences} onUsage={openUsage} onSignOut={confirmSignOut} onPin={togglePin}
        onBotSettings={botSettings} onMoveToSection={moveToSection} onNewSection={newSection}
        onChooseMain={chooseMainFromHome} onDismissMainSuggestion={dismissMainSuggestion} />
      <main className="conversation-panel" inert={mobile && railOpen} {...(view === "conversation" ? tintProps(selected) : {})}>
        <ChatHeader offline={offline} view={view} boot={boot} selected={selected} room={rooms.find(room => room.room_id === roomId)} modelLocked={connectionLost || sending} onModelSaved={refreshSession} avatarState={avatarState} railOpen={railOpen}
          onOpenRail={backToHome}
          onDetails={bot => open({ kind: "details", botId: bot.id })} />
        {viewDock.length > 0 && <div className="view-dock"><StatusDock items={viewDock} /></div>}
        {/* On a computer the rail is always beside this, so its notice is enough. In a chat it joins the composer's dock. */}
        {mobile && !(view === "conversation" && selected) && <UpdateNotice update={update} />}
        {view === "find" ? <Loading key="find"><DiscoveryPanel key={boot.user.id} bootstrap={boot} search={findQuery} onOpenMessage={openMessage} onRoutine={(id,routineId,resultId)=>setPanel({kind:"routine",botId:id,routineId,resultId})} /></Loading> : view === "group" ? <Loading key="group"><GroupRoomView key={`${boot.user.id}:${roomId}`} bootstrap={boot} roomId={roomId} canSend={catalog?.canSend ?? false} reason={catalog?.reason} onChanged={reloadGroups} /></Loading> : view === "today" ? <TodayPanel key={boot.user.id} bootstrap={boot} onOpen={(id, routineId) => { selectBot(id); if (routineId) setPanel({ kind: "routine", botId: id, routineId }); }} /> : <>
          <Conversation boot={boot} selected={selected} botId={botId} conversation={transcript} canonical={conversation} ownRows={ownRows} echo={outgoing} state={state}
            showActivity={showActivity} avatarState={avatarState} connectionLost={connectionLost} connectionShown={connectionShown}
            offline={offline} appUnavailable={appUnavailable} checkingConnection={session.checkingConnection}
            reconnect={session.reconnect} error={error} setError={setError}
            notifications={notifications} scroll={scroll} endSpace={endSpace} content={content} history={history} reply={reply} onScroll={scrolled}
            onRoutineResults={openRoutineRun} onHideRoutineRuns={hideRoutineRuns} computerOpen={panel?.kind === "computer"} reviewed={reviewed}
            onDraft={addToDraft} onCreate={newBot} />
          {selected && <Composer key={`${boot.user.id}:${botId}`} boot={boot} selected={selected} botId={botId} prompts={prompts}
            state={reported}
            active={active} connectionLost={connectionLost} connectionShown={connectionShown} draft={draft} setDraft={setDraft}
            draftReady={draftReady} uploads={uploads} previews={previews} uploading={uploading} upload={uploadFiles}
            retryUpload={retryUploadFile} cancelUpload={cancelUploadFile} pending={pending} receipt={receipt}
            sending={sending} retry={retrySend} discard={discardSend} waiting={waitingPlaceholder(ownConversation, boot.user.id)}
            send={sendMessage} reviewed={reviewed} setReviewed={setReviewed}
            stopping={stopping} onStop={stop} dock={dock} />}
        </>}
      </main>
      {creatingGroup && <Loading><GroupCreate bootstrap={boot} canSend={catalog?.canSend ?? false} onClose={() => setCreatingGroup(false)} onCreated={groupCreated} /></Loading>}
      {panel?.kind === "settings" && (
        <Loading>
          <BotSettings
            bot={panel.bot}
            bootstrap={boot}
            onClose={() => sheetClosed("settings")} closer={panelClose}
            onDeleted={id => { deleted.current = id; }}
            onOpenRoutine={(botId, routineId) => { selectBot(botId); setPanel({ kind: "routine", botId, routineId }); }}
            editPreferences={session.editPreferences}
            onSaved={() => void session.refresh()}
            onCreated={id => void session.refresh().then(next => { if (next?.bots.some(bot => bot.id === id)) selectBot(id); })}
          />
        </Loading>
      )}
      {panel?.kind === "details" && detailsBot && (
        <Loading>
          <BotDetails key={`${boot.user.id}:${detailsBot.id}`} boot={boot} bot={detailsBot}
            avatarState={detailsBot.id === botId ? avatarState : connectionShown ? "disconnected" : detailsBot.activity}
            conversation={conversation} connectionLost={connectionLost} startNewSection={panel.newSection}
            editPreferences={session.editPreferences} onFind={findInChat} onMain={setMain} onCheckIns={setCheckIns}
            onSettings={bot => open({ kind: "settings", bot })} onClose={() => closePanels("details")} />
        </Loading>
      )}
      {panel?.kind === "routine" && <Loading><RoutineResults key={`${boot.user.id}:${panel.botId}:${panel.routineId}`} botId={panel.botId} routineId={panel.routineId} resultId={panel.resultId} onClose={() => closePanels("routine")} /></Loading>}
      {panel?.kind === "usage" && <Loading><UsagePanel key={`usage:${boot.user.id}`} bots={boot.bots} onClose={() => closePanels("usage")} /></Loading>}
      {panel?.kind === "integrations" && <Loading><IntegrationsPanel key={`integrations:${boot.user.id}`} bots={boot.bots} accountScope={boot.user.id} onClose={() => closePanels("integrations")} /></Loading>}
      {computerLoaded && <Loading><ComputerPanel key={`computer:${boot.user.id}`} initialTab={panel?.kind === "computer" ? panel.tab : undefined} open={panel?.kind === "computer"}
        take={panel?.kind === "computer" ? panel.take : undefined} terminal={panel?.kind === "computer" ? panel.terminal : undefined} onClose={() => closePanels("computer")} /></Loading>}
      {upgradeLoaded && <Loading><HermesUpgradePanel key={`upgrades:${boot.user.id}`} open={panel?.kind === "upgrade"} onClose={() => closePanels("upgrade")}
        bots={boot.bots} currentVersion={boot.connection.version} currentRevisionDate={boot.connection.revisionDate} /></Loading>}
      {panel?.kind === "preferences" && (
        <Loading>
          <PreferencesDialog destination={panel.destination} boot={boot} connectionLost={connectionShown} offline={offline} editPreferences={session.editPreferences}
            notifications={notifications} installEvent={installEvent} notice={notice}
            onClose={() => sheetClosed("preferences")} closer={panelClose} onSignOut={signOut}
            onComputer={() => open({ kind: "computer" })} onIntegrations={() => open({ kind: "integrations" })}
            onUpgrade={() => open({ kind: "upgrade" })} onShortcuts={showShortcuts} />
        </Loading>
      )}
      {overlay === "palette" && <CommandPalette boot={boot} botId={botId} rooms={rooms} onSelectRoom={id => { setPanel(null); selectRoom(id); }} onNewGroup={homeGroups.canCreate ? () => { setPanel(null); newGroup(); } : undefined} shownBotId={shownBotId} readThrough={readThrough}
        connectionLost={connectionShown} onClose={closeOverlay} onSelectBot={id => { setPanel(null); selectBot(id); }}
        onView={next => { setPanel(null); showView(next); }} onSearch={text => { setPanel(null); searchMessages(text); }}
        onSettings={destination => setPanel({ kind: "preferences", destination })} onUsage={openUsage} onNewBot={newBot} onTheme={setTheme} onShortcuts={showShortcuts}
        onFind={selected && view === "conversation" ? () => findInChat(selected.id) : undefined} onAsk={askMain} />}
      {choosingMain && <MainAssistantPicker boot={boot} onChoose={setMain} onMakePersonal={bot => setPanel({ kind: "settings", bot })} onClose={() => setChoosingMain(false)} />}
      {overlay === "shortcuts" && <ShortcutsDialog onClose={closeOverlay} />}
      {overlay === "stop" && liveBot && <StopConfirm name={liveBot.name} onStop={stop} onClose={closeOverlay} />}
      <Toast toast={toast.toast} onDismiss={toast.dismiss} onUndo={toast.undo} />
    </div>
  );
}
