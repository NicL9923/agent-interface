import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { createHermesRuntime } from '../src/server/hermes.js';
import type { Runtime, Submission } from '../src/shared/types.js';

// Isolated wire-contract regressions. Real Hermes execution evidence lives in the spike probes.
const token='isolated-contract-token';
const revision='b9cb268deffc97946ec11645aa622a7353dd0591';
let reportedRevision:string;
let snapshot:Record<string,any>;
let calls:{method:string;params:Record<string,any>}[];
let sockets:WireSocket[];
let runtime:Runtime;
let addonReady:boolean;
let metadataConflict:boolean;
let connectionFails:boolean;
let imageReady:boolean;
let opening: 'open' | 'close' | 'hang';
let deferredMethods: Set<string>;
let rpcErrors: Map<string, {code:number; message:string}>;
let beforeSend: ((request:Record<string,any>,socket:WireSocket)=>void) | undefined;
class WireSocket extends EventTarget {
  static CONNECTING=0;
  static OPEN=1;
  static CLOSING=2;
  static CLOSED=3;
  readyState=WireSocket.CONNECTING;
  readonly url: URL;
  constructor(_url:string|URL){super();this.url=new URL(_url);sockets.push(this);queueMicrotask(()=>{
    if (opening === 'hang') return;
    if (opening === 'close') {this.close(); return;}
    if(connectionFails){this.dispatchEvent(new Event('error'));this.close();}
    else {this.readyState=WireSocket.OPEN;this.dispatchEvent(new Event('open'));}
  });}
  receive(frame:unknown){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(frame)}));}
  send(text:string){
    const request=JSON.parse(text);
    beforeSend?.(request,this);
    if (this.readyState !== WireSocket.OPEN) throw new Error('Cannot send on a closing socket.');
    calls.push(request);
    if (deferredMethods.has(request.method)) return;
    if (rpcErrors.has(request.method)) {
      queueMicrotask(()=>this.receive({jsonrpc:'2.0',id:request.id,error:rpcErrors.get(request.method)}));
      return;
    }
    let result:unknown={};
    if(request.method==='agent-interface.capabilities')result={revision:reportedRevision,durable_admission:true,durable_events:addonReady,canonical_open:addonReady,executor_epoch:'epoch-one'};
    if(request.method==='agent-interface.open')result=structuredClone(snapshot);
    if(request.method==='file.attach')result={path:'/workspace/staged/portrait.png'};
    if(request.method==='agent-interface.submit')result={requestId:request.params.request_id,status:'accepted',runId:'task-one'};
    if(request.method==='profiles.list')result={profiles:[{name:'shared',ui_meta:{agent_interface:{name:'Shared',unrelated:'preserve'}},ui_meta_revisions:{agent_interface:3}}]};
    if(request.method==='profiles.describe')result={toolsets:[{name:'terminal',enabled:true}],skills:[],mcp_servers:[]};
    if(request.method==='profiles.configure')result=metadataConflict?{ok:false,applied:{ui_meta:false,ui_meta_conflicts:{agent_interface:{actual:4}}}}:{ok:true,applied:{ui_meta:true}};
    if(request.method==='image.generate')result={available:imageReady,success:false,error:'No image generation backend configured'};
    if(request.method==='profiles.set_asset')result={ok:true};
    queueMicrotask(()=>this.receive({jsonrpc:'2.0',id:request.id,result}));
  }
  close(){this.readyState=3;this.dispatchEvent(new Event('close'));}
}
beforeEach(()=>{
  reportedRevision=revision;
  snapshot={session_id:'live-one',canonical_stored_session_id:'stored-one',info:{running:false},messages:[]};calls=[];sockets=[];addonReady=true;metadataConflict=false;connectionFails=false;imageReady=false;opening='open';deferredMethods=new Set();rpcErrors=new Map();beforeSend=undefined;
  vi.stubGlobal('WebSocket',WireSocket);
  vi.stubGlobal('fetch',vi.fn(async()=>Response.json({profiles:[]})));
  runtime=createHermesRuntime({url:'http://127.0.0.1:19119',token});
});
afterEach(async()=>{await runtime.close();vi.useRealTimers();vi.unstubAllGlobals();});
const input=(attachments:Submission['attachments']=[]):Submission=>({requestId:'request-one',botId:'shared',senderId:'person-one',text:'',attachments});

