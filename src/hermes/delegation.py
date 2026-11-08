"""Main assistants' rosters and the gate on their agent messages.

WildBots sends each main assistant's roster: its member's other personal assistants, which it may
message freely, and the assistants the whole household sees, whose chats everyone can read. Hermes's
``message_agent`` tool (tools/bot_mode_dm.py) is wrapped so a main assistant can message only those,
and a message to a shared one first asks the member through Hermes's own clarify request, the
question card WildBots already shows. Anything else is refused before it is sent. A profile without
a roster, any assistant that is not someone's main one, works exactly as before.

The roster is kept in the add-on journal, so a restarted gateway gates before the app resends it.
"""
import json
import re

TOOL_MODULE = "tools.bot_mode_dm"
TOOL_NAME = "message_agent_tool"
SEND = "Send it"
KEEP = "Don't send"
PROFILE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
MAX_PROFILES = 200
MAX_TARGETS = 200


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
        valid[profile] = {"member": _text(policy.get("member"), 200, "member").strip() or "your member",
                          "personal": _targets(policy.get("personal"), "personal"),
                          "shared": _targets(policy.get("shared"), "shared")}
    return valid


def guidance(policy):
    """What the main assistant reads at the start of each app turn about who it can hand work to."""
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
    return "\n\n".join(parts)


def refusal(message):
    # The tool's own error shape, so the model reads it like any refused hand-off.
    return json.dumps({"error": message, "reason": "not_allowed"}, ensure_ascii=False)


def resolve(name, policy):
    """The roster entry a message_agent target names: its profile id, or its name, ignoring case and a leading @."""
    wanted = name.strip().lstrip("@").lower()
    entries = policy["personal"] + policy["shared"]
    ids = {entry["id"].lower() for entry in entries}
    # Hermes's own alias for the default profile while no profile is named hermes.
    if wanted == "hermes" and "hermes" not in ids:
        wanted = "default"
    return next((entry for entry in entries if entry["id"].lower() == wanted), None) or \
        next((entry for entry in entries if entry["name"].lower() == wanted), None)


class Delegation:
    def __init__(self, db, lock, profile_for_agent):
        self.db, self.lock, self.profile_for_agent = db, lock, profile_for_agent
        with lock, db:
            db.execute("CREATE TABLE IF NOT EXISTS delegation(profile TEXT PRIMARY KEY, value TEXT NOT NULL)")
        self.policies = {}
        with lock:
            for profile, value in db.execute("SELECT profile,value FROM delegation").fetchall():
                try:
                    self.policies.update(validate({profile: json.loads(value)}))
                except (ValueError, TypeError):
                    continue
        self.installed = False

    def replace(self, policies):
        valid = validate(policies)
        with self.lock, self.db:
            self.db.execute("DELETE FROM delegation")
            self.db.executemany("INSERT INTO delegation(profile,value) VALUES(?,?)", [(profile, json.dumps(policy)) for profile, policy in valid.items()])
            self.policies = valid
        return valid

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
        return guidance(policy) if policy else None

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
            def send():
                return original(target=target, message=message, task_id=task_id, agent=agent, expects_reply=expects_reply,
                                cancel=cancel, constraints=constraints, expecting=expecting, **extra)
            policy = self.policies.get(self.profile_for_agent(agent))
            # Withdrawing its own earlier request sends nothing new.
            if policy is None or (isinstance(cancel, str) and cancel.strip()):
                return send()
            names = [part.strip() for part in str(target or "").split(",") if part.strip()]
            if not names:
                return send()
            entries = []
            for name in names:
                entry = resolve(name, policy)
                if entry is None:
                    allowed = ", ".join(f'"{row["id"]}"' for row in policy["personal"] + policy["shared"]) or "none"
                    return refusal(f"{name} isn't one of the assistants you can hand work to. Targets: {allowed}. Do not retry with this target.")
                entries.append(entry)
            shared_ids = {row["id"] for row in policy["shared"]}
            shared = [entry for entry in entries if entry["id"] in shared_ids]
            if not shared:
                return send()
            answer = self.ask(agent, shared, str(message or ""), constraints, expecting)
            if answer is True:
                return send()
            member = policy["member"]
            if isinstance(answer, str) and answer.strip():
                return refusal(f"{member} did not approve sending this. They answered: {answer.strip()}")
            return refusal(f"{member} did not approve sending this, so nothing was sent. Do not resend it unless {member} asks.")
        message_agent_tool.__wrapped__ = original
        return message_agent_tool

    def install(self):
        """Wraps Hermes's message_agent, which its executor looks up on every call. False when this Hermes has none."""
        try:
            import importlib
            module = importlib.import_module(TOOL_MODULE)
            original = getattr(module, TOOL_NAME)
        except (ImportError, AttributeError):
            return False
        if not getattr(original, "__wrapped__", None):
            setattr(module, TOOL_NAME, self.gated(original))
        self.installed = True
        return True
