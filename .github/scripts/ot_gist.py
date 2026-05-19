"""Shared helper: load OT requests from Gist `ot-requests.json`.

Used by gh_ot_creator.py, gh_checkin.py, ot_report.py.

Returns:
  - list of normalized OT entries (always {date, start, end, hours, reason})
    if the Gist file exists (even if empty array — Gist is authoritative)
  - None if GH_PAT missing, Gist read fails, file missing, or shape unexpected
    → caller should fall back to local schedule.json

Accepts both legacy bare-array shape AND new {requests, templates} wrapper
(Phase 3 schema migration).
"""
import json
import os
import urllib.request

GIST_ID = "abc2a47c0a396025a72a6580227ff493"
OT_GIST_FILE = "ot-requests.json"


def load_ot_from_gist(log=None):
    """Load OT requests from Gist. `log` is an optional callable(msg) for logging.

    Returns list[dict] or None.
    """
    _log = log if callable(log) else (lambda m: None)

    pat = os.environ.get("GH_PAT")
    if not pat:
        _log("GH_PAT not set; cannot read Gist OT requests (fallback to schedule.json)")
        return None

    url = f"https://api.github.com/gists/{GIST_ID}"
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {pat}",
        "Accept": "application/vnd.github+json",
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            gist = json.loads(resp.read())
    except Exception as e:
        _log(f"⚠️ Gist read failed: {e} (fallback to schedule.json)")
        return None

    files = gist.get("files") or {}
    f = files.get(OT_GIST_FILE)
    if not f:
        _log(f"Gist file {OT_GIST_FILE} not found (fallback to schedule.json)")
        return None

    content = f.get("content") or "[]"
    try:
        data = json.loads(content)
    except Exception as e:
        _log(f"⚠️ Gist {OT_GIST_FILE} invalid JSON: {e} (fallback to schedule.json)")
        return None

    if isinstance(data, dict) and "requests" in data:
        arr = data.get("requests") or []
    elif isinstance(data, list):
        arr = data
    else:
        _log(f"⚠️ Gist {OT_GIST_FILE} unexpected shape ({type(data).__name__}) "
             "(fallback to schedule.json)")
        return None

    if not isinstance(arr, list):
        _log(f"⚠️ Gist {OT_GIST_FILE} requests not an array (fallback to schedule.json)")
        return None

    normalized = []
    for entry in arr:
        if not isinstance(entry, dict):
            continue
        if not entry.get("date") or not entry.get("start") or not entry.get("end"):
            continue
        normalized.append({
            "date":   entry["date"],
            "start":  entry["start"],
            "end":    entry["end"],
            "hours":  entry.get("hours", 0),
            "reason": entry.get("reason", "task"),
        })
    return normalized
