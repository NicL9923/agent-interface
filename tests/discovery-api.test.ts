import { botFixture, capabilitiesFixture, experienceRequester, routineFixture, toolFixture } from './helpers/runtime-fixtures.js';
import type { HistoryPage } from '../src/shared/discovery.js';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { afterEach, expect, it, vi } from 'vitest';
import { installAuth } from '../src/server/auth.js';
import { Store } from '../src/server/store.js';
import { loadConfig } from '../src/server/config.js';
import { installDiscoveryRoutes } from '../src/server/discovery.js';
import { fakeRuntime, signIn } from "./helpers/server.js";
import { errorHandler } from "../src/server/http-error.js";
const apps:ReturnType<typeof Fastify>[]=[];afterEach(async()=>{for(const app of apps.splice(0))await app.close();});
async function setup() {
  const app=Fastify();apps.push(app);const store=new Store(':memory:');await app.register(cookie);const origin='https://discovery.example.test';
  await installAuth(app,store,loadConfig({NODE_ENV:'production',APP_ORIGIN:origin,APP_DATABASE:':memory:',GOOGLE_CLIENT_ID:'fixture',HOUSEHOLD_EMAILS:'one@example.test,two@example.test'}));
  app.setErrorHandler(errorHandler({ production: true }));
  const history = vi.fn((input: {profile: string; sessionId: string; offset: number}): HistoryPage => ({botId:input.profile,sessionId:input.sessionId,messages:[{id:'reply',role:'assistant',text:'Plan'}],offset:input.offset,hasMore:false}));
  const experience = experienceRequester({
    search: input => [{botId:input.profile,botName:'Shared',sessionId:'history',title:'Dinners',snippet:'Plan'}],
    history,
    usage: input => ({botId:input.profile,days:input.days,sessions:0,inputTokens:0,outputTokens:0,actualCost:null,estimatedCost:null,partial:false,notice:'Recorded usage'}),
  });
  const setRoutineEnabled=vi.fn(async()=>{});const saveRoutine=vi.fn();const routineResults=vi.fn(async()=>[{id:'output',title:'Dinners',preview:'Plan dinners',previewOnly:false}]);
  const runtime=fakeRuntime({listBots:async()=>[botFixture(),botFixture({id:'private',name:'Private',shared:false,ownerId:'two'})],experienceRequest:experience,routines:async()=>[{id:'routine',botId:'shared',name:'Dinners',schedule:'0 7 * * *',prompt:'Report',enabled:true}],routineResults,tools:async()=>[toolFixture({id:'browser',enabled:false}),toolFixture()],capabilities:async()=>capabilitiesFixture({uploads:{supported:true}}),setRoutineEnabled,saveRoutine});
  const experienceRequest = vi.spyOn(runtime, 'experienceRequest');
  await installDiscoveryRoutes(app,runtime,store);const headers=signIn(store,origin,'one',{email:'one@example.test',csrf:'csrf'});app.addHook('onClose',async()=>store.close());return {app,store,headers,experienceRequest,history,setRoutineEnabled,saveRoutine};
}
it('searches only visible profiles and includes routine results without copying their output',async()=>{
  const s=await setup();expect((await s.app.inject('/api/search?q=dinners')).statusCode).toBe(401);
  const response=await s.app.inject({url:'/api/search?q=dinners',headers:s.headers});expect(response.statusCode).toBe(200);expect(response.json().hits).toHaveLength(2);expect(s.experienceRequest).toHaveBeenCalledWith({operation:'search',profile:'shared',query:'dinners'});expect(s.experienceRequest).not.toHaveBeenCalledWith(expect.objectContaining({profile:'private'}));
  expect((await s.app.inject({url:'/api/bots/private/history/history',headers:s.headers})).statusCode).toBe(404);
});
it('validates original reply identity and scoped saved references',async()=>{
  const s=await setup();const body={kind:'session',botId:'shared',sessionId:'history',messageId:'reply',offset:100,title:'Dinner plan'};
  const response=await s.app.inject({url:'/api/saved',method:'POST',headers:s.headers,payload:body});expect(response.statusCode).toBe(200);expect(s.experienceRequest).toHaveBeenLastCalledWith({operation:'history',profile:'shared',sessionId:'history',offset:100});
  expect((await s.app.inject({url:'/api/saved',method:'POST',headers:s.headers,payload:{...body,messageId:'missing'}})).statusCode).toBe(404);expect((await s.app.inject({url:'/api/saved',method:'POST',headers:{cookie:s.headers.cookie,origin:s.headers.origin},payload:body})).statusCode).toBe(403);
});
it('pauses without resaving a stale prompt, schedule or recipients',async()=>{
  const s=await setup();const response=await s.app.inject({url:'/api/routines/routine/state',method:'PATCH',headers:s.headers,payload:{enabled:false}});expect(response.statusCode).toBe(200);expect(s.setRoutineEnabled).toHaveBeenCalledWith('shared','routine',false);expect(s.saveRoutine).not.toHaveBeenCalled();
});
it('offers only enabled tool starters and always leaves sending to the composer',async()=>{
  const s=await setup();const response=await s.app.inject({url:'/api/bots/shared/starters',headers:s.headers});expect(response.json().map((row:any)=>row.id)).toEqual(['meals','document','server']);
});

it('locates a live reply before saving and re-resolves an old saved pointer on opening',async()=>{
  const s=await setup();
  s.history.mockImplementation((input)=>({botId:input.profile,sessionId:input.sessionId,messages:[{id:'stable-uid',role:'assistant',text:'Late answer'}],offset:200,hasMore:false,targetMessageId:'stable-uid'}));
  const reply=await s.app.inject({url:'/api/saved',method:'POST',headers:s.headers,payload:{kind:'session',botId:'shared',sessionId:'history',messageId:'old-row',title:'Saved answer'}});
  expect(reply.statusCode).toBe(200);expect(reply.json()).toMatchObject({messageId:'stable-uid',offset:200});
  expect(s.experienceRequest).toHaveBeenLastCalledWith({operation:'history',profile:'shared',sessionId:'history',messageId:'old-row',offset:0});
  const opened=await s.app.inject({url:'/api/bots/shared/history/history?offset=0&messageId=stable-uid',headers:s.headers});
  expect(opened.statusCode).toBe(200);expect(opened.json()).toMatchObject({offset:200,targetMessageId:'stable-uid'});
  const count=s.experienceRequest.mock.calls.length;
  expect((await s.app.inject({url:'/api/bots/private/history/history?messageId=stable-uid',headers:s.headers})).statusCode).toBe(404);
  expect(s.experienceRequest.mock.calls.length).toBe(count);
});
