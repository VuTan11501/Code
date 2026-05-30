"""Defensive Gist write helpers — prevent data loss / collapse.

PROBLEM (observed 2026-05-19): ot_history_fetch._clean_seed_entries wiped
ALL `ot_seed*` entries including future-dated pending OT, silently dropping
the user's 2026-05-31 Sun 12h entry. No backup, no diff log, no sanity check
→ took human investigation to notice & restore.

DEFENSES (in order of importance):

  1. **Rolling snapshot backup** — every safe write also pushes the previous
     content to a sibling `<filename>.bak.json` file in the SAME gist, in the
     SAME PATCH (atomic). 1-click recovery from the most recent write.

  2. **Pre-write sanity gate** — refuses to write if the new array shrinks
     >20% OR loses any "pending" entries (no `kintai_created_at`) without
     explicit confirmation. Logs full diff (added/removed dates) before write.

  3. **Optimistic concurrency** — refetches gist right before PATCH and
     compares against the original snapshot we read. If another writer raced
     us (content changed), aborts with `RaceDetected` — caller can retry.

  4. **Shape validator** — refuses to PATCH if the new content doesn't match
     the expected structural invariant (top-level array OR dict with required
     keys), preventing schema-collapse bugs like the {entries:[...]} wrap
     disaster.

These do NOT replace careful logic — they're guard rails that turn silent
data loss into loud, actionable failures.
"""
import json
import hashlib
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone, timedelta

JST = timezone(timedelta(hours=9))


class GistSafetyError(Exception):
    """Base for safety-gate failures (sanity, race, shape)."""


class RaceDetected(GistSafetyError):
    """Another writer modified the gist between our read and write."""


class SanityCheckFailed(GistSafetyError):
    """The proposed write would lose too much data — refusing."""


class ShapeInvalid(GistSafetyError):
    """The proposed content doesn't match required structural shape."""


def _hash(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()[:16]


def read_gist_file(pat: str, gist_id: str, filename: str, log=None) -> dict:
    """Read a file from a Gist. Returns dict with keys:
        content: str (raw json string, never None)
        sha:     str (short hash of content — concurrency token)
        parsed:  any (json.loads of content, or None if invalid)
        all_files: dict[str,str] (other filenames present, for backup placement)
    """
    _log = log if callable(log) else (lambda m: None)
    url = f"https://api.github.com/gists/{gist_id}"
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {pat}",
        "Accept": "application/vnd.github+json",
    })
    with urllib.request.urlopen(req, timeout=20) as resp:
        gist = json.loads(resp.read())
    files = gist.get("files") or {}
    f = files.get(filename)
    content = (f.get("content") if f else None) or ""
    # GitHub truncates Gist file content above ~1MB (in practice ~240KB)
    # in the JSON response. When truncated, fetch the full body from raw_url.
    if f and f.get("truncated") and f.get("raw_url"):
        _log(f"⚠️ {filename} truncated by API ({f.get('size')} bytes) — fetching raw_url…")
        raw_req = urllib.request.Request(f["raw_url"], headers={
            "Authorization": f"Bearer {pat}",
            "Accept": "text/plain",
        })
        with urllib.request.urlopen(raw_req, timeout=30) as raw_resp:
            content = raw_resp.read().decode("utf-8")
    try:
        parsed = json.loads(content) if content else None
    except Exception as e:
        _log(f"⚠️ {filename} invalid JSON: {e}")
        parsed = None
    return {
        "content": content,
        "sha": _hash(content),
        "parsed": parsed,
        "all_files": list(files.keys()),
    }


def _classify_entries(arr: list) -> tuple[int, int]:
    """For OT request arrays: (total_count, pending_count).
    Pending = no kintai_created_at OR kintai_created_at falsy.
    Caller can pass any list — if entries are non-dict, they're total but not pending.
    """
    total = len(arr)
    pending = sum(1 for e in arr
                  if isinstance(e, dict) and not e.get("kintai_created_at"))
    return total, pending


