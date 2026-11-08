"""Who each assistant can see and reach, enforced inside Hermes.

Hermes's Bot Mode treats every local profile as a teammate: each Bot Chat system prompt lists
them all with their descriptions (tools/bot_mode_probe.py ``_build_section``), ``message_agent``
(tools/bot_mode_dm.py) reaches any of them, and ``cronjob_manage`` (tools/cronjob_tools.py) can
deliver into any profile's Bot Chat or a group room. WildBots hides a member's personal assistant
from everyone else, so the server sends each profile's roster here and this module applies it:

- A personal assistant sees its owner's other personal assistants and the assistants the whole
  household sees. A shared assistant, or an older one without an owner, sees only the latter.
  Another member's personal assistant is never listed, messaged or delivered to.
- The native roster section is filtered to that roster, and the prompt's capability epoch carries
  the roster, so a cached or stored prompt is rebuilt once when it changes.
- ``message_agent`` resolves its target against the roster once and sends to exactly the profile
  it authorized, by profile ID. A main assistant must ask its member first for a shared assistant.
- ``cronjob_manage`` deliveries go only where the roster allows. A main assistant may deliver only
  to itself or its member's personal assistants; rooms and messaging platforms are refused.
- A main assistant cannot run the Hermes CLI or touch another profile's files through the
  terminal, code or file tools. Those tools act on the whole host, so this is a guard, not a
  boundary: see docs/HouseholdExperience.md#privacy-limits.

Once any roster has arrived, a profile without one (a new assistant the server has not described
yet) sees and reaches nobody. Before that, as with an older WildBots server, Hermes behaves as it
always has. The rosters are kept in the add-on journal, so a restarted gateway enforces them before
the app resends them.
"""
import hashlib
import json
import re
from pathlib import Path

TOOL_MODULE = "tools.bot_mode_dm"
TOOL_NAME = "message_agent_tool"
PROBE_MODULE = "tools.bot_mode_probe"
SEND = "Send it"
KEEP = "Don't send"
PROFILE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
MAX_PROFILES = 200
MAX_TARGETS = 200
ROSTER_HEADING = re.compile(r"^You are `@[^`]+`\. Your teammates .*:$")
HOST_TOOLS = {"terminal", "execute_code", "process_manage"}
FILE_TOOLS = {"write_file", "patch"}


class PolicyError(ValueError):
    pass


def _text(value, limit, field):
    if not isinstance(value, str) or len(value) > limit:
        raise PolicyError(f"{field} must be text of at most {limit} characters")
    return value


def _targets(value, field):
    if not isinstance(value, list) or len(value) > MAX_TARGETS:
        raise PolicyError(f"{field} must be a list of at most {MAX_TARGETS} assistants")
    targets = []
    for entry in value:
        if not isinstance(entry, dict) or not isinstance(entry.get("id"), str) or not PROFILE_ID.match(entry["id"]):
            raise PolicyError(f"{field} entries need a Hermes profile id")
        target = {"id": entry["id"], "name": _text(entry.get("name"), 200, f"{field} name").strip() or entry["id"]}
        if entry.get("description") is not None:
            target["description"] = _text(entry["description"], 1000, f"{field} description").strip()
        targets.append(target)
    return targets


def validate(policies):
    """The policies as stored, or PolicyError naming the first thing wrong with them."""
    if not isinstance(policies, dict) or len(policies) > MAX_PROFILES:
        raise PolicyError(f"policies must map at most {MAX_PROFILES} profiles to rosters")
    valid = {}
    for profile, policy in policies.items():
        if not isinstance(profile, str) or not PROFILE_ID.match(profile) or not isinstance(policy, dict):
            raise PolicyError("each policy needs a Hermes profile id and a roster")
        main, owned = policy.get("main", False), policy.get("owned", False)
        if not isinstance(main, bool) or not isinstance(owned, bool):
            raise PolicyError("main and owned must be true or false")
        valid[profile] = {"member": _text(policy.get("member"), 200, "member").strip() or "your member",
                          "main": main, "owned": owned or main,
                          "personal": _targets(policy.get("personal"), "personal"),
                          "shared": _targets(policy.get("shared"), "shared")}
    return valid


