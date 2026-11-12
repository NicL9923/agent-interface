"""Real gateway idle compaction probe, isolated fixture only.

Needs HERMES_AGENT_INTERFACE_IDLE_COMPACT_SECONDS set low and HERMES_SPIKE_SUMMARY_GATE set: while
the gate file exists, the fixture provider holds Hermes's compaction summary open. Checks that an
input sent during a background compaction runs at once (plain, steering, another client's and a
routine delivery),
that the compaction then never commits, that a finished compaction leaves the app's view and
anchored reads unchanged while the model sees the summary, and that it does not repeat.
"""
import asyncio
import json
import os
import time
import urllib.request
from pathlib import Path
from extension_probe import Client, projection_matches, settled
from guard import verify_target

PROFILE = "default"
SUMMARY = "summarization agent creating a context checkpoint"
LOG = Path(os.environ.get("HERMES_SPIKE_PROVIDER_LOG", "/nonexistent"))
GATE = Path(os.environ.get("HERMES_SPIKE_SUMMARY_GATE", "/nonexistent/gate"))


def requests():
    return [json.loads(line) for line in LOG.read_text().splitlines()] if LOG.exists() else []


def is_summary(request):
    return any(SUMMARY in str(message.get("content", "")) for message in request["messages"])


def summaries():
    return sum(is_summary(request) for request in requests())


def model_text(request):
    return "\n".join(str(message.get("content", "")) for message in request["messages"])


async def until(check, seconds, what):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        value = check()
        if value:
            return value
        await asyncio.sleep(0.1)
    raise AssertionError("Timed out waiting for " + what)


async def compaction_started(count, delay):
    # The add-on polls a quarter of its delay; allow two delays, two polls and the summary build.
    await until(lambda: summaries() > count, delay * 3 + 15, "background compaction " + str(count + 1))
    return summaries()


def visible(snapshot):
    return [(m.get("app_request_id") or m.get("row_id"), m.get("role"), m.get("text")) for m in snapshot["messages"]
            if m.get("display_kind") != "hidden"]


async def send(c, sid, request_id, text, **extra):
    started = time.monotonic()
    receipt = await c.call("agent-interface.submit", profile=PROFILE, session_id=sid, request_id=request_id,
                           sender_id="synthetic-person-a", text=text, attachments=[], **extra)
    admitted = time.monotonic() - started
    await settled(c, PROFILE)
    return receipt, admitted, time.monotonic() - started


async def answered_during(c, sid, label, evidence, before, **extra):
    """Send while the compaction is held open. It must run now, on the uncompacted transcript."""
    request_id = f"during-{label}-{time.time_ns()}"
    count = len(requests())
    receipt, admitted, finished = await send(c, sid, request_id, f"PROBE {label} during compaction", **extra)
    assert receipt["status"] == "accepted" and receipt["steering"] is False and receipt["runId"] == request_id, receipt
    assert GATE.exists(), "The gate must still hold the summary, so the reply cannot have waited for it"
    turn = [r for r in requests()[count:] if not is_summary(r) and f"PROBE {label} during compaction" in model_text(r)]
    assert turn and "Synthetic history turn 0" in model_text(turn[0]), "The input's turn must see the uncompacted transcript"
    snapshot = await c.call("agent-interface.open", profile=PROFILE)
    rows = [m for m in snapshot["messages"] if m.get("app_request_id") == request_id]
    assert len(rows) == 1 and rows[0]["role"] == "user", "The input must appear exactly once"
    later = snapshot["messages"][snapshot["messages"].index(rows[0]) + 1:]
    assert any(m.get("role") == "assistant" and m.get("app_run_id") == request_id for m in later), "The input must be answered"
    found = await c.call("agent-interface.discover", cursor=before)
    assert any(e["kind"] == "completed" and e["runId"] == request_id for e in found["events"]), "Its run must settle"
    evidence["checks"][label] = {"admission_seconds": round(admitted, 3), "settled_seconds": round(finished, 3),
                                 "steering": False, "uncompacted_transcript": True, "answered_once": True}
    return request_id


