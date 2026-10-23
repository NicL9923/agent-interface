// @vitest-environment jsdom
import { act, createElement } from 'react';
import type { Root } from 'react-dom/client';
import { beforeEach, expect, it, vi } from 'vitest';
import { DiscoveryPanel } from '../src/components/DiscoveryPanel';
import { ApiError, api } from '../src/client-api';
import type { Bootstrap, Message } from '../src/shared/types';
import { mountRoot, typeInto } from './ui-harness';
vi.mock('../src/client-api', async original => (await import("./helpers/request-mock")).withRequest(await (async(importOriginal)=>({...await importOriginal<typeof import('../src/client-api')>(),api:vi.fn(),write:vi.fn()}))(original)));
let root:Root;let container:HTMLDivElement;
beforeEach(()=>{({container,root}=mountRoot());});
it('does not let a late history response replace the selected automation view',async()=>{
  let resolve!:(value:unknown)=>void;const history=new Promise(done=>resolve=done);
  vi.mocked(api).mockImplementation(async(path)=>path.startsWith('/search')?{hits:[{botId:'ranch',botName:'Ranch',sessionId:'history',title:'Dinners',snippet:'Plan'}],unavailableBots:[]}:path.includes('/history/')?history:path==='/automations'?{routines:[],usage:[],unavailableBots:[]}:[]);
  const boot={user:{id:'one'},bots:[{id:'ranch',name:'Ranch'}],household:[]} as unknown as Bootstrap;
  await act(async()=>root.render(createElement(DiscoveryPanel,{bootstrap:boot,onRoutine:()=>{}})));
  const input=container.querySelector('input')!;await typeInto(input, 'dinners');
  await act(async()=>container.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
  await act(async()=>container.querySelector<HTMLButtonElement>('.today-row')!.click());
  await act(async()=>[...container.querySelectorAll('button')].find(button=>button.textContent==='Automations')!.click());
  await act(async()=>resolve({botId:'ranch',sessionId:'history',messages:[{id:'reply',role:'assistant',text:'Late reply'}] as Message[],offset:0,hasMore:false}));
  expect(container.textContent).toContain('Usage over 30 days');expect(container.textContent).not.toContain('Conversation history');expect(container.textContent).not.toContain('Late reply');
});
it('opens the current page of a matching identity and scrolls to the answer',async()=>{
  const scroll=vi.fn();HTMLElement.prototype.scrollIntoView=scroll;
  vi.mocked(api).mockImplementation(async(path)=>path.startsWith('/search')?{hits:[{botId:'ranch',botName:'Ranch',sessionId:'history',title:'Dinners',snippet:'Plan',messageId:'stable',offset:100}],unavailableBots:[]}:path.includes('/history/')?{botId:'ranch',sessionId:'history',messages:[{id:'stable',role:'assistant',text:'The matching answer'}],offset:200,hasMore:false,targetMessageId:'stable'}:[]);
    await act(async()=>root.render(createElement(DiscoveryPanel,{bootstrap:{user:{id:'one'},bots:[{id:'ranch',name:'Ranch'}],household:[]} as unknown as Bootstrap,onRoutine:()=>{}})));
  await act(async()=>container.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
  await act(async()=>container.querySelector<HTMLButtonElement>('.today-row')!.click());
  expect(api).toHaveBeenCalledWith('/bots/ranch/history/history?offset=100&messageId=stable');
  expect(container.querySelector('#history-stable')?.textContent).toContain('The matching answer');
  expect(scroll).toHaveBeenCalledWith({block:'center'});
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
});

it('opens a search conversation without a highlight when the matching row was removed',async()=>{
  vi.mocked(api).mockImplementation(async(path)=>{
    if(path.startsWith('/search'))return {hits:[{botId:'ranch',botName:'Ranch',sessionId:'history',title:'Dinners',snippet:'Plan',messageId:'removed'}],unavailableBots:[]};
    if(path.includes('messageId='))throw new ApiError('Original no longer available',404);
    return {botId:'ranch',sessionId:'history',messages:[{id:'remaining',role:'assistant',text:'Remaining conversation'}],offset:0,hasMore:false};
  });
    await act(async()=>root.render(createElement(DiscoveryPanel,{bootstrap:{user:{id:'one'},bots:[{id:'ranch',name:'Ranch'}],household:[]} as unknown as Bootstrap,onRoutine:()=>{}})));
  await act(async()=>container.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
  await act(async()=>container.querySelector<HTMLButtonElement>('.today-row')!.click());
  expect(api).toHaveBeenCalledWith('/bots/ranch/history/history?offset=0');
  expect(container.textContent).toContain('Remaining conversation');
  expect(container.querySelector('#history-remaining')?.getAttribute('style')).toBeNull();
});
