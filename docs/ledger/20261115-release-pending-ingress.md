# Refuse activation while the gateway has pending ingress

Base: `62ea8cb9`, latest `origin/main` when this worktree was created.
Source fingerprint: `sha256:62aa484bc868368d2ccc357e1cb0959ecffa7784b62867ea4a98184f7aabcf36`.
Implemented by GPT-6.1 Sol on NicolasLaptop, Node 24.22.2 and Python 3.14.10.

## Finding and behavior

Sol's independent review of #346 found that the post-acquire idle check ignores pending ingress.
A plugin handler can await work before claiming an agent slot, leaving zero active agents and
no active work while the guard counts one pending ingress. The old check stopped the app before
its later drain check discovered that work, leaving activation held for review.

`gateway_reports_idle` now requires the same schema and maintenance-file stamp already required
by `ready_gateway` in preflight, plus an integer zero ingress count. A missing, malformed or
foreign stamp cannot justify stopping the app. These are not supported legacy preflight states:
preflight already requires this guard. A boolean is not an ingress counter. The existing refusal
path releases the acquired lease, restores the household status, and leaves the app running.
The refusal text and its fence now name pending ingress too.

## Regression and validation

The new real guarded-release test scripts a gateway-file change during the external maintenance
acquire, after preflight. Before the fix it failed with exit 2 instead of the required refusal
exit 75. After the fix it checks exit 75, the specific refusal reason, unchanged service calls,
restored status, removed lease, and RPC order `status`, `acquire`, `release`.

`python3 scripts/run-python-tests.py tests/deploy_common_test.py tests/deploy_guarded_release_test.py`
passed both suites in 14.8 s. Their logs are in `.private/pending-ingress-green.log`.
The shared test fixture now includes the guard that real preflight already requires. Existing
acceptance, active-agent rejection and cleanup-failure tests remain in those suites.

`python3 .agents/tools/mutate-py.py --batch .private/ingress-mutations.json --baseline -- ...`
used the focused pending-ingress and post-acquire rejection tests. Removing the whole guard
and independently accepting boolean ingress counts each failed. The helper restored the file
and cleared bytecode. Results are in `.private/pending-ingress-mutations.log`.
`git diff --check` passed. `npm ci` completed in this worktree.

## Scope and remaining checks

The guarded-release entry point is the only production caller of `acquire_then_stop_app`.
Its full fake-host test runs the real tool and cleanup. The refusal does not restart, stop,
or alter the gateway, so its pending handler can continue. Missing or unreadable state still
refuses through the existing cleanup instead of proceeding to stop.

Full check-all and compatible-container browser validation are queued. Independent review is
incomplete: Anthropic has a weekly usage limit and Grok returned HTTP 402 for exhausted balance.
This OpenAI implementation must remain unmerged until an eligible reviewer is available.
No production command, deployment, browser interaction, or Apple build was run for this fix.
