// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { DiscoveryPanel } from '../src/components/DiscoveryPanel';
import { api } from '../src/client-api';
import type { Bootstrap, Message } from '../src/shared/types';
vi.mock('../src/client-api',()=>({api:vi.fn(),write:vi.fn()}));
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
