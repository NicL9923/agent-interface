import { useEffect, useState } from "react";
import { api, write } from "../client-api";
import { Avatar, stateLabels } from "./Avatar";
import { When } from "./When";
import { eventHeadline } from "../shared/event-copy";
import type { Bootstrap } from "../shared/types";
import type { TodayOverview } from "../shared/experience";
import "./experience.css";

export function TodayPanel({ bootstrap, onOpen }: { bootstrap: Bootstrap; onOpen: (botId: string, routineId?: string) => void }) {
  const [overview, setOverview] = useState<TodayOverview | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let current = true;
    async function refresh() {
      try { const result = await api<TodayOverview>("/today"); if (current) { setOverview(result); setError(""); } }
      catch (e) { if (current) setError((e as Error).message); }
      finally { if (current) setLoading(false); }
    }
    void refresh(); const timer = setInterval(() => void refresh(), 30_000);
    return () => { current = false; clearInterval(timer); };
  }, [bootstrap.user.id, reload]);
  const items = overview?.items || [];
  const attention = items.filter(item => !item.error && (item.approvals.some(approval => approval.status === "pending") || item.attention.length || ["blocked", "interrupted", "failed"].includes(item.activity.state)));
  const active = items.filter(item => !item.error && ["thinking", "working", "waiting"].includes(item.activity.state));
  const completed = overview?.events.filter(event => event.kind === "completed") || [];
  async function caughtUp() {
    if (!overview) return;
    try { await write("/today/seen", { seenAt: overview.generatedAt, frontier: overview.frontier }, "PUT"); setReload(reload + 1); }
    catch (e) { setError((e as Error).message); }
  }
  const files = items.filter(item => item.files.length);
  return <div className="today-panel"><div className="today-intro">
    {overview ? <div className="today-counts" aria-label="Household activity"><span><strong>{attention.length}</strong> need you</span>
      <span><strong>{active.length}</strong> at work</span><span><strong>{completed.length}</strong> {overview.hasMore ? "finished on this page" : "finished since your last visit"}</span></div>
      : <p role="status" className="muted">{loading ? "Checking your assistants..." : "Today is unavailable right now."}</p>}
    <button type="button" disabled={loading} onClick={() => { setLoading(true); setReload(reload + 1); }}>Refresh</button></div>
    {error && <p role="alert" className="form-error">{error} Loaded results may be out of date.</p>}
    {overview && <>
      <section className="today-section"><h3>Needs your attention</h3>{!attention.length && <p className="muted">No pending requests in the assistants we could check.</p>}
        {attention.map(item => <button className="today-row" type="button" key={item.botId} onClick={() => onOpen(item.botId)}>
          <Avatar avatar={bootstrap.bots.find(bot => bot.id === item.botId)?.avatar} name={item.botName} state={item.activity.state} size={42} />
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
        {active.map(item => <button className="today-row" type="button" key={item.botId} onClick={() => onOpen(item.botId)}><Avatar avatar={bootstrap.bots.find(bot => bot.id === item.botId)?.avatar} state={item.activity.state} name={item.botName} size={42} />
          <span className="today-row-copy"><strong>{item.botName}</strong><small>{item.activity.detail || stateLabels[item.activity.state]}</small></span><span aria-hidden="true">›</span></button>)}</section>}
      {!!files.length && <section className="today-section"><h3>Recent files</h3>{files.map(item => <button className="today-row" type="button" key={item.botId} onClick={() => onOpen(item.botId)}>
        <span className="today-row-copy"><strong>{item.botName}</strong><small>{item.files.slice(-3).map(file => file.name).join(" · ")}</small></span><span aria-hidden="true">›</span></button>)}</section>}
      {overview.unavailableBots.length > 0 && <p role="status" className="capability-note">Couldn't check {overview.unavailableBots.length} assistant{overview.unavailableBots.length === 1 ? "" : "s"}. Their current activity is unknown.</p>}
      <p className="muted today-timestamp">Checked <When value={overview.generatedAt} inline /> · updates every 30 seconds</p>
    </>}
  </div>;
}
