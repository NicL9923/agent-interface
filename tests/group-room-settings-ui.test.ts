// @vitest-environment jsdom
import { act, createElement } from 'react';
import type { Root } from 'react-dom/client';
import { beforeEach, expect, it, vi } from 'vitest';
import { api, write } from '../src/client-api';
import { GroupRoomView } from '../src/components/GroupChats';
import { defaultPreferences, type Bootstrap } from '../src/shared/types';
import type { GroupState } from '../src/shared/collaboration';
import { click, mountRoot, typeInto } from './ui-harness';
vi.mock('../src/client-api', async original => (await import("./helpers/request-mock")).withRequest(await (async original=>({...await original<typeof import('../src/client-api')>(),api:vi.fn(),write:vi.fn()}))(original)));

// A group chat's live work, its settings and its lead's hand-offs.
let root: Root, container: HTMLDivElement;
const room = { room_id:'room', name:'Weekend plans', members:[
  { member_id:'ranch', profile:'ranch', handle:'ranch', display_name:'Ranch hand' },
  { member_id:'planner', profile:'planner', handle:'planner', display_name:'Planner' }] };
const boot = (presentation: 'simple' | 'advanced', connected = true) =>
  ({ user:{id:'one'}, bots:[{id:'ranch',name:'Ranch hand'},{id:'planner',name:'Planner'}], preferences:{...defaultPreferences,presentation}, connection:{connected} }) as Bootstrap;
let state: GroupState;
let events: unknown[];
const render = (presentation: 'simple' | 'advanced' = 'simple', connected = true) =>
  act(async () => root.render(createElement(GroupRoomView, { bootstrap: boot(presentation, connected), roomId:'room', canSend:true, onChanged: vi.fn() })));
const activity = () => [...container.querySelectorAll('.group-activity li')].map(line => line.querySelector('.activity-shimmer')!.firstChild!.textContent + (line.querySelector('small') ? ` | ${line.querySelector('small')!.textContent}` : ''));
const status = () => container.querySelector('#group-status')!.textContent;
beforeEach(() => {
  localStorage.clear(); vi.mocked(api).mockReset(); vi.mocked(write).mockReset(); vi.useFakeTimers();
  ({ container, root } = mountRoot());
  HTMLDialogElement.prototype.showModal = vi.fn(); HTMLDialogElement.prototype.close = vi.fn();
  events = [];
  state = { room, context: { purpose:'', notes:'', routing:'everyone', lead_member_id:'' },
    driver_status: { running:true, working:true, blocked:false, pending_actions:[], max_rounds:3, member_activity:[
      { member_id:'planner', status:'running', round_index:1, tool:'web_search', started_at:1, progress_at:2 },
      { member_id:'ranch', status:'queued', round_index:1 }] } };
  vi.mocked(api).mockImplementation(async path => path.includes('/log') ? { events, cursor: events.length, has_more:false } : state);
});

it('names each working assistant in Simple, and adds its tool and round in Advanced', async () => {
  await render('simple');
  expect(activity()).toEqual(['Planner is working...', 'Ranch hand is waiting to start...']);
  expect(container.textContent).not.toContain('Assistants are discussing');
  expect(status()).toBe('Type @ to address one assistant.');
  await act(async () => root.unmount()); ({ container, root } = mountRoot());
  await render('advanced');
  expect(activity()).toEqual(['Planner is using web_search... | Round 2 of 3', 'Ranch hand is waiting to start... | Round 2 of 3']);
});

it('keeps the room-wide line for a Hermes without member activity', async () => {
  state = { room, driver_status: { running:true, working:true, blocked:false, pending_actions:[] } };
  await render('advanced');
  expect(container.querySelector('.group-activity')).toBeNull();
  expect(status()).toBe('Assistants are discussing…');
  // Without room settings in the state, there is nothing to open.
  expect(container.textContent).not.toContain('Group settings');
});