def sanity_check_ot_requests(old_arr: list, new_arr: list,
                             max_total_loss_pct: float = 20.0,
                             max_pending_loss_pct: float = 10.0,
                             allow_explicit: bool = False,
                             log=None) -> None:
    """Refuse if the new array drops too many entries vs the old one.

    Raises SanityCheckFailed with a detailed message if the write would be
    destructive. `allow_explicit=True` bypasses the gate (e.g. user manually
    cleaned via UI and explicitly accepted the loss).

    Thresholds chosen conservatively: a normal sync should ADD entries from
    DokoKin and update kintai_created_at, never remove >1-2 entries.
    """
    _log = log if callable(log) else (lambda m: None)
    if allow_explicit:
        return

    old_total, old_pending = _classify_entries(old_arr)
    new_total, new_pending = _classify_entries(new_arr)

    # Always log the diff
    old_dates = {e.get("date") for e in old_arr if isinstance(e, dict)}
    new_dates = {e.get("date") for e in new_arr if isinstance(e, dict)}
    added = sorted(new_dates - old_dates)
    removed = sorted(old_dates - new_dates)
    if added:
        _log(f"  ➕ Adding dates: {', '.join(added) if len(added) <= 10 else f'{len(added)} dates'}")
    if removed:
        _log(f"  ➖ Removing dates: {', '.join(removed) if len(removed) <= 10 else f'{len(removed)} dates'}")

    if old_total == 0:
        return  # nothing to lose
    total_loss_pct = max(0, (old_total - new_total)) * 100.0 / old_total
    if total_loss_pct > max_total_loss_pct:
        raise SanityCheckFailed(
            f"🚨 Refusing write — would remove {old_total - new_total} of "
            f"{old_total} entries ({total_loss_pct:.1f}% loss > "
            f"{max_total_loss_pct}% threshold). Removed dates: "
            f"{removed[:20]}{'...' if len(removed) > 20 else ''}"
        )

    if old_pending > 0:
        # Only count pending entries as truly lost if they DISAPPEARED from the
        # new array entirely — NOT when they gained kintai_created_at (that means
        # DokoKin confirmed them, which is expected after auto-OT-creator runs).
        old_pending_keys = set()
        for e in old_arr:
            if isinstance(e, dict) and not e.get("kintai_created_at"):
                key = (e.get("date"), e.get("start"), e.get("end"))
                old_pending_keys.add(key)
        # Check which old pending entries are no longer present at all
        new_all_keys = set()
        for e in new_arr:
            if isinstance(e, dict):
                key = (e.get("date"), e.get("start"), e.get("end"))
                new_all_keys.add(key)
        truly_lost = old_pending_keys - new_all_keys
        if truly_lost:
            loss_pct = len(truly_lost) * 100.0 / old_pending
            if loss_pct > max_pending_loss_pct:
                raise SanityCheckFailed(
                    f"🚨 Refusing write — would lose {len(truly_lost)} of "
                    f"{old_pending} PENDING entries (no kintai_created_at). "
                    f"{loss_pct:.1f}% loss > {max_pending_loss_pct}% threshold. "
                    f"Pending entries represent user-scheduled future OT not yet pushed "
                    f"to DokoKin — losing them silently wipes the user's schedule."
                )


