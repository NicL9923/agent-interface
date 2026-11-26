import { matchCombo, shortcuts } from "./shortcuts";
import { lazy, memo, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RefCallback, RefObject } from "react";
import type { ActivityState, Bootstrap, Bot, FileRef, Message } from "../shared/types";
import { Avatar } from "../components/Avatar";
import { avatarProp } from "../components/avatar-motion";
import { ReplyMarkdown } from "../components/MessageMarkdown";
import { ConnectionPanel } from "../components/ConnectionPanel";
import { Icon } from "../components/Icon";
import { NotificationOnboarding } from "../components/DeviceNotifications";
import type { useDeviceNotifications } from "../components/use-device-notifications";
import { openComputer, usesComputer } from "../components/ComputerHandoffCard";
import {
  ExchangeBots,
  exchangeDisplay,
  exchangeWork,
  isAgentExchange,
} from "../components/AgentExchange";
import { T3ThreadCard } from "../components/T3ThreadCard";
import { t3ThreadLaunch } from "../shared/t3-code";
import { Shimmer } from "../components/Shimmer";
import { ComputerPeek } from "../components/ComputerPeek";
import { WorkTape } from "./WorkTape";
import { useLeaving } from "./use-leaving";
import { prefersReducedMotion } from "./reduced-motion";
import { receipt } from "../shared/discovery";
import { activityAction } from "../shared/activity-sentence";
import { MAX_ATTACHMENTS } from "../shared/uploads";
import { messageOrigin } from "../shared/message-origin";
import type { SavedConversation } from "./storage";
import type { SentEcho } from "./sent-echo";
import { CHECKING_CONNECTION, type useConversation } from "./use-conversation";
import { useStableCallback } from "./use-stable-callback";
import { useTurnRetry } from "./use-turn-retry";
import { emptyReplyKeys, replyKeys } from "./reply-keys";
import { AttentionList } from "./AttentionList";
import { ApprovalCard, DeclinedStep } from "./ApprovalCard";
import { useDeclined } from "./decline-handoff";
import { FindBar } from "./FindBar";
import { MessageRail } from "./MessageRail";
import { MessageMeta, QuoteSelection, TranscriptTools } from "./ReplyActions";
import { useReplySpeech } from "./use-reply-speech";
import { useTalkLive } from "./talk-live";
import { quoteBlock } from "./transcript-logic";
import { RoutineRunCard } from "../components/RoutineRunCard";
import { placeRuns, type RoutineRun } from "../shared/routine-runs";
import { useRoutineRuns } from "./use-routine-runs";
import { ReplyFiles } from "./ReplyFiles";
import { DraftRevisions } from "../components/EmailDraftCard";
import { continueDraftRevisions } from "../shared/draft-diff";
import { unknownEarlierFiles, type Artifact } from "../shared/artifacts";
import {
  continueChips,
  continueTurns,
  settleChips,
  settleRevisions,
  settleTurns,
  useSettledWindow,
  type Turn,
} from "./transcript-window";
import { useEarlierFiles } from "./use-earlier-files";
import "./transcript.css";
// The panel loads when a file chip first opens it, as it does from the assistant's details.
import { sameFiles, sameTurn } from "./conversation/turn-equality";
import {
  ExchangeMessages,
  FileLink,
  HistoryEdge,
  HistorySkeleton,
  isPrivateAssistant,
  isReplyRow,
  latestReasoning,
  TurnWork,
  UNKNOWN_SENDER,
} from "./conversation/TurnDetails";
const ArtifactsPanel = lazy(() =>
  import("../components/Artifacts").then((module) => ({ default: module.ArtifactsPanel })),
);
const activeStates: ActivityState[] = ["thinking", "working", "waiting", "blocked"];
const noMessages: Message[] = [];
const noChips = new Map<string, Artifact[]>();
/**
 * Memoized, with stable callbacks from App, so a keystroke in the composer, which changes App's draft,
 * does not re-render the transcript, its decisions, or its activity avatar.
 */
