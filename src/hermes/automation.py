"""Finite human controls over native goals, Kanban, webhooks and skill review.

No execution engine or secret store lives here. All durable writes go through
Hermes APIs. Service callers supply the person's visible roster, never an
arbitrary native method, path, config document or shell command.
"""
import contextlib
import hashlib
import json
import re
import secrets
import threading
import time


class AutomationError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def text(value, limit=20000):
    return str(value or "")[:limit]


def identity(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", value):
        raise AutomationError("Invalid native identity.")
    return value


def goal_document(state):
    return None if not state or state.status == "cleared" else dict(title=text(state.goal, 10000), status=text(state.status, 40), turnsUsed=state.turns_used, maxTurns=state.max_turns, **({"pausedReason": text(state.paused_reason, 1000)} if state.paused_reason else {}))


READS = frozenset(("overview", "task_get", "skill_content", "skill_diff"))
OPERATIONS = READS | frozenset(("goal_set", "goal_pause", "goal_resume", "goal_clear", "task_create", "task_update", "task_action", "task_dependency", "trigger_create", "trigger_update", "trigger_toggle", "trigger_delete", "skill_decide", "skill_policy"))


class Controller:
    error_type = AutomationError

    def __init__(self, server, native, open_bot, canonical_lock, submission_lock, maintenance_lock, maintenance_state, journal, submit=None):
        self.submit = submit
        self.server, self.native, self.open_bot = server, native, open_bot
        self.canonical_lock, self.submission_lock = canonical_lock, submission_lock
        self.maintenance_lock, self.maintenance_state, self.journal = maintenance_lock, maintenance_state, journal
        self.lock = threading.RLock()
        with journal.lock, journal.db:
            journal.db.execute("CREATE TABLE IF NOT EXISTS automation_goal_resumes(request_id TEXT PRIMARY KEY,profile TEXT NOT NULL,actor TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'uncertain',message TEXT)")
            columns = {row[1] for row in journal.db.execute("PRAGMA table_info(automation_goal_resumes)")}
            if "status" not in columns:
                journal.db.execute("ALTER TABLE automation_goal_resumes ADD COLUMN status TEXT NOT NULL DEFAULT 'uncertain'")
            if "message" not in columns:
                journal.db.execute("ALTER TABLE automation_goal_resumes ADD COLUMN message TEXT")
            if "goal_key" not in columns:
                journal.db.execute("ALTER TABLE automation_goal_resumes ADD COLUMN goal_key TEXT")
            journal.db.execute("CREATE TABLE IF NOT EXISTS automation_skill_decisions(profile TEXT NOT NULL,pending_id TEXT NOT NULL,revision TEXT NOT NULL,status TEXT NOT NULL,PRIMARY KEY(profile,pending_id))")

    def session(self, profile):
        response = self.open_bot("automation-open", {"profile": profile, "omit_messages": True})
        if "error" in response:
            raise AutomationError("Hermes could not confirm this assistant's canonical session owner. Reconnect first.", 409)
        value = response["result"]
        session = self.server._sessions.get(value["session_id"])
        if not session or not session.get("session_key"):
            raise AutomationError("Hermes has no stable native session for this assistant.", 409)
        return value, session

    @contextlib.contextmanager
    def profile_mutation(self):
        # The HTTP endpoint holds retirement.work for the whole operation.
        # Maintenance admission therefore cannot overtake these disk writes.
        with self.maintenance_lock:
            if self.maintenance_state():
                raise AutomationError("Hermes is being upgraded. Automation changes are paused.", 409)
        yield

    @contextlib.contextmanager
    def goal_owner(self, value, session):
        from hermes_cli import active_sessions as active
        from hermes_constants import get_hermes_home
        lease = session.get("active_session_lease")
        state_path, lock_path = active._lease_paths(lease=lease, registry_home=session.get("profile_home") or get_hermes_home())
        key = session["session_key"]
        # Use the same registry lock as native claims. An idle gateway keeps
        # its own lifetime lease; only a different writer refuses this edit.
        with active._FileLock(lock_path):
            entries = active._prune_dead(active._read_entries(state_path, strict=True), strict=True, target_session_id=key)
            own_id = getattr(lease, "lease_id", None) if lease is not None and not getattr(lease, "released", False) and getattr(lease, "session_id", None) == key else None
            for entry in entries:
                if str(entry.get("session_id") or "") != key:
                    continue
                if own_id and entry.get("lease_id") == own_id:
                    continue
                if active._is_same_writer(entry, {"live_session_id": value["session_id"]}):
                    continue
                raise AutomationError("Another native executor owns this assistant's session. Wait for it to finish.", 409)
            yield

    @contextlib.contextmanager
    def admitted(self, profile):
        from tui_gateway import server_requests
        with self.submission_lock, self.profile_mutation():
            value, session = self.session(profile)
            with session["history_lock"]:
                busy = any(session.get(key) for key in ("running", "queued_prompt", "queued_prompts", "pending_steer", "_auto_continue_scheduled", "_compute_host_open_request", "resume_hydrating", "_closing"))
                with server_requests._lock:
                    requests = value.get("open_requests") or any(row.sid == value["session_id"] for row in server_requests._open.values())
                if busy or requests:
                    raise AutomationError("This assistant has active work or an unanswered native request. Finish or stop it before changing its goal.", 409)
                with self.goal_owner(value, session):
                    yield value, session

    def roster(self, data):
        rows = self.native("profiles.list", {"include_sessions": False})["profiles"]
        native = {row["name"] for row in rows}
        visible = data.get("visibleProfiles", [data["profile"]])
        if not isinstance(visible, list) or len(visible) > 200 or any(not isinstance(item, str) for item in visible):
            raise AutomationError("Invalid visible assistant roster.")
        if data["profile"] not in native or data["profile"] not in visible:
            raise AutomationError("Assistant not found.", 404)
        return native.intersection(visible)

    def goal(self, profile, operation="overview", data=None, session=None):
        from hermes_cli.goals import GoalManager, GoalState, save_goal
        if session is None:
            _, session = self.session(profile)
        manager = GoalManager(session_id=session["session_key"])
        if operation == "goal_set":
            title, budget = data.get("title"), data.get("maxTurns")
            if not isinstance(title, str) or not 1 <= len(title.strip()) <= 10000 or type(budget) is not int or not 1 <= budget <= 1000:
                raise AutomationError("Enter a goal and a turn budget between 1 and 1,000.")
            save_goal(session["session_key"], GoalState(goal=title.strip(), status="paused", max_turns=budget,
                created_at=time.time(), paused_reason="Created paused in WildBots. Resume explicitly to continue."))
            manager.refresh()
            if not manager.state or manager.state.status != "paused" or manager.state.goal != title.strip() or manager.state.max_turns != budget:
                raise AutomationError("Hermes could not confirm the durable goal change. Refresh its native status before trying again.", 409)
        state = manager.state
        return goal_document(state)

    def resume_status(self, profile, goal_key=None):
        if goal_key is None:
            return {}
        with self.journal.lock:
            row = self.journal.db.execute("SELECT request_id,status,message FROM automation_goal_resumes WHERE profile=? AND goal_key=? ORDER BY rowid DESC LIMIT 1", (profile, goal_key)).fetchone()
            if not row:
                return {}
            receipt = self.journal.receipt(row[0])
        status = row[1]
        if status == "uncertain" and (receipt or {}).get("status") in ("accepted", "rejected"):
            status = receipt["status"]
        return dict(resume=dict(requestId=row[0], status=status,
            **({"runId": receipt["runId"]} if receipt and receipt.get("runId") else {}),
            **({"message": text(row[2], 1000)} if row[2] else {})))

    def goal_overview(self, profile):
        value, session = self.session(profile)
        state = self.journal.submission_state(profile, value["session_id"], session)
        from hermes_cli.goals import GoalManager
        goal = GoalManager(session_id=session["session_key"]).state
        goal_key = digest([goal.goal, goal.created_at]) if goal and goal.status != "cleared" else None
        return dict(goal=goal_document(goal), interruptionPending=state["interrupted"], **self.resume_status(profile, goal_key))

    def record_resume(self, request_id, status, message=None):
        with self.journal.lock, self.journal.db:
            self.journal.db.execute("UPDATE automation_goal_resumes SET status=?,message=? WHERE request_id=?", (status, message, request_id))

    def pause_refused_resume(self, session, original):
        from hermes_cli.goals import GoalManager
        with session["history_lock"]:
            manager = GoalManager(session_id=session["session_key"])
            state = manager.state
            # Never overwrite a goal a native editor replaced during admission.
            if state and state.status == "active" and (state.goal, state.created_at) == original:
                manager.pause("Goal continuation was not confirmed. Review its admission before resuming.")
                manager.refresh()
                if manager.state and manager.state.status == "active":
                    raise AutomationError("Hermes could not confirm that the refused goal is paused. Review its native status.", 409)

    def resume_goal(self, data, visible):
        request_id, actor, profile = data.get("requestId"), data.get("senderId"), data["profile"]
        if not isinstance(request_id, str) or not re.fullmatch(r"[a-fA-F0-9-]{36}", request_id) or not isinstance(actor, str) or not 1 <= len(actor) <= 200:
            raise AutomationError("A stable resume request UUID and signed-in person are required.")
        if type(data.get("reviewedInterruption", False)) is not bool:
            raise AutomationError("Explicit interrupted-work review must be a boolean.")
        if not callable(self.submit):
            raise AutomationError("Durable goal admission is unavailable. Update the Hermes integration.", 409)
        # The registry/history locks cover mutation, then release before native
        # submit takes its own locks. App submit retains its durable receipts.
        with self.submission_lock:
            with self.journal.lock:
                previous = self.journal.db.execute("SELECT profile,actor,goal_key FROM automation_goal_resumes WHERE request_id=?", (request_id,)).fetchone()
                if previous and previous[:2] != (profile, actor):
                    raise AutomationError("This resume request belongs to another assistant or person.", 409)
                if not previous and self.journal.receipt(request_id):
                    raise AutomationError("This request identity already belongs to another native task.", 409)
            from hermes_cli.goals import GoalManager
            if previous:
                _, session = self.session(profile)
                with session["history_lock"]:
                    goal = GoalManager(session_id=session["session_key"]).state
                    goal_key = digest([goal.goal, goal.created_at]) if goal and goal.status != "cleared" else None
                    # Legacy unbound receipts also cannot authorize a different
                    # goal. Keep the receipt, but require a fresh reviewed ID.
                    if previous[2] is None or previous[2] != goal_key:
                        raise AutomationError("This resume request belongs to an earlier goal. Refresh this goal and review its conversation before starting a new resume attempt.", 409)
                return self.overview(profile, visible)
            failure = None
            with self.admitted(profile) as (value, session):
                gate = self.journal.submission_state(profile, value["session_id"], session)
                if gate["current"]:
                    raise AutomationError("Hermes is still settling the preceding task. Refresh its conversation before resuming this goal.", 409)
                if gate["interrupted"] and not data.get("reviewedInterruption", False):
                    raise AutomationError("Review the interrupted work in this assistant's conversation, then explicitly confirm that review before resuming.", 409)
                manager = GoalManager(session_id=session["session_key"])
                if not manager.state or manager.state.status != "paused":
                    raise AutomationError("Only a paused native goal can be resumed.", 409)
                original = (manager.state.goal, manager.state.created_at)
                with self.journal.lock, self.journal.db:
                    self.journal.db.execute("INSERT INTO automation_goal_resumes(request_id,profile,actor,goal_key,status,message) VALUES(?,?,?,?,'rejected','Goal continuation was not submitted.')", (request_id, profile, actor, digest(original)))
                try:
                    manager.resume()
                    manager.refresh()
                    if not manager.state or manager.state.status != "active" or manager.state.turns_used != 0:
                        raise AutomationError("Hermes did not confirm its durable goal resume.", 409)
                    prompt = manager.next_continuation_prompt()
                    if not isinstance(prompt, str) or not prompt:
                        raise AutomationError("Hermes did not produce a native goal continuation.", 409)
                except Exception:
                    failure = 'Hermes could not confirm goal continuation preparation. Review its native status before trying again.'
                sid = value["session_id"]
            if failure:
                self.record_resume(request_id, "rejected", failure)
                self.pause_refused_resume(session, original)
                return self.overview(profile, visible)
            self.record_resume(request_id, "uncertain")
            try:
                response = self.submit("automation-resume", {"profile": profile, "session_id": sid, "request_id": request_id,
                    "sender_id": actor, "text": prompt, "steer": False, "attachments": [], "require_idle": True,
                    "reviewed_interruption": data.get("reviewedInterruption", False)})
            except Exception:
                self.record_resume(request_id, "uncertain", "Hermes could not confirm continuation admission. Review the canonical conversation before another resume.")
                self.pause_refused_resume(session, original)
                return self.overview(profile, visible)
            result = response.get("result") or {}
            if "error" in response or result.get("status") == "rejected":
                self.record_resume(request_id, "rejected", text(result.get("message"), 1000) or "Hermes refused this goal continuation. Review the assistant's conversation before trying again.")
                self.pause_refused_resume(session, original)
            elif result.get("status") == "accepted":
                self.record_resume(request_id, "accepted")
            else:
                self.record_resume(request_id, "uncertain", "Hermes did not confirm goal continuation admission. Refresh the canonical conversation before another resume.")
                self.pause_refused_resume(session, original)
            return self.overview(profile, visible)

    def run(self, data):
        operation = data.get("operation")
        if operation not in OPERATIONS:
            raise AutomationError("Unknown automation operation.")
        identity(data.get("profile"))
        with self.lock:
            visible = self.roster(data)
            if operation == "overview":
                return self.overview(data["profile"], visible)
            if operation in READS:
                return task_operation(data, visible) if operation == "task_get" else skill_operation(data, self.journal)
            if operation == "goal_resume":
                return self.resume_goal(data, visible)
            if operation in ("goal_pause", "goal_clear"):
                from hermes_cli.goals import GoalManager
                with self.profile_mutation():
                    _, session = self.session(data["profile"])
                    with session["history_lock"]:
                        manager = GoalManager(session_id=session["session_key"])
                        if operation == "goal_pause":
                            if manager.state and manager.state.status not in ("cleared", "done"):
                                manager.pause()
                        else:
                            manager.clear()
                        manager.refresh()
                        allowed = ("cleared",) if operation == "goal_clear" else ("paused", "cleared", "done")
                        if manager.state and manager.state.status not in allowed:
                            raise AutomationError("Hermes did not confirm the durable goal control. Refresh its native status.", 409)
                return self.overview(data["profile"], visible)
            if operation == "goal_set":
                with self.admitted(data["profile"]) as (_, session):
                    self.goal(data["profile"], operation, data, session=session)
                return self.overview(data["profile"], visible)
            with self.profile_mutation():
                if operation.startswith("task_"):
                    return task_operation(data, visible)
                if operation.startswith("trigger_"):
                    return trigger_operation(data)
                return skill_operation(data, self.journal)

    def overview(self, profile, visible):
        result = dict(botId=profile, owner="Hermes")
        for key, empty, read in (
            ("goals", dict(goal=None), lambda: self.goal_overview(profile)),
            ("tasks", dict(items=[], truncated=False, limit=100), lambda: task_list(profile, visible)),
            ("triggers", dict(items=[], platformEnabled=False), lambda: trigger_list(profile)),
            ("skills", dict(installed=[], pending=[], approvalRequired=False), skill_list),
        ):
            try:
                result[key] = dict(supported=True, **read())
            except AutomationError as exc:
                result[key] = dict(supported=False, reason=str(exc), **empty)
            except (ImportError, AttributeError):
                result[key] = dict(supported=False, reason=f"This Hermes revision cannot expose {key}. Update and qualify its integration.", **empty)
        return result


def task_owned(kb, conn, task_id, profile, visible, *, idle=False):
    task = kb.get_task(conn, identity(task_id))
    if not task or task.created_by != profile or task.assignee and task.assignee not in visible:
        raise AutomationError("Task not found in this assistant's visible native work.", 404)
    if idle and (task.claim_lock or task.current_run_id is not None or task.status == "running"):
        raise AutomationError("A native worker owns this task. Wait for its claim to settle before changing it.", 409)
    return task


def task_dto(kb, conn, task, profile, visible):
    task_owned(kb, conn, task.id, profile, visible)
    dependencies = []
    for parent in kb.parent_ids(conn, task.id):
        try:
            task_owned(kb, conn, parent, profile, visible)
            dependencies.append(parent)
        except AutomationError:
            # A native graph can contain private or cross-owner edges. Never
            # reveal their IDs or titles, and refuse edits to that graph below.
            pass
    blocked = None
    if task.status == "blocked":
        for event in reversed(kb.list_events(conn, task.id)):
            if event.kind == "blocked" and isinstance(event.payload, dict) and event.payload.get("reason"):
                blocked = text(event.payload["reason"], 2000)
                break
    return dict(id=task.id, title=text(task.title, 500), body=text(task.body), status=text(task.status, 40), priority=task.priority,
        assignee=task.assignee, owner=profile, dependencies=dependencies[:20], **({"blockedReason": blocked} if blocked else {}))


def task_list(profile, visible):
    from hermes_cli import kanban_db as kb
    from hermes_cli.kanban_db_connect import connect_closing
    if not kb.kanban_db_path().is_file():
        return dict(items=[], truncated=False, limit=100)
    with connect_closing() as conn:
        # Exact 41df list_tasks has no created_by filter or paging cursor. Read
        # only owner/visible IDs before bounding, then project via native APIs.
        assignees = sorted(visible)
        clause = "assignee IS NULL" + (" OR assignee IN (" + ",".join("?" for _ in assignees) + ")" if assignees else "")
        rows = conn.execute("SELECT id FROM tasks WHERE created_by=? AND status!='archived' AND (" + clause + ") ORDER BY created_at DESC,priority DESC,id DESC LIMIT 101", (profile, *assignees)).fetchall()
        items = []
        for row in rows[:100]:
            try:
                task = task_owned(kb, conn, row[0], profile, visible)
                items.append(task_dto(kb, conn, task, profile, visible))
            except AutomationError as exc:
                if exc.status != 404:
                    raise
        return dict(items=items, truncated=len(rows) > 100, limit=100)


class GuardedTasks:
    """Validate native ownership after BEGIN IMMEDIATE, before any native write.

    Native transition functions deliberately reject nested transactions. Keep
    their transaction and post-commit hooks intact, injecting just this check.
    """
    def __init__(self, conn, check):
        self.conn, self.check = conn, check

    def __getattr__(self, name):
        return getattr(self.conn, name)

    def execute(self, sql, *args):
        result = self.conn.execute(sql, *args)
        if sql.strip().upper() == "BEGIN IMMEDIATE":
            try:
                self.check(self.conn)
            except Exception:
                self.conn.execute("ROLLBACK")
                raise
        return result


def task_operation(data, visible):
    from hermes_cli import kanban_db as kb
    from hermes_cli.kanban_db_connect import connect_closing
    profile, operation = data["profile"], data["operation"]
    if operation == "task_action" and data.get("action") not in ("start", "block", "unblock", "request_review"):
        raise AutomationError("Unknown human task action.")
    if operation != "task_create" and not kb.kanban_db_path().is_file():
        raise AutomationError("Task not found.", 404)
    task_id = data.get("taskId")
    values = data.get("task", {}) if operation == "task_create" else data
    assignee = values.get("assignee")
    if assignee is not None and assignee not in visible:
        raise AutomationError("Assistant not found.", 404)
    dependencies = values.get("dependencies", []) if operation == "task_create" else ([data.get("dependencyId")] if operation == "task_dependency" else [])
    if not isinstance(dependencies, list) or len(dependencies) > 20:
        raise AutomationError("A task can name at most 20 dependencies.")
    def check(conn):
        if task_id:
            task_owned(kb, conn, task_id, profile, visible, idle=operation != "task_get")
            for parent in kb.parent_ids(conn, task_id):
                task_owned(kb, conn, parent, profile, visible)
        for parent in dependencies:
            task_owned(kb, conn, parent, profile, visible)
    with connect_closing() as raw:
        conn = GuardedTasks(raw, check)
        check(raw)
        if operation == "task_get":
            task = task_owned(kb, conn, task_id, profile, visible)
            return task_dto(kb, conn, task, profile, visible)
        if operation == "task_create":
            title = values.get("title")
            request_id = values.get("requestId", "")
            if not isinstance(title, str) or not 1 <= len(title.strip()) <= 500 or not isinstance(request_id, str) or not re.fullmatch(r"[a-fA-F0-9-]{36}", request_id):
                raise AutomationError("A title and stable task request UUID are required.")
            task_id = kb.create_task(conn, title=title.strip(), body=values.get("body"), priority=values.get("priority", 0), assignee=values.get("assignee", profile),
                created_by=profile, parents=dependencies, initial_status="blocked", workspace_kind="scratch", idempotency_key=f"wildbots:{profile}:{request_id}")
        elif operation == "task_update":
            changed = {key: data[key] for key in ("title", "body", "priority") if key in data}
            if changed and not kb.edit_task(conn, task_id, **changed):
                raise AutomationError("Hermes refused this task edit. Refresh the native task.", 409)
            if "assignee" in data and not kb.assign_task(conn, task_id, assignee):
                raise AutomationError("Hermes refused this task assignment. Refresh its owner.", 409)
        elif operation == "task_dependency":
            if type(data.get("remove")) is not bool:
                raise AutomationError("Choose whether to remove the dependency.")
            if data["remove"]:
                kb.unlink_tasks(conn, identity(data["dependencyId"]), task_id)
            else:
                kb.link_tasks(conn, identity(data["dependencyId"]), task_id)
        elif operation == "task_action":
            action, reason, reviewer = data.get("action"), data.get("reason"), data.get("reviewer")
            if reviewer is not None and reviewer not in visible:
                raise AutomationError("Assistant not found.", 404)
            if action in ("start", "unblock"):
                ok, _ = kb.promote_task(conn, task_id, actor=profile, reason=reason)
            elif action == "block":
                if not isinstance(reason, str) or not reason.strip():
                    raise AutomationError("Explain what blocks this task.")
                ok = kb.block_task(conn, task_id, reason=reason, kind="needs_input")
            elif action == "request_review":
                if not reviewer:
                    raise AutomationError("Choose a visible assistant to review this task.")
                ok = kb.request_review(conn, task_id, summary=reason, reviewer=reviewer)
            else:
                raise AutomationError("Unknown human task action.")
            if not ok:
                raise AutomationError("Hermes refused this transition in the task's current state.", 409)
        else:
            raise AutomationError("Unknown task operation.")
        task = task_owned(kb, conn, task_id, profile, visible)
        return task_dto(kb, conn, task, profile, visible)


def trigger_summary(name, route):
    from hermes_cli import webhook as wh
    return dict(id=name, description=text(route.get("description"), 1000), events=[text(item, 100) for item in route.get("events", [])[:20]],
        routineId=text(route.get("cron_job"), 100), enabled=route.get("enabled", True) is not False, url=wh._route_url(name, route), secretSet=bool(route.get("secret")), revision=digest(route))


def trigger_owned(route, profile):
    return isinstance(route, dict) and route.get("profile", "default") == profile and bool(route.get("cron_job")) and not route.get("script") and not route.get("deliver_only")


def trigger_list(profile):
    from hermes_cli import webhook as wh
    return dict(platformEnabled=wh._is_webhook_enabled(), items=[trigger_summary(name, route) for name, route in wh._load_subscriptions().items() if trigger_owned(route, profile)][:100])


def trigger_operation(data):
    from hermes_cli import webhook as wh
    from hermes_cli.web_routers.cron import _call_cron_for_profile
    operation, profile = data["operation"], data["profile"]
    values = data.get("trigger", {})
    name = identity(values.get("id") if operation in ("trigger_create", "trigger_update") else data.get("triggerId"))
    if operation in ("trigger_create", "trigger_update"):
        if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,79}", name):
            raise AutomationError("Use a lowercase event trigger name.")
        job_id = identity(values.get("routineId"))
        job = _call_cron_for_profile(profile, "get_job", job_id)
        if not job or job.get("id") != job_id:
            raise AutomationError("Routine not found in this assistant's native scheduler.", 404)
        events = values.get("events")
        if not isinstance(events, list) or not 1 <= len(events) <= 20 or any(not isinstance(item, str) or not re.fullmatch(r"[A-Za-z0-9_.*:-]{1,100}", item) for item in events):
            raise AutomationError("Choose between 1 and 20 event names.")
    secret = secrets.token_urlsafe(32) if operation == "trigger_create" else None
    def mutate(subscriptions):
        route = subscriptions.get(name)
        if operation == "trigger_create":
            if route is not None:
                raise AutomationError("This native event trigger name is already used. Refresh before creating another.", 409)
            route = dict(profile=profile, secret=secret, enabled=False, created_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), deliver="log")
            subscriptions[name] = route
        else:
            if not trigger_owned(route, profile):
                raise AutomationError("Event trigger not found in this assistant.", 404)
            if data.get("revision") != digest(route):
                raise AutomationError("This event trigger changed. Refresh before changing it.", 409)
        if operation in ("trigger_create", "trigger_update"):
            route.update(description=text(values.get("description"), 1000), events=values["events"], cron_job=values["routineId"])
        elif operation == "trigger_toggle":
            if type(data.get("enabled")) is not bool:
                raise AutomationError("Choose whether this trigger is enabled.")
            if data["enabled"] and not wh._is_webhook_enabled():
                raise AutomationError("Enable the native webhook platform in Hermes before activating this trigger.", 409)
            if data["enabled"]:
                job = _call_cron_for_profile(profile, "get_job", route["cron_job"])
                if not job or job.get("id") != route["cron_job"]:
                    raise AutomationError("The target routine no longer belongs to this assistant.", 409)
            route["enabled"] = data["enabled"]
        elif operation == "trigger_delete":
            del subscriptions[name]
            return dict(ok=True)
        return dict(subscription=trigger_summary(name, route), **({"secret": secret} if secret else {}))
    return wh._mutate_subscriptions(mutate)


