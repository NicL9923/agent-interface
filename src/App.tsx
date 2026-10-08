import { useEffect, useRef, useState } from "react";
import type { ActivityState, Bot } from "./shared/types";
import { write } from "./client-api";
import { BotSettings } from "./BotSettings";
import { AvatarTrio, SignIn } from "./components/SignIn";
import { IntegrationsPanel } from "./components/IntegrationsPanel";
import { HermesUpgradePanel } from "./components/HermesUpgradePanel";
import { ComputerPanel } from "./components/ComputerPanel";
import { useDeviceNotifications } from "./components/use-device-notifications";
import { TodayPanel } from "./components/TodayPanel";
import { RoutineResults } from "./components/RoutineResults";
import { DiscoveryPanel } from "./components/DiscoveryPanel";
import "./components/discovery.css";
import { GroupChats } from "./components/GroupChats";
import { hasDestination, initialPanel, initialView, startsOnToday, useUrlSync } from "./app/view";
import type { Panel, View } from "./app/view";
import { useSession } from "./app/use-session";
import { useDraft, useDraftPersistence } from "./app/use-draft";
import { useConversation } from "./app/use-conversation";
import { useSubmission } from "./app/use-submission";
import { useAppInstall, useMobile } from "./app/use-browser";
import { Sidebar } from "./app/Sidebar";
import { ChatHeader } from "./app/ChatHeader";
import { Conversation } from "./app/Conversation";
import { Composer } from "./app/Composer";
import { PreferencesDialog } from "./app/PreferencesDialog";
export function App() {
  const [view, setView] = useState<View>(initialView);
  const [panel, setPanel] = useState<Panel | null>(initialPanel);
  const closePanels = (...kinds: Panel["kind"][]) =>
    setPanel(current => current && kinds.includes(current.kind) ? null : current);
  const [error, setError] = useState("");
  // Phones open on the home list unless a link names a destination.
  const [railOpen, setRailOpen] = useState(() => matchMedia("(max-width: 620px)").matches && !hasDestination());
  const mobile = useMobile();
  const session = useSession({
    onIdentityChange: () => {
      reset(); setUploading(false);
      closePanels("settings", "preferences", "upgrade", "integrations", "computer"); setError("");
    },
    onFirstBootstrap: next => { if (startsOnToday(next.preferences)) setView("today"); },
    onError: setError,
  });
  const { boot, botId, setBotId, identityEpoch, offline, appUnavailable } = session;
  const userId = boot?.user.id;
  useUrlSync(view, panel, botId, userId);
  const notifications = useDeviceNotifications(userId, boot?.vapidPublicKey);
  const { draft, setDraft, draftReady, uploading, setUploading, upload } = useDraft({ botId, userId, identityEpoch, setError });
  const { conversation, setConversation, disconnected: conversationDisconnected, reviewed, setReviewed, scroll, persistPosition } = useConversation(botId, userId);
  const connectionLost = session.disconnected || conversationDisconnected || offline;
  const { pending, receipt, sending, send, retry, reset } = useSubmission({
    botId, userId, identityEpoch, draft, setDraft, draftReady, reviewed, connectionLost, setError,
  });
  useDraftPersistence({ draft, setDraft, draftReady, botId, userId, identityEpoch, offline, appUnavailable, pending });
  useEffect(() => {
    const theme = boot?.preferences.theme || "system";
    document.documentElement.dataset.theme = theme;
  }, [boot?.preferences.theme]);
  const { workerUpdate, installEvent, notice, setNotice } = useAppInstall();
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
      reset(); setUploading(false);
      setRailOpen(mobile);
      closePanels("settings", "preferences", "upgrade", "integrations");
    } catch (e) {
      setNotice((e as Error).message);
    }
  };
  if (session.auth) return <SignIn onSuccess={session.signedIn} />;
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
  const togglePin = (bot: Bot) => void session.savePreferences({
    ...boot.preferences,
    favorites: boot.preferences.favorites.includes(bot.id)
      ? boot.preferences.favorites.filter(id => id !== bot.id)
      : [...boot.preferences.favorites, bot.id],
  });
  return (
    <div className="app-shell">
      <Sidebar boot={boot} botId={botId} view={view} state={state} connectionLost={connectionLost} offline={offline}
        mobile={mobile} open={railOpen} onSelectBot={selectBot}
        onView={next => { setView(next); setRailOpen(false); }}
        onNewBot={() => open({ kind: "settings", bot: "new" })}
        onSettings={() => open({ kind: "preferences" })}
        onPin={togglePin}
        onBotSettings={bot => open({ kind: "settings", bot })} />
      <main className="conversation-panel" inert={mobile && railOpen}>
        <ChatHeader boot={boot} view={view} selected={selected} avatarState={avatarState} conversation={conversation}
          connectionLost={connectionLost} railOpen={railOpen}
          onOpenRail={() => setRailOpen(true)}
          onSettings={bot => setPanel({ kind: "settings", bot })} onPin={togglePin} />
        {view === "find" ? <DiscoveryPanel key={boot.user.id} bootstrap={boot} onRoutine={(id,routineId,resultId)=>setPanel({kind:"routine",botId:id,routineId,resultId})} /> : view === "groups" ? <GroupChats key={boot.user.id} bootstrap={boot} /> : view === "today" ? <TodayPanel key={boot.user.id} bootstrap={boot} onOpen={(id, routineId) => { selectBot(id); if (routineId) setPanel({ kind: "routine", botId: id, routineId }); }} /> : <>
          <Conversation boot={boot} selected={selected} botId={botId} conversation={conversation} state={state}
            showActivity={showActivity} avatarState={avatarState} connectionLost={connectionLost}
            offline={offline} appUnavailable={appUnavailable} checkingConnection={session.checkingConnection}
            reconnect={session.reconnect} error={error} setError={setError} workerUpdate={workerUpdate}
            notifications={notifications} scroll={scroll} onScroll={persistPosition}
            onDraft={text => setDraft(previous => ({ ...previous, dirty: true, text: previous.text ? `${previous.text}\n\n${text}` : text }))}
            onCreate={() => setPanel({ kind: "settings", bot: "new" })} />
          {selected && <Composer key={`${boot.user.id}:${botId}`} boot={boot} selected={selected} botId={botId} conversation={conversation} state={state}
            active={active} connectionLost={connectionLost} draft={draft} setDraft={setDraft}
            draftReady={draftReady} uploading={uploading} upload={upload} pending={pending} receipt={receipt}
            sending={sending} send={send} retry={retry} reviewed={reviewed} setReviewed={setReviewed}
            report={setError}
            refresh={() => void session.refresh()} />}
        </>}
      </main>
      {panel?.kind === "settings" && (
        <BotSettings
          bot={panel.bot}
          bootstrap={boot}
          onClose={() => closePanels("settings")}
          onOpenRoutine={(botId, routineId) => { selectBot(botId); setPanel({ kind: "routine", botId, routineId }); }}
          onSaved={() => void session.refresh()}
        />
      )}
      {panel?.kind === "routine" && <RoutineResults key={`${boot.user.id}:${panel.botId}:${panel.routineId}`} botId={panel.botId} routineId={panel.routineId} userId={boot.user.id} resultId={panel.resultId} onClose={() => closePanels("routine")} />}
      {panel?.kind === "integrations" && <IntegrationsPanel key={`integrations:${boot.user.id}`} bots={boot.bots} accountScope={boot.user.id} onClose={() => closePanels("integrations")} />}
      <ComputerPanel key={`computer:${boot.user.id}`} open={panel?.kind === "computer"} onClose={() => closePanels("computer")} />
      <HermesUpgradePanel key={`upgrades:${boot.user.id}`} open={panel?.kind === "upgrade"} onClose={() => closePanels("upgrade")}
        bots={boot.bots} currentVersion={boot.connection.version} />
      {panel?.kind === "preferences" && (
        <PreferencesDialog boot={boot} connectionLost={connectionLost} offline={offline} savePreferences={session.savePreferences}
          notifications={notifications} installEvent={installEvent} notice={notice}
          onClose={() => closePanels("preferences")} onSignOut={signOut}
          onComputer={() => open({ kind: "computer" })} onIntegrations={() => open({ kind: "integrations" })}
          onUpgrade={() => open({ kind: "upgrade" })} />
      )}
    </div>
  );
}
