# 2026-11-25 — Native Platform Complete

## Scope

Implemented native replacements for every remaining post-Hermes platform surface, added the rollback-safe native deploy script, cleaned residual Hermes UI copy, and updated `README.md` with the repository's evolution story:

- **Native Shared Computer & Vault-Safe Browser Sign-In:** `src/server/harness/native-computer.ts`, `src/server/mcp/vault-tools.ts`, `src/server/config.ts`, `src/server/store-secrets.ts`
- **Native Integrations & Custom MCP Manager:** `src/server/harness/native-integrations.ts`
- **Native Bot-to-Bot Delegation, Main Assistant Enforcement, & Routine → Group Delivery:** `src/server/harness/runtime.ts`, `src/server/harness/native-groups.ts`, `src/server/group-coordinator.ts`, `src/server/native-harness.ts`
- **Native Rollback-Safe Deploy Script:** `scripts/deploy.py`

## Red-Run Proofs

| Target                                  | Mutation                                                                             | Test Command                                                      | Result                                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `scripts/deploy.py`                     | Skip `rollback` call on failed `/api/health/ready` check (`mutate-py.py --baseline`) | `python3 scripts/run-python-tests.py tests/deploy_script_test.py` | Caught: `test_rolls_back_automatically_when_health_check_fails` failed (exit 1) |
| `src/server/store-secrets.ts`           | Disable `isReservedSecretName(name)` guard in `getSecret`                            | `npx vitest run tests/native-computer.test.ts`                    | Caught: failed (exit 1)                                                         |
| `src/server/harness/native-computer.ts` | Disable `isPrivateOrLoopbackHost(url.hostname)` check in `assertSafeBrowserUrl`      | `npx vitest run tests/native-computer.test.ts`                    | Caught: failed (exit 1)                                                         |
| `src/server/harness/runtime.ts`         | Disable `if (!reachable)` delegation policy refusal in `assertDelegationAllowed`     | `npx vitest run tests/native-delegation-routines.test.ts`         | Caught: failed (exit 1)                                                         |
