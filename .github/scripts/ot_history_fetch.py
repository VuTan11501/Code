#!/usr/bin/env python3
"""GitHub Actions — OT History Fetch.

Pulls historical OT requests from DokoKin for a range of past months and
merges them into the Gist ot-requests.json so the dashboard can display
the user's full history (not just dashboard-created entries).

Inputs (env):
  AZURE_REFRESH_TOKEN   required
  GH_PAT                required (to PATCH gist)
  MONTHS_BACK           optional, default 12 — how many months back from today

Stdlib only.
"""
import os, sys, json, urllib.request, urllib.parse, traceback
from datetime import datetime, timezone, timedelta, date
from calendar import monthrange

# Reuse helpers from gh_ot_creator
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gh_ot_creator import (  # type: ignore
    JST, API_BASE, GIST_ID, OT_GIST_FILE,
    log, http_post,
    refresh_azure_token, get_kintai_token,
    search_ot_requests,
)


def _hhmm(iso_dt: str) -> str:
    """Extract HH:MM from 'YYYY-MM-DDTHH:MM:SS' or similar."""
    if not iso_dt:
        return ""
    try:
        dt = datetime.fromisoformat(iso_dt.replace("Z", "+00:00"))
        return dt.strftime("%H:%M")
    except Exception:
        # Last-ditch: split on 'T'
        if "T" in iso_dt:
            tail = iso_dt.split("T", 1)[1]
            return tail[:5]
        return ""


def _date_str(iso_dt: str) -> str:
    if not iso_dt:
        return ""
    try:
        dt = datetime.fromisoformat(iso_dt.replace("Z", "+00:00"))
        return dt.strftime("%Y-%m-%d")
    except Exception:
        return iso_dt[:10] if len(iso_dt) >= 10 else ""


def _normalize_dokokin_record(r: dict) -> dict | None:
    """Map a DokoKin OT response → ot-requests.json entry shape.
    Returns None if the record can't be parsed.
    """
    if not isinstance(r, dict):
        return None
    req_date = _date_str(r.get("requestDate") or r.get("startTime") or "")
    start_iso = r.get("startTime") or ""
    end_iso = r.get("endTime") or ""
    start = _hhmm(start_iso)
    end = _hhmm(end_iso)
    if not req_date or not start or not end:
        return None

    hours = r.get("totalOvertime")
    if hours is None:
        # Compute from start/end
        try:
            sdt = datetime.fromisoformat(start_iso.replace("Z", "+00:00"))
            edt = datetime.fromisoformat(end_iso.replace("Z", "+00:00"))
            hours = round((edt - sdt).total_seconds() / 3600.0, 2)
        except Exception:
            hours = 0

    reason = (r.get("reason") or "").strip() or "(from DokoKin)"
    created_at = (
        r.get("createdDate")
        or r.get("createdAt")
        or r.get("modifiedDate")
        or datetime.now(JST).isoformat(timespec="seconds")
    )

    # Stable id derived from natural key
    entry_id = f"dk-{req_date}-{start.replace(':','')}-{end.replace(':','')}"

    return {
        "id": entry_id,
        "date": req_date,
        "start": start,
        "end": end,
        "hours": float(hours) if hours is not None else 0,
        "reason": reason,
        "kintai_created_at": created_at,
        "source": "dokokin",
        "dokokin_status": r.get("status"),
        "dokokin_id": r.get("id") or r.get("overtimeRequestId"),
    }


def _read_gist_ot_file(pat: str):
    url = f"https://api.github.com/gists/{GIST_ID}"
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {pat}",
        "Accept": "application/vnd.github+json",
    })
    with urllib.request.urlopen(req, timeout=20) as resp:
        data = json.loads(resp.read())
    files = data.get("files") or {}
    f = files.get(OT_GIST_FILE)
    if not f:
        return None, None
    try:
        raw = json.loads(f.get("content") or "[]")
    except Exception:
        raw = []
    # Phase 3 wrapper or legacy array
    if isinstance(raw, dict) and "requests" in raw:
        return raw, list(raw.get("requests") or [])
    if isinstance(raw, list):
        return None, list(raw)
    return None, []


