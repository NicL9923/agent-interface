import type { SaveItem } from "../shared/api";
import { useEffect, useRef, useState } from 'react';
import { ApiError, request } from '../client-api';
import { useAction } from '../app/use-action';
import { FormMessage } from './ui/form-message';
import type { Bootstrap, Message } from '../shared/types';
import type { AutomationOverview, HistoryPage, SavedItem, SearchHit, UsageSummary } from '../shared/discovery';
import { AgentExchange, isAgentExchange } from "./AgentExchange";
import { ActionReceipt } from "./ActionReceipt";
import { MessageMarkdown } from './MessageMarkdown';
import { isActivityMessage, messageOrigin } from '../shared/message-origin';
import { Icon } from "./Icon";
import { routineResultLabel, savedReplyTitle } from "../shared/discovery";
import { When } from './When';
/** Incremental search waits this long after typing stops, and starts at this many characters. */
type HistorySave = Extract<SaveItem, {kind:"session"}>;
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
  const [pageTitle,setPageTitle] = useState("Conversation history");
  const [pinned,setPinned] = useState<Set<string>>(new Set());
  const [savingKey,setSavingKey] = useState<string | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const activeTab = useRef<HTMLButtonElement>(null);
  const returning = useRef(false);
  const name = (id:string, fallback="Assistant") => bootstrap.bots.find(bot=>bot.id===id)?.name || fallback;
  const pinKey = (bot:string,session:string,message?:string) => JSON.stringify([bot,session,message || null]);
  const conversationTitle = (bot:string,session:string) => hits.find(hit=>hit.botId===bot&&hit.sessionId===session)?.title || saved.find(item=>item.botId===bot&&item.sessionId===session&&!item.messageId)?.title || "Saved conversation";
  const [savedMessage,setSavedMessage]=useState<string|undefined>();
  const {busy,error,notice,run,setNotice,reset}=useAction();
  function changeTab(next:typeof tab) { reset();setSavingKey(null);setPage(null);setTab(next); }
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
  useEffect(()=> { setPage(null); void run(async({current})=> {
    if(tab==='saved') {
      const items=await request("GET /saved");
      if(current()) { setSaved(items);setPinned(new Set(items.filter(item=>item.kind==='session'&&item.sessionId).map(item=>pinKey(item.botId,item.sessionId!,item.messageId)))); }
    }
    if(tab==='automations') { const value=await request("GET /automations");if(current())setOverview(value); }
  }); },[tab,bootstrap.user.id]);
  async function history(botId:string,sessionId:string,offset=0,messageId?:string,searchHit=false,title?:string) {
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
      setSavedMessage(messageId);
      setPageTitle(title || (page?.botId===botId&&page.sessionId===sessionId ? pageTitle : conversationTitle(botId,sessionId)));
      setPage(value);
    });
  }
  useEffect(()=>{if(savedMessage&&page)document.getElementById(`history-${savedMessage}`)?.scrollIntoView?.({block:"center"});},[page,savedMessage]);
  useEffect(()=>{if(!page&&returning.current){activeTab.current?.focus();returning.current=false;}},[page]);
  const back = () => { reset();setSavingKey(null);returning.current=true;setPage(null); };
  async function pin(item: HistorySave) {
    const key=pinKey(item.botId,item.sessionId!,item.messageId);
    if(busy||pinned.has(key))return;
    await run(async({current})=>{
      setSavingKey(key);
      try {
        await request("POST /saved", { body: item });
        if(current())setPinned(previous=>new Set([...previous,key]));
      } finally { if(current())setSavingKey(null); }
    },{success:'Saved. Find it in Saved items.'});
  }
  const saveControl = (item: HistorySave) => {
    const key=pinKey(item.botId,item.sessionId!,item.messageId), done=pinned.has(key);
    return <button className="history-save" aria-disabled={busy||done} onClick={()=>void pin(item)}>{done?"Saved":savingKey===key?"Saving…":item.messageId?"Save reply":"Save conversation"}</button>;
  };
  const speaker = (message:Message) => messageOrigin(message)?.kind==='scheduled'?'Scheduled':isActivityMessage(message)?'Activity':message.toolCall||isAgentExchange(message)?null:message.role==='assistant'?name(page!.botId):message.role==='user'?(message.sender?.id===bootstrap.user.id?'You':message.sender?.name||'User'):message.role==='system'?'System':'Tool';
  return <div className="discovery-panel">
    <nav className="view-tabs" aria-label="Search, saved items and automations">
      {(['search','saved','automations'] as const).map(value=><button key={value} ref={tab===value?activeTab:undefined} aria-pressed={tab===value} onClick={()=>changeTab(value)}>{value==='search'?'Search':value==='saved'?'Saved items':'Automations'}</button>)}
    </nav>
    {!page&&(error||searchError)&&<FormMessage tone="error">{error||searchError}</FormMessage>}{notice&&<FormMessage tone="notice">{notice}</FormMessage>}{busy&&<p role="status">Loading...</p>}
    {page ? <section className="discovery-history">
      <header className="history-heading">
        <button className="discovery-back" onClick={back}>‹ Back to results</button>
        <h2>{pageTitle}</h2><p>{name(page.botId)} · Read-only history</p>
        {error&&<FormMessage tone="error">{error}</FormMessage>}
      </header>
      <p className="muted discovery-hint">Read from Hermes. This view does not change the assistant's active conversation.</p>
      {saveControl({kind:'session',botId:page.botId,sessionId:page.sessionId,title:conversationTitle(page.botId,page.sessionId).slice(0,120)})}
      {page.messages.map(message=><article className="history-message" id={`history-${message.id}`} key={message.id} style={savedMessage===message.id?{borderLeft:"3px solid var(--accent)",paddingLeft:12}:undefined}>
        {(speaker(message)||message.role==='assistant'&&!isActivityMessage(message))&&<div className="history-message-heading">
          {speaker(message)&&<small>{speaker(message)}</small>}
          {message.role==='assistant'&&!isActivityMessage(message)&&saveControl({kind:'session',botId:page.botId,sessionId:page.sessionId,messageId:message.id,offset:page.offset,title:savedReplyTitle(message.text)})}
        </div>}
        {isActivityMessage(message)?<details><summary>{messageOrigin(message)?.title || "Activity details"}</summary><MessageMarkdown text={message.text}/></details>:isAgentExchange(message)?<AgentExchange message={message} recipient={name(page.botId)}/>:message.toolCall?<ActionReceipt call={message.toolCall}/>:<MessageMarkdown text={message.text}/>}
        {message.files?.map(file=><a key={file.id} href={`/api/files/${encodeURIComponent(file.id)}`} target="_blank" rel="noreferrer">{file.name}</a>)}
      </article>)}
      <div className="discovery-actions"><button disabled={busy||page.offset===0} onClick={()=>void history(page.botId,page.sessionId,Math.max(0,page.offset-100))}>Previous page</button><button disabled={busy||!page.hasMore} onClick={()=>void history(page.botId,page.sessionId,page.offset+100)}>Next page</button></div>
    </section> : <>
      {tab==='search'&&<>
        <form className="discovery-search" role="search" onSubmit={event=>{event.preventDefault();void find(query);}}>
          <div className="discovery-search-control"><input ref={searchInput} type="search" aria-label="Search conversations" placeholder="Answers, files, or a topic" maxLength={200} value={query} onChange={event=>setQuery(event.target.value)}/>
            {query&&<button className="discovery-search-clear" type="button" aria-label="Clear search" onClick={()=>{setQuery('');searchInput.current?.focus();}}><Icon name="close" size={16}/></button>}
          </div><button disabled={busy||!query.trim()}>Search</button>
        </form>
        <p className="sr-only" role="status">{searching?'Searching…':searched.current&&hits.length?`${hits.length} ${hits.length===1?'result':'results'}`:''}</p>
        <p className="muted discovery-hint">Searches answers, attachment names and routine previews across your assistants.</p>
        <div className="discovery-results" aria-busy={searching}>{hits.map(hit=><button className="today-row" key={`${hit.botId}:${hit.sessionId}`} onClick={()=>hit.routineId?onRoutine(hit.botId,hit.routineId,hit.resultId):live(hit)?onOpenMessage!(hit.botId,hit.messageId!):void history(hit.botId,hit.sessionId,hit.offset??0,hit.messageId,true,hit.title)}>
          <span className="today-row-copy"><strong>{hit.title}</strong><small>{name(hit.botId,hit.botName)} · {hit.routineId?'Routine output':live(hit)?'Current chat':'Past conversation'}{hit.updatedAt&&<> <span className="discovery-meta-part">· Updated <When value={hit.updatedAt}/></span></>}</small><small>{hit.snippet.replace(/<[^>]*>/g,'').slice(0,300)}</small></span><span aria-hidden="true">›</span>
        </button>)}</div>
      </>}
      {tab==='saved'&&<>
        <p className="muted discovery-hint">Links to original conversations and routine outputs. Removed originals may be unavailable.</p>
        {!saved.length&&<p className="discovery-empty">No saved items yet. Save a conversation from search or an output from routine results.</p>}
        {saved.map(item=><div className="saved-row" key={item.id}><button className="today-row" onClick={()=>item.kind==='session'?void history(item.botId,item.sessionId!,item.offset||0,item.messageId,false,item.title):onRoutine(item.botId,item.routineId!,item.resultId)}>
          <span className="today-row-copy"><strong>{item.title}</strong><small>{name(item.botId)} · {item.kind==='routine'?'Routine output':item.messageId?'Reply':'Conversation'} <span className="discovery-meta-part">· Saved <When value={item.createdAt}/></span></small></span>
        </button><button aria-label={`Remove ${item.title}`} disabled={busy} onClick={()=>void run(async()=>{await request("DELETE /saved/:id", { params: { id: item.id } });setSaved(saved.filter(row=>row.id!==item.id));if(item.kind==='session'&&item.sessionId)setPinned(previous=>{const next=new Set(previous);next.delete(pinKey(item.botId,item.sessionId!,item.messageId));return next;});})}>Remove</button></div>)}
      </>}
      {tab==='automations'&&<>
        <div className="discovery-toolbar"><p className="muted discovery-hint">Upcoming work, recent failures, recipients and 30-day usage.</p><button disabled={busy} onClick={()=>void run(async()=>setOverview(await request("GET /automations")))}>Refresh</button></div>
        {overview?.routines.map(row=><article className="automation-row" key={row.id}>
          <h3>{row.name}</h3><p>{name(row.botId)} · <span className={`discovery-state${row.enabled?'':' paused'}`}>{row.enabled?'Enabled':'Paused'}</span></p>
          <p>{!row.enabled?'Paused. No runs until you resume.':row.nextRunAt?<>Next: <When value={row.nextRunAt}/></>:'No upcoming run reported'}</p>
          {row.lastStatus&&<p><span className={row.lastError||row.lastDeliveryError?'automation-failure':undefined}>Last result: {routineResultLabel(row.lastStatus)}</span></p>}
          {(row.lastError||row.lastDeliveryError)&&<p role="status" className="form-error">{row.lastError||row.lastDeliveryError}</p>}
          <p>Notify: {row.recipientIds?.map(id=>bootstrap.household.find(user=>user.id===id)?.name||'Household member').join(', ')||'No routine recipients selected'}</p>
          <div className="discovery-actions"><button onClick={()=>onRoutine(row.botId,row.id)}>View outputs</button><button disabled={busy} onClick={()=>void run(async()=>{await request("PATCH /routines/:id/state", { params: { id: row.id }, body: { enabled: !row.enabled } });setOverview(await request("GET /automations"));})}>{row.enabled?'Pause':'Resume'}</button></div>
        </article>)}
        {overview&&!overview.routines.length&&<p className="discovery-empty">No routines yet. Create one in assistant settings.</p>}
        <h3>Usage over 30 days</h3><p className="muted discovery-hint">Recorded main-session usage. Estimates and provider invoices may differ. Auxiliary calls are not included.</p>
        <Usage rows={overview?.usage||[]} name={name}/>
        {!!overview?.unavailableBots.length&&<p role="status">Usage unavailable for {overview.unavailableBots.length} assistant(s).</p>}
      </>}
    </>}
  </div>;
}
function Usage({rows,name}:{rows:UsageSummary[];name:(id:string)=>string}) {
  const cost=(value:number|null)=>value===null?'Unknown':`$${value.toFixed(2)}`;
  const reported=(row:UsageSummary)=>cost(row.actualCost)+(row.actualCost!==null&&row.partial?' (partial)':'');
  return <>
    <div className="usage-table-wrapper"><table className="usage-table"><caption className="sr-only">Recorded main-session usage over 30 days</caption>
      <thead><tr><th scope="col">Assistant</th><th scope="col">Sessions</th><th scope="col">Tokens</th><th scope="col">Reported cost</th><th scope="col">Estimate</th></tr></thead>
      <tbody>{rows.map(row=><tr key={row.botId}><th scope="row">{name(row.botId)}</th><td>{row.sessions}</td><td>{row.inputTokens.toLocaleString()} input<br/>{row.outputTokens.toLocaleString()} output</td><td>{reported(row)}</td><td>{cost(row.estimatedCost)}</td></tr>)}</tbody>
    </table></div>
    <div className="usage-stack">{rows.map(row=><article className="automation-row" key={row.botId}><strong>{name(row.botId)}</strong><p>{row.sessions} sessions · {row.inputTokens.toLocaleString()} input / {row.outputTokens.toLocaleString()} output tokens</p><p>Reported cost: {reported(row)} · Estimate: {cost(row.estimatedCost)}</p></article>)}</div>
  </>;
}
