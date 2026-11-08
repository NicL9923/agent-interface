"""Advanced routine proof using native HTTP, scheduler, scripts and provider requests.

The launcher owns the disposable executor and serial admission. Script-only
execution uses the official scheduler provider and DeliveryRouter with a local
recording transport. Bot Chat is a separate inbound model turn in native Hermes,
so it cannot prove zero provider calls across execution AND delivery.
No scheduler/agent/skill/delivery function is replaced by this probe.
"""
import asyncio
import json
import os
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

from guard import verify_target

PROFILE = "spike"
MODEL = "spike-routine-model"
PROVIDER = "spike-fixture"
FIELDS = ("skills", "model", "provider", "enabled_toolsets", "context_from", "script", "no_agent")


def http(method, suffix="", payload=None, *, profile=PROFILE, expected=200):
    query = urllib.parse.urlencode({"profile": profile})
    request = urllib.request.Request(
        os.environ["HERMES_SPIKE_URL"] + "/api/cron/jobs" + suffix + "?" + query,
        method=method,
        headers={"X-Hermes-Session-Token": os.environ["HERMES_SPIKE_TOKEN"], "Content-Type": "application/json"},
        data=json.dumps(payload).encode() if payload is not None else None,
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            status, result = response.status, json.load(response)
    except urllib.error.HTTPError as error:
        status, result = error.code, json.load(error)
    assert status == expected, (method, suffix, status, result)
    return result


def requests(path):
    """Ignore only an unfinished append. Malformed complete records must fail."""
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines(keepends=True) if line.endswith("\n")]


def user_text(row):
    return "\n".join(str(message.get("content", "")) for message in row.get("messages", []) if message.get("role") == "user")


def assert_wire(row, *, prompt, skill, latest, stale, script, expected_tools):
    """Check the execution request, not a chat summary claiming it saw context."""
    text = user_text(row)
    assert prompt in text and skill in text and latest in text and script in text, text
    assert stale not in text, "Downstream request included stale upstream output"
    assert row["model"] == MODEL, row.get("model")
    tools = [tool["function"]["name"] for tool in row["tools"]]
    assert set(tools) == set(expected_tools) and len(tools) == len(set(tools)), tools
    return sorted(tools)


