// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { SignIn } from '../src/components/SignIn';
import { api, write } from '../src/client-api';
import { defaultPreferences, type Bootstrap, type Conversation } from '../src/shared/types';

vi.mock('../src/client-api',async original=>({...await original<typeof import('../src/client-api')>(),api:vi.fn(),write:vi.fn().mockResolvedValue({})}));
vi.mock('../src/components/Avatar',async original=>({...await original<typeof import('../src/components/Avatar')>(),Avatar:()=>null}));
let root:Root,container:HTMLDivElement,boot:Bootstrap,conversation:Conversation;
let authConfig:{localDevAuth:boolean;googleClientId?:string};
let pendingBootstrap:Promise<Bootstrap>|undefined;
let hermesDown:boolean;
beforeEach(()=>{
  vi.useFakeTimers();vi.clearAllMocks();vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
  vi.mocked(write).mockReset().mockResolvedValue({});
  vi.stubGlobal('matchMedia',vi.fn(()=>({matches:false,addEventListener:vi.fn(),removeEventListener:vi.fn()})));
  localStorage.clear();history.replaceState(null,'','/');
  boot={user:{id:'one',name:'One',email:'one@example.test'},household:[],preferences:structuredClone(defaultPreferences),bots:[{id:'shared',name:'Shared',shared:true,model:'test',activity:'idle'}],capabilities:Object.fromEntries(['chat','steering','approvals','uploads','generatedFiles','botConfiguration','tools','skills','routines','durableEvents','idempotency','imageGeneration','stop','portraitGeneration','avatarMetadata'].map(key=>[key,{supported:true}])) as Bootstrap['capabilities'],connection:{connected:true},csrfToken:'csrf-one'};
  conversation={botId:'shared',messages:[{id:'answer-one',role:'assistant',text:'Existing canonical answer'}],approvals:[],files:[],activity:{state:'idle'}};
  authConfig={localDevAuth:false};pendingBootstrap=undefined;hermesDown=false;
  vi.mocked(api).mockImplementation(async <T>(path:string)=>{
    if(path==='/bootstrap')return await (pendingBootstrap??Promise.resolve(boot)) as T;
    if(path==='/auth/config')return authConfig as T;
    if(path==='/bots/shared/conversation'){if(hermesDown)throw new Error('Hermes unavailable');return conversation as T;}
    if(path==='/bots/shared/draft')return {text:boot.user.id==='one'?'My unsent draft':'Second member draft',attachments:[]} as T;
    return null as T;
  });
  container=document.createElement('div');document.body.append(container);root=createRoot(container);
});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();localStorage.clear();vi.useRealTimers();vi.unstubAllGlobals();Reflect.deleteProperty(window,'google');Reflect.deleteProperty(navigator,'onLine');});
async function renderApp(){await act(async()=>root.render(createElement(App)));}
async function advance(ms:number){await act(async()=>vi.advanceTimersByTimeAsync(ms));}
const googleScript=()=>document.head.querySelector<HTMLScriptElement>('script[src="https://accounts.google.com/gsi/client"]')!;

describe('setup and recovery interface',()=>{
  it('restores a native message anchor without a browser pixel offset',async()=>{
    conversation.messages.push({id:'later-answer',role:'assistant',text:'Later answer'});
    Object.assign(conversation,{readPosition:{messageId:'later-answer'}});
    await renderApp();
    const transcript=container.querySelector<HTMLElement>('.transcript')!;
    const anchor=container.querySelector<HTMLElement>('[data-message-id="later-answer"]')!;
    transcript.getBoundingClientRect=()=>({top:100,bottom:400} as DOMRect);
    anchor.getBoundingClientRect=()=>({top:700,bottom:800} as DOMRect);
    await advance(20);
    expect(transcript.scrollTop).toBe(600);
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
    await advance(8000);
    expect(new URL(location.href).searchParams.get('bot')).toBe('shared');
    expect(container.querySelector('textarea')?.value).toBe('My unsent draft');
    expect(container.querySelector('.transcript')?.textContent).toContain('Existing canonical answer');
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')?.disabled).toBe(true);
    expect(container.textContent).toContain('Hermes is temporarily unavailable');
    expect(JSON.parse(localStorage.getItem('agent-interface:draft:one:shared')!).text).toBe('My unsent draft');
  });

  it('coalesces a focus, visibility and online storm into one outstanding bootstrap read',async()=>{
    await renderApp();const initial=vi.mocked(api).mock.calls.filter(([path])=>path==='/bootstrap').length;
    let finish!:(value:Bootstrap)=>void;pendingBootstrap=new Promise(resolve=>{finish=resolve;});
    await act(async()=>{for(let i=0;i<8;i++){window.dispatchEvent(new Event('focus'));window.dispatchEvent(new Event('online'));document.dispatchEvent(new Event('visibilitychange'));}});
    expect(vi.mocked(api).mock.calls.filter(([path])=>path==='/bootstrap')).toHaveLength(initial+1);
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
    boot={...boot,user:{id:'two',name:'Two',email:'two@example.test'},csrfToken:'csrf-two'};
    await act(async()=>window.dispatchEvent(new Event('focus')));
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
    const nextRetry=Array.from(container.querySelectorAll('button')).find(node=>node.textContent==='Retry this saved message')!;
    expect(nextRetry.disabled).toBe(true);
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
    Object.defineProperty(navigator,'onLine',{configurable:true,value:true});
    await act(async()=>window.dispatchEvent(new Event('online')));await advance(400);
    expect(write).toHaveBeenCalledExactlyOnceWith('/bots/shared/draft',{text:'Written while offline',attachments:[],botId:'shared',userId:'one',dirty:true},'PUT');
    expect(JSON.parse(localStorage.getItem(key)!)).toMatchObject({text:'Written while offline',dirty:false});
    expect(container.querySelector('textarea')?.value).toBe('Written while offline');
  });
});
