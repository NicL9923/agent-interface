// @vitest-environment jsdom
import { act, createElement } from 'react';
import type { Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { api, ApiError, write } from '../src/client-api';
import { contentHash } from '../src/app/draft-merge';
import { defaultPreferences, type Bootstrap, type SavedDraft } from '../src/shared/types';
import { advance, mountRoot, stubMatchMedia, typeInto } from './ui-harness';

vi.mock('../src/client-api',async original=>({...await original<typeof import('../src/client-api')>(),api:vi.fn(),cachedResponse:vi.fn(),write:vi.fn(),clearResponseCache:vi.fn()}));
vi.mock('../src/components/Avatar',async original=>({...await original<typeof import('../src/components/Avatar')>(),Avatar:()=>null}));

// The app server's draft rules, for one person: the phone acts on it directly.
const drafts=new Map<string,SavedDraft>();
const draft=(bot:string)=>drafts.get(bot)??{text:'',attachments:[],revision:0,reason:'edit' as const,sentRevision:0};
const advanceDraft=(bot:string,text:string,reason:'edit'|'sent')=>{
  const revision=draft(bot).revision+1;
  drafts.set(bot,{text,attachments:[],revision,reason,sentRevision:reason==='sent'?revision:draft(bot).sentRevision});
};
const phone={
  edit:(bot:string,text:string)=>advanceDraft(bot,text,'edit'),
  send:(bot:string,text:string,base?:number)=>{
    const current=draft(bot);
    if(!current.text||current.text===text||base!==undefined&&current.revision<=base)advanceDraft(bot,'','sent');
  },
};
let root:Root,container:HTMLDivElement,boot:Bootstrap;
const key=(bot:string)=>`agent-interface:draft:one:${bot}`;
const cached=(bot:string)=>JSON.parse(localStorage.getItem(key(bot))!);
const draftPuts=(bot:string)=>vi.mocked(write).mock.calls.filter(([path,,method])=>path===`/bots/${bot}/draft`&&method==='PUT');
beforeEach(()=>{
  vi.useFakeTimers();vi.clearAllMocks();stubMatchMedia();
  history.replaceState(null,'','/');drafts.clear();
  boot={user:{id:'one',name:'One',email:'one@example.test'},household:[],preferences:{...structuredClone(defaultPreferences),startPage:'assistant'},
    bots:[{id:'shared',name:'Shared',shared:true,model:'test',activity:'idle'},{id:'other',name:'Other',shared:true,model:'test',activity:'idle'}],
    capabilities:Object.fromEntries(['chat','steering','approvals','uploads','generatedFiles','botConfiguration','tools','skills','routines','durableEvents','idempotency','imageGeneration','stop','portraitGeneration','avatarMetadata'].map(key=>[key,{supported:true}])) as Bootstrap['capabilities'],connection:{connected:true},csrfToken:'csrf-one'};
  vi.mocked(api).mockImplementation(async <T>(path:string)=>{
    if(path==='/bootstrap?roster=lean')return boot as T;
    const bot=/^\/bots\/(\w+)\/(draft|conversation)/.exec(path);
    if(bot?.[2]==='conversation')return {botId:bot[1],messages:[],approvals:[],files:[],activity:{state:'idle'}} as T;
    if(bot?.[2]==='draft')return (drafts.get(bot[1])??null) as T;
    return null as T;
  });
  vi.mocked(write).mockImplementation(async <T>(path:string,value:unknown,method?:string)=>{
    const bot=/^\/bots\/(\w+)\/(draft|messages)$/.exec(path)?.[1];
    const body=value as {text:string;baseRevision?:number;requestId?:string;draftBaseRevision?:number};
    if(bot&&method==='PUT'){
      const current=draft(bot);
      if(current.text===body.text)return current as T;
      if(body.baseRevision!==undefined&&body.baseRevision!==current.revision)
        throw new ApiError('This draft changed on another device.',409,'draft_conflict',undefined,{draft:current});
      advanceDraft(bot,body.text,'edit');return draft(bot) as T;
    }
    if(bot){phone.send(bot,body.text,body.draftBaseRevision);return {requestId:body.requestId,status:'accepted'} as T;}
    return {} as T;
  });
  ({container,root}=mountRoot());
});
async function renderApp(){await act(async()=>root.render(createElement(App)));await advance(0);}
const textarea=()=>container.querySelector('textarea')!;
const type=(text:string)=>typeInto(textarea(),text);
const open=(name:string)=>act(async()=>[...container.querySelectorAll<HTMLButtonElement>('.bot-item')].find(button=>button.textContent?.includes(name))!.click());

// Holds the next matching request. `apply` decides whether the server acts on it before or after the hold.
function holdNext(match:(path:string,method?:string)=>boolean,apply:'before'|'after'){
  let release!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;});
  const serve=vi.mocked(write).getMockImplementation()!;
  let taken=false;
  vi.mocked(write).mockImplementation(async (...args)=>{
    if(taken||!match(args[0],args[2]))return serve(...args);
    taken=true;
    if(apply==='after'){await held;return serve(...args);}
    // The server answers now; the answer, a 409 included, reaches the app on release, as a slow network delivers it.
    const answer=serve(...args).then(value=>({value}),(error:unknown)=>({error}));
    await held;
    const result=await answer;
    if('error' in result)throw result.error;
    return result.value;
  });
  return ()=>act(async()=>release());
}
const isDraftSave=(path:string,method?:string)=>path==='/bots/shared/draft'&&method==='PUT';