def _patch_gist_ot_file(pat: str, wrapper, arr):
    url = f"https://api.github.com/gists/{GIST_ID}"
    if wrapper is not None:
        wrapper["requests"] = arr
        new_content = json.dumps(wrapper, indent=2, ensure_ascii=False)
    else:
        new_content = json.dumps(arr, indent=2, ensure_ascii=False)
    body = json.dumps({"files": {OT_GIST_FILE: {"content": new_content}}}).encode()
    req = urllib.request.Request(url, data=body, method="PATCH", headers={
        "Authorization": f"Bearer {pat}",
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
    })
    with urllib.request.urlopen(req, timeout=20) as resp:
        return resp.status


def _merge(existing: list, fetched: list) -> tuple[int, int]:
    """Merge fetched DokoKin entries into existing Gist list.
    - Match on (date, start, end). If found: mark `kintai_created_at` (if missing)
      and `source='dokokin'`; preserve user-set fields like custom reason.
    - If not found: append new entry from DokoKin.
    Returns (updated_count, added_count).
    """
    # Index existing entries by natural key
    key_to_entry: dict[tuple, dict] = {}
    for e in existing:
        if not isinstance(e, dict):
            continue
        k = (e.get("date"), e.get("start"), e.get("end"))
        if all(k):
            key_to_entry[k] = e

    updated = 0
    added = 0
    for f in fetched:
        k = (f["date"], f["start"], f["end"])
        cur = key_to_entry.get(k)
        if cur:
            changed = False
            if not cur.get("kintai_created_at"):
                cur["kintai_created_at"] = f["kintai_created_at"]
                changed = True
            if cur.get("source") != "dokokin":
                # Mark provenance, but don't clobber user-created label
                cur.setdefault("source", "dokokin")
                changed = True
            if not cur.get("reason"):
                cur["reason"] = f["reason"]
                changed = True
            # Always overwrite hours if missing or zero
            if not cur.get("hours"):
                cur["hours"] = f["hours"]
                changed = True
            if changed:
                updated += 1
        else:
            existing.append(f)
            added += 1

    return updated, added


def main():
    now = datetime.now(JST)
    months_back = int(os.environ.get("MONTHS_BACK", "12"))
    log(f"OT History Fetch — {months_back} months back, ending {now:%Y-%m}")

    refresh_token = os.environ.get("AZURE_REFRESH_TOKEN")
    if not refresh_token:
        raise RuntimeError("AZURE_REFRESH_TOKEN not set")
    pat = os.environ.get("GH_PAT")
    if not pat:
        raise RuntimeError("GH_PAT not set (needed to PATCH Gist)")

    log("Refreshing Azure → KINTAI token…")
    az_tok, new_refresh = refresh_azure_token(refresh_token)
    kt = get_kintai_token(az_tok)
    log("Token OK ✓")

    # Build the list of (year, month) to fetch, oldest → newest
    months = []
    y, m = now.year, now.month
    for _ in range(months_back + 1):  # include current month
        months.append((y, m))
        m -= 1
        if m == 0:
            m = 12
            y -= 1
    months.reverse()

    fetched_all: list[dict] = []
    for (yy, mm) in months:
        recs = search_ot_requests(kt, yy, mm)
        normed = [_normalize_dokokin_record(r) for r in recs]
        normed = [n for n in normed if n]
        log(f"  {yy}-{mm:02d}: {len(recs)} raw → {len(normed)} normalized")
        fetched_all.extend(normed)

    log(f"Total fetched from DokoKin: {len(fetched_all)}")

    log("Reading Gist…")
    wrapper, arr = _read_gist_ot_file(pat)
    if arr is None:
        log("Gist file not found, creating new array")
        arr = []
        wrapper = None

    before = len(arr)
    updated, added = _merge(arr, fetched_all)
    log(f"Merge: existing={before}, updated={updated}, added={added}, new total={len(arr)}")

    if updated == 0 and added == 0:
        log("No changes to write.")
        # Still rotate token if needed
        if new_refresh != refresh_token:
            _emit_token_rotation(new_refresh)
        return

    log("PATCHing Gist…")
    st = _patch_gist_ot_file(pat, wrapper, arr)
    log(f"Gist PATCH HTTP {st} ✓")

    if new_refresh != refresh_token:
        _emit_token_rotation(new_refresh)


def _emit_token_rotation(new_refresh: str):
    print(f"::add-mask::{new_refresh}")
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as f:
            f.write(f"token_rotated=true\n")
            f.write(f"new_refresh_token={new_refresh}\n")
    log("⚠️ Azure refresh token rotated — written to GITHUB_OUTPUT")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"❌ {e}")
        traceback.print_exc()
        sys.exit(1)
