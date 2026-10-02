import { afterEach, expect, it } from 'vitest';
import { Store } from '../src/server/store.js';
import { defaultPreferences, type ToolCall, type Runtime } from '../src/shared/types.js';
import { receipt } from '../src/shared/discovery.js';
import { inQuietHours, BackgroundWorker } from '../src/server/notifications.js';
import { loadConfig } from '../src/server/config.js';
const stores:Store[]=[];afterEach(()=>stores.splice(0).forEach(store=>store.close()));
function setup() { const store=new Store(':memory:');stores.push(store);store.user({id:'one',name:'One',email:'one@example.test'});store.user({id:'two',name:'Two',email:'two@example.test'});return store; }
it('stores account-specific pointers and deduplicates original references without copying answers',()=>{
  const store=setup();const pointer={kind:'session' as const,botId:'ranch',sessionId:'session-1',title:'Dinners'};
  const item=store.saveItem('one',pointer);expect(store.saveItem('one',pointer).id).toBe(item.id);
  expect(store.savedItems('two')).toEqual([]);store.deleteSavedItem('two',item.id);expect(store.savedItems('one')).toHaveLength(1);
  store.deleteSavedItem('one',item.id);expect(store.savedItems('one')).toEqual([]);
});
it('handles overnight quiet windows in the person’s timezone, including DST transitions',()=>{
  const settings={timezone:'America/Chicago',quietStart:'22:00',quietEnd:'07:00',batchMinutes:5};
  expect(inQuietHours(settings,new Date('2026-11-01T06:30:00Z'))).toBe(true);
  expect(inQuietHours(settings,new Date('2026-11-01T07:30:00Z'))).toBe(true);
  expect(inQuietHours(settings,new Date('2026-11-01T13:00:00Z'))).toBe(false);
  expect(inQuietHours({...settings,quietStart:'09:00',quietEnd:'17:00'},new Date('2026-10-01T16:00:00Z'))).toBe(true);
  expect(inQuietHours(undefined)).toBe(false);
});
it('keeps a fixed digest across retries and acknowledges each device independently',async()=>{
  const store=setup();store.savePreferences('one',{...defaultPreferences,notifications:{timezone:'UTC',batchMinutes:5}});store.participate('run','one');
  for(const id of ['first','second'])store.recordEvents([{id,runId:'run',botId:'ranch',kind:'completed',title:id,occurredAt:new Date().toISOString()}],id);
  for(const endpoint of ['https://push.test/ok','https://push.test/retry'])store.subscribe('one',{endpoint,keys:{p256dh:'key',auth:'key'}});
  const payloads:{endpoint:string;payload:string}[]=[];
  const runtime={capabilities:async()=>({idempotency:{supported:false},durableEvents:{supported:false}})} as unknown as Runtime;
  const worker=new BackgroundWorker(store,runtime,loadConfig({HOUSEHOLD_EMAILS:'one@example.test'}),async(subscription,payload)=>{payloads.push({endpoint:subscription.endpoint,payload});if(subscription.endpoint.endsWith('/retry')&&payloads.filter(item=>item.endpoint.endsWith('/retry')).length===1)throw new Error('offline');});
  await worker.tick();expect(payloads).toEqual([]);
  store.db.prepare("UPDATE outbox SET payload=json_set(payload,'$.queuedAt',?)").run(Date.now()-600000);
  await worker.tick();expect(payloads).toHaveLength(2);const tag=JSON.parse(payloads[0].payload).tag;
  store.recordEvents([{id:'new',runId:'run',botId:'ranch',kind:'completed',title:'new',occurredAt:new Date().toISOString()}],'3');store.db.prepare('UPDATE outbox SET next_attempt=0').run();
  await worker.tick();expect(payloads).toHaveLength(3);expect(JSON.parse(payloads[2].payload).tag).toBe(tag);expect(JSON.parse(payloads[2].payload).title).toBe('2 assistant updates');expect(store.outbox()).toHaveLength(1);
});
it('defers approval notifications through quiet hours without marking them delivered',async()=>{
  const store=setup();const now=new Date();const time=new Intl.DateTimeFormat('en-GB',{timeZone:'UTC',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(now);
  store.savePreferences('one',{...defaultPreferences,notifications:{timezone:'UTC',quietStart:time,quietEnd:time==='23:59'?'23:58':'23:59',batchMinutes:0}});store.participate('run','one');store.recordEvents([{id:'decision',runId:'run',botId:'ranch',kind:'approval',title:'Decision',occurredAt:now.toISOString()}],'1');store.subscribe('one',{endpoint:'https://push.test/one',keys:{p256dh:'key',auth:'key'}});
  let sends=0;const runtime={capabilities:async()=>({idempotency:{supported:false},durableEvents:{supported:false}})} as unknown as Runtime;
  const worker=new BackgroundWorker(store,runtime,loadConfig({HOUSEHOLD_EMAILS:'one@example.test'}),async()=>{sends++;});await worker.tick();expect(sends).toBe(0);expect(store.outbox()).toHaveLength(1);
  store.savePreferences('one',defaultPreferences);await worker.tick();expect(sends).toBe(1);expect(store.outbox()).toHaveLength(0);
});
it('does not mistake completed transport or shell exit zero for a confirmed external action',()=>{
  const call:ToolCall={id:'tool',name:'terminal',status:'completed',result:'{"exit_code":0}'};
  expect(receipt(call).label).toBe('Tool finished');expect(receipt({...call,result:'{"success":true,"html_url":"https://example.test/result"}'}).links).toEqual(['https://example.test/result']);
  expect(receipt({...call,result:'{"success":false,"error":"No permission"}'}).label).toBe('Tool failed');expect(receipt({...call,result:'{"success":true,"url":"javascript:alert(1)"}'}).links).toEqual([]);
});
it('does not lose an accessible update when another member’s bot is revoked from its digest',async()=>{
  const store=setup();store.savePreferences('one',{...defaultPreferences,notifications:{timezone:'UTC',batchMinutes:5}});store.participate('run','one');
  store.recordEvents([{id:'public',botId:'public',runId:'run',kind:'completed',title:'Public update',occurredAt:new Date().toISOString()},{id:'private',botId:'private',runId:'run',kind:'completed',title:'Private secret title',occurredAt:new Date().toISOString()}],'1');store.db.prepare("UPDATE outbox SET payload=json_set(payload,'$.queuedAt',?)").run(Date.now()-600000);store.deliveryGroups();store.savePresentation('private',{ownerId:'two',shared:false});
  store.subscribe('one',{endpoint:'https://push.test/one',keys:{p256dh:'key',auth:'key'}});const payloads:string[]=[];const runtime={capabilities:async()=>({idempotency:{supported:false},durableEvents:{supported:false}})} as unknown as Runtime;
  const worker=new BackgroundWorker(store,runtime,loadConfig({HOUSEHOLD_EMAILS:'one@example.test'}),async(_,payload)=>{payloads.push(payload);});await worker.tick();expect(payloads).toHaveLength(1);expect(payloads[0]).toContain('Public update');expect(payloads[0]).not.toContain('Private secret title');expect(store.outbox()).toHaveLength(0);
});
