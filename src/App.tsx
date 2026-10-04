import { useEffect, useState } from "react";
import type { ActivityState } from "./shared/types";
import { write } from "./client-api";
import { BotSettings } from "./BotSettings";
import { AvatarTrio, SignIn } from "./components/SignIn";
import { IntegrationsPanel } from "./components/IntegrationsPanel";
import { HermesUpgradePanel } from "./components/HermesUpgradePanel";
import { ComputerPanel } from "./components/ComputerPanel";
import { useDeviceNotifications } from "./components/use-device-notifications";
import { TodayPanel } from "./components/TodayPanel";
import { RoutineResults } from "./components/RoutineResults";
import { DiscoveryPanel, useStarters } from "./components/DiscoveryPanel";
import "./components/discovery.css";
import { GroupChats } from "./components/GroupChats";
import { initialPanel, initialView, startsOnToday, useUrlSync } from "./app/view";
import type { Panel, View } from "./app/view";
import { useSession } from "./app/use-session";
import { useDraft, useDraftPersistence } from "./app/use-draft";
import { useConversation } from "./app/use-conversation";
import { useSubmission } from "./app/use-submission";
import { useAppInstall, useMobile } from "./app/use-browser";
import { Sidebar } from "./app/Sidebar";
import { ChatHeader } from "./app/ChatHeader";
import { Conversation } from "./app/Conversation";
import { Composer, useComposerInput } from "./app/Composer";
import { PreferencesDialog } from "./app/PreferencesDialog";
export function App() {
  const [view, setView] = useState<View>(initialView);
  const [panel, setPanel] = useState<Panel | null>(initialPanel);
  const closePanels = (...kinds: Panel["kind"][]) =>
    setPanel(current => current && kinds.includes(current.kind) ? null : current);
  const [error, setError] = useState("");
  const [startersOpen, setStartersOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
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
  // Only known assistants: a stale deep link must not reach Hermes.
  const starters = useStarters(boot?.bots.some(bot => bot.id === botId) ? botId : "");
  const { draft, setDraft, draftReady, uploading, setUploading, upload } = useDraft({ botId, userId, identityEpoch, setError });
  const { conversation, setConversation, disconnected: conversationDisconnected, reviewed, setReviewed, scroll, persistPosition } = useConversation(botId, userId);
  const connectionLost = session.disconnected || conversationDisconnected || offline;
  const { pending, receipt, sending, send, retry, reset } = useSubmission({
    botId, userId, identityEpoch, draft, setDraft, draftReady, reviewed, connectionLost, setError,
  });
  useDraftPersistence({ draft, setDraft, draftReady, botId, userId, identityEpoch, offline, appUnavailable, pending });
  const composerInput = useComposerInput(draft.text, botId);
  useEffect(() => {
    const theme = boot?.preferences.theme || "system";
    document.documentElement.dataset.theme = theme;
  }, [boot?.preferences.theme]);
  const { workerUpdate, installEvent, notice, setNotice } = useAppInstall();
  const selectBot = (id: string) => {
    persistPosition();
    setView("conversation");
    setBotId(id);
    setStartersOpen(false);
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
      setRailOpen(false);
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
  const open = (next: Panel) => { setRailOpen(false); setPanel(next); };
  return (
    <div className="app-shell">
      <Sidebar boot={boot} botId={botId} view={view} state={state} connectionLost={connectionLost} offline={offline}
        mobile={mobile} open={railOpen} onClose={() => setRailOpen(false)} onSelectBot={selectBot}
        onView={next => { setView(next); setRailOpen(false); }}
        onNewBot={() => open({ kind: "settings", bot: "new" })}
        onComputer={() => open({ kind: "computer" })}
        onPreferences={() => {
          setRailOpen(false);
          setPanel(current => current?.kind === "preferences" ? null : { kind: "preferences" });
        }}
        onIntegrations={() => open({ kind: "integrations" })}
        onUpgrade={() => open({ kind: "upgrade" })} />
      <main className="conversation-panel" inert={mobile && railOpen}>
        <ChatHeader boot={boot} view={view} selected={selected} avatarState={avatarState} conversation={conversation}
          connectionLost={connectionLost} railOpen={railOpen}
          onOpenRail={() => {
            closePanels("preferences");
            setRailOpen(true);
          }}
          onSettings={bot => setPanel({ kind: "settings", bot })} savePreferences={session.savePreferences} />
        {view === "find" ? <DiscoveryPanel key={boot.user.id} bootstrap={boot} onRoutine={(id,routineId,resultId)=>setPanel({kind:"routine",botId:id,routineId,resultId})} /> : view === "groups" ? <GroupChats key={boot.user.id} bootstrap={boot} /> : view === "today" ? <TodayPanel key={boot.user.id} bootstrap={boot} onOpen={(id, routineId) => { selectBot(id); if (routineId) setPanel({ kind: "routine", botId: id, routineId }); }} /> : <>
          <Conversation boot={boot} selected={selected} botId={botId} conversation={conversation} state={state}
            active={active} showActivity={showActivity} avatarState={avatarState} connectionLost={connectionLost}
            offline={offline} appUnavailable={appUnavailable} checkingConnection={session.checkingConnection}
            reconnect={session.reconnect} error={error} setError={setError} workerUpdate={workerUpdate}
            notifications={notifications} scroll={scroll} onScroll={persistPosition}
            onCreate={() => setPanel({ kind: "settings", bot: "new" })} />
          {selected && <Composer boot={boot} selected={selected} botId={botId} conversation={conversation} state={state}
            active={active} showActivity={showActivity} connectionLost={connectionLost} draft={draft} setDraft={setDraft}
            draftReady={draftReady} uploading={uploading} upload={upload} pending={pending} receipt={receipt}
            sending={sending} send={send} retry={retry} reviewed={reviewed} setReviewed={setReviewed}
            starters={starters} startersOpen={startersOpen} setStartersOpen={setStartersOpen}
            input={composerInput} refresh={() => void session.refresh()} />}
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
        <PreferencesDialog prefs={boot.preferences} bots={boot.bots} savePreferences={session.savePreferences}
          notifications={notifications} mobile={mobile} installEvent={installEvent} notice={notice}
          onClose={() => closePanels("preferences")} onSignOut={signOut} />
      )}
    </div>
  );
}
