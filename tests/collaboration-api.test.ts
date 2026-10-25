import { botFixture } from "./helpers/runtime-fixtures.js";
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { afterEach, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/server/config.js';
import { installAuth } from '../src/server/auth.js';
import { Store } from '../src/server/store.js';
import { installCollaborationRoutes } from '../src/server/collaboration.js';
import { fakeRuntime, signIn } from "./helpers/server.js";
import { errorHandler } from "../src/server/http-error.js";
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
async function fixture(privateOwner = 'someone-else') {
  const app = Fastify(); apps.push(app); const store = new Store(':memory:');
  const origin = 'https://collaboration.invalid';
  await app.register(cookie); await installAuth(app, store, loadConfig({ NODE_ENV:'production', APP_ORIGIN:origin, GOOGLE_CLIENT_ID:'fixture', HOUSEHOLD_EMAILS:'one@example.invalid' }));
  app.setErrorHandler(errorHandler({ production: true }));
  const member = (profile: string) => ({ member_id:profile, profile, handle:profile });
  const rooms = [
    { room_id:'shared', name:'Shared discussion', members:[member('ranch'),member('planner')] },
    { room_id:'private', name:'Private discussion', members:[member('ranch'),member('private-bot')] },
    { room_id:'peer', name:'Peer discussion', members:[member('ranch'),{...member('planner'),target:{kind:'peer',profile:'planner'}}] },
  ];
  const groupRequest = vi.fn(async (input: any): Promise<any> => input.operation === 'list' ? {supported:true,canSend:true,rooms}
    : input.operation === 'state' ? {room: rooms.find(room => room.room_id === input.roomId)}
    : input.operation === 'log' ? {events:[],cursor:0,has_more:false,latest_seq:0} : {accepted:true});
  const routineResults = vi.fn(async () => []), routineOutput = vi.fn(async () => ({messages:[],previewOnly:false}));
  const runtime = fakeRuntime({ groupRequest, routineResults, routineOutput, listBots:async () => [botFixture({id:'ranch'}),botFixture({id:'planner'}),botFixture({id:'private-bot',shared:false,ownerId:privateOwner})] });
  await installCollaborationRoutes(app,runtime,store);
  app.addHook('onClose',async () => store.close());
  return {app,store,groupRequest,routineResults,routineOutput,headers:signIn(store,origin,'one')};
}
it('filters private and peer rooms and checks the full roster on every read and action', async () => {
  const s = await fixture();
  expect((await s.app.inject('/api/groups')).statusCode).toBe(401);
  expect((await s.app.inject({url:'/api/groups',headers:s.headers})).json().rooms.map((room:any)=>room.room_id)).toEqual(['shared']);
  for (const roomId of ['private','peer']) {
    for (const tail of ['', '/log?since=0']) expect((await s.app.inject({url:`/api/groups/${roomId}${tail}`,headers:s.headers})).statusCode).toBe(404);
    expect((await s.app.inject({method:'POST',url:`/api/groups/${roomId}/messages`,headers:s.headers,payload:{requestId:crypto.randomUUID(),threadId:crypto.randomUUID(),text:'Message'}})).statusCode).toBe(404);
  }
  expect(s.groupRequest.mock.calls.every(([input])=>!['send','log'].includes(input.operation))).toBe(true);
});
it('lets only the owner put a private assistant in a group, which nobody else can see or reach', async () => {
  const s = await fixture('one');
  expect((await s.app.inject({url:'/api/groups',headers:s.headers})).json().rooms.map((room:any)=>room.room_id)).toEqual(['shared','private']);
  expect((await s.app.inject({method:'POST',url:'/api/groups',headers:s.headers,payload:{requestId:crypto.randomUUID(),name:'Books',botIds:['ranch','private-bot']}})).statusCode).toBe(200);
  for (const tail of ['', '/log?since=0']) expect((await s.app.inject({url:`/api/groups/private${tail}`,headers:s.headers})).statusCode).toBe(200);
  // The first test covers everyone else: the room, its log and its actions answer 404.
});
it('returns the room state with its log for one Hermes state read per poll', async () => {
  const s = await fixture();
  const states = () => s.groupRequest.mock.calls.filter(([input]) => input.operation === 'state').length;
  const polled = await s.app.inject({url:'/api/groups/shared/log?since=0&state=1',headers:s.headers});
  expect(polled.statusCode).toBe(200);
  expect(polled.json()).toMatchObject({events:[],cursor:0,has_more:false,state:{room:{room_id:'shared'}}});
  expect(states()).toBe(1);
  // Older apps ask for the log alone and read the state separately, as before.
  expect((await s.app.inject({url:'/api/groups/shared/log?since=0',headers:s.headers})).json()).not.toHaveProperty('state');
  expect((await s.app.inject({url:'/api/groups/shared/log?since=0&state=yes',headers:s.headers})).statusCode).toBe(400);
  expect((await s.app.inject({url:'/api/groups/private/log?since=0&state=1',headers:s.headers})).statusCode).toBe(404);
});
it('requires CSRF, bounded unique local membership, and exact message payloads',async () => {
  const s = await fixture(), requestId=crypto.randomUUID(), threadId='thread-1';
  const create={requestId,name:'Ranch planning',botIds:['ranch','planner']};
  expect((await s.app.inject({method:'POST',url:'/api/groups',headers:{cookie:s.headers.cookie},payload:create})).statusCode).toBe(403);
  for(const botIds of [['ranch'],['ranch','ranch'],['ranch','private-bot']]) expect((await s.app.inject({method:'POST',url:'/api/groups',headers:s.headers,payload:{...create,botIds}})).statusCode).toBe(400);
  expect((await s.app.inject({method:'POST',url:'/api/groups',headers:s.headers,payload:create})).statusCode).toBe(200);
  const message={requestId,threadId,text:'Discuss the gate repairs'};
  for (const invalid of ['../thread', 'thread with spaces', 't'.repeat(129)]) expect((await s.app.inject({method:'POST',url:'/api/groups/shared/messages',headers:s.headers,payload:{...message,threadId:invalid}})).statusCode).toBe(400);
  expect((await s.app.inject({method:'POST',url:'/api/groups/shared/messages',headers:s.headers,payload:{...message,actor:{kind:'bot',id:'ranch'}}})).statusCode).toBe(400);
  for (let n=0;n<2;n++) expect((await s.app.inject({method:'POST',url:'/api/groups/shared/messages',headers:s.headers,payload:message})).statusCode).toBe(200);
  const sends=s.groupRequest.mock.calls.map(([input])=>input).filter(input=>input.operation==='send');
  expect(sends[0]).toEqual(sends[1]); expect(sends[0]).toMatchObject({operation:'send',text:message.text,threadId});
});
it('keeps routine output profile scope and rejects an inaccessible assistant',async () => {
  const s=await fixture();
  expect((await s.app.inject({url:'/api/bots/private-bot/routines/r1/results',headers:s.headers})).statusCode).toBe(404);
  expect((await s.app.inject({url:'/api/bots/ranch/routines/r1/results/run1',headers:s.headers})).statusCode).toBe(200);
  expect(s.routineOutput).toHaveBeenCalledWith('ranch','r1','run1'); expect(s.routineResults).not.toHaveBeenCalled();
});
it('names the household member who sent each group message, and nobody for messages sent elsewhere', async () => {
  const s = await fixture();
  const event = (event_id: string, kind = 'message.user', actor = 'user') => ({event_id, seq: 1, kind, created_at: 1, actor: {kind: actor, id: actor}, payload: {text: event_id}});
  s.groupRequest.mockImplementation(async (input: any) => input.operation === 'state' ? {room: {room_id: 'shared', name: 'Shared discussion', members: [{member_id: 'ranch', profile: 'ranch', handle: 'ranch'}, {member_id: 'planner', profile: 'planner', handle: 'planner'}]}}
    : input.operation === 'send' ? {event: event(`user:${input.requestId}`), accepted: true}
    : {events: [event(`user:${sent}`), event('user:from-dashboard'), event('reply', 'message.member', 'planner')], cursor: 3, latest_seq: 3, has_more: false});
  let sent = '';
  const response = await s.app.inject({method: 'POST', url: '/api/groups/shared/messages', headers: s.headers, payload: {requestId: crypto.randomUUID(), threadId: 'thread', text: 'Bring water'}});
  expect(response.statusCode).toBe(200);
  sent = s.groupRequest.mock.calls.map(([input]) => input).find(input => input.operation === 'send').requestId;
  s.store.user({id: 'one', name: 'Nicolas', email: 'one@example.invalid'});
  for (const tail of ['', '&state=1']) {
    const events = (await s.app.inject({url: `/api/groups/shared/log?since=0${tail}`, headers: s.headers})).json().events;
    expect(events.map((event: any) => event.sender)).toEqual([{id: 'one', name: 'Nicolas'}, undefined, undefined]);
  }
});
