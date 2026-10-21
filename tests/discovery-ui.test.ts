// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { DiscoveryPanel } from '../src/components/DiscoveryPanel';
import { ApiError, api } from '../src/client-api';
import type { Bootstrap, Message } from '../src/shared/types';
vi.mock('../src/client-api',async(importOriginal)=>({...await importOriginal<typeof import('../src/client-api')>(),api:vi.fn(),write:vi.fn()}));
let root:Root|undefined;let container:HTMLDivElement;
afterEach(async()=>{if(root)await act(async()=>root!.unmount());container?.remove();vi.unstubAllGlobals();});
it('does not let a late history response replace the selected automation view',async()=>{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);let resolve!:(value:unknown)=>void;const history=new Promise(done=>resolve=done);
  vi.mocked(api).mockImplementation(async(path)=>path.startsWith('/search')?{hits:[{botId:'ranch',botName:'Ranch',sessionId:'history',title:'Dinners',snippet:'Plan'}],unavailableBots:[]}:path.includes('/history/')?history:path==='/automations'?{routines:[],usage:[],unavailableBots:[]}:[]);
  container=document.createElement('div');document.body.append(container);root=createRoot(container);const boot={user:{id:'one'},bots:[{id:'ranch',name:'Ranch'}],household:[]} as unknown as Bootstrap;
  await act(async()=>root!.render(createElement(DiscoveryPanel,{bootstrap:boot,onRoutine:()=>{}})));
  const input=container.querySelector('input')!;await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'dinners');input.dispatchEvent(new Event('input',{bubbles:true}));});
  await act(async()=>container.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
  await act(async()=>container.querySelector<HTMLButtonElement>('.today-row')!.click());
  await act(async()=>[...container.querySelectorAll('button')].find(button=>button.textContent==='Automations')!.click());
  await act(async()=>resolve({botId:'ranch',sessionId:'history',messages:[{id:'reply',role:'assistant',text:'Late reply'}] as Message[],offset:0,hasMore:false}));
  expect(container.textContent).toContain('Usage over 30 days');expect(container.textContent).not.toContain('Conversation history');expect(container.textContent).not.toContain('Late reply');
});
it('opens the current page of a matching identity and scrolls to the answer',async()=>{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
  const scroll=vi.fn();HTMLElement.prototype.scrollIntoView=scroll;
  vi.mocked(api).mockImplementation(async(path)=>path.startsWith('/search')?{hits:[{botId:'ranch',botName:'Ranch',sessionId:'history',title:'Dinners',snippet:'Plan',messageId:'stable',offset:100}],unavailableBots:[]}:path.includes('/history/')?{botId:'ranch',sessionId:'history',messages:[{id:'stable',role:'assistant',text:'The matching answer'}],offset:200,hasMore:false,targetMessageId:'stable'}:[]);
  container=document.createElement('div');document.body.append(container);root=createRoot(container);
  await act(async()=>root!.render(createElement(DiscoveryPanel,{bootstrap:{user:{id:'one'},bots:[{id:'ranch',name:'Ranch'}],household:[]} as unknown as Bootstrap,onRoutine:()=>{}})));
  await act(async()=>container.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
  await act(async()=>container.querySelector<HTMLButtonElement>('.today-row')!.click());
  expect(api).toHaveBeenCalledWith('/bots/ranch/history/history?offset=100&messageId=stable');
  expect(container.querySelector('#history-stable')?.textContent).toContain('The matching answer');
  expect(scroll).toHaveBeenCalledWith({block:'center'});
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
});

it('opens a search conversation without a highlight when the matching row was removed',async()=>{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
  vi.mocked(api).mockImplementation(async(path)=>{
    if(path.startsWith('/search'))return {hits:[{botId:'ranch',botName:'Ranch',sessionId:'history',title:'Dinners',snippet:'Plan',messageId:'removed'}],unavailableBots:[]};
    if(path.includes('messageId='))throw new ApiError('Original no longer available',404);
    return {botId:'ranch',sessionId:'history',messages:[{id:'remaining',role:'assistant',text:'Remaining conversation'}],offset:0,hasMore:false};
  });
  container=document.createElement('div');document.body.append(container);root=createRoot(container);
  await act(async()=>root!.render(createElement(DiscoveryPanel,{bootstrap:{user:{id:'one'},bots:[{id:'ranch',name:'Ranch'}],household:[]} as unknown as Bootstrap,onRoutine:()=>{}})));
  await act(async()=>container.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
  await act(async()=>container.querySelector<HTMLButtonElement>('.today-row')!.click());
  expect(api).toHaveBeenCalledWith('/bots/ranch/history/history?offset=0');
  expect(container.textContent).toContain('Remaining conversation');
  expect(container.querySelector('#history-remaining')?.getAttribute('style')).toBeNull();
});