def skill_list():
    from tools import write_approval as wa
    from tools.skills_tool import find_all_skills
    return dict(installed=[dict(name=text(row["name"], 200), description=text(row.get("description"), 1000)) for row in find_all_skills(skip_disabled=True)[:200]],
        pending=[dict(id=row["id"], summary=text(row.get("summary"), 1000), origin=text(row.get("origin"), 40), revision=digest(row)) for row in wa.list_pending(wa.SKILLS)[:100] if re.fullmatch(r"[a-f0-9]{8}", str(row.get("id", "")))],
        approvalRequired=wa.write_approval_enabled(wa.SKILLS))


def skill_refusal_is_definite(record, result):
    """Only native results that prove no content write survived may be retried.

    _apply_one catches exceptions into an empty result. A false boolean alone
    therefore cannot distinguish a validation refusal from a partial write.
    """
    if not isinstance(result, dict) or result.get("success") is not False:
        return False
    payload = record.get("payload") or {}
    operations = payload.get("operations")
    if operations is not None:
        if not isinstance(operations, list) or any(not isinstance(op, dict) or op.get("action") == "delete" for op in operations):
            return False
        if "failed_index" not in result:
            # Native batch validation/snapshot failures precede all content writes.
            return True
        return (type(result.get("failed_index")) is int and type(result.get("completed_before_failure")) is int
            and str(result.get("error", "")).endswith(" — batch aborted, all touched skills rolled back."))
    # Exact native non-delete handlers return false only before mutation or
    # after _guarded_write successfully restores content. Failed restoration
    # raises and _apply_one returns an empty result, which stays uncertain.
    # Delete/archive catches its own exceptions and may be partial even with
    # success:false, so it cannot be inferred safe from that flag alone.
    return payload.get("action") in ("create", "edit", "patch", "write_file", "remove_file")


