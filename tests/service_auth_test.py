"""Exercise the service authentication boundary without Hermes or a network."""
import base64
import sys
import types
import unittest
from unittest.mock import patch

from support import load_source

service = load_source("src/hermes/service_auth.py", "service_auth")
SECRET = base64.urlsafe_b64encode(bytes(range(32))).decode().rstrip("=")


class JSONResponse:
    def __init__(self, payload, status_code=200, headers=None):
        self.payload, self.status_code, self.headers = payload, status_code, headers

    async def __call__(self, scope, receive, send):
        await send({"status": self.status_code, "body": self.payload, "headers": self.headers})


class ServiceAuthTests(unittest.IsolatedAsyncioTestCase):
    async def invoke(self, *, headers=None, client=("127.0.0.1", 1234), path=None, method="GET", raw_path=None, query=b""):
        calls, responses = [], []

        async def app(scope, receive, send):
            calls.append(scope)

        async def send(message):
            responses.append(message)

        async def receive():
            return {"type": "http.request", "body": b""}

        responses_module = types.ModuleType("starlette.responses")
        responses_module.JSONResponse = JSONResponse
        auth_module = types.ModuleType("hermes_cli.dashboard_auth.base")
        auth_module.TokenPrincipal = lambda **kwargs: kwargs
        scope = {"type": "http", "path": path or service.PREFIX + "profiles", "method": method,
                 "headers": headers if headers is not None else [(b"authorization", b"Bearer " + SECRET.encode())],
                 "client": client, "state": {"existing": True}, "query_string": query}
        if raw_path is not None:
            scope["raw_path"] = raw_path
        with patch.dict(sys.modules, {"starlette.responses": responses_module, "hermes_cli.dashboard_auth.base": auth_module}):
            await service.ServiceAuthMiddleware(app, secret=SECRET)(scope, receive, send)
        return calls, responses

    async def test_rejects_untrusted_request_metadata(self):
        auth = (b"authorization", b"Bearer " + SECRET.encode())
        cases = [
            {"client": ("192.0.2.1", 1)}, {"client": ("invalid", 1)}, {"client": None},
            {"headers": [auth, (b"origin", b"https://example.test")]},
            {"headers": [auth, (b"cookie", b"session=x")]},
            {"headers": [auth, auth]}, {"headers": []},
            {"headers": [(b"authorization", b"Bearer incorrect")]},
            {"headers": [auth, (b"X-Forwarded-For", b"127.0.0.1")]},
            {"headers": [auth, (b"forwarded", b"for=127.0.0.1")]},
        ]
        for case in cases:
            with self.subTest(case=case):
                calls, responses = await self.invoke(**case)
                self.assertEqual(calls, [])
                self.assertEqual(responses[0]["status"], 401)
                forwarded = any(key.lower().startswith(b"x-forwarded-") or key.lower() == b"forwarded" for key, _ in case.get("headers", []))
                self.assertEqual(responses[0]["body"], {"error": "Service access must be direct" if forwarded else "Service authentication required"})
                self.assertEqual(responses[0]["headers"], {"Cache-Control": "no-store"})

    async def test_accepts_loopback_and_sets_trusted_state(self):
        calls, responses = await self.invoke(client=("::1", 1))
        self.assertEqual(responses, [])
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["path"], "/api/profiles")
        self.assertEqual(calls[0]["raw_path"], b"/api/profiles")
        self.assertEqual(calls[0]["state"], {"existing": True, "token_authenticated": True,
            "agent_interface_service_authenticated": True, "token_principal": {
                "principal": "agent-interface", "provider": "agent-interface-service", "scopes": ("executor",)}})

    async def test_rejects_disallowed_or_encoded_operations(self):
        for case in ({"method": "DELETE"}, {"raw_path": b"/api/agent-interface/service/pro%2ffiles"},
                     {"path": service.TICKET_PATH}, {"path": service.TICKET_PATH, "method": "POST", "query": b"bad=1"}):
            with self.subTest(case=case):
                calls, responses = await self.invoke(**case)
                self.assertEqual(calls, [])
                self.assertEqual(responses[0]["status"], 404)
                self.assertEqual(responses[0]["body"], {"error": "Service operation not available"})


if __name__ == "__main__":
    unittest.main()
