"""Unmodified queue functions from Hermes ed1afb082eb3, MIT license. See the photo queue ledger."""
from __future__ import annotations

from typing import Any

def _ac_inflight_original(session: dict) -> str:
    turn = session.get("inflight_turn")
    return str(turn.get("user") or "").strip() if isinstance(turn, dict) else ""


def _enqueue_prompt(session: dict, text: Any, transport: Any, image_paths: list[str] | None = None,
                    turn_author: dict | None = None) -> dict | None:
    """Queue a message for the next turn. Text-only arrivals share a slot and merge losslessly (like the
    consecutive-user merge in ``repair_message_sequence``); image-bearing and authored ones stay separate
    envelopes so attachment chronology and the sender survive. ``transport`` is pinned so the drained turn
    streams to its sender. Returns the envelope dict the text landed in (the merged head on a merge)
    so the caller can attach durable state to it; None when the text was dropped as a duplicate."""
    image_paths = list(image_paths or [])
    # Scrub live-turn self-duplicates first so the text merge below can't glue "{original}\n\n{later}" and re-fire the
    # original after a correction settles.
    # See #84417.
    _drop_queued_duplicates_of_inflight_user(session)
    text_only = not image_paths and isinstance(text, str)
    # A text-only self-copy of the live prompt would restart it on drain; an authored copy is another sender's message.
    if text_only and not turn_author and text.strip() == _ac_inflight_original(session) != "":
        return None
    queued = {"text": text, "transport": transport, **({"image_paths": image_paths} if image_paths else {}),
              **({"turn_author": turn_author} if turn_author else {})}
    existing = session.get("queued_prompt")
    if (existing and text_only and not turn_author and isinstance(existing.get("text"), str)
            and not existing.get("image_paths") and not existing.get("turn_author")
            and not session.get("queued_prompts")):
        prev = existing["text"]
        existing["text"] = f"{prev}\n\n{text}" if prev and text else (prev or text)
        return existing
    if existing:
        session.setdefault("queued_prompts", []).append(queued)
    else:
        session["queued_prompt"] = queued
    return queued


def _sanitize_queued_entry_vs_inflight_user(entry: Any, original: str) -> dict | None:
    """Drop (``None``) a text-only self-duplicate of the live user text, or rewrite a merged slot
    ``"{original}\\n\\n{later}"`` to ``later`` so the correction survives without re-firing the original. Image-bearing
    and authored envelopes are left alone: chronology and the sender's own words are kept.

    Returns ``None`` to drop the envelope, or a (possibly rewritten) dict to keep. A merged slot
    ``"{original}\\n\\n{later}"`` (from ``_enqueue_prompt``'s consecutive text merge) is rewritten to just
    ``later`` so a later correction is not lost and the original is not re-fired (#84417).
    """
    if not isinstance(entry, dict):
        return None
    text = entry.get("text")
    if not original or entry.get("image_paths") or entry.get("turn_author") or not isinstance(text, str):
        return entry
    # A lossless text-merge may have glued the live original onto a later follow-up: keep the remainder.
    rest = next((text[len(original + sep):] for sep in ("\n\n", "\n") if text.startswith(original + sep)), text).strip()
    return None if not rest or rest == original else (entry if rest == text.strip() else {**entry, "text": rest})


def _drop_queued_duplicates_of_inflight_user(session: dict) -> None:
    """Remove server-queue copies of the live turn's original user text: a mid-turn ``prompt.submit`` of the same text
    queued while redirect was unavailable must not drain and restart the original.

    A mid-turn ``prompt.submit`` of the same text can land in ``queued_prompt`` when redirect is not yet
    available (model not active, build window, tool boundary). If the user then corrects the turn with a
    different prompt via redirect, that stale self-duplicate must not ``_drain_queued_prompt`` after the
    redirected turn completes — otherwise the original prompt restarts as a fresh agent turn (#84417).
    """
    if not (original := _ac_inflight_original(session)):
        return
    head = session.get("queued_prompt")
    cleaned = (_sanitize_queued_entry_vs_inflight_user(e, original)
               for e in ([head] if head else []) + list(session.get("queued_prompts") or []))
    _ac_set_queue(session, [c for c in cleaned if c is not None])


def _ac_set_queue(session: dict, entries: list) -> None:
    """Write ``entries`` back as queued_prompt (head) + queued_prompts (rest)."""
    session["queued_prompt"] = entries[0] if entries else None
    if len(entries) > 1:
        session["queued_prompts"] = entries[1:]
    else:
        session.pop("queued_prompts", None)