def guidance(policy):
    """What a main assistant reads at the start of each app turn about who it can hand work to."""
    member = policy["member"]
    line = lambda entry: f'- {entry["name"]} (target "{entry["id"]}")' + (f': {entry["description"]}' if entry.get("description") else "")
    parts = [f"You are {member}'s main assistant in WildBots. Hand specialist work to {member}'s other assistants with the "
             f"message_agent tool, using the target in quotes, then tell {member} what came back in your own words."]
    if policy["personal"]:
        parts.append(f"{member}'s personal assistants, private to {member}:\n" + "\n".join(map(line, policy["personal"])))
    if policy["shared"]:
        parts.append(f"Shared with the household. WildBots asks {member} before anything is sent to one of these, because "
                     "everyone in the household can read their chats:\n" + "\n".join(map(line, policy["shared"])))
    if not policy["personal"] and not policy["shared"]:
        parts.append("No other assistants are available for hand-offs right now.")
    else:
        parts.append("These are the only assistants you can message. Send each a short, self-contained request with only what it needs.")
    parts.append(f"Never reach another assistant, a group chat or a messaging channel any other way, such as the Hermes command line, "
                 f"files or a routine's delivery. If a hand-off is refused, tell {member} instead.")
    return "\n\n".join(parts)


def refusal(message):
    # The tool's own error shape, so the model reads it like any refused hand-off.
    return json.dumps({"error": message, "reason": "not_allowed"}, ensure_ascii=False)


def resolve(name, policy):
    """The one roster entry a target names, by profile ID or name, ignoring case and a leading @.

    A profile ID wins over a name, as in Hermes. A name two roster entries share names nobody.
    """
    wanted = name.strip().lstrip("@").lower()
    entries = policy["personal"] + policy["shared"]
    ids = {entry["id"].lower() for entry in entries}
    # Hermes's own alias for the default profile while no profile is named hermes.
    if wanted == "hermes" and "hermes" not in ids:
        wanted = "default"
    by_id = [entry for entry in entries if entry["id"].lower() == wanted]
    if by_id:
        return by_id[0]
    by_name = [entry for entry in entries if entry["name"].lower() == wanted]
    return by_name[0] if len(by_name) == 1 else None


def roster_ids(policy):
    return {entry["id"] for entry in policy["personal"] + policy["shared"]}


def filter_section(section, policy, handle_for):
    """The native Bot Mode section with only this roster's teammates listed.

    Roster lines are "- `@handle` — role" after the "You are `@me`. Your teammates" line, up to
    the next blank or non-bullet line. ``handle_for`` maps a profile ID to its @handle.
    """
    if not section:
        return section
    allowed = {f"@{handle_for(profile)}" for profile in roster_ids(policy)} if policy else set()
    lines, out, in_roster, kept = section.split("\n"), [], False, 0
    for line in lines:
        if ROSTER_HEADING.match(line):
            in_roster, kept = True, 0
            out.append(line)
            continue
        if in_roster:
            bullet = re.match(r"^- `(@[^`]+)`", line)
            if bullet:
                if bullet.group(1) in allowed:
                    out.append(line)
                    kept += 1
                continue
            if line.strip() == "- (no teammates yet)":
                continue
            in_roster = False
            if not kept:
                out.append("- (no teammates yet)")
        out.append(line)
    if in_roster and not kept:
        out.append("- (no teammates yet)")
    return "\n".join(out)


def deliver_tokens(value):
    """Cron delivery targets, from Hermes's comma-separated string or a list."""
    if value is None:
        return []
    items = value if isinstance(value, list) else str(value).split(",")
    return [str(item).strip() for item in items if str(item).strip()]


