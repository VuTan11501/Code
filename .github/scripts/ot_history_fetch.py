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
    api_headers,
)
from gist_safety import (  # type: ignore
    read_gist_file, safe_patch_gist_file,
    sanity_check_ot_requests, validate_ot_requests_shape,
    GistSafetyError, RaceDetected, SanityCheckFailed,
)


def search_ot_requests_verbose(token, year, month):
    """Like gh_ot_creator.search_ot_requests but logs raw response on empty/error
    so we can diagnose why old months return no data.
    """
    last_day = monthrange(year, month)[1]
    status, data = http_post(
        API_BASE + "otrequest/search",
        json_data={
            "Status": 0,
            "FromDate": f"{year}-{month:02d}-01",
            "ToDate": f"{year}-{month:02d}-{last_day}",
            "IsApproval": False,
        },
        headers=api_headers(token),
    )
    if status == 200 and isinstance(data, list):
        return data, status
    snippet = json.dumps(data)[:200] if not isinstance(data, str) else str(data)[:200]
    log(f"  ⚠ {year}-{month:02d} search: HTTP {status} type={type(data).__name__} body={snippet}")
    return [], status


def fetch_timesheet_aggregate(token, year, month, account="tanvc"):
    """Fetch monthly timesheet for cross-validation with payslip 2.4/2.5/2.6.
    Returns dict with overtimeHours / nightWorkingHours / oTRequestHours, or None.
    """
    url = f"{API_BASE}timesheet/{account}/{year}/{month}"
    req = urllib.request.Request(url, headers=api_headers(token), method="GET")
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read() or b"{}")
        if not isinstance(data, dict):
            return None
        return {
            "year": year,
            "month": month,
            "standardWorkingHours": data.get("standardWorkingHours"),
            "overtimeHours": data.get("overtimeHours"),
            "nightWorkingHours": data.get("nightWorkingHours"),
            "oTRequestHours": data.get("oTRequestHours"),
            "sundayWorkingHours": data.get("sundayWorkingHours"),
            "saturdayWorkingHours": data.get("saturdayWorkingHours"),
            "holidayWorkingHours": data.get("holidayWorkingHours"),
        }
    except Exception as e:
        log(f"  ⚠ {year}-{month:02d} timesheet: {e}")
        return None


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
            # Approval status is DokoKin-sourced and mutates over time
            # (Submitted→Approved/Rejected). Always refresh when DokoKin
            # returns a value and it differs from what we have.
            fs = f.get("dokokin_status")
            if fs is not None and cur.get("dokokin_status") != fs:
                cur["dokokin_status"] = fs
                changed = True
            fid = f.get("dokokin_id")
            if fid and cur.get("dokokin_id") != fid:
                cur["dokokin_id"] = fid
                changed = True
            if changed:
                updated += 1
        else:
            existing.append(f)
            added += 1

    return updated, added


def _clean_seed_entries(arr: list) -> int:
    """Remove PAST mock/seed entries (ids like 'ot_seed*'). Future-dated seed
    entries are preserved — they represent user-scheduled OT that hasn't been
    pushed to DokoKin yet (no `kintai_created_at`). Wiping them would silently
    delete the user's pending schedule on every sync (this happened: 2026-05-31
    Sun 12h was lost twice on 2026-05-19)."""
    today_str = datetime.now(JST).strftime("%Y-%m-%d")
    removed = 0
    keep = []
    for e in arr:
        if (isinstance(e, dict)
                and isinstance(e.get("id"), str)
                and e["id"].startswith("ot_seed")
                and str(e.get("date", "")) < today_str):
            removed += 1
            continue
        keep.append(e)
    arr.clear()
    arr.extend(keep)
    return removed