export const Conversation = memo(function Conversation({
  boot,
  selected,
  botId,
  conversation,
  canonical,
  ownRows,
  echo,
  state,
  showActivity,
  avatarState,
  connectionLost,
  connectionShown,
  offline,
  appUnavailable,
  checkingConnection,
  reconnect,
  error,
  setError,
  notifications,
  scroll,
  endSpace,
  content,
  history,
  reply,
  onScroll,
  onCreate,
  onDraft,
  onRoutineResults,
  onHideRoutineRuns,
  startFormSend,
  settleFormSend,
  computerOpen = false,
  reviewed = false,
}: {
  boot: Bootstrap;
  selected?: Bot;
  botId: string;
  /** Includes the echo of a message still on its way, which is drawn as sending. */
  conversation: SavedConversation | null;
  /** The conversation as Hermes has it, without messages still drawn from this device. */
  canonical: SavedConversation | null;
  /** The saved messages with no sender that are this person's own sends; see ownSentRows. */
  ownRows: ReadonlySet<string>;
  startFormSend: TranscriptTools["startFormSend"];
  settleFormSend: TranscriptTools["settleFormSend"];
  echo: SentEcho | null;
  state: ActivityState;
  showActivity: boolean;
  avatarState: ActivityState;
  /** A read just failed, or the connection is down: actions that need it are refused. */
  connectionLost: boolean;
  /** The connection is down, as the chat shows it. It follows `connectionLost` after a grace period; see useOutage. */
  connectionShown: boolean;
  offline: boolean;
  appUnavailable: boolean;
  checkingConnection: boolean;
  reconnect: () => Promise<void>;
  error: string;
  setError: (message: string) => void;
  notifications: ReturnType<typeof useDeviceNotifications>;
  scroll: RefObject<HTMLDivElement | null>;
  endSpace: RefObject<HTMLDivElement | null>;
  content: RefCallback<HTMLDivElement>;
  history: ReturnType<typeof useConversation>["history"];
  reply: ReturnType<typeof useConversation>["reply"];
  onScroll: () => void;
  onCreate: () => void;
  /** Adds text to the draft. False while the draft is on its way, when it must not change. */
  /** Adds to the person's draft, never replacing it. False while a send is on its way; otherwise how many files didn't fit. */
  onDraft: (text: string, files?: FileRef[]) => number | false;
  /** Opens a routine's full results at one run. */
  onRoutineResults: (routineId: string, resultId: string) => void;
  /** Keeps a routine's runs out of this chat, with a way back. */
  onHideRoutineRuns: (routineId: string, routineName: string) => void;
  /** The full computer view is open, so the transcript's small live view steps aside. */
  computerOpen?: boolean;
  /** The person reviewed an interrupted task in the message box; form cards send under the same review. */
  reviewed?: boolean;
}) {
  const prefs = boot.preferences;
  const advanced = prefs.presentation === "advanced";
  // Work over the whole window is done once for the settled messages and continued over the live
  // rows, so a streaming reply costs its own rows, not the window's. See transcript-window.ts.
  const { settled, live } = useSettledWindow(conversation?.messages ?? noMessages);
  const settledTurns = useMemo(() => settleTurns(settled, advanced), [settled, advanced]);
  const blocks = useMemo(
    () => continueTurns(settledTurns, live, conversation?.toolCalls),
    [settledTurns, live, conversation?.toolCalls],
  );
  // Each reply's files, attributed from the same history as the Artifacts panel. A window that starts
  // after the beginning reads the files before it, only when it holds a reply with files of its own.
  const files = conversation?.files,
    loaded = !!conversation;
  const ownChips = useMemo(() => settleChips(settled, files, noMessages), [settled, files]);
  const candidates = useMemo(
    () => loaded && continueChips(ownChips, settled, live, files, noMessages).size > 0,
    [loaded, ownChips, settled, live, files],
  );
  const earlierFiles = useEarlierFiles(botId, conversation, candidates);
  // Until the files before the window are known, a file in it may be the person's or an earlier turn's, so it has no chips.
  const unknownEarlier = !!conversation && unknownEarlierFiles(conversation, earlierFiles.messages);
  const earlier = earlierFiles.messages ?? noMessages;
  const windowChips = useMemo(
    () => (earlier.length ? settleChips(settled, files, earlier) : ownChips),
    [earlier, ownChips, settled, files],
  );
  const replyFiles = useMemo(
    () =>
      !loaded || unknownEarlier
        ? noChips
        : continueChips(windowChips, settled, live, files, earlier),
    [loaded, unknownEarlier, windowChips, settled, live, files, earlier],
  );
  // Email drafts that revise an earlier one here, so their cards can mark what changed. The map keeps
  // its identity while the live rows add no draft, so the cards reading it do not re-render.
  const settledRevisions = useMemo(() => settleRevisions(settled), [settled]);
  const revisions = useMemo(
    () => continueDraftRevisions(settledRevisions, live).revisions,
    [settledRevisions, live],
  );
  // The Artifacts panel opened from a chip, on one file or, from "+N more", on the first.
  const [artifactFocus, setArtifactFocus] = useState<{ fileId?: string } | null>(null);
  const openFile = useStableCallback((fileId?: string) => setArtifactFocus({ fileId }));
  // Routine runs sit among the turns by time. See src/shared/routine-runs.ts for the rules.
  const hiddenRoutines = useMemo(
    () =>
      (prefs.hiddenRoutineRuns ?? [])
        .filter((entry) => entry.botId === botId)
        .map((entry) => entry.routineId),
    [prefs.hiddenRoutineRuns, botId],
  );
  const runs = useRoutineRuns({
    botId,
    messages: canonical?.botId === botId ? canonical.messages : undefined,
    complete: history.complete,
    enabled: !!selected && !!boot.capabilities.routines?.supported,
    hiddenRoutines,
  });
  const runSlots = useMemo(() => placeRuns(blocks.map(turnTime), runs), [blocks, runs]);
  const runActions = useMemo(
    () => ({ onResults: onRoutineResults, onHide: onHideRoutineRuns }),
    [onRoutineResults, onHideRoutineRuns],
  );
  const runningCall = connectionShown
    ? undefined
    : conversation?.toolCalls?.findLast((call) => call.status === "running");
  const prop = avatarProp(runningCall?.name);
  const action = activityAction(state, conversation?.activity.detail, {
    offline,
    connectionLost: connectionShown,
  });
  const running = !!conversation && activeStates.includes(conversation.activity.state);
  // The running turn's one live row: the current tool's receipt, and in Advanced, the latest reasoning line.
  const liveTool = runningCall ? `${receipt(runningCall).label} · ${runningCall.name}` : undefined;
  const liveThought =
    advanced && running && !connectionShown ? latestReasoning(conversation!.messages) : undefined;
  // The running turn's tools so far. Hermes lists only the current turn's calls while it runs.
  const turnCalls = running && !connectionShown ? (conversation!.toolCalls ?? []) : [];
  const peeking = !!selected && !computerOpen && turnCalls.some((call) => usesComputer(call.name));
  // Settled decisions fold away instead of vanishing; Reduce Motion removes them at once.
  const pendingApprovals = useMemo(
    () => conversation?.approvals.filter((approval) => approval.status === "pending") ?? [],
    [conversation?.approvals],
  );
  const approvals = useLeaving(
    pendingApprovals,
    (approval) => approval.id,
    prefersReducedMotion() ? 0 : 420,
    `${boot.user.id}:${botId}`,
  );
  const declined = useDeclined(botId);
  // Short results of reply actions, each its own node so a repeat still reads out.
  const [notice, setNotice] = useState<{ id: number; text: string } | null>(null);
  const announce = useStableCallback((text: string) =>
    setNotice((previous) => ({ id: (previous?.id ?? 0) + 1, text })),
  );
  const quote = useStableCallback((text: string) => {
    if (onDraft(`${quoteBlock(text)}\n\n`) === false)
      return announce("Your message is still sending. Quote once it has gone.");
    announce("Quoted in your message.");
    // The composer is outside the transcript; its field takes the caret after the quote.
    requestAnimationFrame(() => {
      const field = document.getElementById("message");
      if (!(field instanceof HTMLTextAreaElement)) return;
      field.focus();
      field.setSelectionRange(field.value.length, field.value.length);
    });
  });
  // A refused retry's words go back in the message box beside whatever the person already wrote.
  const putBack = useStableCallback((original: Message) => {
    const left = onDraft(original.text, original.files);
    if (left === false)
      return announce("Your message is still sending. Try again once it has gone.");
    announce(
      left
        ? `Your message is in the message box, without ${left} of its files: a message can carry only ${MAX_ATTACHMENTS}.`
        : "Your message is in the message box.",
    );
    requestAnimationFrame(() => document.getElementById("message")?.focus());
  });
  // Live Talk owns the speaker, so replies are not read aloud while it runs.
  const talking = useTalkLive();
  // A reply already playing stops only once the chat shows it is disconnected; starting one is refused at once (`tools.unavailable`).
  const speech = useReplySpeech(botId, connectionShown || talking);
  const tools = useMemo<TranscriptTools>(
    () => ({
      botId,
      sessionId: conversation?.sessionId,
      unavailable: connectionLost,
      quote,
      announce,
      speech,
      reviewedInterruption: reviewed,
      formKey: boot.formKey,
      startFormSend,
      settleFormSend,
    }),
    [
      botId,
      conversation?.sessionId,
      connectionLost,
      quote,
      announce,
      speech,
      reviewed,
      boot.formKey,
      startFormSend,
      settleFormSend,
    ],
  );
  const frame = useRef<HTMLDivElement>(null);
  // The row reads as thinking before Hermes reports the new turn (see awaitingTurn), so the failed turn's retry steps aside.
  const startingTurn =
    activeStates.includes(state) && !activeStates.includes(canonical?.activity.state ?? "idle");
  const retry = useTurnRetry({
    botId,
    userId: boot.user.id,
    canonical,
    blocked: !!echo || startingTurn || connectionLost || !boot.capabilities.chat.supported,
    resendable: boot.capabilities.idempotency.supported,
    report: setError,
  });
  // Find in chat takes Cmd/Ctrl+F while a conversation is on screen. Covered by a dialog or the
  // phone's assistant list, the browser's own find stays.
  const [finding, setFinding] = useState(false);
  const findReturn = useRef<HTMLElement | null>(null);
  const findable = !!selected && !!conversation;
  useEffect(() => setFinding(false), [botId]);
  useEffect(() => {
    if (!findable) return;
    const open = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !matchCombo(event, shortcuts.find)) return;
      const view = scroll.current;
      if (!view || view.closest("[inert]") || document.querySelector("dialog[open]")) return;
      event.preventDefault();
      const field = frame.current?.querySelector<HTMLInputElement>(".find-bar input");
      if (field) return field.select();
      findReturn.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setFinding(true);
    };
    // Assistant details and the palette ask for find in chat by event, once this chat is on screen.
    const requested = (event: Event) => {
      if ((event as CustomEvent<{ botId?: string }>).detail?.botId !== botId) return;
      const field = frame.current?.querySelector<HTMLInputElement>(".find-bar input");
      if (field) return field.select();
      findReturn.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setFinding(true);
    };
    window.addEventListener("keydown", open);
    window.addEventListener("wildbots:find", requested);
    return () => {
      window.removeEventListener("keydown", open);
      window.removeEventListener("wildbots:find", requested);
    };
  }, [findable, scroll, botId]);
  const exchangeBots = useMemo(
    () => ({ bots: boot.bots, currentBotId: botId }),
    [boot.bots, botId],
  );
  const closeFind = useStableCallback(() => {
    setFinding(false);
    const back = findReturn.current;
    findReturn.current = null;
    (back?.isConnected ? back : scroll.current)?.focus({ preventScroll: true });
  });
  return (
    <DraftRevisions.Provider value={revisions}>
      <TranscriptTools.Provider value={tools}>
        <ExchangeBots.Provider value={exchangeBots}>
          {error && (
            <div className="notice error" role="alert">
              {error}
              <button aria-label="Dismiss error" onClick={() => setError("")}>
                <Icon name="close" size={16} />
              </button>
            </div>
          )}
          <NotificationOnboarding notifications={notifications} />
          <div className="transcript-frame" ref={frame}>
            {finding && findable && (
              <FindBar
                botId={botId}
                conversation={conversation}
                scroll={scroll}
                openMessage={history.openMessage}
                onClose={closeFind}
              />
            )}
            {/* Always mounted, so a screen reader is already watching when a reply lands. */}
            {/* Each reply is its own node, so a repeat of the same words still reads out. */}
            <span className="sr-only" role="status">
              {selected && reply?.botId === botId && (
                <span key={reply.id}>{`${selected.name} replied: ${reply.text}`}</span>
              )}
            </span>
            <span className="sr-only" role="status">
              {notice && <span key={notice.id}>{notice.text}</span>}
            </span>
            {/* Before the transcript, so a keyboard reaches its one tab stop without passing every reply. */}
            {selected && conversation && (
              <MessageRail messages={conversation.messages} scroll={scroll} jump={history.jumpTo} />
            )}
            <div
              className="transcript"
              ref={scroll}
              onScroll={onScroll}
              role="region"
              aria-label="Conversation"
              tabIndex={0}
            >
              <div className="transcript-content" ref={content}>
                {!selected && connectionShown ? (
                  <ConnectionPanel
                    connection={boot.connection}
                    offline={offline}
                    appUnavailable={appUnavailable}
                    busy={checkingConnection}
                    retry={() => void reconnect()}
                  />
                ) : !selected ? (
                  <div className="empty-state">
                    <Avatar size={100} />
                    <h2>A little less to carry.</h2>
                    <p>
                      Return to the same assistants, with the context and conversations you share.
                    </p>
                    <button
                      className="primary"
                      disabled={!boot.capabilities.botConfiguration.supported || connectionLost}
                      title={
                        boot.capabilities.botConfiguration.reason ??
                        (connectionLost ? CHECKING_CONNECTION : undefined)
                      }
                      onClick={onCreate}
                    >
                      Create an assistant
                    </button>
                    {!boot.capabilities.botConfiguration.supported && (
                      <p className="muted">
                        Assistant setup is unavailable while the server is disconnected.
                      </p>
                    )}
                    {prefs.presentation === "advanced" && (
                      <details className="activity-details">
                        <summary>Connection details</summary>
                        <p>{boot.connection.detail}</p>
                      </details>
                    )}
                  </div>
                ) : !conversation && !connectionShown ? (
                  <HistorySkeleton />
                ) : !conversation ? (
                  // Never read, so not known to be empty: the notice above the composer says why and retries.
                  <div className="empty-state">
                    <Avatar
                      avatar={selected.avatar}
                      state="disconnected"
                      size={112}
                      name={selected.name}
                      offline={offline}
                      reducedMotion
                    />
                    <h2>This conversation hasn't loaded yet</h2>
                    <p>It will show here as soon as the connection is back.</p>
                  </div>
                ) : blocks.length || runs.length ? (
                  <>
                    <HistoryEdge
                      history={history}
                      scroll={scroll}
                      name={selected.name}
                      disabled={connectionLost}
                    />
                    <Turns
                      blocks={blocks}
                      advanced={advanced}
                      bubbles={prefs.chatStyle !== "classic"}
                      unavailable={connectionLost}
                      disconnected={connectionShown}
                      name={selected.name}
                      botId={botId}
                      userId={boot.user.id}
                      sharedChat={!isPrivateAssistant(selected)}
                      ownRows={ownRows}
                      running={running}
                      outgoingId={echo?.request.requestId}
                      outgoing={echo?.status}
                      runSlots={runSlots}
                      runActions={runActions}
                      replyFiles={replyFiles}
                      onOpenFile={openFile}
                    />
                  </>
                ) : !showActivity ? (
                  <div className="empty-state">
                    <Avatar
                      avatar={selected.avatar}
                      state={avatarState}
                      size={112}
                      name={selected.name}
                      reducedMotion
                    />
                    <h2>Start with {selected.name}'s role</h2>
                    <p>
                      {selected.description || `Tell ${selected.name} what you need help with.`}
                    </p>
                    <button
                      type="button"
                      onClick={() =>
                        onDraft(
                          `Let's discuss your role${selected.description ? `: ${selected.description}` : ". Ask me what I need help with and how I like to work"}.`,
                        )
                      }
                    >
                      Discuss {selected.name}'s role
                    </button>
                    {!boot.capabilities.chat.supported && (
                      <p className="muted">{boot.capabilities.chat.reason}</p>
                    )}
                  </div>
                ) : null}
                {selected && showActivity && (
                  <div
                    className={`activity-status conversation-activity message-activity state-${state}${state === "failed" || state === "interrupted" ? " recovery-activity" : ""}`}
                  >
                    {/* Headers, home and lists keep avatars still; this one moves to show live work. */}
                    <Avatar
                      avatar={selected.avatar}
                      state={state === "blocked" ? "idle" : state}
                      size={52}
                      name={selected.name}
                      botId={selected.id}
                      offline={offline}
                      prop={state === "working" ? prop : undefined}
                    />
                    <div className="activity-copy">
                      {/* Offline is the connection's news, which the app's connection live region announces once. */}
                      <div
                        role={state === "disconnected" ? undefined : "status"}
                        aria-atomic="true"
                      >
                        {state === "failed" || state === "interrupted" ? (
                          <>
                            <p className="recovery-title">
                              {state === "failed"
                                ? `${selected.name} couldn't finish.`
                                : `${selected.name}'s task was interrupted.`}
                            </p>
                            {conversation?.activity.detail?.trim() && (
                              <p className="recovery-detail">{conversation.activity.detail}</p>
                            )}
                            {state === "interrupted" && (
                              <p className="recovery-guidance">
                                Review the last actions above before continuing.
                              </p>
                            )}
                          </>
                        ) : (
                          <Shimmer text={`${selected.name} is ${action}...`} />
                        )}
                      </div>
                      {running && (liveTool || liveThought || turnCalls.length > 0) && (
                        <div className="activity-live">
                          <WorkTape calls={turnCalls} />
                          {liveTool &&
                            (usesComputer(runningCall?.name) ? (
                              <div className="activity-live-computer">
                                <p className="activity-live-tool">{liveTool}</p>
                                <button
                                  type="button"
                                  className="activity-watch"
                                  aria-label={`Watch ${selected.name} on the computer`}
                                  onClick={() => openComputer()}
                                >
                                  <Icon name="computer" size={16} />
                                  Watch
                                </button>
                              </div>
                            ) : (
                              <p className="activity-live-tool">{liveTool}</p>
                            ))}
                          {liveThought && <p className="activity-live-thought">{liveThought}</p>}
                        </div>
                      )}
                      {retry.message && (
                        <p
                          className="recovery-guidance"
                          role={retry.checking ? "status" : undefined}
                        >
                          {retry.checking
                            ? retry.resendable
                              ? "Checking whether the retry arrived… Retry sends the same request again, so it can't run twice."
                              : "Hermes hasn't confirmed the retry yet. It's being checked and won't be sent again. If it never arrives, send the message again from the message box."
                            : "Retry sends your last message again. Your draft stays as it is."}
                        </p>
                      )}
                      {retry.refusal && (
                        <div className="retry-refused">
                          <p role="status">{retry.refusal.text}</p>
                          <button
                            type="button"
                            className="primary retry-turn"
                            onClick={() => putBack(retry.refusal!.message)}
                          >
                            Put my message in the message box
                          </button>
                        </div>
                      )}
                      {retry.message && (
                        <button
                          type="button"
                          className="primary with-progress retry-turn"
                          disabled={retry.busy || (retry.checking && !retry.resendable)}
                          title={
                            retry.checking
                              ? retry.resendable
                                ? "Sends the same request again, so it can't run twice"
                                : boot.capabilities.idempotency.reason
                              : undefined
                          }
                          onClick={() => void retry.run(retry.message!)}
                        >
                          {retry.busy ? (
                            <Icon name="spinner" className="spin" size={16} />
                          ) : (
                            <Icon name="refresh" size={16} />
                          )}
                          {retry.busy ? "Retrying…" : "Retry"}
                        </button>
                      )}
                    </div>
                  </div>
                )}
                <AttentionList
                  conversation={conversation}
                  botId={botId}
                  userId={boot.user.id}
                  bots={boot.bots}
                  assistantName={selected?.name}
                  disconnected={connectionLost}
                  report={setError}
                />
                {approvals.map(({ item: approval, leavingSince }) => (
                  <ApprovalCard
                    key={`${boot.user.id}:${botId}:${approval.id}`}
                    approval={approval}
                    botId={botId}
                    userId={boot.user.id}
                    disconnected={connectionLost}
                    assistantName={selected?.name ?? "The assistant"}
                    supported={boot.capabilities.approvals.supported}
                    unavailableReason={boot.capabilities.approvals.reason}
                    report={setError}
                    leaving={leavingSince !== undefined}
                  />
                ))}
                {declined && !approvals.some(({ item }) => item.id === declined) && (
                  <DeclinedStep name={selected?.name ?? "The assistant"} />
                )}
              </div>
              {/* Room for a message just sent to sit near the top while its reply grows; see use-conversation. */}
              <div className="transcript-end-space" ref={endSpace} aria-hidden="true" />
            </div>
            <QuoteSelection frame={frame} scroll={scroll} />
            {selected && conversation && !history.atLatest && !history.atAttention && (
              <button
                type="button"
                className={`jump-latest${history.unseen ? " has-new" : ""}`}
                onClick={() => {
                  history.jumpToLatest();
                  // The button disappears, so keyboard focus continues from the transcript.
                  scroll.current?.focus({ preventScroll: true });
                }}
              >
                <Icon name="latest" size={16} />
                {history.unseen
                  ? `${history.unseen} new ${history.unseen === 1 ? "message" : "messages"}`
                  : "Jump to latest"}
              </button>
            )}
            {peeking && selected && <ComputerPeek name={selected.name} />}
            {artifactFocus && selected && (
              <Suspense fallback={null}>
                <ArtifactsPanel
                  bot={selected}
                  conversation={conversation}
                  unavailable={connectionLost}
                  focus={artifactFocus.fileId}
                  onClose={() => setArtifactFocus(null)}
                />
              </Suspense>
            )}
          </div>
        </ExchangeBots.Provider>
      </TranscriptTools.Provider>
    </DraftRevisions.Provider>
  );
});
/** The last line of reasoning in the running turn, after the person's latest message. */
type TurnProps = {
  block: Turn;
  advanced: boolean;
  /** Reply prose sits in bubbles; see the person's chat style. */
  bubbles: boolean;
  name: string;
  botId: string;
  userId: string;
  /** Other members may have written in this chat, so a message with no sender is not assumed to be the viewer's own. */
  sharedChat: boolean;
  /** The messages with no sender that this person sent from here, which read as theirs even in a shared chat. */
  ownRows: ReadonlySet<string>;
  /** Actions that need the connection are refused. Only a turn whose replies hold reply cards gets it. */
  unavailable: boolean;
  /** The chat shows it is disconnected. Only a turn with a running call, which then reads "Last seen running", gets it. */
  disconnected: boolean;
  /** This is the latest turn and it is still working, so its work reads as live rather than finished. */
  live: boolean;
  /** The person's sent message still shown from this device, and how far it got. Only the turn that holds it gets these. */
  outgoingId?: string;
  outgoing?: SentEcho["status"];
  /** The files this turn produced and the reply they show under, when it has both. */
  files?: { replyId: string; artifacts: Artifact[] };
  onOpenFile: (fileId?: string) => void;
};
/**
 * Reply cards are the only part of a reply that reads `unavailable`, and a change to it re-parses the
 * reply's Markdown, so only a reply that may hold one gets it. Matched as loosely as sameBlock does.
 */
