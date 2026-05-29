#!/usr/bin/env python3
"""Pending Azure refresh-token rotation queue (Gist-backed).

Why this exists
---------------
Workers (gh_checkin, gh_ot_creator, gh_timesheet_fetch, gh_payslip_fetch,
ot_history_fetch, ai_monthly_insight) used to call ``gh secret set
AZURE_REFRESH_TOKEN`` directly whenever Azure AD rotated the refresh
token. Two workers overlapping could overwrite a NEWER token with an
OLDER one (Azure invalidates the prior token on rotation) → 401 cascade
→ all automation dies.

Solution: only ``token-monitor.yml`` rotates the GitHub secret. Workers
write rotated tokens into the Gist file ``pending_token_rotation.json``
and the monitor drains the queue every */30 min, applying the LATEST
entry by ``written_at``.

Schema
------
::

  {
    "entries": [
      {"token": "<refresh_token>",
       "source": "gh_checkin",
       "written_at": "2026-05-30T10:00:00+09:00",
       "run_id": "1234"}
    ]
  }

Public API
----------
- ``write_pending(token, source, gh_pat, run_id=None) -> bool``
  Append a rotation entry. Idempotent: same token already present → no-op.
- ``consume_pending(gh_pat) -> list[dict]``
  Drain queue atomically (CAS) and return entries.
- ``latest_pending(gh_pat) -> dict | None``
  Peek the latest entry without consuming.

Tokens are never logged in plaintext; use ``_mask`` for any human output.
Stdlib only; uses :mod:`gist_cas` for atomic Gist writes.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from urllib.error import HTTPError
from urllib.request import Request, urlopen

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gist_cas import cas_update  # noqa: E402

try:
    from user_config import GIST_ID as _DEFAULT_GIST_ID  # noqa: E402
except Exception:  # pragma: no cover — defensive
    _DEFAULT_GIST_ID = None

PENDING_FILE = "pending_token_rotation.json"
JST = timezone(timedelta(hours=9))
MAX_QUEUE_LEN = 20  # cap to avoid runaway growth on bug


def _mask(token: str) -> str:
    """Return a privacy-safe representation of a token for logs."""
    if not token or len(token) < 12:
        return "***"
    return f"{token[:4]}…{token[-4:]} (len={len(token)})"


def _gist_id() -> str:
    gid = os.environ.get("GIST_ID") or _DEFAULT_GIST_ID
    if not gid:
        raise RuntimeError("GIST_ID not configured (set env GIST_ID or user_config)")
    return gid


def write_pending(token: str, source: str, gh_pat: str,
                  run_id: str | None = None) -> bool:
    """Append a rotation entry to the queue.

    Idempotent: if an entry with the exact same ``token`` is already
    queued, returns ``False`` without re-writing.

    Returns ``True`` if a new entry was appended, ``False`` if no-op.
    Raises ``RuntimeError`` if the Gist write ultimately fails.
    """
    if not token:
        raise ValueError("token must be non-empty")
    if not gh_pat:
        raise ValueError("gh_pat must be non-empty (set GH_PAT env)")

    run_id = run_id or os.environ.get("GITHUB_RUN_ID")
    new_entry: dict = {
        "token": token,
        "source": source,
        "written_at": datetime.now(JST).isoformat(),
    }
    if run_id:
        new_entry["run_id"] = str(run_id)

    appended = {"flag": False}

    def mutator(d):
        if not isinstance(d, dict):
            d = {}
        entries = list(d.get("entries") or [])
        for e in entries:
            if e.get("token") == token:
                return d  # no-op
        entries.append(new_entry)
        d["entries"] = entries[-MAX_QUEUE_LEN:]
        appended["flag"] = True
        return d

    result = cas_update(_gist_id(), PENDING_FILE, mutator, gh_pat)
    if not result["ok"]:
        raise RuntimeError(
            f"Failed to write pending rotation: {result.get('error')}")
    return appended["flag"]


def consume_pending(gh_pat: str) -> list:
    """Drain the queue atomically. Returns a list of entries (possibly empty).

    On CAS failure, raises ``RuntimeError`` — caller should retry on next
    monitor tick rather than treat as lost.
    """
    if not gh_pat:
        raise ValueError("gh_pat must be non-empty")

    drained = {"entries": []}

    def mutator(d):
        if not isinstance(d, dict):
            return {"entries": []}
        drained["entries"] = list(d.get("entries") or [])
        return {"entries": []}

    result = cas_update(_gist_id(), PENDING_FILE, mutator, gh_pat)
    if not result["ok"]:
        raise RuntimeError(
            f"Failed to consume pending rotations: {result.get('error')}")
    return drained["entries"]


def latest_pending(gh_pat: str):
    """Peek the latest entry (by ``written_at``) without consuming.

    Returns ``None`` if queue is empty or unreadable.
    """
    if not gh_pat:
        return None
    url = f"https://api.github.com/gists/{_gist_id()}"
    req = Request(url, headers={
        "Authorization": f"Bearer {gh_pat}",
        "Accept": "application/vnd.github+json",
        "User-Agent": "dokokin-pending-rotation/1.0",
    })
    try:
        with urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode())
    except (HTTPError, OSError):
        return None
    content = (data.get("files", {}).get(PENDING_FILE, {}) or {}).get("content")
    if not content:
        return None
    try:
        parsed = json.loads(content)
    except (json.JSONDecodeError, ValueError):
        return None
    entries = parsed.get("entries") or []
    if not entries:
        return None
    return sorted(entries, key=lambda e: e.get("written_at", ""))[-1]


def peek_pending(gh_pat: str) -> list:
    """Read all queued entries without consuming. Returns [] on error/empty.

    Used by token-monitor when its own AZURE_REFRESH_TOKEN is stale: peek
    all queued candidates, try each one until refresh succeeds, then only
    consume entries up to and including the chosen one (newer entries stay
    queued for the next tick in case they supersede).
    """
    if not gh_pat:
        return []
    url = f"https://api.github.com/gists/{_gist_id()}"
    req = Request(url, headers={
        "Authorization": f"Bearer {gh_pat}",
        "Accept": "application/vnd.github+json",
        "User-Agent": "dokokin-pending-rotation/1.0",
    })
    try:
        with urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode())
    except (HTTPError, OSError):
        return []
    content = (data.get("files", {}).get(PENDING_FILE, {}) or {}).get("content")
    if not content:
        return []
    try:
        parsed = json.loads(content)
    except (json.JSONDecodeError, ValueError):
        return []
    return list(parsed.get("entries") or [])


def consume_pending_upto(gh_pat: str, written_at_cutoff: str) -> list:
    """Drain only entries with ``written_at <= written_at_cutoff``.

    Keeps newer entries queued (they may carry a fresher rotation that the
    monitor will pick up on the next tick). Returns the drained list.
    """
    if not gh_pat:
        raise ValueError("gh_pat must be non-empty")
    drained = {"entries": []}

    def mutator(d):
        if not isinstance(d, dict):
            return {"entries": []}
        all_entries = list(d.get("entries") or [])
        kept = [e for e in all_entries if e.get("written_at", "") > written_at_cutoff]
        drained["entries"] = [e for e in all_entries if e.get("written_at", "") <= written_at_cutoff]
        return {"entries": kept}

    result = cas_update(_gist_id(), PENDING_FILE, mutator, gh_pat)
    if not result["ok"]:
        raise RuntimeError(
            f"Failed to consume pending rotations: {result.get('error')}")
    return drained["entries"]


# ── Self-test (no network) ──

def _self_test():
    passed = 0

    # 1) mask
    assert _mask("") == "***"
    assert _mask("abc") == "***"
    m = _mask("abcdefghijklmnop")
    assert m.startswith("abcd") and "mnop" in m and "len=16" in m
    passed += 1

    # 2) idempotency logic (mirrors mutator)
    entries = [{"token": "TOK1", "source": "x", "written_at": "t1"}]
    assert any(e["token"] == "TOK1" for e in entries)
    assert not any(e["token"] == "TOK2" for e in entries)
    passed += 1

    # 3) cap at MAX_QUEUE_LEN
    big = [{"token": f"T{i}"} for i in range(MAX_QUEUE_LEN + 5)]
    capped = big[-MAX_QUEUE_LEN:]
    assert len(capped) == MAX_QUEUE_LEN
    assert capped[0]["token"] == "T5"
    passed += 1

    # 4) latest-by-timestamp ordering
    es = [
        {"token": "a", "written_at": "2026-01-01T00:00:00+09:00"},
        {"token": "b", "written_at": "2026-02-01T00:00:00+09:00"},
        {"token": "c", "written_at": "2026-01-15T00:00:00+09:00"},
    ]
    latest = sorted(es, key=lambda e: e["written_at"])[-1]
    assert latest["token"] == "b"
    passed += 1

    # 5) JSON roundtrip stability for non-ASCII source label
    payload = {"entries": [{"token": "TOK", "source": "テスト",
                            "written_at": "2026-05-30T10:00:00+09:00"}]}
    j = json.dumps(payload, ensure_ascii=False, indent=2)
    assert "テスト" in j
    assert json.loads(j) == payload
    passed += 1

    print(f"[OK] pending_rotation self-test: {passed}/5 passed")


def _cli():
    p = argparse.ArgumentParser(description="Pending token rotation queue")
    p.add_argument("--self-test", action="store_true",
                   help="Run inline tests (no network)")
    p.add_argument("--peek", action="store_true",
                   help="Show latest pending entry (masked)")
    p.add_argument("--drain", action="store_true",
                   help="Drain queue and print masked entries")
    args = p.parse_args()

    if args.self_test:
        _self_test()
        return

    gh = os.environ.get("GH_PAT") or os.environ.get("GH_TOKEN")
    if not gh:
        print("ERROR: GH_PAT (or GH_TOKEN) env not set", file=sys.stderr)
        sys.exit(1)

    if args.peek:
        e = latest_pending(gh)
        if e:
            safe = {**e, "token": _mask(e.get("token", ""))}
            print(json.dumps(safe, ensure_ascii=False, indent=2))
        else:
            print("(no pending rotation)")
        return

    if args.drain:
        items = consume_pending(gh)
        for it in items:
            safe = {**it, "token": _mask(it.get("token", ""))}
            print(json.dumps(safe, ensure_ascii=False, indent=2))
        print(f"Drained {len(items)} entries.")
        return

    p.print_help()


if __name__ == "__main__":
    _cli()
