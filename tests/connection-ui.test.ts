// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { SignIn } from '../src/components/SignIn';
import { api, cachedResponse, clearResponseCache, write } from '../src/client-api';
import { defaultPreferences, type Bootstrap, type Conversation } from '../src/shared/types';
import { FakeEventSource } from './fake-event-source';

vi.mock('../src/client-api',async original=>({...await original<typeof import('../src/client-api')>(),api:vi.fn(),cachedResponse:vi.fn(),write:vi.fn().mockResolvedValue({}),clearResponseCache:vi.fn()}));
vi.mock('../src/components/Avatar',async original=>({...await original<typeof import('../src/components/Avatar')>(),Avatar:()=>null}));
let root:Root,container:HTMLDivElement,boot:Bootstrap,conversation:Conversation;
let authConfig:{localDevAuth:boolean;googleClientId?:string};
let pendingBootstrap:Promise<Bootstrap>|undefined;
let hermesDown:boolean;
beforeEach(()=>{
  vi.useFakeTimers();vi.clearAllMocks();vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
  FakeEventSource.reset();vi.stubGlobal('EventSource',FakeEventSource);
  vi.mocked(write).mockReset().mockResolvedValue({});
  vi.stubGlobal('matchMedia',vi.fn(()=>({matches:false,addEventListener:vi.fn(),removeEventListener:vi.fn()})));
  localStorage.clear();history.replaceState(null,'','/');
  boot={user:{id:'one',name:'One',email:'one@example.test'},household:[],preferences:{...structuredClone(defaultPreferences),startPage:"assistant"},bots:[{id:'shared',name:'Shared',shared:true,model:'test',activity:'idle'}],capabilities:Object.fromEntries(['chat','steering','approvals','uploads','generatedFiles','botConfiguration','tools','skills','routines','durableEvents','idempotency','imageGeneration','stop','portraitGeneration','avatarMetadata'].map(key=>[key,{supported:true}])) as Bootstrap['capabilities'],connection:{connected:true},csrfToken:'csrf-one'};
  conversation={botId:'shared',messages:[{id:'answer-one',role:'assistant',text:'Existing canonical answer'}],approvals:[],files:[],activity:{state:'idle'}};
  authConfig={localDevAuth:false};pendingBootstrap=undefined;hermesDown=false;
  vi.mocked(api).mockImplementation(async <T>(path:string)=>{
    if(path==='/bootstrap?roster=lean')return await (pendingBootstrap??Promise.resolve(boot)) as T;
    if(path==='/auth/config')return authConfig as T;
    if(path.startsWith('/bots/shared/conversation?')){if(hermesDown)throw new Error('Hermes unavailable');return conversation as T;}
    if(path==='/bots/shared/draft')return {text:boot.user.id==='one'?'My unsent draft':'Second member draft',attachments:[]} as T;
    return null as T;
  });
  container=document.createElement('div');document.body.append(container);root=createRoot(container);
});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();localStorage.clear();vi.useRealTimers();vi.unstubAllGlobals();Reflect.deleteProperty(window,'google');Reflect.deleteProperty(navigator,'onLine');});
async function renderApp(){await act(async()=>root.render(createElement(App)));}
async function advance(ms:number){await act(async()=>vi.advanceTimersByTimeAsync(ms));}
// The server reports a change, as Hermes frames or a write would.
async function changed(){await act(async()=>FakeEventSource.notifyAll());await advance(1500);}
// Screens such as preferences load on first use.
async function loaded(){await act(async()=>{await vi.dynamicImportSettled();});}
// jsdom has no layout, so the transcript reports a fixed 2000px history in a 300px view.
const transcriptSize=()=>{
  const height=vi.spyOn(Element.prototype,'scrollHeight','get').mockImplementation(function(this:Element){return this.classList.contains('transcript')?2000:0;});
  const view=vi.spyOn(Element.prototype,'clientHeight','get').mockImplementation(function(this:Element){return this.classList.contains('transcript')?300:0;});
  return {mockRestore(){height.mockRestore();view.mockRestore();}};
};
const googleScript=()=>document.head.querySelector<HTMLScriptElement>('script[src="https://accounts.google.com/gsi/client"]')!;

