import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { randomBytes } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { loadConfig } from '../src/server/config.js';
import { installAuth, hash } from '../src/server/auth.js';
import { Store } from '../src/server/store.js';
import { installCollaborationRoutes } from '../src/server/collaboration.js';
import type { Runtime } from '../src/shared/types.js';
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
async function fixture() {
  const app = Fastify(); apps.push(app); const store = new Store(':memory:');
  const origin = 'https://collaboration.invalid';
  await app.register(cookie); await installAuth(app, store, loadConfig({ NODE_ENV:'production', APP_ORIGIN:origin, GOOGLE_CLIENT_ID:'fixture', HOUSEHOLD_EMAILS:'one@example.invalid' }));
  app.setErrorHandler((error, _req, reply) => reply.code(error instanceof z.ZodError ? 400 : (error as {statusCode?:number}).statusCode || 502).send({ error:(error as Error).message }));
  const member = (profile: string) => ({ member_id:profile, profile, handle:profile });
  const rooms = [
    { room_id:'shared', name:'Shared discussion', members:[member('ranch'),member('planner')] },
    { room_id:'private', name:'Private discussion', members:[member('ranch'),member('private-bot')] },
    { room_id:'peer', name:'Peer discussion', members:[member('ranch'),{...member('planner'),target:{kind:'peer',profile:'planner'}}] },
  ];
  const groupRequest = vi.fn(async (input: any) => input.operation === 'list' ? {supported:true,canSend:true,rooms}
    : input.operation === 'state' ? {room: rooms.find(room => room.room_id === input.roomId)}
    : input.operation === 'log' ? {events:[],cursor:0,has_more:false,latest_seq:0} : {accepted:true});
  const routineResults = vi.fn(async () => []), routineOutput = vi.fn(async () => ({messages:[],previewOnly:false}));
  const runtime = { groupRequest, routineResults, routineOutput, listBots:async () => [{id:'ranch',shared:true},{id:'planner',shared:true},{id:'private-bot',shared:false,ownerId:'someone-else'}] } as unknown as Runtime;
  await installCollaborationRoutes(app,runtime,store);
  store.user({id:'one',name:'One',email:'one@example.invalid'}); const token=randomBytes(32).toString('hex'),csrf=randomBytes(32).toString('hex');store.session(hash(token),'one',csrf,Date.now()+600000);
  app.addHook('onClose',async () => store.close());
  return {app,groupRequest,routineResults,routineOutput,headers:{origin,cookie:`session=${token}`,'x-csrf-token':csrf}};
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
