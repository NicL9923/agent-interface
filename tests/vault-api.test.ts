import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { randomBytes } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { installAuth, hash } from '../src/server/auth.js';
import { Store } from '../src/server/store.js';
import { loadConfig } from '../src/server/config.js';
import { installVaultRoutes } from '../src/server/vault.js';
import type { Runtime } from '../src/shared/types.js';
const origin = 'https://vault.example.invalid';
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });
async function setup() {
  const app = Fastify({ logger: false }); apps.push(app);
  const store = new Store(':memory:');
  await app.register(cookie);
  await installAuth(app, store, loadConfig({ NODE_ENV:'production', APP_ORIGIN:origin, APP_DATABASE:':memory:', GOOGLE_CLIENT_ID:'fixture', HOUSEHOLD_EMAILS:'one@example.invalid' }));
  app.setErrorHandler((error, _req, reply) => reply.code(error instanceof z.ZodError ? 400 : (error as {statusCode?:number}).statusCode ?? 502).send({error:(error as Error).message}));
  const vaultRequest = vi.fn(async () => ({status:'ok'}));
  await installVaultRoutes(app, {listBots:async()=>[{id:'shared'}],vaultRequest} as unknown as Runtime);
  store.user({id:'one',name:'One',email:'one@example.invalid'});
  const token=randomBytes(32).toString('hex'), csrf=randomBytes(32).toString('hex');
  store.session(hash(token),'one',csrf,Date.now()+600000);
  app.addHook('onClose', async()=>store.close());
  return {app,store,vaultRequest,headers:{origin,cookie:`session=${token}`,'x-csrf-token':csrf}};
}
const canary='vault-synthetic-password-DoNotLog';
const owner={epoch:'native-epoch',sessionId:'canonical-session',method:'vault.save_login'};
it('authenticates and CSRF-protects secret capture and rejects caller origin/result overrides',async()=>{
  const s=await setup(), url='/api/bots/shared/secure-requests/srq-example';
  const payload={...owner,identifier:'test@example.invalid',password:canary};
  for(const [headers,status] of [[{},401],[{cookie:s.headers.cookie,origin},403],[{...s.headers,origin:'https://foreign.invalid'},403]] as const)
    expect((await s.app.inject({method:'POST',url,headers,payload})).statusCode).toBe(status);
  for(const extra of [{origin:'https://foreign.invalid'},{result:{value:canary}},{cancel:false}])
    expect((await s.app.inject({method:'POST',url,headers:s.headers,payload:{...payload,...extra}})).statusCode).toBe(400);
  expect(s.vaultRequest).not.toHaveBeenCalled();
  const response=await s.app.inject({method:'POST',url,headers:s.headers,payload});
  expect(response.statusCode).toBe(200); expect(response.body).not.toContain(canary);
  expect(s.vaultRequest).toHaveBeenCalledWith({operation:'answer',profile:'shared',requestId:'srq-example',answer:payload});
  expect((await s.app.inject({method:'POST',url:'/api/bots/missing/secure-requests/srq-example',headers:s.headers,payload})).statusCode).toBe(404);
});
it('uses strict native management contracts and keeps unavailable/errors model blind',async()=>{
  const s=await setup();
  const login={label:'Login',origin:'https://site.example.invalid',identifierType:'email',identifier:'test@example.invalid',password:'  '+canary+'  '};
  expect((await s.app.inject({method:'POST',url:'/api/bots/shared/vault/logins',headers:s.headers,payload:login})).statusCode).toBe(200);
  expect(s.vaultRequest).toHaveBeenLastCalledWith({operation:'add_login',profile:'shared',login});
  for(const bad of ['https://user:password@site.invalid','https://site.invalid/login','https://site.invalid/?token=secret'])
    expect((await s.app.inject({method:'POST',url:'/api/bots/shared/vault/logins',headers:s.headers,payload:{...login,origin:bad}})).statusCode).toBe(400);
  expect((await s.app.inject({method:'POST',url:'/api/bots/shared/vault/sources/local/unlock',headers:s.headers,payload:{password:canary}})).statusCode).toBe(400);
  s.vaultRequest.mockRejectedValueOnce(Object.assign(new Error(canary),{statusCode:409}));
  const response=await s.app.inject({method:'POST',url:'/api/bots/shared/vault/sources/bitwarden/unlock',headers:s.headers,payload:{password:canary}});
  expect(response.statusCode).toBe(409); expect(response.body).not.toContain(canary);
  expect(s.vaultRequest).toHaveBeenCalledTimes(2);
});
it('does not replay uncertain secret submission and rejects overlapping mutation',async()=>{
  const s=await setup(); let reject!:(error:Error)=>void;
  s.vaultRequest.mockImplementationOnce(()=>new Promise((_resolve,no)=>{reject=no;}));
  const payload={epoch:'native-epoch',sessionId:'canonical-session',method:'vault.code',value:'123456'};
  const request={method:'POST' as const,url:'/api/bots/shared/secure-requests/srq-example',headers:s.headers,payload};
  const first=s.app.inject(request);
  await vi.waitFor(()=>expect(s.vaultRequest).toHaveBeenCalledOnce());
  expect((await s.app.inject(request)).statusCode).toBe(429);
  reject(new Error(canary)); const response=await first;
  expect(response.statusCode).toBe(502);expect(response.body).not.toContain(canary);
  expect(s.vaultRequest).toHaveBeenCalledOnce();
});
