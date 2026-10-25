import type { SaveItem } from "../shared/api";
import { useEffect, useRef, useState } from 'react';
import { ApiError, request } from '../client-api';
import { useAction } from '../app/use-action';
import { FormMessage } from './ui/form-message';
import type { Bootstrap } from '../shared/types';
import type { AutomationOverview, HistoryPage, SavedItem, SearchHit } from '../shared/discovery';
import { AgentExchange, isAgentExchange } from "./AgentExchange";
import { ActionReceipt } from "./ActionReceipt";
import { MessageMarkdown } from './MessageMarkdown';
import { isActivityMessage, messageOrigin } from '../shared/message-origin';
import { When } from './When';
/** Incremental search waits this long after typing stops, and starts at this many characters. */
export const SEARCH_DEBOUNCE_MS = 300, SEARCH_MIN_CHARS = 2;
export function DiscoveryPanel({ bootstrap, search, onRoutine, onOpenMessage }: {
  bootstrap: Bootstrap;
  /** Words to search for at once, as from the command palette. A new id searches again. */
  search?: { text: string; id: number };
  onRoutine: (botId:string,routineId:string,resultId?:string)=>void;
  /** Opens the live conversation at a message, for hits in an assistant's current session. */
  onOpenMessage?: (botId: string, messageId: string) => void;
}) {
  const [tab,setTab] = useState<'search'|'saved'|'automations'>('search');
  const [query,setQuery] = useState(''); const [hits,setHits] = useState<SearchHit[]>([]); const [saved,setSaved] = useState<SavedItem[]>([]);
  const [overview,setOverview] = useState<AutomationOverview|null>(null); const [page,setPage] = useState<HistoryPage|null>(null);
  const [savedMessage,setSavedMessage]=useState<string|undefined>();
  const {busy,error,notice,run,setNotice,reset}=useAction();
  function changeTab(next:typeof tab) { reset();setPage(null);setTab(next); }
  // Each search outdates the ones before it, so a slow answer for older words never replaces newer results.
  const searchSeq=useRef(0);const searched=useRef('');const [searching,setSearching]=useState(false);const [searchError,setSearchError]=useState('');
  async function find(text:string) {
    const seq=++searchSeq.current;searched.current=text.trim();
    setSearching(true);setSearchError('');
    try {
      const result=await request("GET /search", { query: { q: text.trim() } });
      if(seq!==searchSeq.current)return;
      setHits(result.hits);setNotice(result.unavailableBots.length?`Could not search ${result.unavailableBots.length} assistant(s).`:result.hits.length?'':'No matching conversations.');
    } catch(cause) { if(seq===searchSeq.current)setSearchError((cause as Error).message); }
    finally { if(seq===searchSeq.current)setSearching(false); }
  }
  useEffect(()=>{
    if(tab!=='search')return;
    const text=query.trim();
    if(text===searched.current)return;
    if(text.length<SEARCH_MIN_CHARS){searchSeq.current++;searched.current='';setSearching(false);if(!text){setHits([]);setNotice('');}return;}
    // Enter may already have searched these words meanwhile.
    const timer=setTimeout(()=>{if(text!==searched.current)void find(text);},SEARCH_DEBOUNCE_MS);
    return()=>clearTimeout(timer);
  },[query,tab]);
  useEffect(()=>{ if(!search)return; changeTab('search');setQuery(search.text);if(search.text.trim())void find(search.text); },[search?.id]);
  const live=(hit:SearchHit)=>!!onOpenMessage&&!!hit.messageId&&bootstrap.bots.find(bot=>bot.id===hit.botId)?.sessionId===hit.sessionId;
  useEffect(()=> { setPage(null); void run(async()=> { if(tab==='saved') setSaved(await request("GET /saved")); if(tab==='automations') setOverview(await request("GET /automations")); }); },[tab,bootstrap.user.id]);
  async function history(botId:string,sessionId:string,offset=0,messageId?:string,searchHit=false) {
    await run(async({current})=> {
      const params = { botId, sessionId };
      let value:HistoryPage;
      try { value=await request("GET /bots/:botId/history/:sessionId", { params, query: { offset, messageId } }); }
      catch(error) {
        if(!searchHit||!messageId||!(error instanceof ApiError)||error.status!==404)throw error;
        if(!current())return;
        value=await request("GET /bots/:botId/history/:sessionId", { params, query: { offset: 0 } });messageId=undefined;
      }
      if(!current())return;
      messageId=value.targetMessageId??messageId;
      if(messageId&&!value.messages.some(message=>message.id===messageId))throw new Error('This saved reply is unavailable. Its original history changed in Hermes.');
      setSavedMessage(messageId);setPage(value);
    });
  }
  useEffect(()=>{if(savedMessage&&page)document.getElementById(`history-${savedMessage}`)?.scrollIntoView?.({block:"center"});},[page,savedMessage]);
  async function pin(item: SaveItem) { await run(()=>request("POST /saved", { body: item }),{success:'Saved. Find it in Saved items.'}); }
  return <div className="discovery-panel"><nav className="view-tabs" aria-label="Search and saved"><button aria-pressed={tab==='search'} onClick={()=>changeTab('search')}>Search</button><button aria-pressed={tab==='saved'} onClick={()=>changeTab('saved')}>Saved items</button><button aria-pressed={tab==='automations'} onClick={()=>changeTab('automations')}>Automations</button></nav>
    {(error||searchError)&&<FormMessage tone="error">{error||searchError}</FormMessage>}{notice&&<FormMessage tone="notice">{notice}</FormMessage>}{busy&&<p role="status">Loading...</p>}
    {page ? <section><button className="discovery-back" onClick={()=>setPage(null)}>‹ Back to results</button><h2>Conversation history</h2><p className="muted">Read from Hermes. This view does not change the assistant’s active conversation.</p>
      <button disabled={busy} onClick={()=>void pin({kind:'session',botId:page.botId,sessionId:page.sessionId,title:hits.find(hit=>hit.sessionId===page.sessionId)?.title.slice(0,120)||'Saved conversation'})}>Save conversation</button>
      {page.messages.map(message=><article className="history-message" id={`history-${message.id}`} key={message.id} style={savedMessage===message.id?{borderLeft:"3px solid var(--accent)",paddingLeft:12}:undefined}><small>{messageOrigin(message)?.kind === 'scheduled' ? 'Scheduled' : isActivityMessage(message) ? 'Activity' : message.role}</small>{message.role==='assistant'&&!isActivityMessage(message)&&<button disabled={busy} onClick={()=>void pin({kind:"session",botId:page.botId,sessionId:page.sessionId,messageId:message.id,offset:page.offset,title:message.text.replace(/[#*_`]/g," ").trim().slice(0,120)||"Saved reply"})}>Save reply</button>}<>{isActivityMessage(message)?<details><summary>{messageOrigin(message)?.title || "Activity details"}</summary><MessageMarkdown text={message.text}/></details>:isAgentExchange(message)?<AgentExchange message={message} recipient={bootstrap.bots.find(bot=>bot.id===page.botId)?.name||"Assistant"}/>:message.toolCall?<ActionReceipt call={message.toolCall}/>:<MessageMarkdown text={message.text}/>}</>{message.files?.map(file=><a key={file.id} href={`/api/files/${encodeURIComponent(file.id)}`} target="_blank" rel="noreferrer">{file.name}</a>)}</article>)}
      <div className="discovery-actions"><button disabled={busy||page.offset===0} onClick={()=>void history(page.botId,page.sessionId,Math.max(0,page.offset-100))}>Previous page</button><button disabled={busy||!page.hasMore} onClick={()=>void history(page.botId,page.sessionId,page.offset+100)}>Next page</button></div></section> : <>
    {tab==='search'&&<><form className="discovery-search" role="search" onSubmit={event=>{event.preventDefault();void find(query);}}><input type="search" aria-label="Search conversations" placeholder="Answers, files, or a topic" maxLength={200} value={query} onChange={event=>setQuery(event.target.value)}/><button disabled={busy||!query.trim()}>Search</button></form><p className="sr-only" role="status">{searching?'Searching…':searched.current&&hits.length?`${hits.length} ${hits.length===1?'result':'results'}`:''}</p><p className="muted discovery-hint">Searches answers, attachment names and routine previews across your assistants.</p>
      <div className="discovery-results" aria-busy={searching}>{hits.map(hit=><button className="today-row" key={`${hit.botId}:${hit.sessionId}`} onClick={()=>hit.routineId?onRoutine(hit.botId,hit.routineId,hit.resultId):live(hit)?onOpenMessage!(hit.botId,hit.messageId!):void history(hit.botId,hit.sessionId,hit.offset??0,hit.messageId,true)}><span className="today-row-copy"><strong>{hit.title}</strong><small>{hit.botName}</small><small>{hit.snippet.replace(/<[^>]*>/g,'').slice(0,300)}</small></span><span aria-hidden="true">›</span></button>)}</div></>}
    {tab==='saved'&&<><p className="muted discovery-hint">Links to original conversations and routine outputs. Removed originals may be unavailable.</p>{!saved.length&&<p className="discovery-empty">No saved items yet. Save a conversation from search or an output from routine results.</p>}{saved.map(item=><div className="saved-row" key={item.id}><button className="today-row" onClick={()=>item.kind==='session'?void history(item.botId,item.sessionId!,item.offset||0,item.messageId):onRoutine(item.botId,item.routineId!,item.resultId)}><span className="today-row-copy"><strong>{item.title}</strong><small>{bootstrap.bots.find(bot=>bot.id===item.botId)?.name} · {item.kind==='routine'?'Routine output':'Conversation'}</small></span></button><button aria-label={`Remove ${item.title}`} onClick={()=>void run(async()=>{await request("DELETE /saved/:id", { params: { id: item.id } });setSaved(saved.filter(row=>row.id!==item.id));})}>Remove</button></div>)}</>}
    {tab==='automations'&&<><div className="discovery-toolbar"><p className="muted discovery-hint">Upcoming work, recent failures and who receives results.</p><button disabled={busy} onClick={()=>void run(async()=>setOverview(await request("GET /automations")))}>Refresh</button></div>{overview?.routines.map(row=><article className="automation-row" key={row.id}><h3>{row.name}</h3><p>{bootstrap.bots.find(bot=>bot.id===row.botId)?.name} · {row.enabled?'Enabled':'Paused'}</p><p>{row.nextRunAt&&row.enabled?<>Next: <When value={row.nextRunAt} /></>:'No upcoming run reported'}{row.lastStatus&&` · Last result: ${row.lastStatus}`}</p>{(row.lastError||row.lastDeliveryError)&&<p role="status" className="form-error">{row.lastError||row.lastDeliveryError}</p>}<p>Notify: {row.recipientIds?.map(id=>bootstrap.household.find(user=>user.id===id)?.name||'Household member').join(', ')||'No routine recipients selected'}</p><div className="discovery-actions"><button onClick={()=>onRoutine(row.botId,row.id)}>View outputs</button><button disabled={busy} onClick={()=>void run(async()=>{await request("PATCH /routines/:id/state", { params: { id: row.id }, body: { enabled: !row.enabled } });setOverview(await request("GET /automations"));})}>{row.enabled?'Pause':'Resume'}</button></div></article>)}{overview&&!overview.routines.length&&<p className="discovery-empty">No routines yet. Create one in assistant settings.</p>}
      <h3>Usage over 30 days</h3><p className="muted">Recorded main-session usage. Estimates and provider invoices may differ. Auxiliary calls are not included.</p>{overview?.usage.map(usage=><article className="automation-row" key={usage.botId}><strong>{bootstrap.bots.find(bot=>bot.id===usage.botId)?.name}</strong><p>{usage.sessions} sessions · {usage.inputTokens.toLocaleString()} input / {usage.outputTokens.toLocaleString()} output tokens</p><p>Reported cost: {usage.actualCost===null?'Unknown':`$${usage.actualCost.toFixed(2)}${usage.partial?' (partial)':''}`} · Estimate: {usage.estimatedCost===null?'Unknown':`$${usage.estimatedCost.toFixed(2)}`}</p></article>)}{!!overview?.unavailableBots.length&&<p role="status">Usage unavailable for {overview.unavailableBots.length} assistant(s).</p>}</>}
    </>}
  </div>;
}