const holdsCards = (message: Message) => message.text.includes("agent-ui");
/** When a turn started, for placing routine runs: its first dated message, shown or folded. */
const turnTime = (block: Turn) =>
  block.messages.find((message) => message.createdAt)?.createdAt ??
  [...block.tools.values()].find((message) => message.createdAt)?.createdAt;
type RunActions = {
  onResults: (routineId: string, resultId: string) => void;
  onHide: (routineId: string, routineName: string) => void;
};
const runCards = (runs: RoutineRun[] | undefined, botId: string, actions: RunActions) =>
  (runs ?? []).map((run) => (
    <RoutineRunCard
      key={`run:${run.routineId}:${run.id}`}
      run={run}
      botId={botId}
      onResults={actions.onResults}
      onHide={actions.onHide}
    />
  ));
// Memoized so typing in the composer does not re-render the whole transcript.
const Turns = memo(function Turns({
  blocks,
  running,
  outgoingId,
  outgoing,
  runSlots,
  runActions,
  replyFiles,
  unavailable,
  disconnected,
  ...shared
}: Omit<TurnProps, "block" | "live" | "outgoingId" | "outgoing" | "files"> & {
  replyFiles: Map<string, Artifact[]>;
  blocks: Turn[];
  /** The latest turn is still working. */
  running: boolean;
  outgoingId?: string;
  outgoing?: SentEcho["status"];
  /** Routine runs before each turn, and after the last; see placeRuns. */
  runSlots: RoutineRun[][];
  runActions: RunActions;
}) {
  // One keyed list, so an opened run card stays open when a new turn lands after it.
  return (
    <>
      {blocks.flatMap((block, index) => {
        const holdsEcho =
          outgoingId !== undefined && block.messages.some((message) => message.id === outgoingId);
        const reply = block.messages.findLast((message) => replyFiles.has(message.id));
        // A turn gets the connection flags only when it shows them, so a change re-renders no other turn.
        return [
          ...runCards(runSlots[index], shared.botId, runActions),
          <TurnView
            key={block.messages[0]?.id || `tools-${index}`}
            block={block}
            {...shared}
            live={running && index === blocks.length - 1}
            unavailable={unavailable && block.messages.some(holdsCards)}
            disconnected={
              disconnected &&
              [...block.tools.values()].some((message) => message.toolCall?.status === "running")
            }
            outgoingId={holdsEcho ? outgoingId : undefined}
            outgoing={holdsEcho ? outgoing : undefined}
            files={reply && { replyId: reply.id, artifacts: replyFiles.get(reply.id)! }}
          />,
        ];
      })}
      {runCards(runSlots[blocks.length], shared.botId, runActions)}
    </>
  );
});
// A stream changes the latest reply up to ten times a second, and `turns` rebuilds every block each
// time. A turn is compared by what it shows, so finished turns, and a reload with the same content, bail out.
const sameTurnProps = (a: TurnProps, b: TurnProps) =>
  a.advanced === b.advanced &&
  a.bubbles === b.bubbles &&
  a.unavailable === b.unavailable &&
  a.disconnected === b.disconnected &&
  a.name === b.name &&
  a.botId === b.botId &&
  a.userId === b.userId &&
  a.sharedChat === b.sharedChat &&
  a.block.messages.every((message) => a.ownRows.has(message.id) === b.ownRows.has(message.id)) &&
  a.live === b.live &&
  a.outgoingId === b.outgoingId &&
  a.outgoing === b.outgoing &&
  a.onOpenFile === b.onOpenFile &&
  sameFiles(a.files, b.files) &&
  sameTurn(a.block, b.block);