async def main():
    from extension_probe import Client, settled

    home = Path(os.environ["HERMES_HOME"])
    verify_target(home, os.environ["HERMES_SPIKE_URL"], os.environ["HERMES_SPIKE_TOKEN"])
    revision = os.environ["HERMES_SPIKE_REVISION"]
    log = Path(os.environ["HERMES_SPIKE_PROVIDER_LOG"])
    assert log.is_absolute() and log.parent.resolve() == home.parent.resolve(), "Use the launcher's private provider log"
    client = await Client().connect()
    created = []
    files = []
    directories = []
    checks = {}
    try:
        caps = await client.call("agent-interface.capabilities")
        assert caps["revision"] == revision, caps
        await settled(client)
        # Resolve THIS profile using the native scope, then create actual loadable
        # files. The original probe deliberately created spike with no bundled skills.
        from hermes_cli.web_server_profiles import _profile_scope
        from hermes_cli.config import load_config
        from hermes_cli.runtime_provider import resolve_runtime_provider
        from tools.skills_tool import skill_view
        from toolsets import resolve_toolset
        from cron import jobs
        from cron.scheduler_provider import resolve_cron_scheduler
        from gateway.config import Platform, load_gateway_config
        from gateway.platforms.base import SendResult

        with _profile_scope(PROFILE) as scoped:
            profile_home = Path(scoped).resolve()
            assert profile_home.is_relative_to(home.resolve()), profile_home
            config = load_config()
            configured = config.get("providers", {}).get(PROVIDER, {})
            assert MODEL in configured.get("models", []), "The launcher must configure the explicit fixture model"
            runtime = resolve_runtime_provider(requested=PROVIDER, target_model=MODEL)
            assert runtime["base_url"].rstrip("/") == f"http://127.0.0.1:{int(os.environ['HERMES_SPIKE_PROVIDER_PORT'])}/v1", runtime.get("base_url")
            expected_tools = set(resolve_toolset("skills"))
            # This pinned source's essential skill schemas are all three tools.
            # Do not accept an arbitrary subset, all profile tools, or a hidden bridge.
            assert expected_tools == {"skills_list", "skill_view", "skill_manage"}, expected_tools
            gateway_config = load_gateway_config()
            transport_config = gateway_config.platforms.get(Platform.DISCORD)
            assert transport_config is None or transport_config.enabled, "A disabled transport would cause a standalone fallback"

        unique = uuid.uuid4().hex
        skill_name = "advanced-routine-proof-" + unique
        skill_marker = "ADVANCED_LOADED_SKILL_" + unique
        output_marker = "ADVANCED_STDOUT_" + unique
        agent_script_marker = "ADVANCED_AGENT_SCRIPT_" + unique
        prompt_marker = "ADVANCED_DOWNSTREAM_" + unique
        skill_dir = profile_home / "skills" / skill_name
        scripts_dir = profile_home / "scripts" / skill_name
        skill_dir.mkdir(parents=True)
        scripts_dir.mkdir(parents=True)
        directories.extend([skill_dir, scripts_dir])
        skill_file = skill_dir / "SKILL.md"
        skill_file.write_text(f"---\nname: {skill_name}\ndescription: Public synthetic routine proof\n---\n\n{skill_marker}\nRead the provided routine context. No tools are needed.\n")
        counter = scripts_dir / "source.count"
        source_script = scripts_dir / "source.py"
        source_script.write_text(
            "from pathlib import Path\np = Path(__file__).with_suffix('.count')\n"
            "n = int(p.read_text()) + 1 if p.exists() else 1\np.write_text(str(n))\n"
            f"print({output_marker!r} + '_' + str(n))\n")
        agent_script = scripts_dir / "context.py"
        agent_script.write_text(f"print({agent_script_marker!r})\n")
        files.extend([skill_file, source_script, counter, agent_script])
        with _profile_scope(PROFILE):
            loaded = json.loads(skill_view(skill_name, preprocess=False))
            assert loaded.get("success") and skill_marker in loaded.get("content", ""), loaded
            assert loaded.get("readiness_status") != "setup_needed" and not loaded.get("setup_needed"), loaded
        checks["actual_profile_skill_loadable"] = True

        source_path = str(source_script.relative_to(profile_home / "scripts"))
        context_path = str(agent_script.relative_to(profile_home / "scripts"))
        source_payload = dict(name="Advanced script-only " + unique, prompt="", schedule="1h", paused=True,
            skills=[skill_name], model=MODEL, provider=PROVIDER, enabled_toolsets=["skills"],
            context_from=["self"], script=source_path, no_agent=True,
            deliver="discord:advanced-routine-fixture")
        source = await asyncio.to_thread(http, "POST", payload=source_payload)
        source_id = source["id"]
        created.append((PROFILE, source_id))
        source = await asyncio.to_thread(http, "GET", "/" + source_id)
        assert {key: source[key] for key in FIELDS} == {key: source_payload[key] for key in FIELDS}, source
        checks["native_http_advanced_create_and_read"] = True

        # Native PUT merges only provided fields. Check an unseen native setting too.
        updated = dict(skills=[skill_name], model=MODEL, provider=PROVIDER,
            enabled_toolsets=["skills", "file"], context_from=["self"], script=source_path, no_agent=False,
            reasoning_effort="high")
        await asyncio.to_thread(http, "PUT", "/" + source_id, {"updates": updated})
        source = await asyncio.to_thread(http, "GET", "/" + source_id)
        assert all(source[key] == value for key, value in updated.items()), source
        before = {key: source[key] for key in (*FIELDS, "reasoning_effort", "deliver")}
        await asyncio.to_thread(http, "PUT", "/" + source_id, {"updates": {"name": "Renamed advanced routine " + unique}})
        source = await asyncio.to_thread(http, "GET", "/" + source_id)
        assert {key: source[key] for key in before} == before, source
        listed = await asyncio.to_thread(http, "GET")
        assert next(row for row in listed if row["id"] == source_id)["reasoning_effort"] == "high", listed
        await asyncio.to_thread(http, "PUT", "/" + source_id, {"updates": {"no_agent": True}})
        checks["native_http_advanced_update_and_basic_edit_preservation"] = True

        class RecordingAdapter:
            """Only the outbound transport is synthetic; native routing calls send."""
            splits_long_messages = False

            def __init__(self):
                self.sent = []

            async def send(self, chat_id, content, reply_to=None, metadata=None):
                self.sent.append(dict(chat_id=chat_id, content=content, metadata=metadata, reply_to=reply_to))
                return SendResult(success=True, message_id="advanced-proof-" + str(len(self.sent)), raw_response={"fixture": True})

        adapter = RecordingAdapter()
        loop = asyncio.get_running_loop()

        def fire_source():
            with _profile_scope(PROFILE), jobs.use_cron_store(profile_home):
                provider = resolve_cron_scheduler()
                assert provider.name == "builtin", provider.name
                # Real claim, execution ledger, Python subprocess, output archive,
                # delivery router and mark_job_run. No run_job/send monkeypatches.
                assert provider.fire_due(source_id, adapters={Platform.DISCORD: adapter}, loop=loop, force=True)
                return jobs.get_job(source_id)

        baseline = len(requests(log))
        for run in (1, 2):
            if run == 2:
                # Native archive names have one-second precision. Keep BOTH runs
                # so the context check proves latest-output selection.
                await asyncio.sleep(1.1)
            result = await asyncio.to_thread(fire_source)
            assert result["last_status"] == "ok" and not result.get("last_error") and not result.get("last_delivery_error"), result
            assert int(counter.read_text()) == run, "The profile's Python script did not execute"
            assert len(adapter.sent) == run, adapter.sent
            sent = adapter.sent[-1]
            assert sent["chat_id"] == "advanced-routine-fixture" and f"{output_marker}_{run}" in sent["content"], sent
            assert sent["metadata"]["job_id"] == source_id, sent
            assert len(requests(log)) == baseline, "Script-only execution or delivery called a provider"
        checks["native_script_only_python_execution"] = True
        checks["native_script_stdout_delivery_callback"] = True
        checks["script_execution_and_delivery_zero_provider_requests"] = True
        script_provider_calls = len(requests(log)) - baseline
        with _profile_scope(PROFILE), jobs.use_cron_store(profile_home):
            archives = sorted((jobs.get_cron_output_dir() / source_id).glob("*.md"))
            assert len(archives) == 2, archives
            assert f"{output_marker}_1" in archives[0].read_text() and f"{output_marker}_2" in archives[-1].read_text(), archives

        downstream_payload = dict(name="Advanced downstream " + unique, prompt=prompt_marker, schedule="1h", paused=True,
            skills=[skill_name], model=MODEL, provider=PROVIDER, enabled_toolsets=["skills"],
            context_from=["self", source_id], script=context_path, no_agent=False, deliver="local")
        downstream = await asyncio.to_thread(http, "POST", payload=downstream_payload)
        downstream_id = downstream["id"]
        created.append((PROFILE, downstream_id))
        # Record the dashboard's [] -> null behavior rather than assuming the
        # core scheduler's zero-tool semantics survive this HTTP normalizer.
        await asyncio.to_thread(http, "PUT", "/" + downstream_id, {"updates": {"enabled_toolsets": []}})
        empty_tools = await asyncio.to_thread(http, "GET", "/" + downstream_id)
        assert empty_tools["enabled_toolsets"] is None, empty_tools
        await asyncio.to_thread(http, "PUT", "/" + downstream_id, {"updates": {"enabled_toolsets": ["skills"]}})
        checks["native_dashboard_empty_toolsets_normalizes_to_null"] = True
        wire_start = len(requests(log))
        await asyncio.to_thread(http, "POST", "/" + downstream_id + "/trigger")
        downstream = await asyncio.to_thread(http, "GET", "/" + downstream_id)
        assert downstream["last_status"] == "ok" and not downstream.get("last_error"), downstream
        wires = [row for row in requests(log)[wire_start:] if prompt_marker in user_text(row)]
        assert wires, "HTTP-triggered native scheduler never sent the downstream execution prompt to the fixture provider"
        for row in wires:
            tools = assert_wire(row, prompt=prompt_marker, skill=skill_marker,
                latest=f"{output_marker}_2", stale=f"{output_marker}_1", script=agent_script_marker, expected_tools=expected_tools)
        assert int(counter.read_text()) == 2, "Context references unexpectedly executed the source job"
        checks["native_http_triggered_model_pin_and_exact_tool_schemas"] = True
        checks["native_skill_and_agent_script_in_execution_request"] = True
        checks["native_context_from_latest_upstream_output"] = True
        checks["context_from_does_not_schedule_source"] = True

        # Validate the actual native HTTP ingress, including merged-mode checks.
        await asyncio.to_thread(http, "PUT", "/" + source_id, {"updates": {"script": None}}, expected=400)
        await asyncio.to_thread(http, "POST", payload={**downstream_payload, "script": "../escape.py"}, expected=400)
        await asyncio.to_thread(http, "POST", payload={**downstream_payload, "script": "print('not a script path')"}, expected=400)
        await asyncio.to_thread(http, "POST", payload={**downstream_payload, "context_from": ["missing-job"]}, expected=400)
        foreign = await asyncio.to_thread(http, "POST", payload=dict(name="Foreign context fixture", prompt="Public synthetic fixture", schedule="1h", paused=True, deliver="local"), profile="default")
        created.append(("default", foreign["id"]))
        await asyncio.to_thread(http, "PUT", "/" + downstream_id, {"updates": {"context_from": [foreign["id"]]}}, expected=400)
        checks["native_script_sandbox_and_mode_validation"] = True
        checks["native_same_profile_context_validation"] = True
        evidence = dict(revision=revision, checks=checks, selectedModel=MODEL, selectedProvider=PROVIDER,
            executionToolSchemas=tools, scriptOnlyProviderRequests=script_provider_calls,
            sourceRuns=int(counter.read_text()), sourceArchiveCount=len(archives), downstreamProviderRequests=len(wires),
            observedModels=sorted({row["model"] for row in wires}), advancedNativeFields=list(FIELDS),
            scriptDeliveryCallbacks=len(adapter.sent), scriptDeliveryJobIds=[row["metadata"]["job_id"] for row in adapter.sent],
            scriptDelivery="Official scheduler provider and native DeliveryRouter to a deterministic adapter callback returning native SendResult. No real Discord connection.",
            contextContract="Reads latest stored source output. The probe fires the source explicitly; context_from does not schedule dependencies.",
            botChatContract="Native Bot Chat delivery starts a separate model turn. This zero-provider proof uses a non-agent transport callback.")
        destination = Path(os.environ["HERMES_SPIKE_EVIDENCE_DIR"]) / "hermes-advanced-routine-probe.json"
        destination.write_text(json.dumps(evidence, indent=2) + "\n")
        print("Advanced native HTTP routine fields, Python stdout delivery without provider calls, and latest-output context injection passed")
    finally:
        try:
            for profile, job_id in reversed(created):
                await asyncio.to_thread(http, "DELETE", "/" + job_id, profile=profile)
        finally:
            await client.close()
            for path in files:
                path.unlink(missing_ok=True)
            # Native skill parsing/scripts can add cache files. Keep any nonempty
            # directory in this disposable home instead of deleting unseen files.
            for path in directories:
                try:
                    path.rmdir()
                except OSError:
                    pass


if __name__ == "__main__":
    asyncio.run(main())
