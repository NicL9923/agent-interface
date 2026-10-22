import { useEffect, useMemo, useRef, useState } from "react";
import type { ActivityState, Bot } from "./shared/types";
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
import { useSentEchoes, withEchoes } from "./app/sent-echo";
import { moveBotToSection } from "./app/preferences-editing";
import { useAppInstall, useMobile } from "./app/use-browser";
import { UpdateNotice } from "./app/UpdateNotice";
import { Sidebar } from "./app/Sidebar";
import { ChatHeader } from "./app/ChatHeader";
import { Conversation } from "./app/Conversation";
import { Composer } from "./app/Composer";
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
      reset(); clearUploads();
      closePanels("settings", "details", "preferences", "upgrade", "integrations", "computer"); setError("");
    },
    onFirstBootstrap: next => { if (startsOnToday(next.preferences)) setView("today"); },
    onError: setError,
    onBotGone: gone,
  });
  const { boot, botId, setBotId, identityEpoch, offline, appUnavailable } = session;
  const userId = boot?.user.id;
  useUrlSync(view, panel, botId, userId);
  const notifications = useDeviceNotifications(userId, boot?.vapidPublicKey);
  const { draft, setDraft, draftReady, uploads, previews, uploading, upload, retryUpload, cancelUpload, clearUploads } = useDraft({ botId, userId, identityEpoch, setError });
  const { conversation, setConversation, disconnected: conversationDisconnected, reply, reviewed, setReviewed, scroll, content, history, persistPosition } = useConversation(botId, userId, id => {
    gone(id);
    setBotId("");
    void session.refresh();
  });
  // The chat counts as on screen only when nothing covers it: no panel, and on a phone, not the home list.
  useChatPresence(view === "conversation" && !panel && !(mobile && railOpen) && boot?.bots.some(bot => bot.id === botId) ? botId : undefined, userId);
  const connectionLost = session.disconnected || conversationDisconnected || offline;
  const { pending, receipt, sending, send, retry, reset } = useSubmission({
    botId, userId, identityEpoch, draft, setDraft, draftReady, reviewed, connectionLost, setError,
  });
  useDraftPersistence({ draft, setDraft, draftReady, botId, userId, identityEpoch, offline, appUnavailable, pending });
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
  const selectBot = (id: string) => {
    persistPosition();
    setView("conversation");
    setBotId(id);
    setRailOpen(false);
    setError("");
  };
  const signOut = async () => {
    try {
      await notifications.disable();
      await write("/auth/logout", {});
      session.signedOut();
      setConversation(null);
      setDraft({ text: "", attachments: [] });
      // The signed-out account's in-flight work can never clear these once the identity changes.
      reset(); clearUploads();
      setRailOpen(mobile);
      closePanels("settings", "details", "preferences", "upgrade", "integrations");
    } catch (e) {
      setNotice((e as Error).message);
    }
  };
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
  const open = (next: Panel) => setPanel(next);
  const detailsBot = panel?.kind === "details" ? boot.bots.find(bot => bot.id === panel.botId) : undefined;
  const togglePin = (bot: Bot) => void session.editPreferences(preferences => ({
    ...preferences,
    favorites: preferences.favorites.includes(bot.id)
      ? preferences.favorites.filter(id => id !== bot.id)
      : [...preferences.favorites, bot.id],
  }));
  return (
    <div className="app-shell">
      <Sidebar boot={boot} botId={botId} view={view} state={state} connectionLost={connectionLost} offline={offline}
        mobile={mobile} open={railOpen} update={update} onSelectBot={selectBot}
        onView={next => { setView(next); setRailOpen(false); }}
        onNewBot={() => open({ kind: "settings", bot: "new" })}
        onSettings={() => open({ kind: "preferences" })}
        onPin={togglePin}
        onBotSettings={bot => open({ kind: "settings", bot })}
        onMoveToSection={(bot, sectionId) => void session.editPreferences(preferences => moveBotToSection(preferences, bot.id, sectionId))}
        onNewSection={bot => open({ kind: "details", botId: bot.id, newSection: true })} />
      <main className="conversation-panel" inert={mobile && railOpen}>
        <ChatHeader view={view} selected={selected} avatarState={avatarState} railOpen={railOpen}
          onOpenRail={() => setRailOpen(true)}
          onDetails={bot => open({ kind: "details", botId: bot.id })} />
        {/* On a computer the rail is always beside this, so its notice is enough. */}
        {mobile && <UpdateNotice update={update} />}
        {view === "find" ? <Loading key="find"><DiscoveryPanel key={boot.user.id} bootstrap={boot} onRoutine={(id,routineId,resultId)=>setPanel({kind:"routine",botId:id,routineId,resultId})} /></Loading> : view === "groups" ? <Loading key="groups"><GroupChats key={boot.user.id} bootstrap={boot} /></Loading> : view === "today" ? <TodayPanel key={boot.user.id} bootstrap={boot} onOpen={(id, routineId) => { selectBot(id); if (routineId) setPanel({ kind: "routine", botId: id, routineId }); }} /> : <>
          <Conversation boot={boot} selected={selected} botId={botId} conversation={transcript} echo={outgoing} state={state}
            showActivity={showActivity} avatarState={avatarState} connectionLost={connectionLost}
            offline={offline} appUnavailable={appUnavailable} checkingConnection={session.checkingConnection}
            reconnect={session.reconnect} error={error} setError={setError}
            notifications={notifications} scroll={scroll} content={content} history={history} reply={reply} onScroll={persistPosition}
            onDraft={text => setDraft(previous => ({ ...previous, dirty: true, text: previous.text ? `${previous.text}\n\n${text}` : text }))}
            onCreate={() => setPanel({ kind: "settings", bot: "new" })} />
          {selected && <Composer key={`${boot.user.id}:${botId}`} boot={boot} selected={selected} botId={botId} conversation={conversation} state={state}
            active={active} connectionLost={connectionLost} draft={draft} setDraft={setDraft}
            draftReady={draftReady} uploads={uploads} previews={previews} uploading={uploading} upload={upload}
            retryUpload={retryUpload} cancelUpload={cancelUpload} pending={pending} receipt={receipt}
            sending={sending} retry={retry}
            send={() => { history.jumpToLatest(); return send(); }} reviewed={reviewed} setReviewed={setReviewed}
            report={setError}
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
            editPreferences={session.editPreferences}
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
            onUpgrade={() => open({ kind: "upgrade" })} />
        </Loading>
      )}
    </div>
  );
}
