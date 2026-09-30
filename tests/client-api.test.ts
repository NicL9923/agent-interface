import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, setCsrf } from '../src/client-api.js';

beforeEach(()=>{vi.useFakeTimers();setCsrf('current-session-csrf');});
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
