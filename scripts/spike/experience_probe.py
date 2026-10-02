"""Real marked-home profile memory, cron preview and duplicate-safe native trial.

Runs only against the disposable local executor already verified by guard.py.
No live model accounts, memory files or production scheduler are touched.
"""
import asyncio
import concurrent.futures
import json
import os
import time
import uuid
import urllib.error
import urllib.request
from pathlib import Path
from extension_probe import Client
from guard import verify_target


def call(operation, profile="spike", **fields):
    request = urllib.request.Request(os.environ["HERMES_SPIKE_URL"] + "/api/agent-interface/service/agent-interface/experience",
        method="POST", headers={"Authorization": "Bearer " + os.environ["HERMES_SPIKE_TOKEN"], "Content-Type": "application/json"},
        data=json.dumps(dict(operation=operation, profile=profile, **fields)).encode())
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, json.load(error)


async def main():
    home = Path(os.environ["HERMES_HOME"])
    verify_target(home, os.environ["HERMES_SPIKE_URL"], os.environ["HERMES_SPIKE_TOKEN"])
    assert (home / ".agent-interface-isolated").read_text() == "agent-interface-disposable-spike"
    c = await Client().connect()
    checks = {}
    profile = "experience-other"
    await c.call("profiles.create", name=profile, no_alias=True)
    job_id = None
    try:
        status, initial = call("memory")
        assert status == 200, initial
        document = next(row for row in initial["documents"] if row["target"] == "memory")
        original = document["entries"]
        payload = dict(target="memory", revision=document["revision"], entries=[*original, dict(text="Public synthetic memory proof")])
        status, saved = call("save_memory", **payload)
        assert status == 200, saved
        changed = next(row for row in saved["documents"] if row["target"] == "memory")
        assert changed["revision"] != document["revision"]
        status, _ = call("save_memory", **payload)
        assert status == 409, "Stale edit was not fenced"
        status, other = call("memory", profile=profile)
        assert status == 200, other
        assert not any(entry["text"] == "Public synthetic memory proof" for row in other["documents"] for entry in row["entries"])
        # Two genuine HTTP writers race against the same native revision lock.
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            attempts = list(pool.map(lambda suffix: call("save_memory", target="memory", revision=changed["revision"], entries=[dict(text="Concurrent public proof " + suffix)]), ("A", "B")))
        assert sorted(status for status, _ in attempts) == [200, 409], attempts
        _, latest = call("memory")
        current = next(row for row in latest["documents"] if row["target"] == "memory")
        status, _ = call("save_memory", target="memory", revision=current["revision"], entries=[dict(text="x" * (current["charLimit"] + 1))])
        assert status == 400
        status, _ = call("delete_memory", target="memory", revision=current["revision"], entryId=current["entries"][0]["id"])
        assert status == 200
        _, latest = call("memory")
        current = next(row for row in latest["documents"] if row["target"] == "memory")
        assert call("save_memory", target="memory", revision=current["revision"], entries=original)[0] == 200
        checks.update(native_memory_cas_lock=True, native_memory_limits=True, native_profile_memory_separation=True, native_memory_forget=True)
        status, preview = call("preview", schedule="0 7 * * *")
        assert status == 200 and len(preview["nextRuns"]) == 3 and preview["timezone"], preview
        epochs = [__import__('datetime').datetime.fromisoformat(value).timestamp() for value in preview["nextRuns"]]
        assert epochs == sorted(set(epochs)) and epochs[0] > time.time(), preview
        assert call("preview", schedule="nope")[0] == 400
        checks["native_timezone_schedule_preview"] = True
        result = await c.call("cron.manage", profile="spike", action="add", name="[bot:spike] Experience trial proof", prompt="PROBE_SLOW Public synthetic routine result", schedule="1h", deliver="bot-chat:spike", continuity=True)
        job = result.get("job") or result
        job_id = job.get("job_id") or job.get("id")
        if not job_id:
            jobs = (await c.call("cron.manage", profile="spike", action="list"))["jobs"]
            job_id = next(row["job_id"] for row in jobs if "Experience trial proof" in row["name"])
        await c.call("cron.manage", profile="spike", action="pause", name=job_id)
        request_id = str(uuid.uuid4())
        run = dict(routineId=job_id, requestId=request_id, senderId="experience-fixture")
        status, receipt = call("run", **run)
        assert status == 200 and receipt["status"] in ("accepted", "completed"), receipt
        status, repeat = call("run", **run)
        assert status == 200 and repeat["requestId"] == request_id
        assert call("run", **{**run, "senderId": "another-person"})[0] == 409
        for _ in range(200):
            status, receipt = call("run_receipt", **run)
            assert status == 200
            if receipt["status"] != "accepted":
                break
            await asyncio.sleep(.25)
        assert receipt["status"] == "completed", receipt
        jobs = (await c.call("cron.manage", profile="spike", action="list"))["jobs"]
        job = next(row for row in jobs if (row.get("id") or row.get("job_id")) == job_id)
        assert job.get("enabled") is False or job.get("state") == "paused", job
        request = urllib.request.Request(os.environ["HERMES_SPIKE_URL"] + "/api/agent-interface/service/cron/jobs?profile=spike", headers={"Authorization": "Bearer " + os.environ["HERMES_SPIKE_TOKEN"]})
        with urllib.request.urlopen(request, timeout=10) as response:
            native_job = next(row for row in json.load(response) if (row.get("id") or row.get("job_id")) == job_id)
        before_completed = native_job["last_run_at"]
        assert call("run", **run)[1]["status"] == "completed"
        await asyncio.sleep(.3)
        jobs = (await c.call("cron.manage", profile="spike", action="list"))["jobs"]
        job = next(row for row in jobs if (row.get("id") or row.get("job_id")) == job_id)
        with urllib.request.urlopen(request, timeout=10) as response:
            native_job = next(row for row in json.load(response) if (row.get("id") or row.get("job_id")) == job_id)
        assert native_job["last_run_at"] == before_completed, "Same trial ID reran the native job"
        checks.update(native_try_once_execution=True, paused_routine_restored=True, durable_trial_deduplication=True, trial_actor_scope=True)
        evidence = dict(revision=os.environ.get("HERMES_SPIKE_REVISION"), checks=checks, provider="deterministic fixture; real native memory store and scheduler")
        (Path(os.environ.get("HERMES_SPIKE_EVIDENCE_DIR", "docs/evidence")) / "hermes-experience-probe.json").write_text(json.dumps(evidence, indent=2) + "\n")
        print("Native profile memory, timezone preview and duplicate-safe paused trial passed")
    finally:
        if job_id:
            await c.call("cron.manage", profile="spike", action="remove", name=job_id)
        # Native profile delete is omitted: fixture profile is discarded with its marked home.
        await c.close()


if __name__ == "__main__":
    asyncio.run(main())