def main():
    now = datetime.now(JST)
    months_back = int(os.environ.get("MONTHS_BACK", "24"))
    clean_seeds = os.environ.get("CLEAN_SEEDS", "true").lower() in ("1", "true", "yes")
    fetch_ts = os.environ.get("FETCH_TIMESHEET", "true").lower() in ("1", "true", "yes")
    log(f"OT History Fetch — {months_back} months back, ending {now:%Y-%m} "
        f"(clean_seeds={clean_seeds}, fetch_timesheet={fetch_ts})")

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
    timesheets: list[dict] = []
    first_data_month = None
    last_data_month = None
    for (yy, mm) in months:
        recs, http = search_ot_requests_verbose(kt, yy, mm)
        normed = [_normalize_dokokin_record(r) for r in recs]
        normed = [n for n in normed if n]
        marker = "·" if not normed else "✓"
        log(f"  {marker} {yy}-{mm:02d}: HTTP {http}, {len(recs)} raw → {len(normed)} normalized")
        if normed:
            if first_data_month is None:
                first_data_month = f"{yy}-{mm:02d}"
            last_data_month = f"{yy}-{mm:02d}"
        fetched_all.extend(normed)

        if fetch_ts:
            ts = fetch_timesheet_aggregate(kt, yy, mm)
            if ts and any(v for v in [ts.get("overtimeHours"), ts.get("nightWorkingHours")]):
                log(f"      timesheet: OT={ts.get('overtimeHours')}h "
                    f"Night={ts.get('nightWorkingHours')}h "
                    f"Sun={ts.get('sundayWorkingHours')}h "
                    f"Sat={ts.get('saturdayWorkingHours')}h "
                    f"OTreq={ts.get('oTRequestHours')}h")
                timesheets.append(ts)

    log(f"Total fetched from DokoKin: {len(fetched_all)} OT records, "
        f"{len(timesheets)} timesheets")
    log(f"Data range covered: {first_data_month or '—'} → {last_data_month or '—'}")

    log("Reading Gist…")
    snapshot = read_gist_file(pat, GIST_ID, OT_GIST_FILE, log=log)
    raw = snapshot["parsed"]
    if isinstance(raw, dict) and "requests" in raw:
        wrapper = raw
        arr = list(raw.get("requests") or [])
    elif isinstance(raw, list):
        wrapper = None
        arr = list(raw)
    else:
        log("Gist file not found or empty, creating new array")
        wrapper = None
        arr = []

    # Snapshot original array for sanity diff (deep-copied via json round-trip)
    old_arr_snapshot = json.loads(json.dumps(arr))

    seeds_removed = 0
    if clean_seeds:
        seeds_removed = _clean_seed_entries(arr)
        if seeds_removed:
            log(f"🧹 Removed {seeds_removed} PAST seed/mock entries")

    before = len(arr)
    updated, added = _merge(arr, fetched_all)
    log(f"Merge: existing={before}, updated={updated}, added={added}, "
        f"seeds_removed={seeds_removed}, new total={len(arr)}")

    # Save timesheets into wrapper (so dashboard can show payslip-aligned aggregates)
    if timesheets:
        if wrapper is None:
            wrapper = {"requests": arr}
        wrapper["timesheets"] = timesheets
        wrapper["timesheets_fetched_at"] = datetime.now(JST).isoformat(timespec="seconds")

    if updated == 0 and added == 0 and seeds_removed == 0 and not timesheets:
        log("No changes to write.")
        if new_refresh != refresh_token:
            _emit_token_rotation(new_refresh)
        return

    # ── SAFETY GATE: refuse to write if too destructive ──────────────
    try:
        sanity_check_ot_requests(old_arr_snapshot, arr, log=log)
    except SanityCheckFailed as e:
        log(str(e))
        log("⛔ Aborting write to prevent data loss. Original gist content "
            "preserved unchanged. Investigate logs above for what tried to "
            "remove the entries.")
        sys.exit(2)

    # Build new content
    if wrapper is not None:
        wrapper["requests"] = arr
        new_content = json.dumps(wrapper, indent=2, ensure_ascii=False)
    else:
        new_content = json.dumps(arr, indent=2, ensure_ascii=False)

    log("PATCHing Gist (with rolling backup + race detection)…")
    try:
        st = safe_patch_gist_file(
            pat, GIST_ID, OT_GIST_FILE,
            new_content=new_content,
            snapshot=snapshot,
            shape_validator=validate_ot_requests_shape,
            log=log,
        )
        log(f"Gist PATCH HTTP {st} ✓  (rolling backup → ot-requests.bak.json)")
    except RaceDetected as e:
        log(str(e))
        log("⛔ Aborting — will retry on next scheduled run (every hour).")
        sys.exit(3)
    except GistSafetyError as e:
        log(f"⛔ Safety check failed: {e}")
        sys.exit(2)

    if new_refresh != refresh_token:
        _emit_token_rotation(new_refresh)


def _emit_token_rotation(new_refresh: str):
    # Phase 3 hardening: queue rotation; token-monitor drains centrally.
    print(f"::add-mask::{new_refresh}")
    try:
        from pending_rotation import write_pending_or_alert as write_pending  # noqa: E402
        gh_pat = os.environ.get("GH_PAT") or os.environ.get("GH_TOKEN")
        if gh_pat:
            write_pending(new_refresh, source="ot_history_fetch", gh_pat=gh_pat)
            log("🔄 Refresh token rotated; queued for centralized rotation.")
        else:
            log("⚠️ Refresh token rotated but GH_PAT missing — cannot queue.")
    except Exception as _e:
        log(f"⚠️ Failed to queue pending rotation (non-fatal): {_e}")
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as f:
            f.write("token_rotated=true\n")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"❌ {e}")
        traceback.print_exc()
        sys.exit(1)
