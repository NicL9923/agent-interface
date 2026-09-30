"""Persistent gate behavior with native lifecycle fixtures, no live gateway."""
import asyncio
import importlib.util
import json
from pathlib import Path
import tempfile
import types
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("gateway_guard", ROOT / "src/hermes/gateway_guard.py")
guard = importlib.util.module_from_spec(spec); spec.loader.exec_module(guard)


class GatewayGuardTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "maintenance.json"
        class Startup:
            async def start(self): return self._external_drain_active
            def _serving_state(self): return "running"
            async def _run_startup_resume_event(self): return "native resume"
        class Runner(Startup):
            def _init_lifecycle_state(self): self._external_drain_active = False
        class Inbound:
            async def _handle_message(self, event):
                self.original_calls += 1
                if getattr(event, "pause", None):
                    event.entered.set()
                    await event.pause.wait()
                if getattr(event, "fail", False): raise RuntimeError("Native failure")
                return "native response"
        self.inbound = types.SimpleNamespace(GatewayInboundMixin=Inbound, t=lambda key: "Native maintenance notice")
        self.ingress = Inbound(); self.ingress.original_calls = 0
        self.runner = Runner
        self.native_drain = False
        self.drain = types.SimpleNamespace(drain_requested=lambda **_: self.native_drain)
        self.gateway = types.SimpleNamespace(GatewayStartupMixin=Startup)
        self.status = types.SimpleNamespace(_get_code_identity_fields=lambda: {"code_sha": "exact-native-revision"})
        guard.install(self.drain, self.gateway, self.status, self.path, self.inbound)
    def tearDown(self): self.temp.cleanup()

    def test_persistent_lease_blocks_boot_and_expired_native_marker(self):
        self.path.write_text(json.dumps({"operationId": "installer-operation"}))
        self.assertTrue(self.drain.drain_requested())
        runner = self.runner(); runner._init_lifecycle_state()
        self.assertTrue(asyncio.run(runner.start()))
        self.assertTrue(runner._external_drain_active)
        self.assertEqual(runner._serving_state(), "draining")
        self.assertEqual(self.status._get_code_identity_fields(), {"code_sha": "exact-native-revision", "agent_interface_gateway_guard": {"schemaVersion": 1, "maintenanceFile": str(self.path), "pendingIngress": 0}})
        command = guard.native_command(self.path.parent, "/native/store/python", ["--verbose"])
        self.assertEqual(command[:3], ["/native/store/python", "-I", "-c"])
        self.assertEqual(command[4:], ["--verbose"])
        self.assertTrue(command[3].endswith(f"runpy.run_path({str(self.path.parent.resolve() / 'gateway/run.py')!r}, run_name='__main__')"))

    def test_release_restores_native_gate_and_native_drain_is_still_respected(self):
        self.assertFalse(self.drain.drain_requested())
        self.native_drain = True
        self.assertTrue(self.drain.drain_requested())
        self.native_drain = False
        runner = self.runner(); runner._init_lifecycle_state()
        self.assertFalse(asyncio.run(runner.start()))
        self.assertFalse(runner._external_drain_active)
        self.assertEqual(runner._serving_state(), "running")

    def test_bad_lease_and_broken_symlink_fail_closed(self):
        self.path.write_text("invalid JSON")
        self.assertTrue(self.drain.drain_requested())
        self.path.unlink(); self.path.symlink_to(self.path.parent / "missing")
        self.assertTrue(self.drain.drain_requested())

    def test_pending_resume_waits_for_release_without_replaying_or_losing_native_call(self):
        async def scenario():
            self.path.write_text("held")
            runner = self.runner()
            task = asyncio.create_task(runner._run_startup_resume_event())
            await asyncio.sleep(.01)
            self.assertFalse(task.done())
            self.path.unlink()
            self.assertEqual(await task, "native resume")
        asyncio.run(scenario())

    def test_unknown_native_seam_is_rejected_before_modifying_drain(self):
        drain = types.SimpleNamespace(drain_requested=lambda: False)
        with self.assertRaises(RuntimeError): guard.install(drain, types.SimpleNamespace(GatewayStartupMixin=object), self.status, self.path, self.inbound)
        self.assertFalse(drain.drain_requested())

    def test_ingress_fences_commands_and_internal_events_and_counts_preflight_until_settled(self):
        async def scenario():
            entered, pause = asyncio.Event(), asyncio.Event()
            task = asyncio.create_task(self.ingress._handle_message(types.SimpleNamespace(entered=entered, pause=pause)))
            await entered.wait()
            self.assertEqual(self.status._get_code_identity_fields()["agent_interface_gateway_guard"]["pendingIngress"], 1)
            self.path.write_text("held")
            self.assertEqual(await self.ingress._handle_message(types.SimpleNamespace(command="/reset")), "Native maintenance notice")
            self.assertIsNone(await self.ingress._handle_message(types.SimpleNamespace(internal=True)))
            self.assertEqual(self.ingress.original_calls, 1)
            pause.set(); self.assertEqual(await task, "native response")
            self.assertEqual(self.status._get_code_identity_fields()["agent_interface_gateway_guard"]["pendingIngress"], 0)
            self.path.unlink()
            with self.assertRaises(RuntimeError): await self.ingress._handle_message(types.SimpleNamespace(fail=True))
            self.assertEqual(self.status._get_code_identity_fields()["agent_interface_gateway_guard"]["pendingIngress"], 0)
        asyncio.run(scenario())


if __name__ == "__main__": unittest.main()