it("shows the purpose and the lead's hand-offs, and says who picks when nobody is named", async () => {
  state = { ...state, driver_status: undefined, context: { purpose:'Plan the weekend', notes:'', routing:'lead', lead_member_id:'planner' } };
  events = [
    { event_id:'m', seq:1, kind:'message.user', actor:{kind:'user',id:'one'}, payload:{text:'Who fixes the gate?', thread_id:'t'}, created_at:1 },
    { event_id:'a', seq:2, kind:'room.assignment', actor:{kind:'gateway',id:'g'}, payload:{lead_member_id:'planner', member_ids:['ranch'], thread_id:'t'}, created_at:2 },
    { event_id:'c', seq:3, kind:'room.context_set', actor:{kind:'system',id:'room-control'}, payload:{purpose:'Plan the weekend'}, created_at:3 },
  ];
  await render();
  expect(container.querySelector('.group-purpose')?.textContent).toBe('Plan the weekend');
  expect(container.querySelector('.group-assignment')?.textContent).toBe('Planner gave this to Ranch hand.');
  expect(container.querySelectorAll('.group-message')).toHaveLength(1);
  expect(status()).toBe('Type @ to address one assistant. Otherwise Planner picks who answers.');
});

it("shows a routine's post under the routine's name with a routine marker", async () => {
  state = { ...state, driver_status: undefined };
  events = [
    { event_id:'p', seq:1, kind:'message.user', actor:{kind:'user',id:'cron:job-1',display_name:'[bot:ranch] Morning brief'}, payload:{text:'Gate is shut.', thread_id:'cron-1'}, created_at:1 },
    { event_id:'n', seq:2, kind:'message.user', actor:{kind:'user',id:'cron-notice:job-1',display_name:'Morning brief'}, payload:{text:'The run failed.', thread_id:'cron-2'}, created_at:2 },
    { event_id:'h', seq:3, kind:'message.user', actor:{kind:'user',id:'desktop'}, payload:{text:'Thanks', thread_id:'cron-1'}, created_at:3 },
  ];
  await render();
  const heads = [...container.querySelectorAll('.group-message .group-speaker')].map(head => head.textContent);
  expect(heads).toEqual(['Morning briefRoutine', 'Morning briefRoutine failed', 'Household member']);
  expect(container.querySelector('.group-message button.group-reply')?.getAttribute('aria-label')).toBe('Reply in thread to Morning brief: Gate is shut.');
});

it('saves purpose, notes and lead from Group settings, then reads the room again', async () => {
  state = { ...state, context: { purpose:'Old', notes:'Gate code 1234', routing:'lead', lead_member_id:'ranch' } };
  vi.mocked(write).mockResolvedValue({ context:{}, event:{} });
  await render();
  await click('Group settings');
  const dialog = container.querySelector('dialog')!;
  const [purpose] = dialog.querySelectorAll('input');
  const notes = dialog.querySelector('textarea')!, lead = dialog.querySelector('select')!;
  expect([purpose.value, notes.value, lead.value]).toEqual(['Old', 'Gate code 1234', 'ranch']);
  await typeInto(purpose, 'Plan the weekend');
  await act(async () => { lead.value = ''; lead.dispatchEvent(new Event('change', { bubbles:true })); });
  const reads = vi.mocked(api).mock.calls.length;
  await click('Save settings');
  expect(write).toHaveBeenCalledWith('/groups/room/context', { requestId: expect.any(String), purpose:'Plan the weekend', notes:'Gate code 1234', leadMemberId:null });
  expect(container.querySelector('dialog')).toBeNull();
  expect(vi.mocked(api).mock.calls.length).toBeGreaterThan(reads);
});

it('refuses notes over Hermes\'s byte limit and settings while disconnected', async () => {
  await render();
  await click('Group settings');
  await typeInto(container.querySelector('dialog textarea')!, '€'.repeat(1400));
  expect(container.querySelector('dialog')!.textContent).toContain('These notes are too long. Remove about 104 characters.');
  expect([...container.querySelectorAll<HTMLButtonElement>('dialog button')].find(button => button.textContent === 'Save settings')!.disabled).toBe(true);
  await act(async () => root.unmount()); ({ container, root } = mountRoot());
  await render('simple', false);
  await click('Group settings');
  expect(container.querySelector('dialog')!.textContent).toContain('Reconnect to Hermes to change these settings.');
  expect(container.querySelector<HTMLInputElement>('dialog input')!.disabled).toBe(true);
  expect(write).not.toHaveBeenCalled();
});
