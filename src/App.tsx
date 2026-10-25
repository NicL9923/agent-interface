import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ActivityState, Bot, Preferences } from "./shared/types";
import { MAX_ATTACHMENTS } from "./shared/uploads";
import { write } from "./client-api";
import { AvatarTrio, SignIn } from "./components/SignIn";
import { useDeviceNotifications } from "./components/use-device-notifications";
import { TodayPanel } from "./components/TodayPanel";
import "./components/discovery.css";
import { hasDestination, initialPanel, initialView, startsOnToday, useUrlSync } from "./app/view";
import type { Panel, View } from "./app/view";
import { useSession } from "./app/use-session";
import { useDraft, useDraftPersistence } from "./app/use-draft";
import { useConversation } from "./app/use-conversation";
import { useChatPresence } from "./app/use-chat-presence";
import { useSubmission } from "./app/use-submission";
import { sendingDraft, useSentEchoes, withEchoes } from "./app/sent-echo";
import { moveSectionEdit, togglePinEdit, type UndoableEdit } from "./app/home-undo";
import { useAppInstall, useMobile } from "./app/use-browser";
import { latestMessageAt, useReadThrough } from "./app/unread";
import { useStableCallback } from "./app/use-stable-callback";
import { UpdateNotice } from "./app/UpdateNotice";
import { Sidebar } from "./app/Sidebar";
import { ChatHeader } from "./app/ChatHeader";
import { Conversation } from "./app/Conversation";
import { Composer, useStopResponse } from "./app/Composer";
import { CommandPalette, paletteBots } from "./app/CommandPalette";
import { ShortcutsDialog } from "./app/ShortcutsDialog";
import { StopConfirm } from "./app/StopConfirm";
import { Toast, useToast } from "./app/Toast";
import { useShortcuts } from "./app/shortcuts";
import { badgeCount, useAppBadge } from "./app/badge";
import { ConnectionPanel } from "./components/ConnectionPanel";
import { DecisionsNotice, reviewFirstDecision, type DockItem } from "./app/StatusDock";
import { BotDetails, BotSettings, ComputerPanel, DiscoveryPanel, GroupChats, HermesUpgradePanel, IntegrationsPanel, Loading, PreferencesDialog, RoutineResults, useOnceActive } from "./app/panels";
export function App() {
  const [view, setView] = useState<View>(initialView);
  const [panel, setPanel] = useState<Panel | null>(initialPanel);
  const closePanels = (...kinds: Panel["kind"][]) =>
    setPanel(current => current && kinds.includes(current.kind) ? null : current);
  const [error, setError] = useState("");
  // Phones open on the home list unless a link names a destination.
  const [railOpen, setRailOpen] = useState(() => matchMedia("(max-width: 620px)").matches && !hasDestination());
  const mobile = useMobile();
  // An assistant this person just deleted leaves quietly; any other one explains itself.
  const deleted = useRef("");
  const gone = (id: string) => {
    setPanel(current => (current?.kind === "routine" || current?.kind === "details") && current.botId === id || current?.kind === "settings" && current.bot !== "new" && current.bot.id === id ? null : current);
    if (deleted.current === id) return;
    setError("That assistant is no longer available to you.");
    setRailOpen(mobile);
  };
  const session = useSession({
    onIdentityChange: () => {
      reset(); clearUploads(); toast.dismiss();
      closePanels("settings", "details", "preferences", "upgrade", "integrations", "computer"); setError("");
    },
    onFirstBootstrap: next => { if (startsOnToday(next.preferences)) setView("today"); },
    onError: setError,
    onBotGone: gone,
  });
  const { boot, botId, setBotId, identityEpoch, offline, appUnavailable } = session;
  const userId = boot?.user.id;
  const toast = useToast(session.auth ? undefined : userId);
  useUrlSync(view, panel, botId, userId);
  const notifications = useDeviceNotifications(userId, boot?.vapidPublicKey);
  const { draft, setDraft, draftReady, uploads, previews, uploading, upload, retryUpload, cancelUpload, clearUploads } = useDraft({ botId, userId, identityEpoch, setError });
  const { conversation, setConversation, disconnected: conversationDisconnected, reply, reviewed, setReviewed, scroll, endSpace, content, history, persistPosition } = useConversation(botId, userId, id => {
    gone(id);
    setBotId("");
    void session.refresh();
  });
  // The chat counts as on screen only when nothing covers it: no panel, and on a phone, not the home list.
  const shownBotId = view === "conversation" && !panel && !(mobile && railOpen) && boot?.bots.some(bot => bot.id === botId) ? botId : undefined;
  useChatPresence(shownBotId, userId);
  const readThrough = useReadThrough(userId, shownBotId, shownBotId
    ? latestMessageAt(boot?.bots.find(bot => bot.id === shownBotId), conversation?.botId === shownBotId ? conversation.messages : undefined) : undefined);
  const connectionLost = session.disconnected || conversationDisconnected || offline;
  const { pending, receipt, sending, send, retry, discard, reset } = useSubmission({
    botId, userId, identityEpoch, draft, setDraft, draftReady, reviewed, connectionLost, setError,
  });
  useDraftPersistence({ draft, setDraft, draftReady, botId, userId, identityEpoch, offline, appUnavailable, pending });
  // The anchored send follows the ID Hermes gave its message, once the receipt names one.
  const { sentAs } = history;
  useEffect(() => { if (receipt?.messageId) sentAs(receipt.requestId, receipt.messageId); }, [receipt, sentAs]);
  // A sent message shows in the transcript at once; Send keeps spinning until Hermes answers.
  const echoes = useSentEchoes({ pending, receipt, sending, conversation, sender: boot?.user });
  const transcript = useMemo(() => withEchoes(conversation, echoes), [conversation, echoes]);
  // At most one message is on its way; accepted ones read as ordinary messages.
  const outgoing = echoes.find(echo => echo.status !== "accepted") ?? null;
  useEffect(() => {
    const theme = boot?.preferences.theme || "system";
    document.documentElement.dataset.theme = theme;
  }, [boot?.preferences.theme]);
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
  const signOut = async () => {
    try {
      await notifications.disable();
      await write("/auth/logout", {});
      session.signedOut();
      setConversation(null);
      setDraft({ text: "", attachments: [] });
      // The signed-out account's in-flight work can never clear these once the identity changes.
      reset(); clearUploads(); toast.dismiss();
      setRailOpen(mobile);
      closePanels("settings", "details", "preferences", "upgrade", "integrations");
    } catch (e) {
      setNotice((e as Error).message);
    }
  };
  // Home is memoized, so its handlers keep one identity across renders.
  const scrolled = useCallback(() => persistPosition(), [persistPosition]);
  const showView = useStableCallback((next: View) => { setView(next); setRailOpen(false); });
  const openPanel = useStableCallback((next: Panel) => setPanel(next));
  const newBot = useStableCallback(() => setPanel({ kind: "settings", bot: "new" }));
  const openPreferences = useStableCallback(() => setPanel({ kind: "preferences" }));
  // Home menu changes can be taken back for a few seconds, by the toast's Undo or Cmd+Z. The
  // toast belongs to whoever made the change; useToast drops it for anyone else.
  const undoable = (change: UndoableEdit) => {
    void session.editPreferences(change.apply);
    toast.show(change.message, () => void session.editPreferences(change.undo));
  };
  const togglePin = useStableCallback((bot: Bot) => { if (boot) undoable(togglePinEdit(boot.preferences, bot.id, bot.name)); });
  const botSettings = useStableCallback((bot: Bot) => setPanel({ kind: "settings", bot }));
  const moveToSection = useStableCallback((bot: Bot, sectionId: string | null) => {
    if (boot) undoable(moveSectionEdit(boot.preferences, bot.id, bot.name, sectionId));
  });
  const newSection = useStableCallback((bot: Bot) => setPanel({ kind: "details", botId: bot.id, newSection: true }));
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
  const { stopping, stop } = useStopResponse(botId, setError);
  const liveBot = boot?.bots.find(bot => bot.id === botId);
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
  useAppBadge(boot ? badgeCount(boot.bots, shownBotId, readThrough) : 0);
  if (session.auth) return <SignIn onSuccess={session.signedIn} />;
  if (!boot)
    return (
      <main className="welcome">
        <p className="eyebrow">WildBots</p>
        <AvatarTrio />
        <h1>
          Your assistants,
          <br />
          in one familiar place.
        </h1>
        <p role="status">{appUnavailable ? "Can't reach the app right now. We'll keep trying." : "Connecting to your household…"}</p>
        {appUnavailable && <button onClick={() => void session.refresh()}>Try again</button>}
      </main>
    );
  const selected = boot.bots.find((bot) => bot.id === botId);
  const state: ActivityState = connectionLost
    ? "disconnected"
    : conversation?.activity.state || selected?.activity || "idle";
  const active = ["thinking", "working", "waiting", "blocked"].includes(state);
  const showActivity = state !== "idle" && state !== "done";
  const avatarState = state === "done" ? "idle" : state;
  const open = openPanel;
  const detailsBot = panel?.kind === "details" ? boot.bots.find(bot => bot.id === panel.botId) : undefined;
  const ownConversation = conversation?.botId === botId ? conversation : null;
  const decisions = (ownConversation?.attention?.length ?? 0) + (ownConversation?.approvals.filter(approval => approval.status === "pending").length ?? 0);
  const dock: DockItem[] = [];
  if (connectionLost) dock.push({ id: "connection", kind: "connection", node: <ConnectionPanel compact connection={boot.connection} offline={offline}
    appUnavailable={session.appUnavailable} busy={session.checkingConnection} retry={() => void session.reconnect()} /> });
  if (decisions) dock.push({ id: "decisions", kind: "decisions", node: <DecisionsNotice count={decisions} onReview={() => reviewFirstDecision()} /> });
  if (mobile && update) dock.push({ id: "update", kind: "update", node: <UpdateNotice update={update} /> });

  return (
    <div className="app-shell">
      <Sidebar boot={boot} botId={botId} shownBotId={shownBotId} readThrough={readThrough} view={view} state={state}
        connectionLost={connectionLost} offline={offline} mobile={mobile} open={railOpen} update={update}
        onSelectBot={selectBot} onView={showView} onNewBot={newBot} onSettings={openPreferences} onPin={togglePin}
        onBotSettings={botSettings} onMoveToSection={moveToSection} onNewSection={newSection} />
      <main className="conversation-panel" inert={mobile && railOpen}>
        <ChatHeader view={view} selected={selected} avatarState={avatarState} railOpen={railOpen}
          onOpenRail={() => setRailOpen(true)}
          onDetails={bot => open({ kind: "details", botId: bot.id })} />
        {/* On a computer the rail is always beside this, so its notice is enough. In a chat it joins the composer's dock. */}
        {mobile && !(view === "conversation" && selected) && <UpdateNotice update={update} />}
        {view === "find" ? <Loading key="find"><DiscoveryPanel key={boot.user.id} bootstrap={boot} search={findQuery} onOpenMessage={openMessage} onRoutine={(id,routineId,resultId)=>setPanel({kind:"routine",botId:id,routineId,resultId})} /></Loading> : view === "groups" ? <Loading key="groups"><GroupChats key={boot.user.id} bootstrap={boot} /></Loading> : view === "today" ? <TodayPanel key={boot.user.id} bootstrap={boot} onOpen={(id, routineId) => { selectBot(id); if (routineId) setPanel({ kind: "routine", botId: id, routineId }); }} /> : <>
          <Conversation boot={boot} selected={selected} botId={botId} conversation={transcript} canonical={conversation} echo={outgoing} state={state}
            showActivity={showActivity} avatarState={avatarState} connectionLost={connectionLost}
            offline={offline} appUnavailable={appUnavailable} checkingConnection={session.checkingConnection}
            reconnect={session.reconnect} error={error} setError={setError}
            notifications={notifications} scroll={scroll} endSpace={endSpace} content={content} history={history} reply={reply} onScroll={scrolled}
            onDraft={(text, files = []) => {
              // Drafts are known by their text, so one on its way must not change.
              if (sendingDraft(draft, pending, sending)) return false;
              // Files join those already there, as many as a message can carry.
              const missing = files.filter(file => !draft.attachments.some(kept => kept.id === file.id));
              const added = missing.slice(0, Math.max(0, MAX_ATTACHMENTS - draft.attachments.length - uploads.length));
              setDraft(previous => ({ ...previous, dirty: true, text: previous.text.trim() ? `${previous.text.trimEnd()}\n\n${text}` : text,
                attachments: [...previous.attachments, ...added.filter(file => !previous.attachments.some(kept => kept.id === file.id))] }));
              return missing.length - added.length;
            }}
            onCreate={() => setPanel({ kind: "settings", bot: "new" })} />
          {selected && <Composer key={`${boot.user.id}:${botId}`} boot={boot} selected={selected} botId={botId} conversation={conversation} state={state}
            active={active} connectionLost={connectionLost} draft={draft} setDraft={setDraft}
            draftReady={draftReady} uploads={uploads} previews={previews} uploading={uploading} upload={upload}
            retryUpload={retryUpload} cancelUpload={cancelUpload} pending={pending} receipt={receipt}
            sending={sending} retry={retry} discard={discard}
            send={() => send(request => history.anchorSend(request.requestId))} reviewed={reviewed} setReviewed={setReviewed}
            stopping={stopping} onStop={stop} dock={dock}
            refresh={() => void session.refresh()} />}
        </>}
      </main>
      {panel?.kind === "settings" && (
        <Loading>
          <BotSettings
            bot={panel.bot}
            bootstrap={boot}
            onClose={() => closePanels("settings")}
            onDeleted={id => { deleted.current = id; }}
            onOpenRoutine={(botId, routineId) => { selectBot(botId); setPanel({ kind: "routine", botId, routineId }); }}
            onSaved={() => void session.refresh()}
          />
        </Loading>
      )}
      {panel?.kind === "details" && detailsBot && (
        <Loading>
          <BotDetails key={`${boot.user.id}:${detailsBot.id}`} boot={boot} bot={detailsBot}
            avatarState={detailsBot.id === botId ? avatarState : connectionLost ? "disconnected" : detailsBot.activity}
            conversation={conversation} connectionLost={connectionLost} startNewSection={panel.newSection}
            editPreferences={session.editPreferences} onFind={findInChat}
            onSettings={bot => open({ kind: "settings", bot })} onClose={() => closePanels("details")} />
        </Loading>
      )}
      {panel?.kind === "routine" && <Loading><RoutineResults key={`${boot.user.id}:${panel.botId}:${panel.routineId}`} botId={panel.botId} routineId={panel.routineId} userId={boot.user.id} resultId={panel.resultId} onClose={() => closePanels("routine")} /></Loading>}
      {panel?.kind === "integrations" && <Loading><IntegrationsPanel key={`integrations:${boot.user.id}`} bots={boot.bots} accountScope={boot.user.id} onClose={() => closePanels("integrations")} /></Loading>}
      {computerLoaded && <Loading><ComputerPanel key={`computer:${boot.user.id}`} open={panel?.kind === "computer"} onClose={() => closePanels("computer")} /></Loading>}
      {upgradeLoaded && <Loading><HermesUpgradePanel key={`upgrades:${boot.user.id}`} open={panel?.kind === "upgrade"} onClose={() => closePanels("upgrade")}
        bots={boot.bots} currentVersion={boot.connection.version} currentRevisionDate={boot.connection.revisionDate} /></Loading>}
      {panel?.kind === "preferences" && (
        <Loading>
          <PreferencesDialog boot={boot} connectionLost={connectionLost} offline={offline} editPreferences={session.editPreferences}
            notifications={notifications} installEvent={installEvent} notice={notice}
            onClose={() => closePanels("preferences")} onSignOut={signOut}
            onComputer={() => open({ kind: "computer" })} onIntegrations={() => open({ kind: "integrations" })}
            onUpgrade={() => open({ kind: "upgrade" })} onShortcuts={showShortcuts} />
        </Loading>
      )}
      {overlay === "palette" && <CommandPalette boot={boot} botId={botId} shownBotId={shownBotId} readThrough={readThrough}
        connectionLost={connectionLost} onClose={closeOverlay} onSelectBot={id => { setPanel(null); selectBot(id); }}
        onView={next => { setPanel(null); showView(next); }} onSearch={text => { setPanel(null); searchMessages(text); }}
        onSettings={openPreferences} onNewBot={newBot} onTheme={setTheme} onShortcuts={showShortcuts}
        onFind={selected && view === "conversation" ? () => findInChat(selected.id) : undefined} />}
      {overlay === "shortcuts" && <ShortcutsDialog onClose={closeOverlay} />}
      {overlay === "stop" && liveBot && <StopConfirm name={liveBot.name} onStop={stop} onClose={closeOverlay} />}
      <Toast toast={toast.toast} onDismiss={toast.dismiss} onUndo={toast.undo} />
    </div>
  );
}
