import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { randomBytes } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { installAuth, hash } from '../src/server/auth.js';
import { Store } from '../src/server/store.js';
import { loadConfig } from '../src/server/config.js';
import { installDiscoveryRoutes } from '../src/server/discovery.js';
import type { Runtime } from '../src/shared/types.js';
const apps:ReturnType<typeof Fastify>[]=[];afterEach(async()=>{for(const app of apps.splice(0))await app.close();});
async function setup() {
  const app=Fastify();apps.push(app);const store=new Store(':memory:');await app.register(cookie);const origin='https://discovery.example.test';
  await installAuth(app,store,loadConfig({NODE_ENV:'production',APP_ORIGIN:origin,APP_DATABASE:':memory:',GOOGLE_CLIENT_ID:'fixture',HOUSEHOLD_EMAILS:'one@example.test,two@example.test'}));
  app.setErrorHandler((error,_req,reply)=>reply.code(error instanceof z.ZodError?400:(error as {statusCode?:number}).statusCode??502).send({error:(error as Error).message}));
  const experienceRequest=vi.fn(async(input:any)=>input.operation==='search'?[{botId:input.profile,sessionId:'history',title:'Dinners',snippet:'Plan'}]:input.operation==='history'?{botId:input.profile,sessionId:input.sessionId,messages:[{id:'reply',role:'assistant',text:'Plan'}],offset:input.offset,hasMore:false}:{botId:input.profile,days:30,actualCost:null});
  const setRoutineEnabled=vi.fn(async()=>{});const saveRoutine=vi.fn();const routineResults=vi.fn(async()=>[{id:'output',title:'Dinners',preview:'Plan dinners'}]);
  const runtime={listBots:async()=>[{id:'shared',name:'Shared',shared:true},{id:'private',name:'Private',shared:false,ownerId:'two'}],experienceRequest,routines:async()=>[{id:'routine',botId:'shared',name:'Dinners',schedule:'0 7 * * *',prompt:'Report',enabled:true}],routineResults,tools:async()=>[{id:'browser',enabled:false},{id:'terminal',enabled:true}],capabilities:async()=>({uploads:{supported:true}}),setRoutineEnabled,saveRoutine} as unknown as Runtime;
  await installDiscoveryRoutes(app,runtime,store);store.user({id:'one',name:'One',email:'one@example.test'});const token=randomBytes(32).toString('hex');store.session(hash(token),'one','csrf',Date.now()+600000);const headers={cookie:`session=${token}`,origin,'x-csrf-token':'csrf'};app.addHook('onClose',async()=>store.close());return {app,store,headers,experienceRequest,setRoutineEnabled,saveRoutine};
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
