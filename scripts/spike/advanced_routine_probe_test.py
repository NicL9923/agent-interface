"""Small tests for false-positive prevention in the native proof's wire evidence."""
import copy
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import advanced_routine_probe as probe
from provider import Provider


class WireEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.tools = {"skills_list", "skill_view", "skill_manage"}
        self.row = dict(model=probe.MODEL,
            messages=[dict(role="user", content="downstream loaded-skill latest-output script-output")],
            tools=[dict(type="function", function=dict(name=name)) for name in self.tools])
        self.expected = dict(prompt="downstream", skill="loaded-skill", latest="latest-output", stale="stale-output",
            script="script-output", expected_tools=self.tools)

    def test_execution_request_requires_exact_pin_tools_and_latest_context(self):
        self.assertEqual(probe.assert_wire(self.row, **self.expected), sorted(self.tools))
        for change in (
            dict(model="inherited-model"),
            dict(tools=self.row["tools"] + [dict(function=dict(name="terminal"))]),
            dict(tools=self.row["tools"] + self.row["tools"][:1]),
            dict(tools=self.row["tools"][:1]),
            dict(messages=[dict(role="user", content="downstream loaded-skill latest-output stale-output script-output")]),
            dict(messages=[dict(role="user", content="downstream latest-output script-output")]),
        ):
            with self.subTest(change=change), self.assertRaises(AssertionError):
                probe.assert_wire({**self.row, **change}, **self.expected)

    def test_assistant_claim_or_system_catalog_is_not_execution_context_proof(self):
        row = copy.deepcopy(self.row)
        row["messages"][0]["role"] = "assistant"
        with self.assertRaises(AssertionError):
            probe.assert_wire(row, **self.expected)
        row["messages"][0]["role"] = "system"
        row["messages"].append(dict(role="user", content="downstream"))
        with self.assertRaises(AssertionError):
            probe.assert_wire(row, **self.expected)

    def test_provider_log_ignores_partial_append_but_rejects_corrupt_complete_record(self):
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / "provider.jsonl"
            self.assertEqual(probe.requests(log), [])
            log.write_text(json.dumps(self.row) + '\n{"unfinished":')
            self.assertEqual(probe.requests(log), [self.row])
            log.write_text(json.dumps(self.row) + '\n{"corrupt":\n')
            with self.assertRaises(json.JSONDecodeError):
                probe.requests(log)

    def test_real_fixture_handler_logs_model_and_tool_schemas_for_json_and_stream(self):
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / "provider.jsonl"
            for stream in (False, True):
                request = {**self.row, "stream": stream}
                raw = json.dumps(request).encode()
                handler = Provider.__new__(Provider)
                handler.headers = {"Content-Length": str(len(raw))}
                handler.rfile, handler.wfile = io.BytesIO(raw), io.BytesIO()
                with patch.object(handler, "send_response"), patch.object(handler, "send_header"), \
                        patch.object(handler, "end_headers"), patch.dict(os.environ, {"HERMES_SPIKE_PROVIDER_LOG": str(log)}):
                    handler.do_POST()
                response = handler.wfile.getvalue().decode()
                if stream:
                    chunks = [json.loads(line.removeprefix("data: ")) for line in response.splitlines() if line.startswith("data: {")]
                    self.assertTrue(chunks)
                    self.assertTrue(all(chunk["model"] == probe.MODEL for chunk in chunks))
                else:
                    self.assertEqual(json.loads(response)["model"], probe.MODEL)
            records = probe.requests(log)
            self.assertEqual(len(records), 2)
            for row in records:
                self.assertEqual(row["model"], probe.MODEL)
                self.assertEqual(row["tools"], self.row["tools"])
                self.assertEqual(row["messages"], self.row["messages"])


if __name__ == "__main__":
    unittest.main()
