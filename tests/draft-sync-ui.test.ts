// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { api, ApiError, write } from '../src/client-api';
import { defaultPreferences, type Bootstrap, type SavedDraft } from '../src/shared/types';

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
    if(current.text&&(current.text===text||base!==undefined&&current.revision<=base))advanceDraft(bot,'','sent');
  },
};
let root:Root,container:HTMLDivElement,boot:Bootstrap;
const key=(bot:string)=>`agent-interface:draft:one:${bot}`;
const cached=(bot:string)=>JSON.parse(localStorage.getItem(key(bot))!);
const draftPuts=(bot:string)=>vi.mocked(write).mock.calls.filter(([path,,method])=>path===`/bots/${bot}/draft`&&method==='PUT');
beforeEach(()=>{
  vi.useFakeTimers();vi.clearAllMocks();vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
  vi.stubGlobal('matchMedia',vi.fn(()=>({matches:false,addEventListener:vi.fn(),removeEventListener:vi.fn()})));
  localStorage.clear();history.replaceState(null,'','/');drafts.clear();
  boot={user:{id:'one',name:'One',email:'one@example.test'},household:[],preferences:{...structuredClone(defaultPreferences),startPage:'assistant'},
    bots:[{id:'shared',name:'Shared',shared:true,model:'test',activity:'idle'},{id:'other',name:'Other',shared:true,model:'test',activity:'idle'}],
    capabilities:Object.fromEntries(['chat','steering','approvals','uploads','generatedFiles','botConfiguration','tools','skills','routines','durableEvents','idempotency','imageGeneration','stop','portraitGeneration','avatarMetadata'].map(key=>[key,{supported:true}])) as Bootstrap['capabilities'],connection:{connected:true},csrfToken:'csrf-one'};
  vi.mocked(api).mockImplementation(async <T>(path:string)=>{
    if(path==='/bootstrap')return boot as T;
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
  container=document.createElement('div');document.body.append(container);root=createRoot(container);
});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();localStorage.clear();vi.useRealTimers();vi.unstubAllGlobals();});
async function renderApp(){await act(async()=>root.render(createElement(App)));await advance(0);}
async function advance(ms:number){await act(async()=>vi.advanceTimersByTimeAsync(ms));}
const textarea=()=>container.querySelector('textarea')!;
async function type(text:string){
  const setValue=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!;
  await act(async()=>{setValue.call(textarea(),text);textarea().dispatchEvent(new Event('input',{bubbles:true}));});
}
const open=(name:string)=>act(async()=>[...container.querySelectorAll<HTMLButtonElement>('.bot-item')].find(button=>button.textContent?.includes(name))!.click());

describe('draft sync across devices',()=>{
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

  it('drops a stale unsaved copy once the server shows its text was sent, without saving it back',async()=>{
    // The save on switch never arrived, and the phone finished and sent the message.
    localStorage.setItem(key('shared'),JSON.stringify({text:'Pick up fe',attachments:[],botId:'shared',userId:'one',dirty:true,baseRevision:0}));
    phone.edit('shared','Pick up feed');phone.send('shared','Pick up feed');
    await renderApp();await advance(400);
    expect(textarea().value).toBe('');
    expect(cached('shared')).toMatchObject({text:'',dirty:false,baseRevision:2});
    expect(draftPuts('shared')).toEqual([]);
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
    await act(async()=>root.unmount());root=createRoot(container);await renderApp();await advance(400);
    expect(textarea().value).toBe('');
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