describe('Hermes adapter trust and recovery boundary',()=>{
  it('exposes real streamed reasoning and keeps working while a tool is running', async () => {
    snapshot.info.running = true;
    await runtime.conversation('shared');
    const event = (type:string,payload:Record<string,unknown>) => sockets[0].receive({method:'event',params:{session_id:'live-one',type,payload}});
    event('message.start', {});
    event('reasoning.delta', {text:'Exposed provider explanation.'});
    event('thinking.delta', {text:'Still waiting for the provider…'});
    const waiting = await runtime.conversation('shared');
    expect(waiting.activity.detail).toBe('Still waiting for the provider…');
    expect(waiting.messages.at(-1)?.reasoning).toBe('Exposed provider explanation.');
    event('tool.start', {tool_id:'call-one',name:'terminal',args:{command:'printf synthetic'}});
    event('message.delta', {text:'A streamed answer'});
    const working = await runtime.conversation('shared');
    expect(working.activity).toMatchObject({state:'working',detail:'Using terminal'});
    expect(working.messages.at(-1)).toMatchObject({text:'A streamed answer',reasoning:'Exposed provider explanation.'});
    expect(working.toolCalls).toMatchObject([{id:'call-one',name:'terminal',arguments:'{\n  "command": "printf synthetic"\n}',status:'running'}]);
    event('tool.complete', {tool_id:'call-one',name:'terminal',result:{output:'synthetic',exit_code:1,error:'Command failed'}});
    const finishedTool = await runtime.conversation('shared');
    expect(finishedTool.activity.state).toBe('thinking');
    expect(finishedTool.toolCalls).toMatchObject([{id:'call-one',status:'failed',error:'Command failed'}]);
    expect(finishedTool.toolCalls![0].startedAt).toBeDefined();
    expect(finishedTool.toolCalls![0].completedAt).toBeDefined();
  });
  it('recovers running tool details and reasoning from an authoritative cold snapshot', async () => {
    snapshot.info.running = true;
    snapshot.app_tool_calls = [{id:'run:call',name:'web_search',arguments:'{"query":"synthetic"}',status:'running'}];
    snapshot.inflight = {reasoning:'Exposed native reasoning without answer text'};
    const cold = await runtime.conversation('shared');
    expect(cold.activity).toMatchObject({state:'working',detail:'Using web_search'});
    expect(cold.toolCalls).toEqual(snapshot.app_tool_calls);
    expect(cold.messages.at(-1)).toMatchObject({text:'',reasoning:snapshot.inflight.reasoning});
  });
  it('settles missed streamed completion without adding stale reasoning to canonical history', async () => {
    snapshot.info.running = true;
    await runtime.conversation('shared');
    sockets[0].receive({method:'event',params:{session_id:'live-one',type:'reasoning.delta',payload:{text:'Partial live explanation'}}});
    snapshot.info.running = false;
    snapshot.inflight = null;
    snapshot.messages = [{role:'assistant',row_id:8,text:'The durable answer',reasoning:'The complete exposed explanation'}];
    const settled = await runtime.conversation('shared');
    expect(settled.messages).toHaveLength(1);
    expect(settled.messages[0]).toMatchObject({text:'The durable answer',reasoning:'The complete exposed explanation'});
  });
  it('drops old streamed detail when another turn begins during a disconnected gap', async () => {
    snapshot.info.running = true;
    snapshot.app_run_id = 'old-run';
    await runtime.conversation('shared');
    sockets[0].receive({method:'event',params:{session_id:'live-one',type:'reasoning.delta',payload:{text:'Old run partial reasoning'}}});
    sockets[0].receive({method:'event',params:{session_id:'live-one',type:'tool.start',payload:{tool_id:'old-tool',name:'terminal'}}});
    sockets[0].close();
    snapshot.app_run_id = 'different-run';
    snapshot.inflight = {assistant:'',streaming:true};
    snapshot.messages = [{role:'assistant',row_id:8,text:'Completed prior answer',reasoning:'Completed prior reasoning'}];
    await runtime.reconnect!();
    const current = await runtime.conversation('shared');
    expect(current.messages).toHaveLength(1);
    expect(current.messages[0].reasoning).toBe('Completed prior reasoning');
    expect(current.toolCalls).toEqual([]);
    expect(current.activity.state).toBe('thinking');
  });
  it('preserves durable actual tool input/output and does not keep an idle bot working', async () => {
    snapshot.messages = [{role:'tool',row_id:7,name:'terminal',tool_call_id:'call-one',args:{command:'synthetic'},
      app_tool_result:{output:'completed',exit_code:0},app_tool_call:{id:'run-one:call-one',name:'terminal',arguments:'{"command":"synthetic"}',status:'completed',result:'actual result',startedAt:'2026-09-30T00:00:00Z',completedAt:'2026-09-30T00:00:01Z'}}];
    await runtime.conversation('shared');
    sockets[0].receive({method:'event',params:{session_id:'live-one',type:'tool.start',payload:{tool_id:'later-call',name:'terminal'}}});
    const idle = await runtime.conversation('shared');
    expect(idle.activity.state).toBe('idle');
    expect(idle.toolCalls).toEqual([]);
    expect(idle.messages[0].toolCall).toEqual(snapshot.messages[0].app_tool_call);
    expect(idle.messages[0].text).toContain('completed');
  });
  it('reports both qualified actual revisions and rejects unknown revisions', async () => {
    for (const actual of [revision, 'd23cc6b06455b8551fb6f61d3cad040a0e82f5b6']) {
      await runtime.close(); reportedRevision = actual;
      runtime = createHermesRuntime({url: 'http://127.0.0.1:19119', token});
      expect(await runtime.status()).toMatchObject({connected: true, version: actual});
    }
    await runtime.close(); reportedRevision = 'unknown-unqualified-revision';
    runtime = createHermesRuntime({url: 'http://127.0.0.1:19119', token});
    expect(await runtime.status()).toMatchObject({connected: false, code: 'incompatible'});
  });

  it('uses a fresh single-use ticket and private prefixed bearer HTTP routes in service mode', async () => {
    await runtime.close();
    const fetch = vi.fn(async (url: URL | string) => String(url).endsWith('/service-ticket')
      ? Response.json({ticket: 't'.repeat(43)}) : Response.json({profiles: []}));
    vi.stubGlobal('fetch', fetch);
    runtime = createHermesRuntime({url: 'http://127.0.0.1:19119', token, authMode: 'service'});
    expect(await runtime.status()).toMatchObject({connected: true});
    expect(sockets[0].url.searchParams.get('ticket')).toBe('t'.repeat(43));
    expect(sockets[0].url.searchParams.has('token')).toBe(false);
    expect(fetch.mock.calls[0][0].toString()).toBe('http://127.0.0.1:19119/api/agent-interface/service-ticket');
    const request = (fetch.mock.calls as unknown as [URL, RequestInit][])[0][1];
    expect(request).toMatchObject({method: 'POST', headers: {Authorization: `Bearer ${token}`}});
    await runtime.deleteBot('shared');
    const deletion = (fetch.mock.calls as unknown as [URL, RequestInit][]).find(([url]) => url.pathname.includes('/service/profiles/'))!;
    expect(deletion[0].pathname).toBe('/api/agent-interface/service/profiles/shared');
    expect(new Headers(deletion[1].headers).get('Authorization')).toBe(`Bearer ${token}`);
    expect(new Headers(deletion[1].headers).has('X-Hermes-Session-Token')).toBe(false);
    sockets[0].close();
    await runtime.reconnect!();
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/service-ticket'))).toHaveLength(2);
  });

  it('fails service authentication without opening a socket when ticket issuance rejects the credential', async () => {
    await runtime.close(); vi.stubGlobal('fetch', vi.fn(async () => Response.json({error: 'Denied'}, {status: 401})));
    runtime = createHermesRuntime({url: 'http://127.0.0.1:19119', token, authMode: 'service'});
    expect(await runtime.status()).toMatchObject({connected: false, code: 'unauthorized'});
    expect(sockets).toHaveLength(0);
  });
  it('creates a bot without installing a machine-wide shell alias',async()=>{
    await runtime.saveBot({name:'Shared',instructions:'Local instructions',model:'Inherited',shared:true});
    expect(calls.find(call=>call.method==='profiles.create')?.params).toMatchObject({name:'shared',no_alias:true});
  });

  it('never signs text paths or unverified tool JSON, and trusts only executor artifact descriptors',async()=>{
    snapshot.messages=[
      {row_id:1,role:'user',text:'@file:/etc/passwd',app_artifacts:[{path:'/etc/passwd'}]},
      {row_id:2,role:'assistant',text:'MEDIA:/etc/passwd',reasoning_content:'Exposed native reasoning content'},
      {row_id:3,role:'tool',text:'tool result',app_tool_result:{path:'/etc/passwd'}},
      {row_id:4,role:'user',text:'upload',app_attachments:[{path:'/workspace/staged/note.txt',name:'note.txt',mime:'text/plain'}]},
      {row_id:5,role:'assistant',text:'output',reasoning:'Primary exposed reasoning',reasoning_content:'Secondary exposed reasoning',app_artifacts:[{path:'/workspace/output/result.png',name:'result.png',mime:'image/png'}]},
      {row_id:6,role:'assistant',text:'answer',reasoning:{unsupported:'structured value'},reasoning_content:'Fallback exposed reasoning'},
      {row_id:7,role:'assistant',text:'answer',reasoning_content:{unsupported:'structured value'}},
    ];
    const result=await runtime.conversation('shared');
    expect(result.messages.slice(0,3).flatMap(row=>row.files??[])).toEqual([]);
    expect(result.files.map(file=>file.name)).toEqual(['note.txt','result.png']);
    expect(result.files.every(file=>file.url?.startsWith('/api/files/'))).toBe(true);
    expect(result.messages.map(message=>message.reasoning)).toEqual([undefined,'Exposed native reasoning content',undefined,undefined,'Primary exposed reasoning','Fallback exposed reasoning',undefined]);
  });

  it('renders image-only display text without exposing its native path or stripping ordinary user text',async()=>{
    snapshot.messages=[
      {row_id:1,role:'user',text:'@image:/workspace/staged/photo.png',app_request_id:'image-request',app_display_text:'',app_attachments:[{path:'/workspace/staged/photo.png',name:'photo.png',mime:'image/png'}]},
      {row_id:2,role:'user',text:'Please explain @image:/an/example/path'},
    ];
    const result=await runtime.conversation('shared');
    expect(result.messages[0]).toMatchObject({id:'image-request',text:'',files:[{name:'photo.png',mime:'image/png'}]});
    expect(result.messages[1]).toMatchObject({text:'Please explain @image:/an/example/path',files:[]});
  });

  it('rejects old unscoped signed file identifiers before fetching a path',async()=>{
    const body=Buffer.from(JSON.stringify({path:'/etc/passwd',name:'passwd',mime:'text/plain',botId:'shared'})).toString('base64url');
    const id=`${body}.${createHmac('sha256',token).update(body).digest('base64url')}`;
    const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
    await expect(runtime.download(id)).rejects.toThrow('Unregistered file identifier');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects invalid or cross-bot draft files before native admission', async () => {
    const invalid = await runtime.submit(input([{id:'a.b',name:'old.png',mime:'image/png'}]));
    expect(invalid.status).toBe('rejected');
    expect(invalid.message).toContain('attach the file again');
    const file = await runtime.upload('another-bot', {name:'photo.png',mime:'image/png',data:Buffer.from('image')});
    expect((await runtime.submit(input([file]))).status).toBe('rejected');
    expect(calls.some(call => call.method === 'agent-interface.submit')).toBe(false);
  });

  it('creates disabled routines atomically and resumes through the native lifecycle endpoint', async () => {
    const requests: {url:string; method:string; body:Record<string,any>}[] = [];
    let job = {id:'job-one',enabled:false,state:'paused'};
    vi.stubGlobal('fetch', vi.fn(async (url:URL, init:RequestInit) => {
      requests.push({url:String(url),method:init.method!,body:JSON.parse(String(init.body || '{}'))});
      if (String(url).includes('/resume?')) job = {...job,enabled:true,state:'scheduled'};
      if (String(url).includes('/pause?')) job = {...job,enabled:false,state:'paused'};
      return Response.json(job);
    }));
    const routine = {botId:'shared',name:'Morning',prompt:'A useful reminder',schedule:'1h',enabled:false};
    expect((await runtime.saveRoutine(routine)).enabled).toBe(false);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({method:'POST',body:{paused:true,context_from:['self'],deliver:'bot-chat:shared'}});
    expect(requests[0].url.endsWith('/api/cron/jobs?profile=shared')).toBe(true);
    expect((await runtime.saveRoutine({...routine,enabled:true},'job-one')).enabled).toBe(true);
    expect(requests[1].body.updates).not.toHaveProperty('paused');
    expect(requests[2].url.endsWith('/api/cron/jobs/job-one/resume?profile=shared')).toBe(true);
    expect((await runtime.saveRoutine(routine,'job-one')).enabled).toBe(false);
    expect(requests[4].url.endsWith('/api/cron/jobs/job-one/pause?profile=shared')).toBe(true);
  });

  it('recovers disconnected transport state from an authoritative idle snapshot',async()=>{
    await runtime.conversation('shared');
    snapshot.info.running=true;
    sockets[0].receive({method:'event',params:{session_id:'live-one',type:'tool.start',payload:{name:'terminal'}}});
    expect((await runtime.conversation('shared')).activity.state).toBe('working');
    sockets[0].close();
    snapshot.info.running=false;
    await runtime.reconnect!();
    expect((await runtime.conversation('shared')).activity.state).toBe('idle');
    expect(sockets).toHaveLength(2);
  });

  it('does not resume or create canonical work when the durable add-on contract is absent',async()=>{
    addonReady=false;
    await expect(runtime.conversation('shared')).rejects.toThrow('verified durable Hermes add-on');
    expect(calls.some(call=>['session.resume','session.create','agent-interface.open'].includes(call.method))).toBe(false);
    expect((await runtime.capabilities()).chat.supported).toBe(false);
  });

  it('rediscovers capabilities after an initially disconnected gateway recovers',async()=>{
    connectionFails=true;
    expect((await runtime.capabilities()).chat.supported).toBe(false);
    connectionFails=false;
    expect((await runtime.reconnect!()).connected).toBe(true);
    expect((await runtime.capabilities()).chat.supported).toBe(true);
  });

  it.each(['approval','clarify'])('removes resolved %s cards when a fresh native snapshot omits empty open requests',async(method)=>{
    await runtime.conversation('shared');
    const request={id:'srq-one',method,params:{session_id:'live-one',description:'Native request'}};
    sockets[0].receive(request);snapshot.open_requests=[request];snapshot.info.running=true;
    const waiting=await runtime.conversation('shared');
    expect(method==='approval'?waiting.approvals:waiting.attention).toHaveLength(1);
    delete snapshot.open_requests;snapshot.info.running=false;
    const settled=await runtime.conversation('shared');
    expect(settled.approvals).toEqual([]);expect(settled.attention).toEqual([]);expect(settled.activity.state).toBe('idle');
  });

  it('projects durable interrupted task identity over a cold idle snapshot',async()=>{
    snapshot.app_interruption={requestId:'admission-one',runId:'task-one'};
    const result=await runtime.conversation('shared');
    expect(result.sessionId).toBe('stored-one');
    expect(result.activity).toEqual({state:'interrupted',runId:'task-one'});
  });

  it('keeps a turn-completed task active until its durable root actually settles',async()=>{
    await runtime.conversation('shared');
    sockets[0].receive({method:'event',params:{session_id:'live-one',type:'message.complete',payload:{status:'complete'}}});
    snapshot.app_run_id='task-one';
    expect((await runtime.conversation('shared')).activity).toEqual({state:'thinking',runId:'task-one'});
    delete snapshot.app_run_id;snapshot.app_task_state='done';
    expect((await runtime.conversation('shared')).activity.state).toBe('done');
  });

  it('forwards an image-only prompt and explicit reviewed interruption without inventing text',async()=>{
    const file=await runtime.upload('shared',{name:'portrait.png',mime:'image/png',data:Buffer.from('test image')});
    expect((await runtime.submit({...input([file]),reviewedInterruption:true})).status).toBe('accepted');
    const submission=calls.find(call=>call.method==='agent-interface.submit')!;
    expect(submission.params.text).toBe('');
    expect(submission.params.reviewed_interruption).toBe(true);
    expect(submission.params.attachments[0]).toMatchObject({path:'/workspace/staged/portrait.png',mime:'image/png',kind:'upload'});
  });

  it('definitely rejects a busy image instead of silently dropping it, even with altered client MIME',async()=>{
    const file=await runtime.upload('shared',{name:'portrait.png',mime:'image/png',data:Buffer.from('test image')});
    snapshot.info.running=true;
    const result=await runtime.steer({...input([{...file,mime:'text/plain'}]),text:'Use this image'});
    expect(result.status).toBe('rejected');
    expect(result.message).toContain('Keep this draft');
    expect(calls.some(call=>call.method==='agent-interface.submit')).toBe(false);
  });

  it('copies a registered portrait to the native profile asset and preserves unrelated metadata',async()=>{
    const file=await runtime.upload('shared',{name:'portrait.png',mime:'image/png',data:Buffer.from('test image')});
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(new Uint8Array([137,80,78,71]))));
    await runtime.setAvatar!('shared',{mode:'portrait',origin:'uploaded',src:file.url!});
    expect(calls.find(call=>call.method==='profiles.set_asset')?.params).toMatchObject({name:'shared',asset:'avatar',data:'data:image/png;base64,iVBORw=='});
    const metadata=calls.find(call=>call.method==='profiles.configure')?.params;
    expect(metadata?.ui_meta.agent_interface.unrelated).toBe('preserve');
    expect(metadata?.ui_meta_expected_revisions.agent_interface).toBe(3);
  });

  it('does not overwrite a native portrait after metadata CAS rejects a stale save',async()=>{
    const file=await runtime.upload('shared',{name:'portrait.png',mime:'image/png',data:Buffer.from('test image')});
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(new Uint8Array([137,80,78,71]))));metadataConflict=true;
    await expect(runtime.setAvatar!('shared',{mode:'portrait',origin:'uploaded',src:file.url!})).rejects.toThrow('changed on another client');
    expect(calls.some(call=>call.method==='profiles.set_asset')).toBe(false);
  });

  it('does not generate a paid portrait without the verified add-on even when an image provider is ready', async () => {
    addonReady=false; imageReady=true;
    expect((await runtime.capabilities()).portraitGeneration.supported).toBe(false);
    await expect(runtime.generatePortrait('shared','Portrait')).rejects.toThrow('verified durable Hermes add-on');
    expect(calls.some(call => call.method === 'image.generate' && !call.params.probe)).toBe(false);
  });

  it('keeps generation unavailable without a provider and uses native square aspect syntax',async()=>{
    expect((await runtime.capabilities()).portraitGeneration.supported).toBe(false);
    await expect(runtime.generatePortrait('shared','A friendly portrait')).rejects.toThrow('No image generation backend configured');
    expect(calls.find(call=>call.method==='image.generate'&&!call.params.probe)?.params).toMatchObject({aspect_ratio:'square',max_bytes:2_000_000});
  });
});

