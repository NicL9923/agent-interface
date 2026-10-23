// @vitest-environment jsdom
import { act, createElement } from 'react';
import type { Root } from 'react-dom/client';
import { beforeEach, expect, it, vi } from 'vitest';
import { api, ApiError, write } from '../src/client-api';
import { agentEnvelope } from '../src/shared/collaboration';
import { GroupChats } from '../src/components/GroupChats';
import { RoutineResults } from '../src/components/RoutineResults';
import { AgentExchange } from '../src/components/AgentExchange';
import { defaultPreferences, type Bootstrap } from '../src/shared/types';
import { click, mountRoot } from './ui-harness';
vi.mock('../src/client-api',async original=>({...await original<typeof import('../src/client-api')>(),api:vi.fn(),write:vi.fn()}));
let root:Root, container:HTMLDivElement;
const bootstrap = { user:{id:'one'},bots:[{id:'ranch',name:'Ranch hand'},{id:'planner',name:'Planner'}],preferences:defaultPreferences,connection:{connected:true} } as Bootstrap;
const room={room_id:'room',name:'Weekend plans',members:[{member_id:'ranch',profile:'ranch',handle:'ranch',display_name:'Ranch hand'},{member_id:'planner',profile:'planner',handle:'planner',display_name:'Planner'}]};
beforeEach(()=>{vi.mocked(api).mockReset();vi.mocked(write).mockReset();vi.useFakeTimers();({container,root}=mountRoot());HTMLDialogElement.prototype.showModal=vi.fn();HTMLDialogElement.prototype.close=vi.fn(); });
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
  expect(api).toHaveBeenCalledWith('/bots/ranch/routines/morning/results/run-one',expect.anything());expect(container.textContent).toContain('north gate battery');
});
it('reports a saved routine output as a notice, not an error',async()=>{
  vi.mocked(api).mockImplementation(async(path)=>path.endsWith('/results')?[{id:'run-one',title:'Morning',previewOnly:false}]:{messages:[{id:'reply',role:'assistant',text:'The north gate battery needs replacing.'}],previewOnly:false});
  vi.mocked(write).mockResolvedValueOnce({});
  await act(async()=>root.render(createElement(RoutineResults,{botId:'ranch',routineId:'morning',userId:'one',onClose:vi.fn()})));
  await click('Save output');
  expect(write).toHaveBeenCalledWith('/saved',expect.objectContaining({kind:'routine',botId:'ranch',routineId:'morning',resultId:'run-one'}));
  expect(container.querySelector('[role="status"].form-notice')?.textContent).toBe('Saved to your saved items.');
  expect(container.querySelector('[role="alert"]')).toBeNull();
  vi.mocked(write).mockRejectedValueOnce(new Error('Could not save.'));
  await click('Save output');
  expect(container.querySelector('[role="alert"].form-error')?.textContent).toBe('Could not save.');
  expect(container.textContent).not.toContain('Saved to your saved items.');
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
it('keeps existing rooms readable while a saved group creation awaits retry',async()=>{
  localStorage.setItem('agent-interface:group-create:one',JSON.stringify({requestId:crypto.randomUUID(),name:'Garden crew',botIds:['ranch','planner']}));
  vi.mocked(api).mockImplementation(async(path)=>path==='/groups'?{supported:true,canSend:true,rooms:[room]}:path.includes('/log')?{events:[{event_id:'one',seq:1,kind:'message.user',actor:{id:'one'},payload:{text:'Bring water'},created_at:1}],cursor:1,has_more:false}:{room,driver_status:{working:false,blocked:false,pending_actions:[]}});
  await act(async()=>root.render(createElement(GroupChats,{bootstrap})));
  expect(container.textContent).toContain('Finish creating group');expect(container.textContent).toContain('Bring water');
  expect(Array.from(container.querySelectorAll('button')).some(button=>button.textContent==='Retry saved group request')).toBe(true);
});
it('leaves a group that disappears and says that a personal assistant keeps a new group to its owner',async()=>{
  const other={...room,room_id:'other',name:'Garden crew'};
  let rooms=[room,other],reads=0;
  vi.mocked(api).mockImplementation(async(path)=>{
    if(path==='/groups')return {supported:true,canSend:true,rooms};
    if(path.startsWith('/groups/room')){reads++;if(!rooms.includes(room))throw new ApiError('Group chat not found',404);}
    return path.includes('/log')?{events:[],cursor:0,has_more:false}:{room:path.startsWith('/groups/other')?other:room,driver_status:{working:false,blocked:false,pending_actions:[]}};
  });
  const mine={...bootstrap,bots:[...bootstrap.bots,{id:'books',name:'Ranch books',shared:false,ownerId:'one'}]} as Bootstrap;
  await act(async()=>root.render(createElement(GroupChats,{bootstrap:mine})));
  rooms=[other];
  await act(async()=>vi.advanceTimersByTimeAsync(3000));
  expect(container.textContent).toContain('That group chat is no longer available to you.');
  expect(container.querySelector('[aria-current="page"]')?.textContent).toContain('Garden crew');
  const settled=reads;await act(async()=>vi.advanceTimersByTimeAsync(9000));expect(reads).toBe(settled);
  await click('New group');
  expect(container.textContent).not.toContain('Only you will see this group');
  await act(async()=>Array.from(container.querySelectorAll('label')).find(label=>label.textContent==='Ranch books')!.querySelector('input')!.click());
  expect(container.textContent).toContain('Only you will see this group, because it includes your personal assistant.');
});
it('clears a vanished group at once, even when the group list cannot be refreshed',async()=>{
  let gone=false;
  vi.mocked(api).mockImplementation(async(path)=>{
    if(gone)throw path==='/groups'?new Error('Connection lost'):new ApiError('Group chat not found',404);
    if(path==='/groups')return {supported:true,canSend:true,rooms:[room]};
    return path.includes('/log')?{events:[{event_id:'e',seq:1,kind:'message.member',actor:{id:'planner'},payload:{text:'The secret ledger total',member_id:'planner'},created_at:1}],cursor:1,has_more:false}:{room,driver_status:{working:false,blocked:false,pending_actions:[]}};
  });
  await act(async()=>root.render(createElement(GroupChats,{bootstrap})));
  expect(container.textContent).toContain('The secret ledger total');
  gone=true;
  await act(async()=>vi.advanceTimersByTimeAsync(3000));
  for(const leak of ['The secret ledger total','Weekend plans','@planner'])expect(container.textContent).not.toContain(leak);
  expect(container.textContent).toContain('That group chat is no longer available to you.');
});
it('shows a sent group message at once even while a background check is still running',async()=>{
  const state={room,driver_status:{working:false,blocked:false,pending_actions:[]}};
  const sent={event_id:'sent',seq:1,kind:'message.user',actor:{id:'one'},payload:{text:'Plan Saturday'},created_at:1};
  let reads=0,delivered=false,held:((value:unknown)=>void)|undefined;
  vi.mocked(api).mockImplementation(async(path)=>{
    if(path==='/groups')return{supported:true,canSend:true,rooms:[room]};
    if(path==='/groups/room')return ++reads===2?new Promise(done=>{held=done;}):state;
    return{events:delivered?[sent]:[],cursor:delivered?1:0,has_more:false};
  });
  vi.mocked(write).mockImplementation(async()=>{delivered=true;return{accepted:true};});
  await act(async()=>root.render(createElement(GroupChats,{bootstrap})));
  await act(async()=>vi.advanceTimersByTimeAsync(3000));expect(held).toBeDefined();
  const field=container.querySelector<HTMLTextAreaElement>('#group-message')!;
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(field,'Plan Saturday');field.dispatchEvent(new Event('input',{bubbles:true}));});
  await act(async()=>field.form!.requestSubmit());
  expect(write).toHaveBeenCalledWith('/groups/room/messages',expect.objectContaining({text:'Plan Saturday'}));
  expect(container.querySelector('.group-message')?.textContent).toContain('Plan Saturday');
  await act(async()=>held!(state));
  expect(container.querySelectorAll('.group-message')).toHaveLength(1);
});
it('reads a room log from the start again after leaving and returning to it',async()=>{
  const other={...room,room_id:'other',name:'Fence repair'};
  const state={room,driver_status:{working:false,blocked:false,pending_actions:[]}};
  const first={event_id:'one',seq:1,kind:'message.user',actor:{id:'one'},payload:{text:'Bring water'},created_at:1};
  vi.mocked(api).mockImplementation(async(path)=>{
    if(path==='/groups')return{supported:true,canSend:true,rooms:[room,other]};
    if(path==='/groups/other')return new Promise(()=>{});
    if(path==='/groups/room')return state;
    return path.endsWith('since=0')?{events:[first],cursor:1,has_more:false}:{events:[],cursor:1,has_more:false};
  });
  await act(async()=>root.render(createElement(GroupChats,{bootstrap})));
  expect(container.querySelector('.group-message')?.textContent).toContain('Bring water');
  await click('Fence repair2 assistants');await click('Weekend plans2 assistants');
  expect(vi.mocked(api).mock.calls.at(-1)?.[0]).toBe('/groups/room/log?since=0');
  expect(container.querySelector('.group-message')?.textContent).toContain('Bring water');
});
it('keeps the newly selected room when an action from a room that left the list finishes',async()=>{
  const other={...room,room_id:'other',name:'Fence repair'};
  const idle={driver_status:{working:false,blocked:false,pending_actions:[]}};
  let rooms=[room,other],removed=false,finish:((value:unknown)=>void)|undefined;
  vi.mocked(api).mockImplementation(async(path)=>{
    if(path==='/groups')return{supported:true,canSend:true,rooms};
    if(path==='/groups/room'){if(removed)throw new ApiError('Not found',404);return{room,driver_status:{...idle.driver_status,working:true}};}
    if(path==='/groups/other')return{room:other,...idle};
    return{events:[],cursor:0,has_more:false};
  });
  vi.mocked(write).mockImplementation(()=>new Promise(done=>{finish=done;}));
  await act(async()=>root.render(createElement(GroupChats,{bootstrap})));
  await click('Stop discussion');expect(write).toHaveBeenCalledWith('/groups/room/stop',expect.anything());
  // Another member made the room personal, so the list drops it and selects the next one.
  rooms=[other];await act(async()=>vi.advanceTimersByTimeAsync(15000));
  expect(container.querySelector('.group-heading h3')?.textContent).toBe('Fence repair');
  const reads=vi.mocked(api).mock.calls.filter(([path])=>path==='/groups/room').length;
  removed=true;await act(async()=>finish!({ok:true}));
  expect(container.querySelector('.group-heading h3')?.textContent).toBe('Fence repair');
  expect(container.textContent).not.toContain('That group chat is no longer available to you.');
  expect(vi.mocked(api).mock.calls.filter(([path])=>path==='/groups/room').length).toBe(reads);
});
