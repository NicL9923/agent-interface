import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { defaultPreferences, type Avatar, type FileRef, type Runtime } from '../src/shared/types.js';

const origin='http://127.0.0.1:3000';
const capabilities=Object.fromEntries(['chat','steering','approvals','uploads','generatedFiles','botConfiguration','tools','skills','routines','durableEvents','idempotency','imageGeneration','stop','portraitGeneration','avatarMetadata'].map(key=>[key,{supported:true}])) as Awaited<ReturnType<Runtime['capabilities']>>;
const apps:Awaited<ReturnType<typeof createApp>>['app'][]=[];
afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));});
async function installation(overrides:Partial<Runtime>={}){
  const runtime={
    listBots:vi.fn(async()=>[{id:'shared',name:'Shared',shared:true,model:'test',activity:'idle'}]),
    capabilities:vi.fn(async()=>capabilities),
    status:vi.fn(async()=>({connected:true,code:'connected'})),
    reconnect:vi.fn(async()=>({connected:true,code:'connected'})),
    close:vi.fn(async()=>{}),...overrides,
  } as unknown as Runtime;
  const result=await createApp(loadConfig({LOCAL_DEV_AUTH:'true',APP_DATABASE:':memory:'}),runtime,{background:false});
  apps.push(result.app);return {...result,runtime};
}
async function identity(app:Awaited<ReturnType<typeof createApp>>['app'],member:'one'|'two'='one'){
  const response=await app.inject({method:'POST',url:'/api/auth/local',headers:{origin},payload:{member}});
  expect(response.statusCode).toBe(200);
  return {cookie:`${response.cookies[0].name}=${response.cookies[0].value}`,origin,'x-csrf-token':response.json().csrfToken};
}