def safe_patch_gist_file(pat: str, gist_id: str, filename: str,
                        new_content: str, snapshot,
                        shape_validator=None,
                        skip_backup: bool = False,
                        backup: bool = True,
                        log=None) -> int:
    """Atomically PATCH a gist file with safety rails.

    Args:
      pat: GH PAT with `gist` scope
      gist_id, filename: target
      new_content: the JSON string to write
      snapshot: dict from read_gist_file() taken at read time
      shape_validator: optional callable(parsed_new) → raises ShapeInvalid
      skip_backup: pass True if writing to a `.bak.json` file (avoid recursion)
      backup: when False, do NOT write a rolling `.bak.json` AND purge any existing
              one in the same PATCH. Use for REGENERABLE caches (timesheet, payslip)
              that can be re-fetched from DokoKin — their backups only bloat the gist
              (every read transfers them; large total trips secondary write limits).
      log: optional logger

    Behavior:
      1. Validates shape of new_content (json parse + shape_validator)
      2. Refetches gist; if current content hash != snapshot.sha → RaceDetected
      3. Builds atomic PATCH body containing BOTH:
           - filename → new_content
           - <stem>.bak.json → snapshot.content (rolling backup)
      4. Single PATCH (atomic at gist level)

    Returns HTTP status. Raises GistSafetyError subclasses on safety violations.
    """
    _log = log if callable(log) else (lambda m: None)

    # 1. Shape validation
    try:
        parsed_new = json.loads(new_content)
    except Exception as e:
        raise ShapeInvalid(f"new_content is not valid JSON: {e}")
    if shape_validator is not None:
        shape_validator(parsed_new)  # may raise ShapeInvalid

    # 2. Race detection (optimistic concurrency)
    current = read_gist_file(pat, gist_id, filename, log=_log)
    if current["sha"] != snapshot["sha"]:
        raise RaceDetected(
            f"🚨 Race detected: {filename} changed between read "
            f"(sha={snapshot['sha']}) and write (sha={current['sha']}). "
            f"Another writer modified the gist. Refusing PATCH to avoid "
            f"overwriting their changes."
        )

    # 3. Build atomic PATCH body
    files_payload = {filename: {"content": new_content}}
    # Derive the rolling-backup filename (used for either write or purge).
    if filename.endswith(".json"):
        bak_name = filename[:-5] + ".bak.json"
    else:
        bak_name = filename + ".bak"
    if not skip_backup and not backup:
        # Regenerable cache: skip the rolling backup AND delete any stale one so the
        # gist stays small. Setting the file to null in the PATCH deletes it.
        if bak_name in (current.get("all_files") or []):
            files_payload[bak_name] = None
            _log(f"🧹 Purging stale {bak_name} (backup disabled for regenerable cache)")
    elif not skip_backup and snapshot["content"]:
        # Rolling backup: stem.bak.json (e.g. ot-requests.json → ot-requests.bak.json)
        # Wrap backup content with metadata so it's self-describing
        bak_payload = {
            "_backup_of": filename,
            "_backup_at": datetime.now(JST).isoformat(timespec="seconds"),
            "_previous_sha": snapshot["sha"],
            "content": snapshot["parsed"]
                       if snapshot["parsed"] is not None
                       else snapshot["content"],
        }
        files_payload[bak_name] = {
            "content": json.dumps(bak_payload, indent=2, ensure_ascii=False)
        }
        _log(f"📦 Snapshotting previous {filename} → {bak_name} "
             f"(sha={snapshot['sha']}, size={len(snapshot['content'])}B)")

    # 4. Single atomic PATCH (with retry/backoff on GitHub's secondary rate
    #    limit). Two writers touching the SAME gist within ~a minute (e.g. the
    #    timesheet Action write + a timesheet Fetch) can trip a 403/429
    #    "secondary rate limit" even though the PATCH is otherwise valid. The
    #    request never applied, so retrying the identical body is safe.
    body = json.dumps({"files": files_payload}).encode()
    url = f"https://api.github.com/gists/{gist_id}"
    headers = {
        "Authorization": f"Bearer {pat}",
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
    }
    max_attempts = 4
    for attempt in range(1, max_attempts + 1):
        req = urllib.request.Request(url, data=body, method="PATCH", headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return resp.status
        except urllib.error.HTTPError as e:
            err_body = ""
            try:
                err_body = (e.read() or b"").decode(errors="replace")
            except Exception:
                pass
            retryable = e.code in (403, 429) or 500 <= e.code < 600
            if retryable and attempt < max_attempts:
                # Honor Retry-After when present; else exponential backoff.
                ra = e.headers.get("Retry-After") if e.headers else None
                try:
                    wait = int(ra) if ra else 0
                except (TypeError, ValueError):
                    wait = 0
                if wait <= 0:
                    wait = min(2 ** attempt, 20)  # 2, 4, 8 …
                snippet = err_body.strip().replace("\n", " ")[:160]
                _log(f"⚠️ Gist PATCH HTTP {e.code} (attempt {attempt}/{max_attempts}) "
                     f"— retrying in {wait}s · {snippet}")
                time.sleep(wait)
                continue
            # Out of retries (or non-retryable) → surface the real reason.
            snippet = err_body.strip().replace("\n", " ")[:300]
            _log(f"❌ Gist PATCH HTTP {e.code} (final) · {snippet}")
            raise
    # Unreachable, but keep the type checker happy.
    raise GistSafetyError("gist PATCH exhausted retries")


def validate_ot_requests_shape(parsed) -> None:
    """Raise ShapeInvalid if parsed is not a valid ot-requests.json shape.
    Accepts: list[dict] OR dict with 'requests' key → list[dict].
    """
    if isinstance(parsed, list):
        if any(not isinstance(e, (dict, type(None))) for e in parsed):
            raise ShapeInvalid("ot-requests array contains non-dict entries")
        return
    if isinstance(parsed, dict):
        if "requests" not in parsed:
            raise ShapeInvalid("ot-requests dict missing 'requests' key")
        if not isinstance(parsed["requests"], list):
            raise ShapeInvalid("ot-requests.requests is not a list")
        return
    raise ShapeInvalid(f"ot-requests root must be list or dict, got {type(parsed).__name__}")


def validate_scheduled_runs_shape(parsed) -> None:
    """Raise ShapeInvalid if parsed is not a valid scheduled-runs.json shape.
    MUST be a top-level array (dispatcher does `for entry in runs`).
    The 2026-05-XX wrap-as-{entries:[]} bug broke production until reverted.
    """
    if not isinstance(parsed, list):
        raise ShapeInvalid(
            f"scheduled-runs MUST be top-level array (dispatcher iterates it). "
            f"Got {type(parsed).__name__}. Wrapping as {{entries:[]}} breaks "
            f"the dispatcher silently."
        )
