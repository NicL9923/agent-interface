// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api, write } from '../src/client-api';
import { agentEnvelope } from '../src/shared/collaboration';
import { GroupChats } from '../src/components/GroupChats';
import { RoutineResults } from '../src/components/RoutineResults';
import { AgentExchange } from '../src/components/AgentExchange';
import { defaultPreferences, type Bootstrap } from '../src/shared/types';
vi.mock('../src/client-api',async original=>({...await original<typeof import('../src/client-api')>(),api:vi.fn(),write:vi.fn()}));
let root:Root, container:HTMLDivElement;
const bootstrap = { user:{id:'one'},bots:[{id:'ranch',name:'Ranch hand'},{id:'planner',name:'Planner'}],preferences:defaultPreferences,connection:{connected:true} } as Bootstrap;
const room={room_id:'room',name:'Weekend plans',members:[{member_id:'ranch',profile:'ranch',handle:'ranch',display_name:'Ranch hand'},{member_id:'planner',profile:'planner',handle:'planner',display_name:'Planner'}]};
beforeEach(()=>{ vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.mocked(api).mockReset();vi.mocked(write).mockReset();localStorage.clear();vi.useFakeTimers();container=document.createElement('div');document.body.append(container);root=createRoot(container);HTMLDialogElement.prototype.showModal=vi.fn();HTMLDialogElement.prototype.close=vi.fn(); });
afterEach(async()=>{await act(async()=>root.unmount());container.remove();vi.useRealTimers();vi.unstubAllGlobals();});
async function click(name:string){const button=Array.from(container.querySelectorAll('button')).find(button=>button.textContent===name);expect(button).toBeTruthy();await act(async()=>button!.click());}
it('renders bot envelopes, multiline and legacy deliveries while preserving attributed human text', async()=>{
  for(const text of ['Message from 🤖 Planner (@planner): Bring water\nand a picnic',"[Message from agent 'planner'] Bring water"]){ expect(agentEnvelope({role:'user',text})?.text).toContain('Bring water'); }
  expect(agentEnvelope({role:'user',text:'I got a Message from 🤖 Planner: yesterday'})).toBeNull();
  expect(agentEnvelope({role:'user',text:'Message from 🤖 Planner: I wrote this',sender:{id:'one',name:'One'}})).toBeNull();
  await act(async()=>root.render(createElement(AgentExchange,{message:{id:'agent',role:'user',text:'Message from 🤖 Planner (@planner): Bring water'},recipient:'Ranch hand'})));
  expect(container.textContent).toContain('Planner → Ranch hand');expect(container.textContent).toContain('Bring water');
});
it('reads a notification-selected routine history and displays the saved output',async()=>{
  vi.mocked(api).mockImplementation(async(path)=>path.endsWith('/results')?[{id:'run-one',title:'Morning',previewOnly:false}]:{messages:[{id:'reply',role:'assistant',text:'The north gate battery needs replacing.'}],previewOnly:false});
  await act(async()=>root.render(createElement(RoutineResults,{botId:'ranch',routineId:'morning',userId:'one',onClose:vi.fn()})));
  expect(api).toHaveBeenCalledWith('/bots/ranch/routines/morning/results/run-one');expect(container.textContent).toContain('north gate battery');
});
it('restores an uncertain group send and retries the exact same saved request after refresh',async()=>{
  const pending={requestId:crypto.randomUUID(),threadId:crypto.randomUUID(),text:'Plan Saturday'};
  const key='agent-interface:group-send:one:room';localStorage.setItem(key,JSON.stringify(pending));
  vi.mocked(api).mockImplementation(async(path)=>path==='/groups'?{supported:true,canSend:true,rooms:[room]}:path.includes('/log')?{events:[],cursor:0,has_more:false}:{room,driver_status:{working:false,blocked:false,pending_actions:[]}});
  vi.mocked(write).mockRejectedValueOnce(new Error('Connection lost')).mockResolvedValue({accepted:true});
  await act(async()=>root.render(createElement(GroupChats,{bootstrap})));
  await click('Retry same saved message');expect(write).toHaveBeenLastCalledWith('/groups/room/messages',pending);expect(localStorage.getItem(key)).toBe(JSON.stringify(pending));
  await act(async()=>vi.advanceTimersByTimeAsync(15000));expect(write).toHaveBeenCalledTimes(1);
  await click('Retry same saved message');expect(write).toHaveBeenLastCalledWith('/groups/room/messages',pending);expect(localStorage.getItem(key)).toBeNull();
});
it('disables creation and sending when native group coordinator is unavailable',async()=>{
  vi.mocked(api).mockResolvedValue({supported:true,canSend:false,rooms:[],reason:'Coordinator is unavailable.'});
  await act(async()=>root.render(createElement(GroupChats,{bootstrap})));
  expect(Array.from(container.querySelectorAll('button')).find(button=>button.textContent==='New group')?.disabled).toBe(true);
  expect(container.textContent).toContain('Coordinator is unavailable.');expect(write).not.toHaveBeenCalled();
});