describe('setup and recovery interface',()=>{
  it('opens at the latest message even when another device saved an earlier position',async()=>{
    conversation.messages.push({id:'later-answer',role:'assistant',text:'Later answer'});
    Object.assign(conversation,{readPosition:{messageId:'answer-one',scrollTop:40}});
    const size=transcriptSize();
    try{
      await renderApp();await advance(20);
      expect(container.querySelector<HTMLElement>('.transcript')!.scrollTop).toBe(2000);
      expect(container.querySelector('.jump-latest')).toBeNull();
      expect(api).toHaveBeenCalledWith('/bots/shared/conversation?turns=20');
    }finally{size.mockRestore();}
  });

  it('loads recent turns first and holds the reader in place while earlier turns load',async()=>{
    const turn=(n:number)=>[{id:`p${n}`,role:'user' as const,text:`Prompt ${n}`},{id:`a${n}`,role:'assistant' as const,text:`Reply ${n}`}];
    const paths:string[]=[];
    vi.mocked(api).mockImplementation(async <T>(path:string)=>{
      if(path==='/bootstrap?roster=lean')return boot as T;
      if(!path.startsWith('/bots/shared/conversation?'))return null as T;
      paths.push(path);
      return (path.includes('turns=20')&&path.includes('start=')||path.includes('start=p0')
        ?{...conversation,messages:[...turn(0),...turn(1)],earlier:0}:{...conversation,messages:turn(1),earlier:2}) as T;
    });
    const size=transcriptSize();
    // The prompt being read sits 50px below the top until two earlier messages arrive above it.
    const rects=vi.spyOn(Element.prototype,'getBoundingClientRect').mockImplementation(function(this:Element){
      const top=this.classList.contains('transcript')?100:(this as HTMLElement).dataset.messageId==='p1'
        ?(document.querySelector('[data-message-id="p0"]')?650:150):0;
      return {top,bottom:top+100} as DOMRect;
    });
    try{
      await renderApp();await changed();
      expect(paths.slice(0,2)).toEqual(['/bots/shared/conversation?turns=20','/bots/shared/conversation?start=p1']);
      const transcript=container.querySelector<HTMLElement>('.transcript')!;
      transcript.scrollTop=300;
      await act(async()=>transcript.dispatchEvent(new Event('scroll')));
      const earlier=[...container.querySelectorAll('button')].find(button=>button.textContent==='Show earlier messages')!;
      await act(async()=>earlier.click());
      expect(paths).toContain('/bots/shared/conversation?start=p1&turns=20');
      expect(container.querySelector('[data-message-id="p0"]')).not.toBeNull();
      expect(transcript.scrollTop).toBe(800);
      expect(container.textContent).toContain('This is the start of your conversation with Shared.');
      await changed();
      expect(paths.at(-1)).toBe('/bots/shared/conversation?start=p0');
    }finally{size.mockRestore();rects.mockRestore();}
  });

  it('keeps the cached message a reader scrolled to when the first refresh has moved past it',async()=>{
    const turn=(n:number)=>[{id:`p${n}`,role:'user' as const,text:`Prompt ${n}`},{id:`a${n}`,role:'assistant' as const,text:`Reply ${n}`}];
    vi.mocked(cachedResponse).mockReturnValue({...conversation,messages:[...turn(0),...turn(1)],earlier:0});
    let respond!:()=>void;const paths:string[]=[];
    vi.mocked(api).mockImplementation(async <T>(path:string)=>{
      if(path==='/bootstrap?roster=lean')return boot as T;
      if(!path.startsWith('/bots/shared/conversation?'))return null as T;
      paths.push(path);
      if(path.includes('start=p0'))return {...conversation,messages:[...turn(0),...turn(1),...turn(2)],earlier:0} as T;
      return await new Promise<T>(resolve=>{respond=()=>resolve({...conversation,messages:[...turn(1),...turn(2)],earlier:2} as T);});
    });
    const size=transcriptSize();
    try{
      await renderApp();
      expect(container.querySelector('[data-message-id="p0"]')).not.toBeNull();
      const transcript=container.querySelector<HTMLElement>('.transcript')!;
      transcript.scrollTop=300;
      await act(async()=>transcript.dispatchEvent(new Event('scroll')));
      await act(async()=>respond());
      expect(paths).toEqual(['/bots/shared/conversation?turns=20','/bots/shared/conversation?start=p0']);
      expect(container.querySelector('[data-message-id="p0"]')).not.toBeNull();
      expect(container.querySelector('[data-message-id="a2"]')).not.toBeNull();
    }finally{size.mockRestore();vi.mocked(cachedResponse).mockReset();}
  });

  it('holds the reader in place when an image above them finishes loading',async()=>{
    const resized:(()=>void)[]=[];
    vi.stubGlobal('ResizeObserver',class{constructor(callback:()=>void){resized.push(callback);}observe(){}disconnect(){}});
    let readingTop=150;
    const size=transcriptSize();
    const rects=vi.spyOn(Element.prototype,'getBoundingClientRect').mockImplementation(function(this:Element){
      const top=this.classList.contains('transcript')?100:(this as HTMLElement).dataset.messageId==='answer-one'?readingTop:0;
      return {top,bottom:top+100} as DOMRect;
    });
    try{
      await renderApp();await advance(20);
      const transcript=container.querySelector<HTMLElement>('.transcript')!;
      transcript.scrollTop=300;
      await act(async()=>transcript.dispatchEvent(new Event('scroll')));
      readingTop=400;
      await act(async()=>resized.forEach(callback=>callback()));
      expect(transcript.scrollTop).toBe(550);
    }finally{size.mockRestore();rects.mockRestore();}
  });

  it('counts a reply as new when its text arrives after its reasoning was seen',async()=>{
    conversation.messages.push({id:'live',role:'assistant',text:'',reasoning:'Checking the pantry'});
    const size=transcriptSize();
    try{
      await renderApp();await advance(20);
      const transcript=container.querySelector<HTMLElement>('.transcript')!;
      transcript.scrollTop=300;
      await act(async()=>transcript.dispatchEvent(new Event('scroll')));
      conversation={...conversation,messages:[conversation.messages[0],{id:'live',role:'assistant',text:'Pot roast tonight'}]};
      await changed();
      expect(container.querySelector('.jump-latest')!.textContent).toBe('1 new message');
    }finally{size.mockRestore();}
  });

  it('counts replies that arrive while reading earlier messages and jumps back to them',async()=>{
    const size=transcriptSize();
    try{
      await renderApp();await advance(20);
      const transcript=container.querySelector<HTMLElement>('.transcript')!;
      transcript.scrollTop=300;
      await act(async()=>transcript.dispatchEvent(new Event('scroll')));
      expect(container.querySelector('.jump-latest')!.textContent).toBe('Jump to latest');
      conversation={...conversation,messages:[...conversation.messages,{id:'fresh',role:'assistant',text:'Fresh reply'}]};
      await changed();
      expect(transcript.scrollTop).toBe(300);
      expect(container.querySelector('.jump-latest')!.textContent).toBe('1 new message');
      await act(async()=>container.querySelector<HTMLButtonElement>('.jump-latest')!.click());
      expect(transcript.scrollTop).toBe(2000);
      expect(document.activeElement).toBe(transcript);
      expect(container.querySelector('.jump-latest')).toBeNull();
      conversation={...conversation,messages:[...conversation.messages,{id:'followed',role:'assistant',text:'Followed reply'}]};
      transcript.scrollTop=1700;
      await changed();
      expect(transcript.scrollTop).toBe(2000);
    }finally{size.mockRestore();}
  });

  it('saves the visible message anchor while reading older messages',async()=>{
    conversation.messages.push({id:'latest-answer',role:'assistant',text:'Latest answer'});
    await renderApp();await advance(20);
    const transcript=container.querySelector<HTMLElement>('.transcript')!;
    Object.defineProperties(transcript,{scrollHeight:{value:2000},clientHeight:{value:300}});
    transcript.scrollTop=300;
    transcript.getBoundingClientRect=()=>({top:100,bottom:400} as DOMRect);
    container.querySelector<HTMLElement>('[data-message-id="answer-one"]')!.getBoundingClientRect=()=>({top:80,bottom:220} as DOMRect);
    container.querySelector<HTMLElement>('[data-message-id="latest-answer"]')!.getBoundingClientRect=()=>({top:1800,bottom:1900} as DOMRect);
    await act(async()=>transcript.dispatchEvent(new Event('scroll')));
    await advance(310);
    expect(write).toHaveBeenCalledWith('/bots/shared/read-position',{scrollTop:300,messageId:'answer-one'},'PUT');
  });

  it('gives an unconfigured household a concrete setup action and rechecks saved settings',async()=>{
    await act(async()=>root.render(createElement(SignIn,{onSuccess:vi.fn()})));
    expect(container.textContent).toContain('npm run setup');
    expect(container.textContent).toContain('Start on the computer running this app');
    const button=Array.from(container.querySelectorAll('button')).find(node=>node.textContent==='Check setup again')!;
    expect(button).toBeDefined();expect(googleScript()).toBeNull();
    authConfig={localDevAuth:true};await act(async()=>button.click());
    expect(container.textContent).toContain('Enter local workspace');
    expect(container.textContent).not.toContain('Start on the computer running this app');
  });

  it('keeps a Google script failure visible during config polling and retries the script explicitly',async()=>{
    authConfig={localDevAuth:false,googleClientId:'household-client'};
    await act(async()=>root.render(createElement(SignIn,{onSuccess:vi.fn()})));
    const failed=googleScript();expect(failed).toBeDefined();
    await act(async()=>failed.dispatchEvent(new Event('error')));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Google sign-in couldn't load");
    await advance(8000);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Google sign-in couldn't load");
    const retry=Array.from(container.querySelectorAll('button')).find(node=>node.textContent==='Try again')!;
    await act(async()=>retry.click());expect(googleScript()).not.toBe(failed);expect(failed.isConnected).toBe(false);
    const initialize=vi.fn(),renderButton=vi.fn((element:HTMLElement)=>{element.textContent='Google sign-in ready';});
    Object.defineProperty(window,'google',{configurable:true,value:{accounts:{id:{initialize,renderButton}}}});
    await act(async()=>googleScript().dispatchEvent(new Event('load')));
    expect(initialize).toHaveBeenCalledTimes(1);expect(renderButton).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('preserves the selected bot, unsent draft and existing transcript during a same-user empty-roster outage',async()=>{
    await renderApp();expect(container.querySelector('textarea')?.value).toBe('My unsent draft');
    expect(container.querySelector('.transcript')?.textContent).toContain('Existing canonical answer');
    hermesDown=true;boot={...boot,bots:[],connection:{connected:false,code:'unreachable'}};
    await advance(45_000);
    expect(new URL(location.href).searchParams.get('bot')).toBe('shared');
    expect(container.querySelector('textarea')?.value).toBe('My unsent draft');
    expect(container.querySelector('.transcript')?.textContent).toContain('Existing canonical answer');
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')?.disabled).toBe(true);
    expect(container.textContent).toContain('Hermes is temporarily unavailable');
    expect(JSON.parse(localStorage.getItem('agent-interface:draft:one:shared')!).text).toBe('My unsent draft');
  });

  it('coalesces a focus, visibility and online storm into one outstanding bootstrap read',async()=>{
    await renderApp();const initial=vi.mocked(api).mock.calls.filter(([path])=>path==='/bootstrap?roster=lean').length;
    let finish!:(value:Bootstrap)=>void;pendingBootstrap=new Promise(resolve=>{finish=resolve;});
    await act(async()=>{for(let i=0;i<8;i++){window.dispatchEvent(new Event('focus'));window.dispatchEvent(new Event('online'));document.dispatchEvent(new Event('visibilitychange'));}});
    expect(vi.mocked(api).mock.calls.filter(([path])=>path==='/bootstrap?roster=lean')).toHaveLength(initial+1);
    await act(async()=>{finish(boot);});
    expect(container.querySelector('textarea')?.value).toBe('My unsent draft');
  });

  it('falls back to an existing bot when a saved default and deep link no longer exist',async()=>{
    boot.preferences.defaultBotId='removed';history.replaceState(null,'','/?bot=removed');
    await renderApp();
    expect(new URL(location.href).searchParams.get('bot')).toBe('shared');
    expect(container.querySelector('.transcript')?.textContent).toContain('Existing canonical answer');
    expect(vi.mocked(api).mock.calls.some(([path])=>path.includes('/bots/removed/'))).toBe(false);
  });

  it('ignores an old identity send response without clearing the new identity draft or replaying work',async()=>{
    let finish!:(receipt:{requestId:string;status:'accepted'})=>void;
    const response=new Promise<{requestId:string;status:'accepted'}>(resolve=>{finish=resolve;});
    vi.mocked(write).mockImplementation(async <T>(path:string)=>path==='/bots/shared/messages'?await response as T:{} as T);
    await renderApp();
    await act(async()=>container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click());
    const admission=vi.mocked(write).mock.calls.find(([path])=>path==='/bots/shared/messages')!;
    const requestId=(admission[1] as {requestId:string}).requestId;
    expect(requestId).toBeDefined();
    expect(clearResponseCache).not.toHaveBeenCalled();
    boot={...boot,user:{id:'two',name:'Two',email:'two@example.test'},csrfToken:'csrf-two'};
    await act(async()=>window.dispatchEvent(new Event('focus')));
    expect(clearResponseCache).toHaveBeenCalledTimes(1);
    expect(container.querySelector('textarea')?.value).toBe('Second member draft');
    await act(async()=>finish({requestId,status:'accepted'}));
    expect(container.querySelector('textarea')?.value).toBe('Second member draft');
    expect(JSON.parse(localStorage.getItem('agent-interface:draft:one:shared')!).text).toBe('My unsent draft');
    expect(vi.mocked(write).mock.calls.filter(([path])=>path==='/bots/shared/messages')).toHaveLength(1);
  });

  it.each(['receipt','failure'])('ignores an old identity retry %s while the next identity is sending',async(outcome)=>{
    const pending={requestId:'saved-request',botId:'shared',text:'My unsent draft',attachments:[],reviewedInterruption:false};
    localStorage.setItem('agent-interface:submission:one:shared',JSON.stringify(pending));
    const original=vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation(async <T>(path:string,init?:RequestInit)=>path==='/submissions/saved-request'
      ? {requestId:'saved-request',status:'uncertain'} as T : await original(path,init) as T);
    let finish!:()=>void;
    const retry=new Promise((resolve,reject)=>{finish=()=>outcome==='receipt'
      ? resolve({requestId:'saved-request',status:'rejected',message:'Old account rejection'})
      : reject(new Error('Old account retry failure'));});
    vi.mocked(write).mockReturnValueOnce(retry).mockReturnValueOnce(new Promise(()=>{}));
    await renderApp();
    const button=Array.from(container.querySelectorAll('button')).find(node=>node.textContent==='Retry this saved message')!;
    await act(async()=>button.click());
    boot={...boot,user:{id:'two',name:'Two',email:'two@example.test'},csrfToken:'csrf-two'};
    await act(async()=>window.dispatchEvent(new Event('focus')));
    await act(async()=>container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click());
    expect(vi.mocked(write).mock.calls.filter(([path])=>path==='/bots/shared/messages')).toHaveLength(2);
    await act(async()=>finish());
    expect(container.textContent).not.toContain('Old account');
    expect(container.querySelector('textarea')?.value).toBe('Second member draft');
    // An in-flight send only spins the send button; Retry returns if it ends without a receipt.
    expect(Array.from(container.querySelectorAll('button')).some(node=>node.textContent==='Retry this saved message')).toBe(false);
    expect(container.querySelector('[aria-label="Send message"]')?.getAttribute('aria-busy')).toBe('true');
    expect(JSON.parse(localStorage.getItem('agent-interface:submission:one:shared')!).requestId).toBe('saved-request');
  });

  it.each(['admission','reconciliation'])('clears local state after a deferred %s receipt without writing draft data over another device',async(mode)=>{
    let finish!:(receipt:{requestId:string;status:'accepted'})=>void;
    const response=new Promise<{requestId:string;status:'accepted'}>(resolve=>{finish=resolve;});
    let requestId='saved-request';
    if(mode==='reconciliation'){
      localStorage.setItem('agent-interface:draft:one:shared',JSON.stringify({text:'My unsent draft',attachments:[],botId:'shared',userId:'one',dirty:true}));
      localStorage.setItem('agent-interface:submission:one:shared',JSON.stringify({requestId,botId:'shared',text:'My unsent draft',attachments:[],reviewedInterruption:false}));
      const original=vi.mocked(api).getMockImplementation()!;
      vi.mocked(api).mockImplementation(async <T>(path:string,init?:RequestInit)=>path===`/submissions/${requestId}`?await response as T:await original(path,init) as T);
    }else{
      vi.mocked(write).mockImplementation(async <T>(path:string)=>path==='/bots/shared/messages'?await response as T:{} as T);
    }
    await renderApp();await advance(400);
    if(mode==='admission'){
      const textarea=container.querySelector('textarea')!;
      const setValue=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!;
      await act(async()=>{setValue.call(textarea,'Edited immediately before sending');textarea.dispatchEvent(new Event('input',{bubbles:true}));});
      await act(async()=>container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click());
      requestId=(vi.mocked(write).mock.calls.find(([path])=>path==='/bots/shared/messages')![1] as {requestId:string}).requestId;
    }
    vi.mocked(write).mockClear();
    await advance(400);
    expect(vi.mocked(write).mock.calls.some(([path,_,method])=>path==='/bots/shared/draft'&&method==='PUT')).toBe(false);
    await act(async()=>finish({requestId,status:'accepted'}));
    await advance(400);
    expect(container.querySelector('textarea')?.value).toBe('');
    expect(vi.mocked(write).mock.calls.some(([path])=>path==='/bots/shared/draft/clear')).toBe(false);
    expect(vi.mocked(write).mock.calls.some(([path,value,method])=>path==='/bots/shared/draft'&&method==='PUT'&&(value as {text?:string}).text==='')).toBe(false);
  });

  it('refreshes a clean cached draft from a newer server draft after remount without writing hydration back',async()=>{
    await renderApp();await advance(400);expect(write).not.toHaveBeenCalled();
    const original=vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation(async <T>(path:string,init?:RequestInit)=>path==='/bots/shared/draft'?{text:'New draft from my phone',attachments:[]} as T:await original(path,init) as T);
    await act(async()=>root.unmount());root=createRoot(container);await renderApp();await advance(400);
    expect(container.querySelector('textarea')?.value).toBe('New draft from my phone');
    expect(JSON.parse(localStorage.getItem('agent-interface:draft:one:shared')!).text).toBe('New draft from my phone');
    expect(write).not.toHaveBeenCalled();
  });

  it('keeps a dirty offline edit through remount and saves it once the connection returns',async()=>{
    await renderApp();
    Object.defineProperty(navigator,'onLine',{configurable:true,value:false});
    await act(async()=>window.dispatchEvent(new Event('offline')));
    const textarea=container.querySelector('textarea')!;
    const setValue=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!;
    await act(async()=>{setValue.call(textarea,'Written while offline');textarea.dispatchEvent(new Event('input',{bubbles:true}));});
    await advance(400);
    const key='agent-interface:draft:one:shared';
    expect(JSON.parse(localStorage.getItem(key)!)).toMatchObject({text:'Written while offline',dirty:true});
    expect(write).not.toHaveBeenCalled();
    await act(async()=>root.unmount());root=createRoot(container);await renderApp();
    expect(container.querySelector('textarea')?.value).toBe('Written while offline');
    // The server answers a save with the draft it now holds.
    vi.mocked(write).mockImplementation(async <T>(_path:string,value:unknown)=>({...value as object,revision:1,reason:'edit',sentRevision:0}) as T);
    Object.defineProperty(navigator,'onLine',{configurable:true,value:true});
    await act(async()=>window.dispatchEvent(new Event('online')));await advance(400);
    expect(write).toHaveBeenCalledExactlyOnceWith('/bots/shared/draft',{text:'Written while offline',attachments:[],baseRevision:0},'PUT');
    expect(JSON.parse(localStorage.getItem(key)!)).toMatchObject({text:'Written while offline',dirty:false});
    expect(container.querySelector('textarea')?.value).toBe('Written while offline');
  });
});
it.each(['','?bot=shared'])('uses Today only when initial navigation has no explicit conversation: %s',async(query)=>{
  boot.preferences.startPage=undefined;const previous=vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation(async <T>(path:string)=>path==='/today'?{generatedAt:new Date().toISOString(),since:new Date().toISOString(),frontier:'0',hasMore:false,items:[],events:[],unavailableBots:[],upcoming:[]} as T:previous(path) as Promise<T>);
  history.replaceState(null,'',`/${query}`);await renderApp();
  expect(!!container.querySelector('.today-panel')).toBe(!query);expect(!!container.querySelector('.transcript')).toBe(!!query);
});
it('offers a role discussion specific to an empty assistant and preserves an existing draft',async()=>{
  conversation.messages=[];
  boot.bots[0].description='Plan easy family dinners';
  await renderApp();await advance(20);
  const button=container.querySelector<HTMLButtonElement>('.empty-state button')!;
  expect(button.textContent).toContain(boot.bots[0].name);
  await act(async()=>button.click());
  expect(container.querySelector('textarea')!.value).toContain('Plan easy family dinners');
  expect(write).not.toHaveBeenCalledWith('/bots/shared/messages',expect.anything());
});
it('lets the next sign-in send after signing out while a send was unanswered',async()=>{
  for(const [name,open] of [['showModal',true],['close',false]] as const)Object.defineProperty(HTMLDialogElement.prototype,name,{configurable:true,value:function(this:HTMLDialogElement){this.open=open;}});
  authConfig={localDevAuth:true};
  const previous=vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation(async <T>(path:string,init?:RequestInit)=>path.startsWith('/submissions/')?{status:'rejected'} as T:await previous(path,init) as T);
  vi.mocked(write).mockImplementation(async <T>(path:string)=>path==='/bots/shared/messages'?await new Promise<T>(()=>{}):{} as T);
  const button=(label:string)=>[...container.querySelectorAll('button')].find(node=>node.textContent?.trim()===label)!;
  await renderApp();await advance(400);
  await act(async()=>container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click());
  await act(async()=>container.querySelector<HTMLButtonElement>('[aria-label="Settings"]')!.click());
  await loaded();
  await act(async()=>button('Sign out').click());
  expect(container.querySelector('.sign-in')).not.toBeNull();
  await act(async()=>button('Enter local workspace').click());
  await advance(2500);
  expect(container.textContent).not.toContain('Checking whether Hermes accepted your message');
  expect(container.querySelector('textarea')?.value).toBe('My unsent draft');
  expect(container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')?.disabled).toBe(false);
});
it('fits a restored multi-line draft when returning to the conversation',async()=>{
  Object.defineProperty(HTMLTextAreaElement.prototype,'scrollHeight',{configurable:true,get(this:HTMLTextAreaElement){return this.value.split('\n').length*24;}});
  try{
    const previous=vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation(async <T>(path:string)=>path==='/bots/shared/draft'?{text:'Milk\nEggs\nFlour\nButter',attachments:[]} as T
      :path==='/today'?{generatedAt:new Date().toISOString(),since:new Date().toISOString(),frontier:'0',hasMore:false,items:[],events:[],unavailableBots:[],upcoming:[]} as T:previous(path) as Promise<T>);
    await renderApp();
    expect(container.querySelector('textarea')!.style.height).toBe('96px');
    await act(async()=>[...container.querySelectorAll<HTMLButtonElement>('.home-links button')].find(node=>node.textContent?.includes('Today'))!.click());
    expect(container.querySelector('textarea')).toBeNull();
    await act(async()=>container.querySelector<HTMLButtonElement>('.bot-item')!.click());
    expect(container.querySelector('textarea')!.style.height).toBe('96px');
  }finally{Reflect.deleteProperty(HTMLTextAreaElement.prototype,'scrollHeight');}
});
describe('pushed conversation updates',()=>{
  const reads=()=>vi.mocked(api).mock.calls.filter(([path])=>String(path).startsWith('/bots/shared/conversation?')).length;
  const opened=async()=>{
    await renderApp();await advance(20);
    expect(FakeEventSource.created).toEqual(['/api/events','/api/bots/shared/events?inflight=1']);
    const stream=[...FakeEventSource.streams].find(stream=>stream.url.includes('/bots/'))!;
    // A change between the first read and the subscription would be lost, so connecting reloads.
    const before=reads();
    await act(async()=>stream.connect());await advance(0);
    expect(reads()).toBe(before+1);
    return stream;
  };
  it('refetches on each change notice and otherwise polls only every 30 seconds',async()=>{
    const stream=await opened();
    const first=reads();
    await advance(29_000);
    expect(reads()).toBe(first);
    conversation={...conversation,messages:[...conversation.messages,{id:'answer-two',role:'assistant',text:'Pushed answer'}]};
    await act(async()=>stream.emit('message','change'));await advance(20);
    expect(reads()).toBe(first+1);
    expect(container.textContent).toContain('Pushed answer');
    // Pings only show the stream is alive.
    await act(async()=>stream.emit('ping','ping'));await advance(20);
    expect(reads()).toBe(first+1);
    await advance(1_000);
    expect(reads()).toBe(first+2);
  });
  it('reloads after a dropped stream reconnects and replaces a refused or silent one at the next poll',async()=>{
    const stream=await opened();
    const first=reads();
    // EventSource reconnects a drop by itself. Notices sent meanwhile are lost, so it reloads.
    await act(async()=>stream.connect());await advance(20);
    expect(reads()).toBe(first+1);
    // A refusal is never retried by EventSource itself.
    await act(async()=>stream.fail());
    await advance(30_000);
    expect(FakeEventSource.created.filter(url=>url.includes("/bots/"))).toHaveLength(2);
    const replacement=[...FakeEventSource.streams].find(stream=>stream.url.includes("/bots/"))!;
    const replaced=reads();
    await act(async()=>replacement.connect());await advance(0);
    expect(reads()).toBe(replaced+1);
    // A minute without a ping looks like a dead connection; the next poll after that replaces it.
    await advance(59_000);expect(FakeEventSource.created.filter(url=>url.includes("/bots/"))).toHaveLength(2);await advance(31_000);
    expect(FakeEventSource.created.filter(url=>url.includes("/bots/"))).toHaveLength(3);
    expect(FakeEventSource.streams.size).toBe(2);
  });
  it('closes the stream and stops polling while hidden, then refreshes at once when shown',async()=>{
    let visibility:DocumentVisibilityState='visible';
    Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>visibility});
    try{
      await opened();
      const shown=async(state:DocumentVisibilityState)=>{visibility=state;await act(async()=>document.dispatchEvent(new Event('visibilitychange')));};
      await shown('hidden');
      expect(FakeEventSource.streams.size).toBe(0);
      const hidden=reads();
      await advance(120_000);
      expect(reads()).toBe(hidden);
      await shown('visible');await advance(0);
      expect(reads()).toBe(hidden+1);
      expect(FakeEventSource.created.filter(url=>url.includes("/bots/"))).toHaveLength(2);
      expect(FakeEventSource.streams.size).toBe(2);
    }finally{Reflect.deleteProperty(document,'visibilityState');}
  });
});
