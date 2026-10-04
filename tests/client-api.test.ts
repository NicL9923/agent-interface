import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, clearResponseCache, setCsrf } from '../src/client-api.js';

beforeEach(()=>{vi.useFakeTimers();setCsrf('current-session-csrf');clearResponseCache();});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();setCsrf('');});
function stalledBody(){
  let signal:AbortSignal|undefined;
  const fetch=vi.fn(async(_path:string,init:RequestInit)=>{
    signal=init.signal as AbortSignal;
    return {ok:true,status:200,text:()=>new Promise<string>((_resolve,reject)=>{
      if(signal!.aborted)reject(signal!.reason);
      else signal!.addEventListener('abort',()=>reject(signal!.reason),{once:true});
    })};
  });
  vi.stubGlobal('fetch',fetch);return {fetch,get signal(){return signal;}};
}

describe('client request recovery',()=>{
  it.each([{method:undefined,deadline:20_000},{method:'POST',deadline:60_000}])('includes response-body reading in the $method request deadline',async({method,deadline})=>{
    const transport=stalledBody();
    const pending=api('/bootstrap',method?{method,body:'{}'}:{});
    const failure=expect(pending).rejects.toMatchObject({status:504,code:'CONNECTION_UNAVAILABLE'});
    await vi.advanceTimersByTimeAsync(deadline-1);
    expect(transport.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);await failure;
    expect(transport.signal?.aborted).toBe(true);
    expect(transport.fetch).toHaveBeenCalledTimes(1);
  });

  it('preserves caller cancellation while reading the body instead of reporting a connection failure',async()=>{
    const transport=stalledBody(),caller=new AbortController(),reason=new Error('Identity changed');
    const pending=api('/bootstrap',{signal:caller.signal});
    const failure=expect(pending).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(0);caller.abort(reason);await failure;
    expect(transport.signal?.aborted).toBe(true);
    expect(transport.fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects unreadable successful responses instead of returning an empty successful bootstrap',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>new Response('<html>Proxy error</html>',{status:200})));
    await expect(api('/bootstrap')).rejects.toMatchObject({status:502,code:'INVALID_RESPONSE'});
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('conditional reads',()=>{
  const json=(body:unknown,etag?:string)=>new Response(JSON.stringify(body),{status:200,headers:etag?{ETag:etag}:{}});
  const notModified=()=>new Response(null,{status:304});
  function server(...replies:Response[]){
    const fetch=vi.fn(async(_path:string,_init:RequestInit)=>replies.shift()!);
    vi.stubGlobal('fetch',fetch);return fetch;
  }
  const validator=(fetch:ReturnType<typeof server>,call:number)=>new Headers(fetch.mock.calls[call][1].headers).get('If-None-Match');

  it('revalidates only the exact path it holds and answers a 304 with the same object',async()=>{
    const fetch=server(json({messages:['hello']},'W/"one"'),notModified(),json({messages:[]}),json({ok:true}));
    const first=await api('/bots/ranch/conversation');
    await expect(api('/bots/ranch/conversation')).resolves.toBe(first);
    expect(validator(fetch,0)).toBeNull();
    expect(validator(fetch,1)).toBe('W/"one"');
    await api('/bots/ranch/conversation?since=1');
    expect(validator(fetch,2)).toBeNull();
    await api('/bots/ranch/conversation',{method:'POST',body:'{}'});
    expect(validator(fetch,3)).toBeNull();
  });

  it('keeps the cached object when a full response repeats the same text and replaces it when the text changes',async()=>{
    const fetch=server(json({state:'idle'}),json({state:'idle'}),json({state:'working'},'W/"two"'),json({state:'working'}));
    const first=await api('/bots/ranch/conversation');
    await expect(api('/bots/ranch/conversation')).resolves.toBe(first);
    const changed=await api<{state:string}>('/bots/ranch/conversation');
    expect(changed).not.toBe(first);expect(changed.state).toBe('working');
    await expect(api('/bots/ranch/conversation')).resolves.toBe(changed);
    expect(validator(fetch,1)).toBeNull();expect(validator(fetch,3)).toBe('W/"two"');
  });

  it('retries a 304 it did not ask for once without a validator instead of reporting an error',async()=>{
    let fetch=server(notModified(),json({ready:true},'W/"three"'));
    await expect(api('/today')).resolves.toEqual({ready:true});
    expect(fetch).toHaveBeenCalledTimes(2);expect(validator(fetch,1)).toBeNull();
    clearResponseCache();fetch=server(notModified(),notModified());
    await expect(api('/today')).rejects.toMatchObject({status:502,code:'INVALID_RESPONSE'});
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('forgets every body on an identity change, including reads that were in flight',async()=>{
    let finish!:(response:Response)=>void;
    const fetch=vi.fn(async(_path:string,_init:RequestInit)=>new Promise<Response>(resolve=>{finish=resolve;}));
    vi.stubGlobal('fetch',fetch);
    const pending=api('/bootstrap');await vi.advanceTimersByTimeAsync(0);
    clearResponseCache();finish(json({user:'one'},'W/"one"'));await pending;
    const next=api('/bootstrap');await vi.advanceTimersByTimeAsync(0);finish(json({user:'two'}));await next;
    expect(validator(fetch,1)).toBeNull();
  });

  it('bounds the cache by count and size, evicting the least recently used path',async()=>{
    const fetch=server(...Array.from({length:64},(_,index)=>json({index},`W/"${index}"`)),
      notModified(),json({index:64},'W/"64"'),json({index:1}),notModified(),
      json({blob:'x'.repeat(4_000_001)},'W/"big"'),json({blob:''}));
    for(let index=0;index<64;index++)await api(`/item/${index}`);
    await api('/item/0');await api('/item/64');
    await api('/item/1');await api('/item/0');
    expect([validator(fetch,64),validator(fetch,66),validator(fetch,67)]).toEqual(['W/"0"',null,'W/"0"']);
    await api('/large');await api('/large');
    expect(validator(fetch,69)).toBeNull();
  });
});