def skill_operation(data, journal=None):
    from tools import write_approval as wa
    operation = data["operation"]
    if operation == "skill_policy":
        from hermes_cli.config import load_config, save_config
        from hermes_cli.web_routers._common import config_write_scope
        if type(data.get("approvalRequired")) is not bool:
            raise AutomationError("Choose whether skill writes require approval.")
        with config_write_scope(data["profile"]):
            config = load_config()
            config.setdefault("skills", {})[wa.CONFIG_KEY] = data["approvalRequired"]
            save_config(config)
        return dict(ok=True)
    if operation == "skill_content":
        from tools.skill_manager_tool import _find_skill
        name = data.get("name")
        if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_./-]{1,200}", name) or any(part in ("", ".", "..") for part in name.split("/")):
            raise AutomationError("Invalid skill name.")
        found = _find_skill(name)
        if not found:
            raise AutomationError("Installed skill not found in this profile.", 404)
        path = found["path"] / "SKILL.md"
        # Only the native discovered skill document is readable. No relative
        # path from a caller is ever appended, and linked documents stay out.
        if path.is_symlink() or not path.is_file():
            raise AutomationError("This skill document is unavailable for safe preview.", 409)
        with path.open(encoding="utf-8-sig") as handle:
            content = handle.read(100001)
        return dict(name=name, content=content[:100000], truncated=len(content) > 100000)
    pending_id = data.get("pendingId")
    if not isinstance(pending_id, str) or not re.fullmatch(r"[a-f0-9]{8}", pending_id):
        raise AutomationError("Invalid pending skill write identity.")
    record = wa.get_pending(wa.SKILLS, pending_id)
    if not record:
        raise AutomationError("Pending skill write not found in this profile.", 404)
    if operation == "skill_diff":
        diff = wa.skill_pending_diff(record)
        return dict(id=pending_id, diff=diff[:100000], revision=digest([record, diff]), truncated=len(diff) > 100000)
    if operation != "skill_decide" or data.get("decision") not in ("approve", "reject"):
        raise AutomationError("Unknown skill decision.")
    current_diff = wa.skill_pending_diff(record)
    if data.get("decision") == "approve" and len(current_diff) > 100000:
        raise AutomationError("This diff is too large to approve safely here. Review it in native Hermes.", 409)
    if data.get("revision") != digest([record, current_diff]):
        raise AutomationError("This pending skill write changed. Review its current diff first.", 409)
    if journal is None:
        raise AutomationError("Native skill review admission is unavailable.", 409)
    with journal.lock, journal.db:
        prior = journal.db.execute("SELECT status FROM automation_skill_decisions WHERE profile=? AND pending_id=?", (data["profile"], pending_id)).fetchone()
        if prior and prior[0] != "rejected":
            raise AutomationError("This skill decision was already attempted. Its outcome may be uncertain. Review it in native Hermes before taking another action.", 409)
        journal.db.execute("INSERT INTO automation_skill_decisions VALUES(?,?,?,'uncertain') ON CONFLICT(profile,pending_id) DO UPDATE SET revision=excluded.revision,status='uncertain'", (data["profile"], pending_id, data["revision"]))
    if data["decision"] == "approve":
        from hermes_cli.web_server_profiles import _profile_scope
        from hermes_cli.write_approval_commands import _apply_one
        # Config contextvars do not protect native skill-directory globals.
        # The native scope serializes their swap with every other profile.
        with _profile_scope(data["profile"]):
            ok, _, result = _apply_one(wa.SKILLS, record, None)
        if not ok:
            if skill_refusal_is_definite(record, result):
                with journal.lock, journal.db:
                    journal.db.execute("UPDATE automation_skill_decisions SET status='rejected' WHERE profile=? AND pending_id=?", (data["profile"], pending_id))
                raise AutomationError("Hermes refused this skill edit without a surviving content change. Refresh its diff before retrying or rejecting it.", 409)
            raise AutomationError("Hermes could not confirm whether this skill edit changed content. Review it in native Hermes before another attempt.", 409)
    if not wa.discard_pending(wa.SKILLS, pending_id):
        raise AutomationError("The skill decision outcome is uncertain. Refresh its native status before taking another action.", 409)
    with journal.lock, journal.db:
        journal.db.execute("UPDATE automation_skill_decisions SET status='completed' WHERE profile=? AND pending_id=?", (data["profile"], pending_id))
    return dict(ok=True)