describe('Hermes transport liveness and diagnostics', () => {
  it.each([
    'wss://example.com', 'http://example.com', 'http://127.0.0.1/api',
    'http://127.0.0.1/hidden/..', 'https://example.com?token=secret',
    'https://example.com?', 'https://example.com#',
    'https://user:secret@example.com', 'not a URL',
  ])('rejects unsafe or malformed configured origins without making a request: %s', async url => {
    runtime = createHermesRuntime({url, token});
    expect(await runtime.status()).toMatchObject({connected: false, code: 'invalid_config'});
    expect(JSON.stringify(await runtime.status())).not.toContain('secret');
    expect(sockets).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('distinguishes missing settings from a partial configuration', async () => {
    runtime = createHermesRuntime();
    expect(await runtime.status()).toMatchObject({code: 'not_configured', connected: false});
    runtime = createHermesRuntime({url: 'https://hermes.example.com'});
    expect(await runtime.status()).toMatchObject({code: 'invalid_config', connected: false});
  });

  it('reports a usable contract and sanitized address after coalesced concurrent connection reads', async () => {
    const [status, caps, bots] = await Promise.all([
      runtime.status(), runtime.capabilities(), runtime.listBots(),
      runtime.capabilities(), runtime.listBots(),
    ]);
    expect(status).toMatchObject({connected: true, code: 'ready', version: revision, address: 'http://127.0.0.1:19119'});
    expect(status.lastConnectedAt).toBeDefined();
    expect(caps.chat.supported).toBe(true);
    expect(bots).toHaveLength(1);
    expect(sockets).toHaveLength(1);
    expect(calls.filter(call => call.method === 'agent-interface.capabilities')).toHaveLength(1);
    expect(calls.filter(call => call.method === 'image.generate')).toHaveLength(1);
    expect(calls.filter(call => call.method === 'profiles.list')).toHaveLength(1);
    expect(calls.every(call => call.method !== 'image.generate' || call.params.probe === true)).toBe(true);
  });

  it('settles close-before-open and diagnoses invalid credentials with an authenticated read', async () => {
    opening = 'close';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, {status: 401})));
    const status = await runtime.status();
    expect(status).toMatchObject({connected: false, code: 'unauthorized'});
    expect(JSON.stringify(status)).not.toContain(token);
    expect(fetch).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({
      headers: {'X-Hermes-Session-Token': token}, redirect: 'error',
    }));
    expect(String(vi.mocked(fetch).mock.calls[0]![0])).toBe('http://127.0.0.1:19119/api/profiles');
    expect(calls).toEqual([]);
  });

  it('uses the native authenticated read to diagnose an opaque websocket upgrade error', async () => {
    connectionFails = true;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, {status: 403})));
    expect(await runtime.status()).toMatchObject({connected: false, code: 'unauthorized'});
  });

  it('distinguishes a missing durable add-on from an incompatible contract without trusting native error text', async () => {
    rpcErrors.set('agent-interface.capabilities', {code: -32601, message: `Missing: ${token} https://user:secret@host/`});
    const missing = await runtime.status();
    expect(missing).toMatchObject({connected: false, code: 'addon_missing'});
    expect(JSON.stringify(missing)).not.toContain(token);
    expect(JSON.stringify(missing)).not.toContain('secret');
    rpcErrors.clear();
    addonReady = false;
    expect(await runtime.reconnect!()).toMatchObject({connected: false, code: 'incompatible'});
    expect(calls.some(call => ['agent-interface.open', 'agent-interface.submit', 'image.generate'].includes(call.method))).toBe(false);
  });

  it('bounds an opening socket and a stalled add-on handshake', async () => {
    vi.useFakeTimers();
    opening = 'hang';
    const openingStatus = runtime.status();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await openingStatus).toMatchObject({connected: false, code: 'unreachable'});
    expect(sockets[0].readyState).toBe(WireSocket.CLOSED);
    opening = 'open';
    deferredMethods.add('agent-interface.capabilities');
    const handshakeStatus = runtime.reconnect!();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await handshakeStatus).toMatchObject({connected: false, code: 'unreachable'});
    expect(sockets[1].readyState).toBe(WireSocket.CLOSED);
  });

  it('rejects outstanding connection work immediately when the runtime is closed', async () => {
    opening = 'hang';
    const status = runtime.status();
    await runtime.close();
    expect(await status).toMatchObject({connected: false, code: 'closed'});
    expect(await runtime.reconnect!()).toMatchObject({connected: false, code: 'closed'});
    expect(sockets).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('backs off repeated failed polls and automatically recovers after the retry deadline', async () => {
    vi.useFakeTimers();
    connectionFails = true;
    const failed = await runtime.status();
    expect(failed).toMatchObject({connected: false, code: 'unreachable'});
    expect(Date.parse(failed.retryAt!) - Date.now()).toBe(1_000);
    await Promise.all([runtime.status(), runtime.status(), runtime.capabilities(), runtime.listBots()]);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await runtime.status()).toMatchObject({connected: false});
    expect(sockets).toHaveLength(2);
    expect(Date.parse((await runtime.status()).retryAt!) - Date.now()).toBe(2_000);
    connectionFails = false;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await runtime.status()).toMatchObject({connected: true, code: 'ready'});
    expect((await runtime.status()).retryAt).toBeUndefined();
    expect(sockets).toHaveLength(3);
  });

  it('keeps the successful bot roster visible and disconnected during an outage', async () => {
    const before = await runtime.listBots();
    sockets[0].close();
    const offline = await runtime.listBots();
    expect(offline).toEqual(before.map(bot => ({...bot, activity: 'disconnected'})));
    expect(sockets).toHaveLength(1);
    await runtime.reconnect!();
    expect((await runtime.listBots())[0].activity).toBe('idle');
  });

  it('ignores old socket close, error, response, and activity events after replacement', async () => {
    await runtime.conversation('shared');
    const old = sockets[0];
    old.close();
    await runtime.reconnect!();
    await runtime.conversation('shared');
    deferredMethods.add('profiles.describe');
    let settled = false;
    const tools = runtime.tools('shared').then(result => {settled = true; return result;});
    await vi.waitFor(() => expect(calls.at(-1)?.method).toBe('profiles.describe'));
    const id = (calls.at(-1)! as Record<string,any>).id;
    old.receive({id, result: {toolsets: []}});
    old.receive({method: 'event', params: {session_id: 'live-one', type: 'tool.start', payload: {name: 'stale'}}});
    old.close();
    old.dispatchEvent(new Event('error'));
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(await runtime.status()).toMatchObject({connected: true, code: 'ready'});
    sockets[1].receive({id, result: {toolsets: [{name: 'terminal', enabled: true}]}});
    expect(await tools).toHaveLength(1);
    snapshot.info.running = true;
    expect((await runtime.conversation('shared')).activity.state).toBe('thinking');
    expect(sockets).toHaveLength(2);
  });

  it('does not send a mutation if the socket begins closing between readiness and send', async () => {
    beforeSend = (request, socket) => {
      if (request.method === 'agent-interface.submit') socket.readyState = WireSocket.CLOSING;
    };
    const result = await runtime.submit(input());
    expect(result.status).toBe('uncertain');
    expect(calls.filter(call => call.method === 'agent-interface.submit')).toHaveLength(0);
    expect(await runtime.status()).toMatchObject({connected: false, code: 'unreachable'});
  });

  it('bounds read requests, drops a dead transport, and never replays an uncertain mutation', async () => {
    vi.useFakeTimers();
    deferredMethods.add('agent-interface.submit');
    const submitted = runtime.submit(input());
    await vi.advanceTimersByTimeAsync(0);
    deferredMethods.add('profiles.describe');
    const read = runtime.tools('shared');
    const rejected = expect(read).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(await submitted).toMatchObject({requestId: 'request-one', status: 'uncertain'});
    expect(await runtime.status()).toMatchObject({connected: false, code: 'unreachable'});
    await runtime.reconnect!();
    expect(calls.filter(call => call.method === 'agent-interface.submit')).toHaveLength(1);
  });

  it('coalesces overlapping identical configuration reads without caching later edits', async () => {
    await runtime.status();
    deferredMethods.add('profiles.describe');
    const tools = runtime.tools('shared');
    const skills = runtime.skills('shared');
    await vi.waitFor(() => expect(calls.filter(call => call.method === 'profiles.describe')).toHaveLength(1));
    const id = (calls.at(-1)! as Record<string,any>).id;
    sockets[0].receive({id, result: {toolsets: [{name: 'terminal', enabled: true}], skills: [{name: 'local', enabled: false}]}});
    expect(await tools).toHaveLength(1);
    expect(await skills).toMatchObject([{id: 'local', enabled: false}]);
    deferredMethods.clear();
    await runtime.skills('shared');
    expect(calls.filter(call => call.method === 'profiles.describe')).toHaveLength(2);
  });

  it('disables every capability if the read-only image probe loses the verified connection', async () => {
    vi.useFakeTimers();
    await runtime.status();
    deferredMethods.add('image.generate');
    const capabilities = runtime.capabilities();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(Object.values(await capabilities).every(value => !value.supported)).toBe(true);
    expect(await runtime.status()).toMatchObject({connected: false, code: 'unreachable'});
    expect(calls.filter(call => call.method === 'image.generate')).toMatchObject([{params: {probe: true}}]);
  });

  it('verifies liveness after socket silence and keeps a healthy manual reconnect read-only', async () => {
    vi.useFakeTimers();
    await runtime.status();
    deferredMethods.add('agent-interface.submit');
    const submitted = runtime.submit(input());
    await vi.advanceTimersByTimeAsync(0);
    const refreshed = await Promise.all([runtime.reconnect!(), runtime.reconnect!()]);
    expect(refreshed).toMatchObject([{connected: true, code: 'ready'}, {connected: true, code: 'ready'}]);
    expect(sockets).toHaveLength(1);
    expect(calls.filter(call => call.method === 'agent-interface.capabilities')).toHaveLength(2);
    const request = calls.find(call => call.method === 'agent-interface.submit')! as Record<string,any>;
    sockets[0].receive({id: request.id, result: {requestId: 'request-one', status: 'accepted', runId: 'run-one'}});
    expect(await submitted).toMatchObject({status: 'accepted'});
    await vi.advanceTimersByTimeAsync(15_000);
    deferredMethods.add('agent-interface.capabilities');
    const stale = runtime.status();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await stale).toMatchObject({connected: false, code: 'unreachable'});
    expect(calls.filter(call => call.method === 'agent-interface.submit')).toHaveLength(1);
  });
});