describe('connection recovery API',()=>{
  it('coalesces concurrent runtime bootstrap reads while keeping identity, preferences and CSRF separate',async()=>{
    let finish!: (bots:unknown[])=>void;
    const listBots=vi.fn(()=>new Promise<unknown[]>(resolve=>{finish=resolve;}));
    const {app,store,runtime}=await installation({listBots:listBots as Runtime['listBots']});
    const one=await identity(app),two=await identity(app,'two');
    store.savePreferences('local-one',{...defaultPreferences,theme:'dark',favorites:['shared']});
    store.savePreferences('local-two',{...defaultPreferences,theme:'light',favorites:[]});
    const first=app.inject({url:'/api/bootstrap',headers:one});
    const second=app.inject({url:'/api/bootstrap',headers:two});
    await vi.waitFor(()=>expect(listBots).toHaveBeenCalledTimes(1));
    await new Promise(resolve=>setImmediate(resolve));
    expect(runtime.capabilities).toHaveBeenCalledTimes(1);
    finish([{id:'shared',name:'Shared',shared:true,model:'test',activity:'idle'}]);
    const [a,b]=await Promise.all([first,second]);
    expect(a.statusCode).toBe(200);expect(b.statusCode).toBe(200);
    expect(runtime.status).toHaveBeenCalledTimes(1);
    expect(a.json().bots).toEqual(b.json().bots);
    expect(a.json()).toMatchObject({user:{id:'local-one'},preferences:{theme:'dark',favorites:['shared']},csrfToken:one['x-csrf-token']});
    expect(b.json()).toMatchObject({user:{id:'local-two'},preferences:{theme:'light',favorites:[]},csrfToken:two['x-csrf-token']});
    expect(a.json().csrfToken).not.toBe(b.json().csrfToken);
  });

  it('does not cache a failed runtime snapshot across the next bootstrap retry',async()=>{
    const listBots=vi.fn().mockRejectedValueOnce(new Error('Hermes temporarily unavailable')).mockResolvedValue([]);
    const {app}=await installation({listBots});const headers=await identity(app);
    expect((await app.inject({url:'/api/bootstrap',headers})).statusCode).toBe(502);
    expect((await app.inject({url:'/api/bootstrap',headers})).statusCode).toBe(200);
    expect(listBots).toHaveBeenCalledTimes(2);
  });

  it('requires authentication, matching Origin and the current session CSRF before reconnecting',async()=>{
    const {app,runtime}=await installation();const headers=await identity(app);
    const attempts=[
      {headers:{origin},status:401},
      {headers:{cookie:headers.cookie,origin},status:403},
      {headers:{...headers,origin:'https://foreign.example'},status:403},
      {headers:{cookie:headers.cookie,'x-csrf-token':headers['x-csrf-token']},status:403},
      {headers:{...headers,'x-csrf-token':'wrong-session-token'},status:403},
    ];
    for(const attempt of attempts){const result=await app.inject({method:'POST',url:'/api/connection/retry',headers:attempt.headers,payload:{}});expect(result.statusCode).toBe(attempt.status);}
    expect(runtime.reconnect).not.toHaveBeenCalled();
    const result=await app.inject({method:'POST',url:'/api/connection/retry',headers,payload:{}});
    expect(result.statusCode).toBe(200);expect(result.json()).toMatchObject({connected:true});
    expect(runtime.reconnect).toHaveBeenCalledTimes(1);
  });

  it('keeps native avatar metadata authoritative after external updates and native removal',async()=>{
    const saved:Avatar={mode:'geometric',shape:'circle',color:'#1084FE',eyes:'oval',accessory:'none'};
    const external:Avatar={...saved,color:'#FF6700',shape:'hex'};
    let avatar:Avatar|undefined;
    const setAvatar=vi.fn(async(_id:string,value:Avatar)=>{avatar=value;});
    const {app}=await installation({
      capabilities:async()=>({...capabilities,avatarMetadata:{supported:true}}),
      listBots:async()=>[{id:'shared',name:'Shared',shared:true,model:'test',activity:'idle',avatar}],setAvatar,
    });
    const headers=await identity(app);
    expect((await app.inject({method:'PUT',url:'/api/bots/shared/avatar',headers,payload:saved})).statusCode).toBe(200);
    expect(setAvatar).toHaveBeenCalledTimes(1);
    avatar=external;
    expect((await app.inject({url:'/api/bootstrap',headers})).json().bots[0].avatar).toEqual(external);
    avatar=undefined;
    expect((await app.inject({url:'/api/bootstrap',headers})).json().bots[0].avatar).toBeUndefined();
  });

  it('retains app avatar fallback when native avatar metadata is unsupported',async()=>{
    const avatar:Avatar={mode:'mascot',family:'fox',color:'#FF6700',eyes:'round',accessory:'hat'};
    const setAvatar=vi.fn();
    const {app}=await installation({capabilities:async()=>({...capabilities,avatarMetadata:{supported:false}}),setAvatar});
    const headers=await identity(app);
    expect((await app.inject({method:'PUT',url:'/api/bots/shared/avatar',headers,payload:avatar})).statusCode).toBe(200);
    expect(setAvatar).not.toHaveBeenCalled();
    expect((await app.inject({url:'/api/bootstrap',headers})).json().bots[0].avatar).toEqual(avatar);
  });

  it('versions drafts and refuses an edit made on a stale revision, while older clients still save',async()=>{
    const {app}=await installation({conversation:async()=>({botId:'shared',messages:[],activity:{state:'idle'},approvals:[],files:[]})});
    const one=await identity(app);
    const put=(payload:object)=>app.inject({method:'PUT',url:'/api/bots/shared/draft',headers:one,payload:{attachments:[],...payload}});
    const first=await put({text:'Laptop draft',baseRevision:0});
    expect(first.statusCode).toBe(200);expect(first.json()).toEqual({text:'Laptop draft',attachments:[],revision:1,reason:'edit',sentRevision:0});
    expect((await put({text:'Phone edit',baseRevision:1})).json()).toMatchObject({text:'Phone edit',revision:2});
    const stale=await put({text:'Laptop edit on the old copy',baseRevision:1});
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({code:'draft_conflict',draft:{text:'Phone edit',attachments:[],revision:2,reason:'edit',sentRevision:0}});
    // A retried save whose first attempt landed is not a conflict and does not advance the revision.
    expect((await put({text:'Phone edit',baseRevision:1})).json()).toMatchObject({text:'Phone edit',revision:2});
    const legacy=await put({text:'Older app build'});
    expect(legacy.statusCode).toBe(200);expect(legacy.json()).toMatchObject({text:'Older app build',revision:3});
    expect((await app.inject({url:'/api/bots/shared/draft',headers:one})).json()).toMatchObject({text:'Older app build',revision:3,reason:'edit'});
    expect((await app.inject({url:'/api/bots/shared/conversation',headers:one})).json().draft).toMatchObject({text:'Older app build',revision:3});
    const fresh=await app.inject({method:'PUT',url:'/api/bots/other/draft',headers:one,payload:{text:'Elsewhere',attachments:[],baseRevision:4}});
    expect(fresh.statusCode).toBe(409);expect(fresh.json().draft).toEqual({text:'',attachments:[],revision:0,reason:'edit',sentRevision:0});
  });

  it('advances the revision with reason sent when an accepted message clears the draft',async()=>{
    const {app}=await installation({
      conversation:async()=>({botId:'shared',messages:[],activity:{state:'idle'},approvals:[],files:[]}),
      submit:async input=>({requestId:input.requestId,status:'accepted',runId:input.requestId}),
    });
    const one=await identity(app);
    const put=(text:string,baseRevision:number)=>app.inject({method:'PUT',url:'/api/bots/shared/draft',headers:one,payload:{text,attachments:[],baseRevision}});
    await put('Send me',0);
    await app.inject({method:'POST',url:'/api/bots/shared/messages',headers:one,payload:{requestId:randomUUID(),text:'Send me',attachments:[]}});
    expect((await app.inject({url:'/api/bots/shared/draft',headers:one})).json()).toEqual({text:'',attachments:[],revision:2,reason:'sent',sentRevision:2});
    // The device that typed on revision 1 learns that its text was sent.
    expect((await put('Send me, edited late',1)).json()).toMatchObject({code:'draft_conflict',draft:{reason:'sent',sentRevision:2}});
    expect((await put('Next message',2)).json()).toEqual({text:'Next message',attachments:[],revision:3,reason:'edit',sentRevision:2});
  });

  it('clears a draft whose last save is no newer than the revision a message was written on, even with unsaved final edits',async()=>{
    const {app}=await installation({
      conversation:async()=>({botId:'shared',messages:[],activity:{state:'idle'},approvals:[],files:[]}),
      submit:async input=>({requestId:input.requestId,status:'accepted',runId:input.requestId}),
    });
    const one=await identity(app);
    const put=(text:string,baseRevision:number)=>app.inject({method:'PUT',url:'/api/bots/shared/draft',headers:one,payload:{text,attachments:[],baseRevision}});
    const read=async()=>(await app.inject({url:'/api/bots/shared/draft',headers:one})).json();
    const submit=(text:string,draftBaseRevision?:number)=>app.inject({method:'POST',url:'/api/bots/shared/messages',headers:one,payload:{requestId:randomUUID(),text,attachments:[],draftBaseRevision}});
    // Sent before the last keystrokes were saved: the server holds a partial draft.
    await put('Pick up fe',0);
    expect((await submit('Pick up feed',1)).json().status).toBe('accepted');
    expect(await read()).toEqual({text:'',attachments:[],revision:2,reason:'sent',sentRevision:2});
    // Another device edited after the message's base revision: its draft survives.
    await put('Phone draft',2);
    expect((await submit('Something else',2)).json().status).toBe('accepted');
    expect(await read()).toMatchObject({text:'Phone draft',revision:3,reason:'edit'});
    // Without a base, as from older clients, only the exact sent text clears.
    expect((await submit('Something else')).json().status).toBe('accepted');
    expect(await read()).toMatchObject({text:'Phone draft',revision:3});
    expect((await submit('Phone draft')).json().status).toBe('accepted');
    expect(await read()).toMatchObject({text:'',revision:4,reason:'sent'});
  });

  it('records every accepted send, so a save dispatched before it cannot restore the sent text',async()=>{
    const {app}=await installation({
      conversation:async()=>({botId:'shared',messages:[],activity:{state:'idle'},approvals:[],files:[]}),
      submit:async input=>({requestId:input.requestId,status:'accepted',runId:input.requestId}),
    });
    const one=await identity(app);
    const put=(bot:string,text:string,baseRevision:number)=>app.inject({method:'PUT',url:`/api/bots/${bot}/draft`,headers:one,payload:{text,attachments:[],baseRevision}});
    const submit=(bot:string,text:string,draftBaseRevision:number)=>app.inject({method:'POST',url:`/api/bots/${bot}/messages`,headers:one,payload:{requestId:randomUUID(),text,attachments:[],draftBaseRevision}});
    // Never saved: the send creates the draft at revision 1.
    expect((await submit('shared','Typed and sent at once',0)).json().status).toBe('accepted');
    expect((await app.inject({url:'/api/bots/shared/draft',headers:one})).json()).toEqual({text:'',attachments:[],revision:1,reason:'sent',sentRevision:1});
    expect((await put('shared','Typed and sent at once',0)).statusCode).toBe(409);
    // Already empty on the server.
    await put('other','',0);
    expect((await submit('other','Second',1)).json().status).toBe('accepted');
    expect((await put('other','Second',1)).json()).toMatchObject({code:'draft_conflict',draft:{text:'',revision:2,reason:'sent'}});
  });

  it('clears a matching draft only on first accepted receipt, preserving newer phone edits and a retyped identical draft',async()=>{
    const {app}=await installation({
      conversation:async()=>({botId:'shared',messages:[],activity:{state:'idle'},approvals:[],files:[]}),
      submit:async input=>({requestId:input.requestId,status:'accepted',runId:input.requestId}),
      lookupSubmission:async requestId=>({requestId,status:'accepted',runId:requestId}),
    });
    const one=await identity(app),two=await identity(app,'two');
    const put=(headers:typeof one,text:string,attachments:FileRef[]=[])=>app.inject({method:'PUT',url:'/api/bots/shared/draft',headers,payload:{text,attachments}});
    const read=(headers:typeof one)=>app.inject({url:'/api/bots/shared/draft',headers});
    const submit=(text:string,attachments:FileRef[]=[])=>app.inject({method:'POST',url:'/api/bots/shared/messages',headers:one,payload:{requestId:randomUUID(),text,attachments}});
    await put(one,'Original submitted draft');await put(two,'Other member draft');
    const accepted=await submit('Original submitted draft');expect(accepted.statusCode).toBe(200);expect(accepted.json().status).toBe('accepted');
    expect((await read(one)).json()).toEqual({text:'',attachments:[],revision:2,reason:'sent',sentRevision:2});
    expect((await read(two)).json()).toEqual({text:'Other member draft',attachments:[],revision:1,reason:'edit',sentRevision:0});
    await put(one,'Original submitted draft');
    const repeated=await app.inject({url:`/api/submissions/${accepted.json().requestId}`,headers:one});
    expect(repeated.statusCode).toBe(200);expect(repeated.json().status).toBe('accepted');
    expect((await read(one)).json()).toEqual({text:'Original submitted draft',attachments:[],revision:3,reason:'edit',sentRevision:2});
    await put(one,'New phone draft');
    const second=await submit('Older snapshot submitted from another device');
    expect(second.json().status).toBe('accepted');
    expect((await read(one)).json()).toMatchObject({text:'New phone draft',attachments:[],revision:4,reason:'edit'});
    expect((await read(two)).json()).toMatchObject({text:'Other member draft',revision:1});
    const oldFile={id:'old.signature',name:'note.txt',mime:'text/plain'},newFile={...oldFile,id:'new.signature'};
    await put(one,'Same text, newer attachment',[newFile]);
    expect((await submit('Same text, newer attachment',[oldFile])).json().status).toBe('accepted');
    expect((await read(one)).json()).toMatchObject({text:'Same text, newer attachment',attachments:[newFile],revision:5,reason:'edit'});
  });
});