class Delegation:
    def __init__(self, db, lock, profile_for_agent, current_profile=None, hermes_root=None):
        self.db, self.lock, self.profile_for_agent = db, lock, profile_for_agent
        # The profile a registry tool runs for, from Hermes's profile-scoped home.
        self.current_profile = current_profile or (lambda: None)
        self.hermes_root = hermes_root
        with lock, db:
            db.execute("CREATE TABLE IF NOT EXISTS delegation(profile TEXT PRIMARY KEY, value TEXT NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS delegation_state(key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        self.policies = {}
        with lock:
            for profile, value in db.execute("SELECT profile,value FROM delegation").fetchall():
                try:
                    self.policies.update(validate({profile: json.loads(value)}))
                except (ValueError, TypeError):
                    continue
            # Once WildBots has sent rosters, a profile without one is unknown and reaches nobody.
            self.enforcing = db.execute("SELECT 1 FROM delegation_state WHERE key='enforcing'").fetchone() is not None
        self.installed = False

    def replace(self, policies):
        valid = validate(policies)
        with self.lock, self.db:
            self.db.execute("DELETE FROM delegation")
            self.db.executemany("INSERT INTO delegation(profile,value) VALUES(?,?)", [(profile, json.dumps(policy)) for profile, policy in valid.items()])
            self.db.execute("INSERT OR REPLACE INTO delegation_state(key,value) VALUES('enforcing','1')")
            self.policies, self.enforcing = valid, True
        return valid

    def policy_for(self, profile):
        """This profile's roster; an empty one when rosters are enforced and it has none; None when they are not."""
        policy = self.policies.get(profile) if profile else None
        if policy is not None or not self.enforcing:
            return policy
        return {"member": "your member", "main": False, "owned": True, "personal": [], "shared": []}

    def rpc(self, server):
        def handle(rid, params):
            try:
                self.replace((params or {}).get("policies"))
            except PolicyError as error:
                return server._err(rid, -32602, f"Invalid delegation policies: {error}")
            return server._ok(rid, {"ok": True})
        return handle

    def guidance_for(self, profile):
        policy = self.policies.get(profile)
        return guidance(policy) if policy and policy["main"] else None

    def fingerprint(self, profile):
        """A short digest of this profile's roster, mixed into the prompt's capability epoch."""
        policy = self.policy_for(profile)
        return "" if policy is None else hashlib.sha256(json.dumps(policy, sort_keys=True).encode()).hexdigest()[:12]

    def ask(self, agent, entries, message, constraints, expecting):
        """True when the member chose Send; otherwise their own words, or None."""
        callback = getattr(agent, "clarify_callback", None)
        if callback is None:
            return None
        from tools.clarify_tool import clarify_tool
        names = " and ".join(entry["name"] for entry in entries)
        shown = message.strip() or "(no message)"
        for label, value in (("Limits", constraints), ("Asking for", expecting)):
            if isinstance(value, str) and value.strip():
                shown += f"\n\n{label}: {value.strip()}"
        whose = "its chat" if len(entries) == 1 else "their chats"
        question = f"Send this to {names}? Everyone in the household can read {whose}.\n\n{shown}"
        try:
            result = json.loads(clarify_tool([{"question": question, "choices": [KEEP, SEND]}], callback=callback))
            response = result["responses"][0]
        except (ValueError, TypeError, KeyError, IndexError):
            return None
        if response.get("status") == "answered" and response.get("user_response") == SEND:
            return True
        answer = response.get("user_response")
        return answer if isinstance(answer, str) and answer not in (KEEP, SEND) else None

    def gated(self, original):
        def message_agent_tool(target="", message="", task_id=None, agent=None, expects_reply=True, cancel="",
                               constraints="", expecting="", **extra):
            def send(to):
                result = original(target=to, message=message, task_id=task_id, agent=agent, expects_reply=expects_reply,
                                  cancel=cancel, constraints=constraints, expecting=expecting, **extra)
                return without_teammates(result)
            policy = self.policy_for(self.profile_for_agent(agent))
            # Withdrawing its own earlier request sends nothing new.
            if policy is None or (isinstance(cancel, str) and cancel.strip()):
                return send(target)
            names = [part.strip() for part in str(target or "").split(",") if part.strip()]
            if not names:
                return send(target)
            entries = []
            for name in names:
                entry = resolve(name, policy)
                if entry is None:
                    allowed = ", ".join(f'"{row["id"]}"' for row in policy["personal"] + policy["shared"]) or "none"
                    return refusal(f"{name} isn't one of the assistants you can hand work to. Targets: {allowed}. Do not retry with this target.")
                entries.append(entry)
            # Exactly the profiles authorized, by ID: Hermes prefers an ID over a name, so forwarding the
            # words the model wrote could reach a different profile than the one checked here.
            destination = ",".join(dict.fromkeys(entry["id"] for entry in entries))
            shared_ids = {row["id"] for row in policy["shared"]}
            shared = [entry for entry in entries if entry["id"] in shared_ids]
            if not shared or not policy["main"]:
                return send(destination)
            answer = self.ask(agent, shared, str(message or ""), constraints, expecting)
            if answer is True:
                return send(destination)
            member = policy["member"]
            if isinstance(answer, str) and answer.strip():
                return refusal(f"{member} did not approve sending this. They answered: {answer.strip()}")
            return refusal(f"{member} did not approve sending this, so nothing was sent. Do not resend it or try another way unless {member} asks.")
        message_agent_tool.__wrapped__ = original
        return message_agent_tool

    def delivery_refusal(self, profile, policy, args):
        """Why a cron create or update may not deliver where it asks, or None.

        Its own chat is always allowed. Its member's personal assistants' chats are allowed, and
        household-visible chats except from a main assistant. Group rooms only from an assistant the
        whole household sees, since this add-on cannot tell who can open a room. A main assistant's
        results never go to a messaging platform either.
        """
        personal = {row["id"] for row in policy["personal"]}
        shared = {row["id"] for row in policy["shared"]}
        for field in ("deliver", "failure_deliver"):
            for token in deliver_tokens(args.get(field)):
                kind, _, rest = token.partition(":")
                kind, rest = kind.strip().lower(), rest.strip()
                if kind in ("origin", "local") or (kind == "bot-chat" and rest in ("", profile)):
                    continue
                if kind == "bot-chat":
                    if rest in personal or (rest in shared and not policy["main"]):
                        continue
                    return f"This routine can't deliver to {rest}'s chat. Deliver to this chat instead."
                if kind == "room" and not policy["owned"]:
                    continue
                if kind not in ("bot-chat", "room") and not policy["main"]:
                    continue
                return (f"This routine can't deliver to {token}: results from this assistant stay in its member's own chats. "
                        "Deliver to this chat instead.")
        return None

    def host_refusal(self, name, profile, policy, args):
        """Why a main assistant's terminal, code or file call may not run, or None."""
        if not policy["main"]:
            return None
        if name in HOST_TOOLS:
            text = json.dumps(args, ensure_ascii=False, default=str)
            if re.search(r"(?i)(?<![\w.-])hermes(?![\w-])|\.hermes|/profiles/|HERMES_HOME|bot[-_]live[-_]delivery", text):
                return "Your main assistant can't run the Hermes command line or open other assistants' files. Ask your member instead."
        if name in FILE_TOOLS and self.hermes_root:
            path = args.get("path") or args.get("file_path") or ""
            try:
                resolved = Path(str(path)).expanduser().resolve()
                root = Path(self.hermes_root()).resolve()
                own = root if profile == "default" else root / "profiles" / profile
                elsewhere = resolved.is_relative_to(root) and (not resolved.is_relative_to(own)
                    or profile == "default" and resolved.is_relative_to(root / "profiles"))
            except (OSError, ValueError, TypeError):
                return "Your main assistant can't write to that path."
            if elsewhere:
                return "Your main assistant can't write into other assistants' files."
        return None

    def gate_registry(self, registry):
        """Wraps the registry tools that can reach another profile, a room or the whole host."""
        wrapped = []
        for name in ("cronjob_manage", *sorted(HOST_TOOLS | FILE_TOOLS)):
            entry = registry.get_entry(name)
            if entry is None or getattr(entry.handler, "__wrapped__", None):
                continue
            original = entry.handler

            def handler(args, *rest, __original=original, __name=name, **kwargs):
                profile = self.current_profile()
                policy = self.policy_for(profile)
                if policy is not None and isinstance(args, dict):
                    reason = self.delivery_refusal(profile, policy, args) if __name == "cronjob_manage" else self.host_refusal(__name, profile, policy, args)
                    if reason:
                        return refusal(reason)
                return __original(args, *rest, **kwargs)
            handler.__wrapped__ = original
            # The registry passes only the keyword arguments a handler declares, so keep the original's.
            handler.__signature__ = __import__("inspect").signature(original)
            entry.handler = handler
            wrapped.append(name)
        return wrapped

    def install(self):
        """Wraps Hermes's message_agent, roster section and capability epoch, and the registry tools
        that can reach other profiles. False when this Hermes has no message_agent."""
        import importlib
        try:
            module = importlib.import_module(TOOL_MODULE)
            original = getattr(module, TOOL_NAME)
        except (ImportError, AttributeError):
            return False
        if not getattr(original, "__wrapped__", None):
            setattr(module, TOOL_NAME, self.gated(original))
        try:
            probe = importlib.import_module(PROBE_MODULE)
            self.install_probe(probe)
        except (ImportError, AttributeError):
            return False
        try:
            from tools.registry import registry
            self.gate_registry(registry)
        except ImportError:
            pass
        self.installed = True
        return True

    def install_probe(self, probe):
        """Filters the native roster section and carries the roster in the capability epoch."""
        section, fingerprint = probe.get_bot_mode_protocol_section, probe.capability_fingerprint
        if getattr(section, "__wrapped__", None):
            return
        def profile_of(home):
            return probe._profile_name(probe._resolve_home(home))
        def handle_for(home):
            root = probe._hermes_root(probe._resolve_home(home))
            names = [name for name, _ in probe._roster(root)]
            return lambda profile: probe._handle(profile, names)
        def filtered_section(home=None, **kwargs):
            text = section(home, **kwargs)
            policy = self.policy_for(profile_of(home))
            return text if policy is None else filter_section(text, policy, handle_for(home))
        def epoch(home=None):
            digest = self.fingerprint(profile_of(home))
            base = fingerprint(home)
            return base if not digest else hashlib.sha256(f"{base}:{digest}".encode()).hexdigest()[:12]
        filtered_section.__wrapped__, epoch.__wrapped__ = section, fingerprint
        probe.get_bot_mode_protocol_section, probe.capability_fingerprint = filtered_section, epoch


def without_teammates(result):
    """Hermes lists every local profile as `teammates` in some message_agent errors; that list goes."""
    try:
        payload = json.loads(result)
    except (TypeError, ValueError):
        return result
    if isinstance(payload, dict) and "teammates" in payload:
        payload.pop("teammates")
        return json.dumps(payload, ensure_ascii=False)
    return result