def install_runtime(server, native, open_bot, canonical_lock, submission_lock, maintenance_lock, maintenance_state, journal, submit):
    journal.automation = Controller(server, native, open_bot, canonical_lock, submission_lock, maintenance_lock, maintenance_state, journal, submit)


def install(web, journal):
    from fastapi import Request
    from starlette.responses import JSONResponse
    from hermes_cli.web_routers._common import config_scoped_to_thread
    from hermes_cli.backend_retirement import retirement

    # Runtime and route installers can load this sibling as separate module
    # instances. Preserve the runtime error type rather than turning its safe
    # 404/409 refusals into generic 502 responses.
    error_types = (AutomationError, journal.automation.error_type)
    original_require_token = web._require_token
    def require_token(request):
        principal = getattr(request.state, "token_principal", None)
        if (request.scope.get("path") == "/api/agent-interface/automation"
                and getattr(request.state, "agent_interface_service_authenticated", False) is True
                and getattr(request.state, "token_authenticated", False) is True
                and getattr(principal, "provider", None) == "agent-interface-service"
                and getattr(principal, "principal", None) == "agent-interface"):
            return
        return original_require_token(request)
    web._require_token = require_token

    async def endpoint(request: Request):
        headers = {"Cache-Control": "no-store"}
        try:
            if not getattr(request.state, "agent_interface_service_authenticated", False):
                raise AutomationError("Private service authentication required.", 401)
            data = await request.json()
            if not isinstance(data, dict) or data.get("operation") not in OPERATIONS:
                raise AutomationError("Expected a finite automation request.")
            profile = identity(data.get("profile"))
            with retirement.work() as admitted:
                if not admitted:
                    raise AutomationError("Hermes is being upgraded. Automation controls are paused.", 409)
                result = await config_scoped_to_thread(profile, lambda: journal.automation.run(data))
            return JSONResponse(result, headers=headers)
        except error_types as exc:
            return JSONResponse({"error": str(exc)}, status_code=exc.status, headers=headers)
        except __import__("fastapi").HTTPException as exc:
            return JSONResponse({"error": "Assistant or native automation state unavailable."}, status_code=exc.status_code, headers=headers)
        except Exception:
            # Do not log arbitrary native exceptions: pending skill payloads
            # and webhook stores can contain secrets.
            return JSONResponse({"error": "Hermes could not confirm this automation operation. Refresh native status before trying again."}, status_code=502, headers=headers)
    globals()["Request"] = Request
    web.app.add_api_route("/api/agent-interface/automation", endpoint, methods=["POST"])
