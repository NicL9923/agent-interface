// @vitest-environment jsdom
import { act, createElement } from 'react';
import type { Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, write } from '../src/client-api';
import { agentEnvelope } from '../src/shared/collaboration';
import { GroupChats } from '../src/components/GroupChats';
import { RoutineResults } from '../src/components/RoutineResults';
import { AgentExchange } from '../src/components/AgentExchange';
import { defaultPreferences, type Bootstrap } from '../src/shared/types';
import { click, mountRoot, typeInto } from './ui-harness';
import { FakeEventSource } from './fake-event-source';
vi.mock('../src/client-api', async original => (await import("./helpers/request-mock")).withRequest(await (async original=>({...await original<typeof import('../src/client-api')>(),api:vi.fn(),write:vi.fn()}))(original)));
// Avatar drawing is covered by its own suite; these tests exercise group interactions.
vi.mock('../src/components/Avatar',()=>({Avatar:({botId}:{botId?:string})=>createElement('span',{'data-avatar':botId})}));
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
  vi.mocked(api).mockImplementation(async(path)=>path==='/routines'?[{id:'morning',botId:'ranch',name:'Morning check'}]:path.endsWith('/results')?[{id:'run-one',title:'Morning',previewOnly:false}]:{messages:[{id:'reply',role:'assistant',text:'The north gate battery needs replacing.'}],previewOnly:false});
  await act(async()=>root.render(createElement(RoutineResults,{botId:'ranch',routineId:'morning',userId:'one',onClose:vi.fn()})));
  expect(api).toHaveBeenCalledWith('/bots/ranch/routines/morning/results/run-one',expect.anything());expect(container.textContent).toContain('north gate battery');expect(container.querySelector('h2')?.textContent).toBe('Morning check results');
});
it('keeps routine history readable when the routine-name lookup fails',async()=>{
  vi.mocked(api).mockImplementation(async path=>{
    if(path==='/routines')throw new Error('Names unavailable');
    return path.endsWith('/results')?[{id:'run-one',title:'Morning',previewOnly:false}]:{messages:[{id:'reply',role:'assistant',text:'The gate is closed.'}],previewOnly:false};
  });
  await act(async()=>root.render(createElement(RoutineResults,{botId:'ranch',routineId:'morning',userId:'one',onClose:vi.fn()})));
  expect(container.querySelector('h2')?.textContent).toBe('Routine results');
  expect(container.textContent).toContain('The gate is closed.');
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
it('reports a saved routine output as a notice, not an error',async()=>{
  vi.mocked(api).mockImplementation(async(path)=>path==='/routines'?[{id:'morning',botId:'ranch',name:'Morning check'}]:path.endsWith('/results')?[{id:'run-one',title:'Morning',previewOnly:false}]:{messages:[{id:'reply',role:'assistant',text:'The north gate battery needs replacing.'}],previewOnly:false});
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
  await act(async()=>vi.advanceTimersByTimeAsync(30000));
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
  await act(async()=>vi.advanceTimersByTimeAsync(30000));
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
  await act(async()=>vi.advanceTimersByTimeAsync(30000));expect(held).toBeDefined();
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

describe('group conversation',()=>{
  const state={room,driver_status:{working:false,blocked:false,pending_actions:[]}};
  const serve=(events:unknown[]=[])=>vi.mocked(api).mockImplementation(async(path)=>path==='/groups'?{supported:true,canSend:true,rooms:[room]}:path.includes('/log')?{events,cursor:events.length,has_more:false}:state);
  const field=()=>container.querySelector<HTMLTextAreaElement>('#group-message')!;
  const type=(text:string,caret=text.length)=>act(async()=>{
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(field(),text);
    field().setSelectionRange(caret,caret);
    field().dispatchEvent(new Event('input',{bubbles:true}));
  });
  const press=(key:string)=>act(async()=>field().dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true})));
  const suggestions=()=>[...container.querySelectorAll('.mention-list [role="option"]')].map(option=>option.querySelector('small')!.textContent);

  it('names who sent each human message, falling back for older servers',async()=>{
    serve([
      {event_id:'a',seq:1,kind:'message.user',actor:{kind:'user',id:'app'},payload:{text:'From Nic'},created_at:1,sender:{id:'one',name:'Nicolas'}},
      {event_id:'b',seq:2,kind:'message.user',actor:{kind:'user',id:'app'},payload:{text:'From somebody'},created_at:2},
    ]);
    await act(async()=>root.render(createElement(GroupChats,{bootstrap})));
    expect([...container.querySelectorAll('.group-message strong')].map(name=>name.textContent)).toEqual(['You','Household member']);
  });

  it('offers members for @, and completes one with the arrows and Enter without sending',async()=>{
    serve();
    await act(async()=>root.render(createElement(GroupChats,{bootstrap})));
    await type('Ask @');
    expect(suggestions()).toEqual(['@ranch','@planner']);
    expect(field().getAttribute('aria-controls')).toBe(container.querySelector('.mention-list')!.id);
    await press('ArrowDown');
    expect(field().getAttribute('aria-activedescendant')).toBe(container.querySelector('[aria-selected="true"]')!.id);
    await press('Enter');
    expect(field().value).toBe('Ask @planner ');
    expect(write).not.toHaveBeenCalled();
    expect(container.querySelector('.mention-list')).toBeNull();
    await type('Ask @planner and @r');
    expect(suggestions()).toEqual(['@ranch']);
    await press('Escape');
    expect(container.querySelector('.mention-list')).toBeNull();
    await type('Ask @planner and @ra');
    await press('Tab');
    expect(field().value).toBe('Ask @planner and @ranch ');
  });

  it('reads new events when the stream names this room, instead of polling every few seconds',async()=>{
    FakeEventSource.reset();vi.stubGlobal('EventSource',FakeEventSource);
    serve();
    await act(async()=>root.render(createElement(GroupChats,{bootstrap})));
    const logs=()=>vi.mocked(api).mock.calls.filter(([path])=>String(path).includes('/log')).length;
    const stream=[...FakeEventSource.streams].find(item=>item.url==='/api/events?group=room')!;
    expect(stream).toBeDefined();
    const before=logs();
    await act(async()=>vi.advanceTimersByTimeAsync(10_000));
    expect(logs()).toBe(before);
    await act(async()=>stream.emit('group',JSON.stringify({roomId:'other',latestSeq:4})));
    expect(logs()).toBe(before);
    await act(async()=>stream.emit('group',JSON.stringify({roomId:'room',latestSeq:4})));
    expect(logs()).toBe(before+1);
    await act(async()=>root.render(createElement('div')));
    expect(FakeEventSource.streams.has(stream)).toBe(false);
  });

  it('reloads a driver status change at the current cursor, sharing one reload between notices that arrive during a load',async()=>{
    FakeEventSource.reset();vi.stubGlobal('EventSource',FakeEventSource);
    serve([{event_id:'a',seq:1,kind:'message.user',actor:{kind:'user',id:'app'},payload:{text:'Hello'},created_at:1}]);
    await act(async()=>root.render(createElement(GroupChats,{bootstrap})));
    const reads=()=>vi.mocked(api).mock.calls.filter(([path])=>path==='/groups/room').length;
    const stream=[...FakeEventSource.streams].find(item=>item.url==='/api/events?group=room')!;
    const before=reads();
    // The cursor is 1; a new pending approval announces the same sequence.
    await act(async()=>stream.emit('group',JSON.stringify({roomId:'room',latestSeq:1})));
    expect(reads()).toBe(before+1);
    let finish!:()=>void;
    const previous=vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation(async(path,...rest)=>{
      if(path==='/groups/room') await new Promise<void>(done=>{finish=done;});
      return previous(path,...rest);
    });
    await act(async()=>stream.emit('group',JSON.stringify({roomId:'room',latestSeq:1})));
    await act(async()=>stream.emit('group',JSON.stringify({roomId:'room',latestSeq:1})));
    await act(async()=>stream.emit('group',JSON.stringify({roomId:'room',latestSeq:1})));
    expect(reads()).toBe(before+2);
    await act(async()=>finish());
    expect(reads()).toBe(before+3);
    await act(async()=>finish());
    expect(reads()).toBe(before+3);
  });
});

it('shows thread context, focuses the composer and sends the selected thread ID',async()=>{
  const events=[
    {event_id:'root',seq:1,kind:'message.user',actor:{id:'one'},sender:{id:'one',name:'Nicolas'},payload:{text:'Plan a short walk',thread_id:'walk-thread'},created_at:1},
    {event_id:'other',seq:2,kind:'message.member',actor:{id:'planner'},payload:{text:'A separate dinner topic',thread_id:'dinner-thread'},created_at:2},
    {event_id:'reply',seq:3,kind:'message.member',actor:{id:'ranch'},payload:{text:'Bring water for the walk',thread_id:'walk-thread'},created_at:3},
  ];
  vi.mocked(api).mockImplementation(async path=>path==='/groups'?{supported:true,canSend:true,rooms:[room]}:path.includes('/log')?{events,cursor:3,has_more:false}:{room,driver_status:{working:false,blocked:false,pending_actions:[]}});
  vi.mocked(write).mockResolvedValue({accepted:true});
  await act(async()=>root.render(createElement(GroupChats,{bootstrap})));
  const rows=[...container.querySelectorAll('.group-message')];
  expect(rows[0].querySelector('.group-speaker')?.textContent).toBe('You');
  expect(rows[2].querySelector('.group-thread-context')?.textContent).toBe('In thread with You: Plan a short walk');
  expect(rows[1].querySelector('.group-thread-context')).toBeNull();
  expect(rows[2].querySelector('[data-avatar]')?.getAttribute('data-avatar')).toBe('ranch');
  const field=container.querySelector<HTMLTextAreaElement>('#group-message')!;
  await typeInto(field,'Keep it under an hour');
  await act(async()=>rows[0].querySelector<HTMLButtonElement>('.group-reply')!.click());
  expect(document.activeElement).toBe(field);expect(rows[0].classList.contains('selected')).toBe(true);
  expect(container.querySelector('.group-thread')?.textContent).toContain('You: Plan a short walk');
  expect(rows[0].querySelector('.group-reply')?.getAttribute('aria-label')).toContain('You: Plan a short walk');
  await click('New topic');expect(container.querySelector('.group-thread')).toBeNull();expect(field.value).toBe('Keep it under an hour');
  await act(async()=>rows[0].querySelector<HTMLButtonElement>('.group-reply')!.click());
  await act(async()=>field.form!.requestSubmit());
  expect(write).toHaveBeenCalledWith('/groups/room/messages',expect.objectContaining({threadId:'walk-thread',text:'Keep it under an hour'}));
  expect(field.value).toBe('');expect(container.querySelector('.group-message.selected')).toBeNull();
});
it('names the approving assistant without changing the decision identifiers',async()=>{
  const action={kind:'approval',task_id:'task',member_id:'planner',execution_generation:4,request_id:'exact-approval-request',approval:{description:'Read the weather forecast'}};
  vi.mocked(api).mockImplementation(async path=>path==='/groups'?{supported:true,canSend:true,rooms:[room]}:path.includes('/log')?{events:[],cursor:0,has_more:false}:{room,driver_status:{working:false,blocked:true,pending_actions:[action]}});
  vi.mocked(write).mockResolvedValue({approved:true});
  await act(async()=>root.render(createElement(GroupChats,{bootstrap})));
  expect(container.querySelector('.group-requester')?.textContent).toBe('Planner requests approval');
  await click('Deny');
  expect(write).toHaveBeenCalledWith('/groups/room/approve',{taskId:'task',memberId:'planner',generation:4,requestId:'exact-approval-request',choice:'deny'});
});
it('explains the six-assistant selection limit and restores choices after deselection',async()=>{
  vi.mocked(api).mockResolvedValue({supported:true,canSend:true,rooms:[]});
  const many={...bootstrap,bots:Array.from({length:7},(_,i)=>({id:'bot-'+i,name:'Assistant '+i}))} as Bootstrap;
  await act(async()=>root.render(createElement(GroupChats,{bootstrap:many})));
  await click('New group');
  const choices=[...container.querySelectorAll<HTMLInputElement>('.group-create input[type=checkbox]')];
  for(const choice of choices.slice(0,6))await act(async()=>choice.click());
  expect(container.querySelector('legend')?.textContent).toContain('6 chosen');expect(choices[6].disabled).toBe(true);
  expect(container.textContent).toContain('Six assistants selected. Deselect one to choose another.');
  await act(async()=>choices[0].click());expect(choices[6].disabled).toBe(false);
});