async def main():
    home = Path(os.environ["HERMES_HOME"])
    assert home.is_absolute() and (home / ".agent-interface-isolated").read_text() == "agent-interface-disposable-spike"
    verify_target(home, os.environ["HERMES_SPIKE_URL"], os.environ["HERMES_SPIKE_TOKEN"])
    c = await Client().connect()
    caps = await c.call("agent-interface.capabilities")
    delay = caps.get("idle_compaction_seconds")
    assert isinstance(delay, int) and 0 < delay <= 10, "Run with a short HERMES_AGENT_INTERFACE_IDLE_COMPACT_SECONDS"
    evidence = {"revision": caps["revision"], "provider": "deterministic fixture; real Hermes compaction", "idle_seconds": delay, "checks": {}}
    snapshot = await c.call("agent-interface.open", profile=PROFILE)
    sid = snapshot["session_id"]
    cursor = (await c.call("agent-interface.discover", cursor="0"))["cursor"]
    GATE.write_text("hold")
    try:
        # A transcript well over Hermes's kept-tail and summary budgets for this fixture model.
        for turn in range(20):
            receipt, _, _ = await send(c, sid, f"history-{turn}-{time.time_ns()}", f"Synthetic history turn {turn}: " + "pasture fence gate " * 400)
            assert receipt["status"] == "accepted", receipt
        assert summaries() == 0, "No compaction may start while turns keep arriving"
        count = await compaction_started(0, delay)
        snapshot = await c.call("agent-interface.open", profile=PROFILE)
        assert not snapshot.get("info", {}).get("running") and not snapshot.get("app_run_id"), "A background compaction must look idle"
        anchor = await answered_during(c, sid, "plain_message", evidence, cursor)

        count = await compaction_started(count, delay)
        await answered_during(c, sid, "steer_flag_message", evidence, cursor, steer=True)

        count = await compaction_started(count, delay)
        # Another client sends straight to Hermes, which queues it behind the compaction.
        started = time.monotonic()
        queued = await c.call("prompt.submit", session_id=sid, profile=PROFILE, text="PROBE native client during compaction")
        async def answered():
            rows = [m for m in (await c.call("agent-interface.open", profile=PROFILE))["messages"] if m.get("display_kind") != "hidden"]
            index = next((i for i, m in enumerate(rows) if m.get("text") == "PROBE native client during compaction"), None)
            return index is not None and any(m.get("role") == "assistant" for m in rows[index + 1:])
        deadline = time.monotonic() + 30
        while not await answered():
            assert time.monotonic() < deadline, "Input another client queued in Hermes must not wait for the held compaction"
            await asyncio.sleep(0.1)
        assert GATE.exists()
        evidence["checks"]["native_client_message"] = {"native_status": queued.get("status"), "answered_seconds": round(time.monotonic() - started, 3)}
        await settled(c, PROFILE)

        count = await compaction_started(count, delay)
        job = await c.call("cron.manage", profile=PROFILE, action="add", name="[bot:default] Synthetic routine during compaction",
                           prompt="Public synthetic routine result", schedule="1h", deliver="bot-chat:" + PROFILE, continuity=True)
        job_id = (job.get("job") or job).get("job_id") or (job.get("job") or job).get("id")
        try:
            started = time.monotonic()
            trigger = urllib.request.Request(os.environ["HERMES_SPIKE_URL"] + f"/api/cron/jobs/{job_id}/trigger?profile={PROFILE}", method="POST",
                                             headers={"X-Hermes-Session-Token": os.environ["HERMES_SPIKE_TOKEN"]})
            await asyncio.to_thread(lambda: urllib.request.urlopen(trigger, timeout=120).read())
            async def delivered():
                rows = (await c.call("agent-interface.open", profile=PROFILE))["messages"]
                return any("Public synthetic routine delivery proof" in (m.get("text") or "") for m in rows)
            deadline = time.monotonic() + 60
            while not await delivered():
                assert time.monotonic() < deadline, "The routine delivery must not wait for the held compaction"
                await asyncio.sleep(0.25)
            assert GATE.exists()
            evidence["checks"]["routine_delivery"] = {"delivered_seconds": round(time.monotonic() - started, 3), "compaction_still_held": True}
        finally:
            await c.call("cron.manage", profile=PROFILE, action="remove", name=job_id)
        await settled(c, PROFILE)

        count = await compaction_started(count, delay)
        before = visible(await c.call("agent-interface.open", profile=PROFILE))
        GATE.unlink()
        # The held summary returns; Hermes commits in place and releases the session.
        await asyncio.sleep(2)
        await settled(c, PROFILE)
    finally:
        GATE.unlink(missing_ok=True)
    after = visible(await c.call("agent-interface.open", profile=PROFILE))
    changed = [(index, b, a) for index, (b, a) in enumerate(zip(before, after)) if b != a]
    assert after == before, f"In-place compaction changed the app's view: {len(before)} -> {len(after)} rows, first changes {[(i, b[:2], str(b[2])[:40], a[:2], str(a[2])[:40]) for i, b, a in changed[:6]]}"
    # Compaction stored every kept row again under a new ID: the memo projects them anew and matches the whole projection.
    evidence["checks"]["projection_memo_after_compaction"] = await projection_matches(c, PROFILE)
    window = await c.call("agent-interface.open", profile=PROFILE, window={"start": anchor, "turns": 1})
    assert any(m.get("app_request_id") == anchor for m in window["messages"]), "Talk's anchored read must still find its request"
    receipt, _, _ = await send(c, sid, f"after-{time.time_ns()}", "PROBE after compaction")
    assert receipt["status"] == "accepted", receipt
    turn = next(r for r in reversed(requests()) if not is_summary(r) and "PROBE after compaction" in model_text(r))
    # Hermes keeps the first turns and the latest ones verbatim; the middle is summarized.
    assert "Synthetic compaction summary" in model_text(turn) and "Synthetic history turn 5:" not in model_text(turn), "The next turn must read the compacted transcript"
    evidence["checks"]["committed"] = {"app_view_unchanged": True, "anchored_read": True, "model_sees_summary": True,
                                       "model_messages_after": len(turn["messages"])}
    total = summaries()
    await asyncio.sleep(delay * 3 + 5)
    assert summaries() == total, "A compacted transcript within budget must not compact again"
    evidence["checks"]["no_repeat"] = {"waited_seconds": delay * 3 + 5}
    # Hermes announces a compaction with status.update frames ("compressing", "compacting"). No
    # turn here grew large enough to compact itself, so every such frame came from the background.
    leaked = [f for f in c.frames if (f.get("params") or {}).get("type") == "status.update"
              and ((f.get("params") or {}).get("payload") or {}).get("kind") in ("compressing", "compacting")]
    assert not leaked, f"A background compaction's progress reached the app: {leaked[:2]}"
    evidence["checks"]["progress_private"] = {"compaction_status_frames": 0, "frames_seen": len(c.frames)}
    destination = Path(os.environ.get("HERMES_SPIKE_EVIDENCE_DIR", "docs/evidence")) / "hermes-compaction-probe.json"
    destination.write_text(json.dumps(evidence, indent=2) + "\n")
    await c.close()
    print("Idle compaction yielded to every input, committed without changing the app's view, and did not repeat")


if __name__ == "__main__":
    asyncio.run(main())
