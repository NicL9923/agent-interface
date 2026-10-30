import { routeUrl } from "../shared/api";
import { useState } from "react";
import { request } from "../client-api";
import { useAction } from "../app/use-action";
import { useResource } from "../app/use-resource";
import { FormMessage } from "./ui/form-message";
import { Avatar, stateLabels } from "./Avatar";
import { Icon } from "./Icon";
import { When } from "./When";
import { eventHeadline } from "../shared/event-copy";
import type { Bootstrap } from "../shared/types";
import type { TodayItem } from "../shared/experience";
import "./experience.css";

function attentionCopy(item: TodayItem) {
  if (item.error) return { title: item.error, reason: "Disconnected", action: "Reconnect", failed: true };
  const approval = item.approvals.find(value => value.status === "pending");
  if (approval) return { title: approval.title, reason: "Approval", action: "Review", failed: false };
  const question = item.attention[0];
  if (question) return { title: question.title, reason: question.kind === "clarify" ? "Question" : question.kind === "secure" ? "Secure request" : "Needs your help", action: question.kind === "clarify" ? "Answer" : "Review", failed: false };
  const failed = item.activity.state === "failed" || item.activity.state === "interrupted";
  return { title: item.activity.detail || stateLabels[item.activity.state], reason: stateLabels[item.activity.state], action: failed ? "View error" : "Review", failed };
}

