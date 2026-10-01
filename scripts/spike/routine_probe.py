"""Real official scheduler-provider execution and canonical delivery, isolated fixture only."""
import asyncio
import json
import os
import time
import urllib.request
from pathlib import Path
from extension_probe import Client
from guard import verify_target

async def main():
    home = Path(os.environ['HERMES_HOME'])
    assert home.is_absolute() and (home / '.agent-interface-isolated').read_text() == 'agent-interface-disposable-spike'
    assert os.environ['HERMES_SPIKE_URL'].startswith('http://127.0.0.1:')
    verify_target(home, os.environ["HERMES_SPIKE_URL"], os.environ["HERMES_SPIKE_TOKEN"])
    c = await Client().connect()
    snapshot = await c.call('agent-interface.open', profile='spike')
    # The preceding executor probe deliberately left interruption requiring review.
    if snapshot.get('app_interruption'):
        await c.call('agent-interface.submit', profile='spike', session_id=snapshot['session_id'], request_id='routine-reviewed-'+str(time.time_ns()),sender_id='synthetic-person-a',text='Reviewed isolated interruption',attachments=[],reviewed_interruption=True)
        await asyncio.sleep(2)
    before = await c.call('agent-interface.discover', cursor='0')
    result = await c.call('cron.manage',profile='spike',action='add',name='[bot:spike] Synthetic routine execution',prompt='Public synthetic routine result',schedule='1h',deliver='bot-chat:spike',continuity=True)
    job = result.get('job') or result
    job_id = job.get('job_id') or job.get('id')
    if not job_id:
        jobs=(await c.call('cron.manage',profile='spike',action='list'))['jobs']; job_id=next(x['job_id'] for x in jobs if 'Synthetic routine execution' in x['name'])
    try:
        url=os.environ['HERMES_SPIKE_URL']+'/api/cron/jobs/'+job_id+'/trigger?profile=spike'
        request=urllib.request.Request(url,method='POST',headers={'X-Hermes-Session-Token':os.environ['HERMES_SPIKE_TOKEN']})
        response=await asyncio.to_thread(lambda:json.loads(urllib.request.urlopen(request,timeout=120).read()))
        discovery=await c.call('agent-interface.discover',cursor=before['cursor'])
        events=[x for x in discovery['events'] if x.get('routineId')==job_id]
        assert events and any(x['kind']=='completed' for x in events), events
        delivered=[]
        for _ in range(160):
            snapshot=await c.call('agent-interface.open',profile='spike')
            delivered=[x for x in snapshot.get('messages',[]) if 'Public synthetic routine delivery proof' in (x.get('text') or '') or 'cron' in str(x.get('display_kind') or '').lower()]
            if delivered:
                break
            await asyncio.sleep(0.25)
        assert delivered, 'Scheduler completed but no canonical bot delivery was observed'
        evidence={'revision':os.environ.get('HERMES_SPIKE_REVISION','b9cb268deffc97946ec11645aa622a7353dd0591'),'provider':'deterministic fixture; real scheduler provider/AIAgent','checks':{'native_scheduler_provider_execution':True,'canonical_bot_delivery':True,'durable_routine_discovery':True,'explicit_routine_identity':True},'scheduler_owner':'Official in-process scheduler provider fired through authenticated dashboard trigger. Automatic timer scheduling requires a separately supervised native gateway/scheduler; application never executes jobs.'}
        (Path(os.environ.get('HERMES_SPIKE_EVIDENCE_DIR', 'docs/evidence')) / 'hermes-routine-probe.json').write_text(json.dumps(evidence,indent=2)+'\n')
        print('Real routine execution, canonical bot delivery, and durable discovery passed')
    finally:
        await c.call('cron.manage',profile='spike',action='remove',name=job_id)
        await c.close()

if __name__=='__main__':
    asyncio.run(main())