const TurnView = memo(function TurnView({
  block,
  advanced,
  bubbles,
  unavailable,
  disconnected,
  name,
  botId,
  userId,
  sharedChat,
  ownRows,
  live: running,
  outgoingId,
  outgoing,
  files: turnFiles,
  onOpenFile,
}: TurnProps) {
  const allWork = [...block.tools.values()];
  const work = allWork.flatMap((message) => exchangeWork(message) ?? []);
  // Keep bot messages in saved order beside ordinary replies, without changing Hermes's origin
  // classification or duplicating a tool-call row that is already conversation-visible.
  const byId = new Map([...block.messages, ...allWork].map((message) => [message.id, message]));
  const shownIds = new Set(block.messages.map((message) => message.id));
  const sources = new Map<string, string>();
  const ordered = block.order.flatMap<Message | { id: string }>((id) => {
    const shown = byId.has(id) ? exchangeDisplay(byId.get(id)!) : [{ id }];
    for (const message of shown) sources.set(message.id, id);
    return shown;
  });
  const messages = ordered.filter(
    (message): message is Message =>
      "role" in message &&
      (isAgentExchange(message) || (message.role !== "tool" && shownIds.has(message.id))),
  );
  // A turn's intermediate work folds into one row: before the reply that follows the work, before the
  // first reply when there is only reasoning, or at the end.
  const fold =
    work.length || block.reasoning.length ? (
      <TurnWork
        key="turn-work"
        work={work}
        reasoning={block.reasoning}
        messages={block.messages}
        advanced={advanced}
        disconnected={disconnected}
        recipient={name}
        live={running}
      />
    ) : null;
  const foldAt = work.length
    ? block.replyAt
    : block.messages.find((message) => message.role !== "user")?.id;
  // Work the person should see without opening the fold, such as a T3 Code thread it started, follows it.
  const shown = work.flatMap((message) => {
    const thread = message.toolCall && t3ThreadLaunch(message.toolCall);
    return thread ? [<T3ThreadCard key={`t3:${message.id}`} thread={thread} />] : [];
  });
  const afterFold = [...(fold ? [fold] : []), ...shown];
  // One keyed list, so the fold keeps its open state when finishing moves it above the reply.
  // Each row is keyed by its own identity. A streamed reply's saved copy takes the live row's key
  // when the hand-off is unambiguous (see replyKeys), so React keeps the row's node, with any
  // selection in it, instead of building the reply again.
  const handoff = useRef(emptyReplyKeys());
  const { key: rowKey, record } = replyKeys(handoff.current, block.messages);
  useLayoutEffect(() => {
    handoff.current = record;
  });
  const positions = new Map(ordered.map((message, index) => [message.id, index]));
  const consecutive = (earlier: Message, later: Message) =>
    positions.get(later.id) === positions.get(earlier.id)! + 1;
  const rows = messages.flatMap((message, position) => {
    if (isAgentExchange(message)) {
      if (
        position > 0 &&
        isAgentExchange(messages[position - 1]) &&
        consecutive(messages[position - 1], message) &&
        message.id !== foldAt
      )
        return [];
      const run = [message];
      for (
        let at = position + 1;
        at < messages.length &&
        isAgentExchange(messages[at]) &&
        consecutive(messages[at - 1], messages[at]) &&
        messages[at].id !== foldAt;
        at++
      )
        run.push(messages[at]);
      const article = (
        <ExchangeMessages key={rowKey(message)} messages={run} recipient={name} sources={sources} />
      );
      return message.id === foldAt ? [...afterFold, article] : [article];
    }
    // The conversation is with one assistant, so its replies need no name. Consecutive reply parts
    // in a turn read as one reply, with the time under the last part.
    const reply = isReplyRow(message);
    // A progress line stands apart from the answer around it.
    const joins = (earlier: Message | undefined, later: Message | undefined) =>
      !!later &&
      isReplyRow(later) &&
      earlier?.role === "assistant" &&
      later.id !== block.replyAt &&
      !isAgentExchange(earlier) &&
      !isAgentExchange(later) &&
      !earlier.interim &&
      !later.interim;
    const continued = joins(messages[position - 1], message);
    const endsRun = !joins(message, messages[position + 1]);
    const scheduled = messageOrigin(message)?.kind === "scheduled";
    const own = message.role === "user" && !scheduled;
    // A name goes above a message only where it tells the reader something: a scheduled prompt, or
    // another member of the household. The person's own words and the assistant's replies need none.
    // A person's message with no sender, such as one a native Hermes client wrote, is theirs in a
    // private chat, where they are the only member. In a shared one it could be anyone's, so it is
    // labeled rather than passed off as theirs, unless it is a send of this person's own that Hermes
    // saved without saying so, as it does a steer or a queued send (see ownSentRows).
    const label = scheduled
      ? "Scheduled"
      : own
        ? message.sender
          ? message.sender.id !== userId
            ? message.sender.name
            : ""
          : sharedChat && !ownRows.has(message.id)
            ? UNKNOWN_SENDER
            : ""
        : reply
          ? ""
          : message.toolName || message.role;
    // Accepted, it reads as any other message until Hermes's own copy takes its place.
    const delivery = outgoingId === message.id && outgoing !== "accepted" ? outgoing : undefined;
    const streaming = message.id.endsWith("-inflight");
    const progress = message.interim === true;
    let when = message.createdAt;
    for (let at = position; !when && at > 0 && joins(messages[at - 1], messages[at]); at--)
      when = messages[at - 1].createdAt;
    const files = message.files?.map((file) => <FileLink file={file} key={file.id} />);
    const article = (
      <article
        className={`message message-${message.role}${progress ? " message-interim" : ""}${continued ? " message-continued" : ""}${delivery ? ` message-outgoing message-${delivery}` : ""}`}
        key={rowKey(message)}
        data-message-id={message.id}
        aria-busy={delivery === "sending" || undefined}
      >
        {!continued && label && <div className="message-attribution">{label}</div>}
        {/* Only a person's own message has a bubble, so its meta line can sit beneath it. */}
        {reply ? (
          <ReplyMarkdown
            live={streaming}
            bubbles={bubbles && !progress && message.role === "assistant"}
            text={message.text}
            botId={botId}
            messageId={message.id}
            userId={userId}
            unavailable={unavailable && holdsCards(message)}
            inlineUi={message.role === "assistant" && (streaming || !progress)}
          />
        ) : (
          message.role !== "tool" &&
          (own ? (
            <div className="message-bubble">
              <div className="message-text">{message.text}</div>
              {files}
            </div>
          ) : (
            <div className="message-text">{message.text}</div>
          ))
        )}
        {own && message.steered && <p className="message-steered">Added to the current task</p>}
        {!own && files}
        {turnFiles?.replyId === message.id && !streaming && (
          <ReplyFiles artifacts={turnFiles.artifacts} onOpen={onOpenFile} />
        )}
        {/* A live reply holds its meta row's place, hidden, so nothing moves when it is saved. */}
        {!progress && (reply || own) && (
          <MessageMeta
            message={message}
            own={own}
            when={endsRun ? when : undefined}
            delivery={delivery}
            pending={streaming}
            actions={!!message.text.trim() && (message.role === "assistant" || own)}
          />
        )}
      </article>
    );
    return message.id === foldAt ? [...afterFold, article] : [article];
  });
  if (foldAt === undefined) rows.push(...afterFold);
  return <div className="conversation-turn">{rows}</div>;
}, sameTurnProps);
