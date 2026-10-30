// @vitest-environment jsdom
import { act, createElement } from 'react';
import type { Root } from 'react-dom/client';
import { beforeEach, expect, it, vi } from 'vitest';
import { DiscoveryPanel } from '../src/components/DiscoveryPanel';
import { ApiError, api, write } from '../src/client-api';
import type { Bootstrap, Message } from '../src/shared/types';
import { mountRoot, typeInto, click } from './ui-harness';
vi.mock('../src/client-api', async original => (await import("./helpers/request-mock")).withRequest(await (async(importOriginal)=>({...await importOriginal<typeof import('../src/client-api')>(),api:vi.fn(),write:vi.fn()}))(original)));
let root:Root;let container:HTMLDivElement;
beforeEach(()=>{vi.mocked(api).mockReset();vi.mocked(write).mockReset();({container,root}=mountRoot());});
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

it('searches as the person types, after a pause, and drops answers for older words',async()=>{
  vi.useFakeTimers();
  const answers=new Map<string,(value:unknown)=>void>();
  vi.mocked(api).mockImplementation(path=>new Promise(resolve=>answers.set(String(path),resolve)));
  await act(async()=>root.render(createElement(DiscoveryPanel,{bootstrap:{user:{id:'one'},bots:[{id:'ranch',name:'Ranch'}],household:[]} as unknown as Bootstrap,onRoutine:()=>{}})));
  const input=container.querySelector('input')!;
  await typeInto(input,'g');
  await act(async()=>vi.advanceTimersByTimeAsync(1000));
  expect(api).not.toHaveBeenCalled();
  await typeInto(input,'ga');
  await act(async()=>vi.advanceTimersByTimeAsync(299));
  expect(api).not.toHaveBeenCalled();
  await act(async()=>vi.advanceTimersByTimeAsync(1));
  expect(api).toHaveBeenCalledExactlyOnceWith('/search?q=ga');
  await typeInto(input,'gate');
  // Enter searches at once; the pause that follows does not search the same words again.
  await act(async()=>container.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
  await act(async()=>vi.advanceTimersByTimeAsync(1000));
  expect(vi.mocked(api).mock.calls.map(([path])=>path)).toEqual(['/search?q=ga','/search?q=gate']);
  const hit=(title:string)=>({hits:[{botId:'ranch',botName:'Ranch',sessionId:'s',title,snippet:''}],unavailableBots:[]});
  await act(async()=>answers.get('/search?q=gate')!(hit('Gate battery')));
  await act(async()=>answers.get('/search?q=ga')!(hit('Garden')));
  expect(container.textContent).toContain('Gate battery');expect(container.textContent).not.toContain('Garden');
  expect(container.querySelector('[role="status"].sr-only')?.textContent).toBe('1 result');
});
it('opens a hit in the live conversation at its message, and older sessions read-only',async()=>{
  vi.mocked(api).mockImplementation(async(path)=>path.startsWith('/search')?{hits:[
    {botId:'ranch',botName:'Ranch',sessionId:'canonical',title:'Live',snippet:'',messageId:'m9'},
    {botId:'ranch',botName:'Ranch',sessionId:'older',title:'Old',snippet:'',messageId:'m1'},
  ],unavailableBots:[]}:{botId:'ranch',sessionId:'older',messages:[{id:'m1',role:'assistant',text:'Old answer'}],offset:0,hasMore:false});
  const onOpenMessage=vi.fn();
  await act(async()=>root.render(createElement(DiscoveryPanel,{bootstrap:{user:{id:'one'},bots:[{id:'ranch',name:'Ranch',sessionId:'canonical'}],household:[]} as unknown as Bootstrap,onRoutine:()=>{},onOpenMessage,search:{text:'answer',id:1}})));
  expect(container.querySelector('input')!.value).toBe('answer');
  const [live,older]=[...container.querySelectorAll<HTMLButtonElement>('.today-row')];
  await act(async()=>live!.click());
  expect(onOpenMessage).toHaveBeenCalledWith('ranch','m9');
  await act(async()=>older!.click());
  expect(container.textContent).toContain('Old answer');
});


const discoveryBoot={user:{id:'one',name:'Nicolas'},bots:[{id:'ranch',name:'Ranch hand',sessionId:'canonical'}],household:[]} as unknown as Bootstrap;
const archivedHit={botId:'ranch',botName:'Old bot label',sessionId:'history',title:'Gate plan',snippet:'A saved plan'};
it('labels each search destination, uses the current assistant name and shows optional update time',async()=>{
  const updatedAt='2026-10-28T12:00:00Z';
  vi.mocked(api).mockResolvedValue({hits:[
    {...archivedHit,sessionId:'canonical',messageId:'live',title:'Current gate',updatedAt},
    archivedHit,{...archivedHit,sessionId:'routine',title:'Morning output',routineId:'r1',resultId:'run-one'},
  ],unavailableBots:[]});
  const onOpenMessage=vi.fn(),onRoutine=vi.fn();
  await act(async()=>root.render(createElement(DiscoveryPanel,{bootstrap:discoveryBoot,onOpenMessage,onRoutine,search:{text:'gate',id:1}})));
  const rows=[...container.querySelectorAll<HTMLButtonElement>('.discovery-results .today-row')];
  expect(rows[0].textContent).toContain('Ranch hand · Current chat');
  expect(rows[0].querySelector('time')?.getAttribute('datetime')).toBe(updatedAt);
  expect(rows[1].textContent).toContain('Past conversation');expect(rows[1].querySelector('time')).toBeNull();
  expect(rows[2].textContent).toContain('Routine output');
  expect(container.textContent).not.toContain('Old bot label');
  await act(async()=>rows[0].click());expect(onOpenMessage).toHaveBeenCalledWith('ranch','live');
  await act(async()=>rows[2].click());expect(onRoutine).toHaveBeenCalledWith('ranch','r1','run-one');
});
it('shows history context and speaker names, saves in place once, and preserves identifier underscores',async()=>{
  vi.mocked(api).mockImplementation(async path=>path.startsWith('/search')?{hits:[archivedHit],unavailableBots:[]}:{botId:'ranch',sessionId:'history',offset:0,hasMore:false,messages:[
    {id:'u1',role:'user',text:'Check the gate',sender:{id:'one',name:'Nicolas'}},
    {id:'u2',role:'user',text:'Check the barn too',sender:{id:'two',name:'Pat'}},
    {id:'answer',role:'assistant',text:'## `binary_sensor.north_gate`'},
  ]});
  await act(async()=>root.render(createElement(DiscoveryPanel,{bootstrap:discoveryBoot,onRoutine:vi.fn(),search:{text:'gate',id:1}})));
  await act(async()=>container.querySelector<HTMLButtonElement>('.discovery-results .today-row')!.click());
  expect(container.querySelector('.history-heading h2')?.textContent).toBe('Gate plan');
  expect(container.querySelector('.history-heading')?.textContent).toContain('Ranch hand · Read-only history');
  expect([...container.querySelectorAll('.history-message-heading > small')].map(el=>el.textContent)).toEqual(['You','Pat','Ranch hand']);
  let finish!:(value:unknown)=>void;vi.mocked(write).mockReturnValueOnce(new Promise(resolve=>{finish=resolve;}));
  const save=container.querySelector<HTMLButtonElement>('#history-answer .history-save')!;
  await act(async()=>{save.focus();save.click();});
  expect(save.textContent).toBe('Saving…');expect(save.getAttribute('aria-disabled')).toBe('true');
  await act(async()=>save.click());expect(write).toHaveBeenCalledOnce();
  await act(async()=>finish({id:'saved-reply'}));
  expect(save.textContent).toBe('Saved');expect(document.activeElement).toBe(save);
  await act(async()=>save.click());expect(write).toHaveBeenCalledOnce();
  expect(write).toHaveBeenCalledWith('/saved',expect.objectContaining({kind:'session',botId:'ranch',sessionId:'history',messageId:'answer',offset:0,title:'binary_sensor.north_gate'}));
  vi.mocked(write).mockResolvedValueOnce({id:'saved-conversation'});
  const whole=container.querySelector<HTMLButtonElement>('.discovery-history > .history-save')!;
  await act(async()=>whole.click());expect(whole.textContent).toBe('Saved');
  expect(write).toHaveBeenLastCalledWith('/saved',{kind:'session',botId:'ranch',sessionId:'history',title:'Gate plan'});
});
it('returns to the same results and drops a pagination answer that arrives after Back',async()=>{
  let finish!:(value:unknown)=>void;
  const page={botId:'ranch',sessionId:'history',offset:0,hasMore:true,messages:[{id:'a',role:'assistant',text:'The first answer'}]};
  vi.mocked(api).mockImplementation(async path=>path.startsWith('/search')?{hits:[archivedHit],unavailableBots:[]}:path.includes('offset=100')?await new Promise(resolve=>{finish=resolve;}):page);
  await act(async()=>root.render(createElement(DiscoveryPanel,{bootstrap:discoveryBoot,onRoutine:vi.fn(),search:{text:'gate',id:1}})));
  await act(async()=>container.querySelector<HTMLButtonElement>('.discovery-results .today-row')!.click());
  await click('Next page');
  await act(async()=>container.querySelector<HTMLButtonElement>('.discovery-back')!.click());
  expect(container.querySelector<HTMLInputElement>('input[type="search"]')!.value).toBe('gate');
  expect(document.activeElement).toBe(container.querySelector('.view-tabs [aria-pressed="true"]'));
  await act(async()=>finish({...page,offset:100,messages:[{id:'late',role:'assistant',text:'Late page must stay hidden'}]}));
  expect(container.querySelector('.discovery-history')).toBeNull();expect(container.textContent).toContain('Gate plan');
  expect(container.textContent).not.toContain('Late page must stay hidden');
});
it('distinguishes saved replies, dates and exact message pointers from full conversations',async()=>{
  const createdAt='2026-10-28T12:00:00Z';
  vi.mocked(api).mockImplementation(async path=>path==='/saved'?[
    {id:'reply',botId:'ranch',kind:'session',sessionId:'history',messageId:'a',offset:200,title:'Gate reply',createdAt},
    {id:'conversation',botId:'ranch',kind:'session',sessionId:'history',title:'Gate conversation',createdAt},
  ]:{botId:'ranch',sessionId:'history',offset:200,hasMore:false,messages:[{id:'a',role:'assistant',text:'A particular answer'}]});
  await act(async()=>root.render(createElement(DiscoveryPanel,{bootstrap:discoveryBoot,onRoutine:vi.fn()})));
  await click('Saved items',container.querySelector('.view-tabs')!);
  const rows=[...container.querySelectorAll('.saved-row')];
  expect(rows[0].textContent).toContain('Ranch hand · Reply · Saved');expect(rows[1].textContent).toContain('Conversation · Saved');
  expect(rows[0].querySelector('time')?.getAttribute('datetime')).toBe(createdAt);
  await act(async()=>rows[0].querySelector<HTMLButtonElement>('.today-row')!.click());
  expect(api).toHaveBeenCalledWith('/bots/ranch/history/history?offset=200&messageId=a');
  expect(container.querySelector('.history-heading h2')?.textContent).toBe('Gate reply');
  expect(container.querySelector('#history-a .history-save')?.textContent).toBe('Saved');
  await act(async()=>container.querySelector<HTMLButtonElement>('.discovery-back')!.click());
  await act(async()=>container.querySelector<HTMLButtonElement>('.saved-row > button:last-child')!.click());
  await act(async()=>container.querySelector<HTMLButtonElement>('.saved-row .today-row')!.click());
  expect(container.querySelector('#history-a .history-save')?.textContent).toBe('Save reply');
  await act(async()=>container.querySelector<HTMLButtonElement>('#history-a .history-save')!.click());
  expect(write).toHaveBeenCalledWith('/saved/reply',expect.anything(),'DELETE');
  expect(write).toHaveBeenCalledWith('/saved',expect.objectContaining({messageId:'a',offset:200}));
});
it('explains deliberate pause and preserves unknown and partial usage in the compact table',async()=>{
  vi.mocked(api).mockResolvedValue({routines:[{id:'r1',botId:'ranch',name:'Morning',enabled:false,lastStatus:'delivery_failed',lastDeliveryError:'Destination unavailable'}],usage:[
    {botId:'ranch',sessions:4,inputTokens:1200,outputTokens:400,actualCost:null,estimatedCost:.02,partial:true},
    {botId:'other',sessions:2,inputTokens:100,outputTokens:50,actualCost:1.23,estimatedCost:null,partial:true},
  ],unavailableBots:[]});
  await act(async()=>root.render(createElement(DiscoveryPanel,{bootstrap:discoveryBoot,onRoutine:vi.fn()})));
  await click('Automations',container.querySelector('.view-tabs')!);
  expect(container.textContent).toContain('Paused. No runs until you resume.');expect(container.textContent).toContain('Last result: Delivery failed');
  expect(container.textContent).not.toContain('delivery_failed');
  const rows=[...container.querySelectorAll('.usage-table tbody tr')];
  expect(rows[0].textContent).toContain('Unknown');expect(rows[0].textContent).not.toContain('(partial)');
  expect(rows[1].textContent).toContain('$1.23 (partial)');expect(rows[1].textContent).toContain('Unknown');
});