describe('draft sync across devices',()=>{
  it('keeps a reverted edit unsaved until an older save lands, then saves the revert',async()=>{
    phone.edit('shared','A');
    await renderApp();
    const release=holdNext(isDraftSave,'after');
    await type('AB');await advance(400);
    await type('A');await advance(1600);
    await release();
    await advance(400);await advance(400);await advance(1600);
    expect(textarea().value).toBe('A');
    expect(draft('shared')).toMatchObject({text:'A'});
  });

  it('saves a revert again after an older save lands, even once the person moved to another assistant',async()=>{
    phone.edit('shared','A');
    await renderApp();
    const release=holdNext(isDraftSave,'after');
    await type('AB');await advance(400);
    await type('A');await open('Other');await advance(0);
    expect(draft('shared')).toMatchObject({text:'A',revision:1});
    await release();await advance(0);
    expect(draft('shared')).toMatchObject({text:'A',revision:3});
    expect(cached('shared')).toMatchObject({text:'A',dirty:false,baseRevision:3});
  });

  it('saves an edit typed during a save that fails, after a backoff',async()=>{
    await renderApp();
    let release!:()=>void;
    const held=new Promise<void>(resolve=>{release=resolve;});
    const serve=vi.mocked(write).getMockImplementation()!;
    vi.mocked(write).mockImplementationOnce(async ()=>{await held;throw new ApiError('Request failed (500)',500);});
    await type('A');await advance(400);
    await type('AB');await advance(400);
    await act(async()=>release());await advance(0);
    expect(draft('shared').text).toBe('');
    await advance(1000);await advance(400);
    expect(draft('shared')).toMatchObject({text:'AB',revision:1});
    expect(cached('shared')).toMatchObject({dirty:false});
    vi.mocked(write).mockImplementation(serve);
  });

  it('drops text sent while its save was in flight, without a retry restoring it',async()=>{
    await renderApp();
    const releaseSave=holdNext(isDraftSave,'after');
    await type('Hello');await advance(400);
    const releaseSend=holdNext(path=>path==='/bots/shared/messages','before');
    await act(async()=>container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click());
    expect(draft('shared')).toMatchObject({text:'',reason:'sent',revision:1});
    await open('Other');
    await releaseSave();await advance(400);
    expect(draft('shared')).toMatchObject({text:'',revision:1});
    expect(draftPuts('shared')).toHaveLength(1);
    expect(cached('shared')).toMatchObject({text:'',dirty:false});
    await releaseSend();
  });

  it('ignores a late 409 from an older save after a newer save landed',async()=>{
    phone.edit('shared','Start');
    await renderApp();
    phone.edit('shared','Phone words');
    const release=holdNext(isDraftSave,'before');
    await type('Older');await advance(400);
    // Saves wait for the one in flight; leaving the page sends them anyway.
    await type('Newer');
    await act(async()=>window.dispatchEvent(new Event('pagehide')));await advance(0);
    await act(async()=>window.dispatchEvent(new Event('pagehide')));await advance(0);
    expect(draft('shared')).toMatchObject({text:'Newer',revision:3});
    await release();await advance(0);
    expect(textarea().value).toBe('Newer');
    expect(cached('shared')).toMatchObject({text:'Newer',baseRevision:3});
  });


  it('saves an edit at once when switching assistants, then shows it was sent from the phone',async()=>{
    await renderApp();
    await type('Pick up feed');await advance(100);
    await open('Other');
    expect(draftPuts('shared')).toEqual([['/bots/shared/draft',{text:'Pick up feed',attachments:[],baseRevision:0},'PUT',{keepalive:true}]]);
    await advance(0);
    expect(cached('shared')).toMatchObject({text:'Pick up feed',dirty:false,baseRevision:1});
    phone.send('shared','Pick up feed');
    await open('Shared');await advance(400);
    expect(textarea().value).toBe('');
    expect(draftPuts('shared')).toHaveLength(1);
    expect(draft('shared')).toMatchObject({text:'',reason:'sent'});
  });

  it('drops an unsaved copy still holding the text that was sent, without saving it back',async()=>{
    // Marked unsaved, but unchanged since the revision it was loaded on; the phone sent that text.
    phone.edit('shared','Pick up feed');
    localStorage.setItem(key('shared'),JSON.stringify({text:'Pick up feed',attachments:[],botId:'shared',userId:'one',dirty:true,baseRevision:1,baseHash:contentHash({text:'Pick up feed',attachments:[]})}));
    phone.send('shared','Pick up feed');
    await renderApp();await advance(400);
    expect(textarea().value).toBe('');
    expect(cached('shared')).toMatchObject({text:'',dirty:false,baseRevision:2});
    expect(draftPuts('shared')).toEqual([]);
  });

  it('keeps different text typed offline when another device sends the shared draft',async()=>{
    phone.edit('shared','Shared plan');
    localStorage.setItem(key('shared'),JSON.stringify({text:'Offline note',attachments:[],botId:'shared',userId:'one',dirty:true,baseRevision:1,baseHash:contentHash({text:'Shared plan',attachments:[]})}));
    phone.send('shared','Shared plan');
    await renderApp();await advance(400);await advance(400);
    expect(textarea().value).toBe('Offline note');
    expect(draft('shared')).toMatchObject({text:'Offline note',revision:3});
  });

  it('ignores a late save acknowledgment from before a send, keeping the next message',async()=>{
    await renderApp();
    let release!:()=>void;
    const held=new Promise<void>(resolve=>{release=resolve;});
    const serve=vi.mocked(write).getMockImplementation()!;
    vi.mocked(write).mockImplementationOnce(async (...args)=>{const response=await serve(...args);await held;return response;});
    await type('First message');await advance(400);
    expect(draft('shared')).toMatchObject({text:'First message',revision:1});
    await act(async()=>container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click());
    expect(draft('shared')).toMatchObject({text:'',reason:'sent',revision:2});
    await type('Second message');
    await act(async()=>release());
    await advance(400);await advance(400);
    expect(draft('shared')).toMatchObject({text:'Second message',revision:3});
    expect(textarea().value).toBe('Second message');
  });

  it('keeps the words typed here over a newer phone edit, and saves them on its revision',async()=>{
    phone.edit('shared','Start');
    await renderApp();
    expect(textarea().value).toBe('Start');
    phone.edit('shared','Phone words');
    await type('Laptop words');await advance(400);await advance(400);
    expect(draftPuts('shared').map(([,body])=>body)).toEqual([
      {text:'Laptop words',attachments:[],baseRevision:1},
      {text:'Laptop words',attachments:[],baseRevision:2},
    ]);
    expect(draft('shared')).toMatchObject({text:'Laptop words',revision:3});
    expect(textarea().value).toBe('Laptop words');
    expect(cached('shared')).toMatchObject({dirty:false,baseRevision:3});
  });

  it('saves an edit again on the new revision when its save on leaving the assistant conflicts',async()=>{
    await renderApp();
    phone.edit('shared','Phone words');
    await type('Laptop words');
    await open('Other');await advance(0);
    expect(draftPuts('shared').map(([,body])=>body)).toEqual([
      {text:'Laptop words',attachments:[],baseRevision:0},
      {text:'Laptop words',attachments:[],baseRevision:1},
    ]);
    expect(draft('shared')).toMatchObject({text:'Laptop words',revision:2});
    expect(cached('shared')).toMatchObject({text:'Laptop words',dirty:false,baseRevision:2});
  });

  it('keeps a message typed right after sending, although the server cleared the draft for that send',async()=>{
    phone.edit('shared','First message');
    await renderApp();
    await act(async()=>container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click());
    expect(draft('shared')).toMatchObject({text:'',reason:'sent',revision:2});
    expect(textarea().value).toBe('');
    await type('Second message');await advance(400);await advance(400);
    expect(draft('shared')).toMatchObject({text:'Second message',revision:3});
    expect(textarea().value).toBe('Second message');
  });

  it('clears the server draft when a message is sent before its last edits were saved',async()=>{
    phone.edit('shared','Pick up fe');
    await renderApp();
    await type('Pick up feed');
    await act(async()=>container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click());
    expect(vi.mocked(write).mock.calls.find(([path])=>path==='/bots/shared/messages')![1]).toMatchObject({text:'Pick up feed',draftBaseRevision:1});
    expect(draftPuts('shared')).toEqual([]);
    expect(draft('shared')).toMatchObject({text:'',reason:'sent',revision:2});
    await act(async()=>root.unmount());await renderApp();await advance(400);
    expect(textarea().value).toBe('');
  });

  it('refreshes the open draft when the page is shown again and while it stays open',async()=>{
    phone.edit('shared','Buy feed');
    await renderApp();
    expect(textarea().value).toBe('Buy feed');
    phone.send('shared','Buy feed');
    await act(async()=>document.dispatchEvent(new Event('visibilitychange')));await advance(0);
    expect(textarea().value).toBe('');
    phone.edit('shared','Fix the gate');
    await advance(1600);
    expect(textarea().value).toBe('Fix the gate');
    expect(draftPuts('shared')).toEqual([]);
  });

  it('sends a save as an ordinary request when overlapping keepalive saves would exceed the browser budget',async()=>{
    await renderApp();
    let release!:()=>void;
    const held=new Promise<void>(resolve=>{release=resolve;});
    const serve=vi.mocked(write).getMockImplementation()!;
    vi.mocked(write).mockImplementation(async (...args)=>{await held;return serve(...args);});
    const long=(word:string)=>word.repeat(35_000/word.length);
    await type(long('feed '));await open('Other');
    await type(long('gate '));await open('Shared');
    expect(draftPuts('shared')[0][3]).toEqual({keepalive:true});
    expect(draftPuts('other')).toHaveLength(1);
    expect(draftPuts('other')[0]).toHaveLength(3);
    await act(async()=>release());await advance(0);
    expect(draft('shared').text).toBe(long('feed '));
    expect(draft('other').text).toBe(long('gate '));
  });

  it('saves a pending edit when the page is hidden or closed',async()=>{
    await renderApp();
    await type('Before closing');
    await act(async()=>window.dispatchEvent(new Event('pagehide')));
    expect(draftPuts('shared')).toEqual([['/bots/shared/draft',{text:'Before closing',attachments:[],baseRevision:0},'PUT',{keepalive:true}]]);
    await type('Before hiding');
    Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});
    try{await act(async()=>document.dispatchEvent(new Event('visibilitychange')));}
    finally{Reflect.deleteProperty(document,'visibilityState');}
    expect(draftPuts('shared').at(-1)).toEqual(['/bots/shared/draft',{text:'Before hiding',attachments:[],baseRevision:1},'PUT',{keepalive:true}]);
    await advance(400);
    expect(draftPuts('shared')).toHaveLength(2);
  });
});
