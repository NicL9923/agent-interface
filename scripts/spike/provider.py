"""Deterministic local OpenAI wire fixture. It is not a real model quality test."""
import json
import time
import os
import re
import shlex
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Provider(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"data": [{"id": "spike-model", "object": "model"}]}).encode())

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if os.environ.get("HERMES_SPIKE_PROVIDER_LOG"):
            with open(os.environ["HERMES_SPIKE_PROVIDER_LOG"], "a") as log:
                log.write(json.dumps({"at": time.time(), "messages": body.get("messages", [])}) + "\n")
        messages = body.get("messages", [])
        user = next((str(x.get("content", "")) for x in reversed(messages) if x["role"] == "user"), "")
        tools = body.get("tools", [])
        tool_names = {x.get("function", {}).get("name") for x in tools}
        after_tool = bool(messages and messages[-1]["role"] == "tool")
        if ("PROBE_TOOL" in user or "PROBE_SLOW_TOOL" in user or "PROBE_APPROVAL" in user or "PROBE_FILE" in user or "PROBE_READ" in user) and not after_tool and "terminal" in tool_names:
            command = "rm -rf ./approval-probe-does-not-exist" if "PROBE_APPROVAL" in user else "printf synthetic-file-proof > generated-proof.txt; printf 'MEDIA:%s/generated-proof.txt' \"$PWD\"" if "PROBE_FILE" in user else "sleep 2; printf hermes-real-tool-proof" if "PROBE_SLOW_TOOL" in user else "printf hermes-real-tool-proof"
            if "PROBE_READ" in user:
                match = re.search(r'@file:(?:"([^"\n]+)"|([^\s<>]+))', user)
                command = "cat " + shlex.quote(match.group(1) or match.group(2)) if match else "printf missing-attachment-reference"
            message = {"role": "assistant", "content": None, "tool_calls": [{"id": "probe-tool", "type": "function", "function": {"name": "terminal", "arguments": json.dumps({"command": command, "timeout": 10})}}]}
        elif "PROBE_CLARIFY" in user and not after_tool and "clarify" in tool_names:
            message = {"role": "assistant", "content": None, "tool_calls": [{"id": "probe-clarify", "type": "function", "function": {"name": "clarify", "arguments": json.dumps({"questions": [{"qid": "spike-question", "question": "Which synthetic option?", "choices": ["First", "Second"]}]})}}]}
        elif "markdown formatting example" in user.lower():
            message = {"role": "assistant", "content": "## A quieter start to the day\n\nPick **one thing that matters** before opening the rest of your to-do list.\n\n- [x] Make coffee and take a breath\n- [ ] Choose today's priority\n- [ ] Leave room for a walk outside\n\n### A small plan\n\n| Time | Focus |\n| --- | --- |\n| Morning | One uninterrupted work session |\n| Lunch | Step away from the screen |\n| Evening | Family time, then tomorrow's shortlist |\n\nIf you're scripting a reminder, start small:\n\n```python\npriorities = [\"Build something useful\", \"Get outside\"]\nfor priority in priorities:\n    print(priority)\n```\n\nThis is a synthetic formatting example from the local test provider."}
        else:
            if "PROBE_SLOW" in user:
                time.sleep(3)
            message = {"role": "assistant", "content": "Public synthetic routine delivery proof" if any("Public synthetic routine result" in str(x.get("content", "")) or "Public synthetic routine delivery proof" in str(x.get("content", "")) for x in messages) else "Isolated Hermes answer. " + ("Tool completed." if after_tool else "Ready.")}
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream" if body.get("stream") else "application/json")
        self.end_headers()
        if body.get("stream"):
            delta = dict(message)
            if "tool_calls" in delta:
                delta["tool_calls"][0]["index"] = 0
            for piece in [delta, {}]:
                self.wfile.write(("data: " + json.dumps({"id": "spike", "object": "chat.completion.chunk", "created": 1, "model": "spike-model", "choices": [{"index": 0, "delta": piece, "finish_reason": None if piece else ("tool_calls" if "tool_calls" in message else "stop")} ]}) + "\n\n").encode())
                self.wfile.flush()
            self.wfile.write(b"data: [DONE]\n\n")
        else:
            self.wfile.write(json.dumps({"id": "spike", "object": "chat.completion", "created": 1, "model": "spike-model", "choices": [{"index": 0, "message": message, "finish_reason": "tool_calls" if "tool_calls" in message else "stop"}], "usage": {"prompt_tokens": 10, "completion_tokens": 10, "total_tokens": 20}}).encode())


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", int(os.environ.get("HERMES_SPIKE_PROVIDER_PORT", "19120"))), Provider).serve_forever()
