import { useState } from "react";
import { write } from "../client-api";
import { useAction } from "../app/use-action";
import { useResource } from "../app/use-resource";
import { FormMessage } from "./ui/form-message";
import { Avatar, stateLabels } from "./Avatar";
import { When } from "./When";
import { eventHeadline } from "../shared/event-copy";
import type { Bootstrap } from "../shared/types";
import type { TodayOverview } from "../shared/experience";
import "./experience.css";

export function TodayPanel({ bootstrap, onOpen }: { bootstrap: Bootstrap; onOpen: (botId: string, routineId?: string) => void }) {
  // An unchanged recap revalidates as 304 and keeps its original generatedAt, so the check time is this client's.
  const [checkedAt, setCheckedAt] = useState("");
  const today = useResource<TodayOverview>("/today", { deps: [bootstrap.user.id], pollMs: 30_000, onData: () => setCheckedAt(new Date().toISOString()) });
  const { data: overview, loading } = today;
  const seen = useAction();
  const error = seen.error || today.error;
  const items = overview?.items || [];
  const attention = items.filter(item => !item.error && (item.approvals.some(approval => approval.status === "pending") || item.attention.length || ["blocked", "interrupted", "failed"].includes(item.activity.state)));
  const active = items.filter(item => !item.error && ["thinking", "working", "waiting"].includes(item.activity.state));
  const completed = overview?.events.filter(event => event.kind === "completed") || [];
  const caughtUp = () => overview && seen.run(async () => {
    await write("/today/seen", { seenAt: overview.generatedAt, frontier: overview.frontier }, "PUT");
    await today.reload();
  });
  const files = items.filter(item => item.files.length);
  return <div className="today-panel"><div className="today-intro">
    {overview ? <div className="today-counts" aria-label="Household activity"><span><strong>{attention.length}</strong> need you</span>
      <span><strong>{active.length}</strong> at work</span><span><strong>{completed.length}</strong> {overview.hasMore ? "finished on this page" : "finished since your last visit"}</span></div>
      : <p role="status" className="muted">{loading ? "Checking your assistants..." : "Today is unavailable right now."}</p>}
    <button type="button" disabled={loading} onClick={() => void today.reload()}>Refresh</button></div>
    {error && <FormMessage tone="error">{error} Loaded results may be out of date.</FormMessage>}
    {overview && <>
      <section className="today-section"><h3>Needs your attention</h3>{!attention.length && <p className="muted">No pending requests in the assistants we could check.</p>}
        {attention.map(item => <button className="today-row" type="button" key={item.botId} onClick={() => onOpen(item.botId)}>
          <Avatar avatar={bootstrap.bots.find(bot => bot.id === item.botId)?.avatar} name={item.botName} state={item.activity.state} size={42} reducedMotion />
          <span className="today-row-copy"><strong>{item.botName}</strong><small>{item.approvals.find(approval => approval.status === "pending")?.title || item.attention[0]?.title || item.activity.detail || stateLabels[item.activity.state]}</small></span><span aria-hidden="true">›</span>
        </button>)}</section>
      <section className="today-section"><h3>Since you were away</h3><p className="muted">Since <When value={overview.since} inline /></p>
        {!overview.events.length && <p>No new recorded results yet.</p>}
        {overview.events.map(event => <button className="today-row" type="button" key={event.id} onClick={() => event.routineId ? onOpen(event.botId, event.routineId) : onOpen(event.botId)}>
          <span className="today-row-copy"><strong>{bootstrap.bots.find(bot => bot.id === event.botId)?.name || "Assistant"}</strong>
            <small>{eventHeadline(event)}</small><small><When value={event.occurredAt} /></small></span><span aria-hidden="true">›</span></button>)}
        {overview.hasMore && <p className="muted">More recorded results are waiting. Mark this page caught up to load the next page.</p>}
        <button type="button" onClick={() => void caughtUp()}>{overview.hasMore ? "Mark this page caught up" : "Mark caught up"}</button>
      </section>
      {!!overview.upcoming?.length && <section className="today-section"><h3>Scheduled next</h3>{overview.upcoming.map(row=><button className="today-row" key={row.id} onClick={()=>onOpen(row.botId,row.id)}><span className="today-row-copy"><strong>{row.name}</strong><small>{bootstrap.bots.find(bot=>bot.id===row.botId)?.name} · <When value={row.nextRunAt!} /></small></span><span aria-hidden="true">›</span></button>)}</section>}
      {!!active.length && <section className="today-section"><h3>At work</h3>
        {active.map(item => <button className="today-row" type="button" key={item.botId} onClick={() => onOpen(item.botId)}><Avatar avatar={bootstrap.bots.find(bot => bot.id === item.botId)?.avatar} state={item.activity.state} name={item.botName} size={42} reducedMotion />
          <span className="today-row-copy"><strong>{item.botName}</strong><small>{item.activity.detail || stateLabels[item.activity.state]}</small></span><span aria-hidden="true">›</span></button>)}</section>}
      {!!files.length && <section className="today-section"><h3>Recent files</h3>{files.map(item => <button className="today-row" type="button" key={item.botId} onClick={() => onOpen(item.botId)}>
        <span className="today-row-copy"><strong>{item.botName}</strong><small>{item.files.slice(-3).map(file => file.name).join(" · ")}</small></span><span aria-hidden="true">›</span></button>)}</section>}
      {overview.unavailableBots.length > 0 && <p role="status" className="capability-note">Couldn't check {overview.unavailableBots.length} assistant{overview.unavailableBots.length === 1 ? "" : "s"}. Their current activity is unknown.</p>}
      <p className="muted today-timestamp">Checked <When value={checkedAt || overview.generatedAt} inline /> · updates every 30 seconds</p>
    </>}
  </div>;
}