export function TodayPanel({ bootstrap, onOpen }: { bootstrap: Bootstrap; onOpen: (botId: string, routineId?: string) => void }) {
  // A 304 keeps generatedAt, so record when this client last confirmed the overview.
  const [checkedAt, setCheckedAt] = useState("");
  const today = useResource(routeUrl("GET /today", {}), { load: (_, signal) => request("GET /today", { signal }), deps: [bootstrap.user.id], pollMs: 30_000, onData: () => setCheckedAt(new Date().toISOString()) });
  const { data: overview, loading } = today;
  const seen = useAction();
  const error = seen.error || today.error;
  const items = overview?.items || [];
  const attention = items.filter(item => item.error || (item.approvals.some(approval => approval.status === "pending") || item.attention.length || ["blocked", "interrupted", "failed"].includes(item.activity.state)));
  const active = items.filter(item => !item.error && ["thinking", "working", "waiting"].includes(item.activity.state));
  const working = active.filter(item => !attention.some(other => other.botId === item.botId));
  const completed = overview?.events.filter(event => event.kind === "completed") || [];
  const bot = (id: string) => bootstrap.bots.find(value => value.id === id);
  const avatar = (id: string, name: string) => <span className="today-avatar" aria-hidden="true"><Avatar avatar={bot(id)?.avatar} name={name} state="idle" size={36} reducedMotion /></span>;
  const caughtUp = () => overview && seen.run(async () => {
    await request("PUT /today/seen", { body: { seenAt: overview.generatedAt, frontier: overview.frontier } });
    await today.reload();
  });
  const files = items.filter(item => item.files.length);
  const unchecked = overview?.unavailableBots.filter(id => !items.some(item => item.botId === id && item.error)) || [];
  return <div className="today-panel"><div className="today-content">
    <div className="today-status">
      <p className="muted today-timestamp" role={overview ? undefined : "status"} title="Updates every 30 seconds">{overview ? <>Checked <When value={checkedAt || overview.generatedAt} inline /></> : loading ? "Checking your assistants..." : "Today is unavailable right now."}</p>
      <button type="button" disabled={loading} onClick={() => void today.reload()}><Icon name="refresh" size={16} />Refresh</button>
    </div>
    {error && <FormMessage tone="error">{error} Loaded results may be out of date.</FormMessage>}
    {overview && <>
      <div className="today-summary" role="group" aria-label="Household activity">
        {!attention.length && <span className="today-clear"><Icon name="check" size={18} />{overview.unavailableBots.length ? "No requests in checked assistants" : "All clear"}</span>}
        {!!attention.length && <span><strong>{attention.length}</strong> need you</span>}
        <span><strong>{working.length}</strong> at work</span>
        <span><strong>{completed.length}</strong> finished</span>
      </div>
      {!!attention.length && <section className="today-section today-attention" aria-labelledby="today-attention-title">
        <h3 id="today-attention-title">Needs your attention <span>{attention.length}</span></h3>
        <div className="today-attention-list">{attention.map(item => {
          const copy = attentionCopy(item);
          return <button className="today-row" type="button" key={item.botId} onClick={() => onOpen(item.botId)}>
            {avatar(item.botId, item.botName)}
            <span className="today-row-copy"><strong>{copy.title}</strong><small>{item.botName} · <span className={copy.failed ? "today-reason failed" : "today-reason"}>{copy.reason}</span></small></span>
            <span className="today-row-action">{copy.action}</span>
          </button>;
        })}</div>
      </section>}
      <section className="today-section" aria-labelledby="today-recap-title">
        <div className="today-section-heading"><h3 id="today-recap-title">Since you were away</h3>
          <button type="button" disabled={seen.busy} onClick={() => void caughtUp()}>{overview.hasMore ? "Mark this page caught up" : "Mark caught up"}</button></div>
        <p className="today-section-note">Since <When value={overview.since} inline /></p>
        {!overview.events.length && <p className="today-empty">You're caught up. New results will appear here.</p>}
        {overview.events.map(event => {
          const name = bot(event.botId)?.name || "Assistant";
          return <button className="today-row" type="button" key={event.id} onClick={() => event.routineId ? onOpen(event.botId, event.routineId) : onOpen(event.botId)}>
            {avatar(event.botId, name)}
            <span className="today-row-copy"><strong>{eventHeadline(event)}</strong><small>{name} · <When value={event.occurredAt} /></small></span><Icon name="chevron" size={16} />
          </button>;
        })}
        {overview.hasMore && <p className="today-section-note today-more">More results are waiting. Mark this page caught up to see them.</p>}
      </section>
      {(!!working.length || !!overview.upcoming?.length) && <section className="today-section" aria-labelledby="today-next-title"><h3 id="today-next-title">Up next</h3>
        {working.map(item => <button className="today-row" type="button" key={item.botId} onClick={() => onOpen(item.botId)}>
          {avatar(item.botId, item.botName)}
          <span className="today-row-copy"><strong>{item.activity.detail || item.botName}</strong><small>{item.activity.detail && <>{item.botName} · </>}{stateLabels[item.activity.state]}</small></span><Icon name="chevron" size={16} />
        </button>)}
        {overview.upcoming?.map(row => {
          const name = bot(row.botId)?.name || "Assistant";
          return <button className="today-row" type="button" key={row.id} onClick={() => onOpen(row.botId, row.id)}>
            {avatar(row.botId, name)}<span className="today-row-copy"><strong>{row.name}</strong><small>{name} · Scheduled{row.nextRunAt && <> · <When value={row.nextRunAt} /></>}</small></span><Icon name="chevron" size={16} />
          </button>;
        })}
      </section>}
      {!!files.length && <section className="today-section" aria-labelledby="today-files-title"><h3 id="today-files-title">Recent files</h3>{files.map(item => <button className="today-row" type="button" key={item.botId} onClick={() => onOpen(item.botId)}>
        {avatar(item.botId, item.botName)}<span className="today-row-copy"><span className="today-file-list">{item.files.slice(-3).map(file => <span className="today-file" key={file.id}><Icon name="file" size={14} />{file.name}</span>)}</span><small>{item.botName}</small></span><Icon name="chevron" size={16} /></button>)}</section>}
      {unchecked.length > 0 && <p role="status" className="capability-note">Couldn't check {unchecked.length} assistant{unchecked.length === 1 ? "" : "s"}. Their current activity is unknown.</p>}
    </>}
  </div></div>;
}
