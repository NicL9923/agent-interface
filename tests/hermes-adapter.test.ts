import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { createHermesRuntime } from '../src/server/hermes.js';
import type { Runtime, Submission } from '../src/shared/types.js';

// Isolated wire-contract regressions. Real Hermes execution evidence lives in the spike probes.
const token='isolated-contract-token';
const revision='b9cb268deffc97946ec11645aa622a7353dd0591';
let snapshot:Record<string,any>;
let calls:{method:string;params:Record<string,any>}[];
let sockets:WireSocket[];
let runtime:Runtime;
let addonReady:boolean;
let metadataConflict:boolean;
let connectionFails:boolean;
let imageReady:boolean;
class WireSocket extends EventTarget {
  static OPEN=1;
  readyState=1;
  constructor(_url:string){super();sockets.push(this);queueMicrotask(()=>{if(connectionFails){this.dispatchEvent(new Event('error'));this.close();}else this.dispatchEvent(new Event('open'));});}
  receive(frame:unknown){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(frame)}));}
  send(text:string){
    const request=JSON.parse(text);calls.push(request);
    let result:unknown={};
    if(request.method==='agent-interface.capabilities')result={revision,durable_admission:true,durable_events:addonReady,canonical_open:addonReady,executor_epoch:'epoch-one'};
    if(request.method==='agent-interface.open')result=structuredClone(snapshot);
    if(request.method==='file.attach')result={path:'/workspace/staged/portrait.png'};
    if(request.method==='agent-interface.submit')result={requestId:request.params.request_id,status:'accepted',runId:'task-one'};
    if(request.method==='profiles.list')result={profiles:[{name:'shared',ui_meta:{agent_interface:{name:'Shared',unrelated:'preserve'}},ui_meta_revisions:{agent_interface:3}}]};
    if(request.method==='profiles.configure')result=metadataConflict?{ok:false,applied:{ui_meta:false,ui_meta_conflicts:{agent_interface:{actual:4}}}}:{ok:true,applied:{ui_meta:true}};
    if(request.method==='image.generate')result={available:imageReady,success:false,error:'No image generation backend configured'};
    if(request.method==='profiles.set_asset')result={ok:true};
    queueMicrotask(()=>this.receive({jsonrpc:'2.0',id:request.id,result}));
  }
  close(){this.readyState=3;this.dispatchEvent(new Event('close'));}
}
beforeEach(()=>{
  snapshot={session_id:'live-one',canonical_stored_session_id:'stored-one',info:{running:false},messages:[]};calls=[];sockets=[];addonReady=true;metadataConflict=false;connectionFails=false;imageReady=false;
  vi.stubGlobal('WebSocket',WireSocket);
  runtime=createHermesRuntime({url:'http://127.0.0.1:19119',token});
});
afterEach(async()=>{await runtime.close();vi.unstubAllGlobals();});
const input=(attachments:Submission['attachments']=[]):Submission=>({requestId:'request-one',botId:'shared',senderId:'person-one',text:'',attachments});

describe('Hermes adapter trust and recovery boundary',()=>{
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
    expect((await runtime.status()).connected).toBe(true);
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
