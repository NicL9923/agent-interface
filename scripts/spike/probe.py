"""Native Hermes gateway probe, with an explicitly deterministic provider fixture.

Usage: HERMES_SPIKE_URL=http://127.0.0.1:19119 python scripts/spike/probe.py
Only an isolated HERMES_HOME may be used. Output excludes transport credentials.
"""
import asyncio
import base64
import json
import os
import re
import urllib.request
from pathlib import Path
import websockets
from guard import verify_target, verify_url


async def main():
    home = Path(os.environ.get("HERMES_HOME", ""))
    if not home.is_absolute() or not (home / ".agent-interface-isolated").is_file() or (home / ".agent-interface-isolated").read_text() != "agent-interface-disposable-spike":
        raise SystemExit("Mutation probe requires the launcher's disposable HERMES_HOME marker.")
    url = os.environ.get("HERMES_SPIKE_URL", "http://127.0.0.1:19119")
    if not url.startswith("http://127.0.0.1:"):
        raise SystemExit("Only the isolated loopback spike URL is allowed.")
    verify_url(url)
    token = os.environ.get("HERMES_SPIKE_TOKEN")
    if not token:
        html = urllib.request.urlopen(url).read().decode()
        token = re.search(r'__HERMES_SESSION_TOKEN__="([^"]+)"', html).group(1)
    verify_target(home, url, token)
    frames = []
    result = {"provider": "deterministic local wire fixture; no real model or image backend", "source_revision": os.environ.get("HERMES_SPIKE_REVISION", "b9cb268deffc97946ec11645aa622a7353dd0591"), "checks": {}}
    async with websockets.connect(url.replace("http", "ws", 1) + "/api/ws?token=" + token) as ws:
        counter = 0
        async def call(method, **params):
            nonlocal counter
            counter += 1
            rid = counter
            await ws.send(json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params}))
            while True:
                item = json.loads(await asyncio.wait_for(ws.recv(), 90))
                frames.append(item)
                if item.get("id") == rid:
                    if "error" in item:
                        raise RuntimeError(method + ": " + json.dumps(item["error"]))
                    return item.get("result", {})
        await call("client.capabilities", server_requests=True)
        result["checks"]["gateway"] = await call("gateway.capabilities")
        roster = await call("profiles.list", include_sessions=True)
        if not any(x["name"] == "spike" for x in roster["profiles"]):
            await call("profiles.create", name="spike", no_skills=True, no_alias=True, mirror_credentials=True, description="Public synthetic integration probe")
        result["checks"]["configure"] = await call("profiles.configure", name="spike", description="Integration proof", soul="Answer concise public synthetic questions.", model="spike-model", provider="spike-fixture", ui_meta={"hermes-bots": {"title": "Spike Bot"}, "agent_interface": {"shared": True}}, enabled_toolsets=["terminal", "file", "clarify"])
        assert result["checks"]["configure"]["ok"], "Native profile configuration did not fully apply"
        result["checks"]["describe"] = await call("profiles.describe", name="spike")
        result["checks"]["skills"] = await call("skills.manage", profile="spike", action="list")
        result["checks"]["routines"] = await call("cron.manage", profile="spike", action="list")
        existing = (await call("profiles.list", include_sessions=True))["profiles"]
        canonical = next(x for x in existing if x["name"] == "spike").get("canonical_session")
        if canonical:
            created = await call("session.resume", profile="spike", session_id=canonical["resolved_id"], close_on_disconnect=False)
            created["stored_session_id"] = canonical["resolved_id"]
        else:
            created = await call("session.create", profile="spike", title="Bot Chat", hidden=True, follow_profile_config=True, close_on_disconnect=False)
            await call("session.title", profile="spike", session_id=created["session_id"], title="Bot Chat")
        sid = created["session_id"]
        stored = created["stored_session_id"]
        result["checks"]["created"] = created
        result["checks"]["tools"] = await call("tools.list", session_id=sid)
        result["checks"]["text_attachment"] = await call("file.attach", session_id=sid, profile="spike", name="proof.txt", data_url="data:text/plain;base64," + base64.b64encode(b"public synthetic text proof").decode())
        # A valid one-page text PDF is produced without dependency on a PDF library.
        objects = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>", b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 4 0 R >>", b"<< /Length 0 >>\nstream\n\nendstream"]
        pdf = b"%PDF-1.4\n"
        offsets = [0]
        for n, obj in enumerate(objects, 1):
            offsets.append(len(pdf)); pdf += str(n).encode() + b" 0 obj\n" + obj + b"\nendobj\n"
        xref = len(pdf)
        pdf += b"xref\n0 5\n0000000000 65535 f \n" + b"".join(f"{n:010d} 00000 n \n".encode() for n in offsets[1:]) + f"trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF".encode()
        result["checks"]["pdf_attachment"] = await call("file.attach", session_id=sid, profile="spike", name="proof.pdf", data_url="data:application/pdf;base64," + base64.b64encode(pdf).decode())
        result["checks"]["submission"] = await call("prompt.submit", session_id=sid, profile="spike", text="PROBE_TOOL")
        for _ in range(80):
            item = json.loads(await asyncio.wait_for(ws.recv(), 90)); frames.append(item)
            if item.get("params", {}).get("type") in ("message.complete", "error"):
                break
        result["checks"]["history"] = await call("session.history", session_id=sid, profile="spike")
        result["checks"]["canonical"] = await call("profiles.list", include_sessions=True)
        result["checks"]["replay"] = await call("session.events.since", session_id=sid, profile="spike", last_seen=0)
        await call("prompt.submit", session_id=sid, profile="spike", text="PROBE_SLOW")
        result["checks"]["steer"] = await call("session.steer", session_id=sid, profile="spike", text="Public steering proof")
    # Every client disappears while native Hermes is still working.
    await asyncio.sleep(4)
    async with websockets.connect(url.replace("http", "ws", 1) + "/api/ws?token=" + token) as ws2:
        await ws2.send(json.dumps({"jsonrpc": "2.0", "id": 999, "method": "session.resume", "params": {"session_id": stored, "profile": "spike", "close_on_disconnect": False}}))
        while True:
            frame = json.loads(await asyncio.wait_for(ws2.recv(), 90)); frames.append(frame)
            if frame.get("id") == 999:
                result["checks"]["reconnect"] = frame; break
    result["event_types"] = sorted({f.get("params", {}).get("type", "") for f in frames if f.get("method") == "event"})
    data = json.dumps(result, indent=2).replace(str(home), "<isolated-home>").replace(str(home.parent), "<isolated-root>")
    data = re.sub(r'/Users/[^/"\\\s]+', '<machine-home>', data)
    data = re.sub(r'/private/tmp/agent-interface[^/"\\\s]*', '<isolated-temp>', data)
    destination = Path(os.environ.get("HERMES_SPIKE_EVIDENCE_DIR", "docs/evidence")) / "hermes-native-probe.json"
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(data + "\n")
    print(json.dumps({"evidence": str(destination), "event_types": result["event_types"], "checks": list(result["checks"])}))


if __name__ == "__main__":
    asyncio.run(main())
