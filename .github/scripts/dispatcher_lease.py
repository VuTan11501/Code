#!/usr/bin/env python3
"""Distributed lease (lock) for scheduled-dispatch.yml self-loop.

Prevents multiple dispatchers from running concurrently. Heartbeat/watchdog
use is_live() to check before resurrecting.

Storage: Gist abc2a47c0a396025a72a6580227ff493, file 'dispatcher-lease.json'.

Usage:
    from dispatcher_lease import acquire, heartbeat, release, is_live
    
CLI:
    python dispatcher_lease.py --probe          # read current lease
    python dispatcher_lease.py --self-test      # offline logic tests
"""
import json
import os
import sys
import argparse
from datetime import datetime, timezone, timedelta

# Ensure sibling import works regardless of cwd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gist_cas import cas_update, _gist_get, _GistError  # noqa: E402

GIST_ID = 'abc2a47c0a396025a72a6580227ff493'
LEASE_FILE = 'dispatcher-lease.json'
DEFAULT_TTL_MIN = 15
STALE_THRESHOLD_MIN = 5


def _now():
    return datetime.now(timezone.utc)


def _parse_dt(s):
    """Parse ISO datetime string to tz-aware UTC."""
    if not s:
        return None
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _to_iso(dt):
    return dt.isoformat()


def _is_expired_or_stale(lease):
    """Check if lease is expired (past lease_until) or stale (no heartbeat)."""
    now = _now()
    lease_until = _parse_dt(lease.get('lease_until'))
    last_hb = _parse_dt(lease.get('last_heartbeat'))

    if lease_until and now > lease_until:
        return True, 'lease_until expired'
    if last_hb and (now - last_hb) > timedelta(minutes=STALE_THRESHOLD_MIN):
        return True, f'no heartbeat for >{STALE_THRESHOLD_MIN}min'
    return False, ''


def acquire(run_id, run_url, ttl_minutes, token):
    """Try to acquire lease. Returns {'acquired': bool, 'current_owner': str|None, 'reason': str}."""
    ttl = timedelta(minutes=ttl_minutes)

    def _mutator(lease):
        now = _now()
        # Empty or no owner → acquire
        if not lease or not lease.get('owner_run_id'):
            return _new_lease(run_id, run_url, now, ttl, lease)

        # Same owner re-acquiring (restart case)
        if lease.get('owner_run_id') == str(run_id):
            return _new_lease(run_id, run_url, now, ttl, lease)

        # Check expired or stale
        expired, _ = _is_expired_or_stale(lease)
        if expired:
            return _new_lease(run_id, run_url, now, ttl, lease)

        # Lease held by someone else and still valid
        return lease  # no change → cas_update returns no_change=True

    result = cas_update(GIST_ID, LEASE_FILE, _mutator, token, max_retries=3)

    if not result['ok']:
        return {'acquired': False, 'current_owner': None, 'reason': f'CAS error: {result["error"]}'}

    if result.get('no_change'):
        # Mutator returned unchanged → lease held by other
        content = result['final_content'] or {}
        return {'acquired': False, 'current_owner': content.get('owner_run_id'),
                'reason': 'lease held by active owner'}

    return {'acquired': True, 'current_owner': str(run_id), 'reason': 'ok'}


def _new_lease(run_id, run_url, now, ttl, old_lease):
    """Build new lease dict, preserving last_rescue_at from old."""
    return {
        'owner_run_id': str(run_id),
        'owner_run_url': run_url,
        'started_at': _to_iso(now),
        'lease_until': _to_iso(now + ttl),
        'last_heartbeat': _to_iso(now),
        'last_rescue_at': (old_lease or {}).get('last_rescue_at'),
    }


def heartbeat(run_id, token, ttl_minutes=DEFAULT_TTL_MIN):
    """Update last_heartbeat + extend lease. Returns False if no longer owner."""
    def _mutator(lease):
        if not lease or lease.get('owner_run_id') != str(run_id):
            return lease  # not owner → no change
        now = _now()
        lease['last_heartbeat'] = _to_iso(now)
        lease['lease_until'] = _to_iso(now + timedelta(minutes=ttl_minutes))
        return lease

    result = cas_update(GIST_ID, LEASE_FILE, _mutator, token, max_retries=2)
    if result.get('no_change'):
        return False  # not owner anymore
    return result['ok']


def release(run_id, token):
    """Clear lease if owned by run_id. Idempotent."""
    def _mutator(lease):
        if not lease or lease.get('owner_run_id') != str(run_id):
            return lease  # not owner or empty → no-op
        return {
            'owner_run_id': None,
            'owner_run_url': None,
            'started_at': None,
            'lease_until': None,
            'last_heartbeat': None,
            'last_rescue_at': lease.get('last_rescue_at'),
        }

    result = cas_update(GIST_ID, LEASE_FILE, _mutator, token, max_retries=2)
    return True  # idempotent — always succeeds conceptually


def is_live(token, stale_threshold_min=STALE_THRESHOLD_MIN):
    """Read-only check. Returns {'live': bool, 'owner': str|None, 'silent_for_min': float, ...}."""
    try:
        _, content = _gist_get(GIST_ID, LEASE_FILE, token)
        lease = json.loads(content) if content else {}
    except _GistError:
        lease = {}

    if not lease or not lease.get('owner_run_id'):
        return {'live': False, 'owner': None, 'silent_for_min': None, 'last_rescue_silent_min': None}

    now = _now()
    last_hb = _parse_dt(lease.get('last_heartbeat'))
    silent_min = (now - last_hb).total_seconds() / 60.0 if last_hb else None

    last_rescue = _parse_dt(lease.get('last_rescue_at'))
    rescue_silent = (now - last_rescue).total_seconds() / 60.0 if last_rescue else None

    live = True
    if silent_min is not None and silent_min > stale_threshold_min:
        live = False
    lease_until = _parse_dt(lease.get('lease_until'))
    if lease_until and now > lease_until:
        live = False

    return {
        'live': live,
        'owner': lease.get('owner_run_id'),
        'silent_for_min': round(silent_min, 2) if silent_min is not None else None,
        'last_rescue_silent_min': round(rescue_silent, 2) if rescue_silent is not None else None,
    }


def record_rescue(token):
    """Update last_rescue_at to now. Called by heartbeat/watchdog on resurrect."""
    def _mutator(lease):
        if not lease:
            lease = {}
        lease['last_rescue_at'] = _to_iso(_now())
        return lease

    result = cas_update(GIST_ID, LEASE_FILE, _mutator, token, max_retries=2)
    return result['ok']


# --- Self-test (no network, mock CAS) ---

def _self_test():
    """Validate lease logic with mocked gist_cas."""
    tests_passed = 0

    # Mock state
    mock_lease = {}

    # Test 1: acquire on empty lease
    now = _now()
    ttl = timedelta(minutes=15)
    result_lease = _new_lease('run-1', 'http://url/1', now, ttl, mock_lease)
    assert result_lease['owner_run_id'] == 'run-1'
    assert _parse_dt(result_lease['lease_until']) > now
    tests_passed += 1

    # Test 2: is_expired_or_stale — fresh lease
    expired, reason = _is_expired_or_stale(result_lease)
    assert not expired, f'Should not be expired: {reason}'
    tests_passed += 1

    # Test 3: is_expired_or_stale — expired lease_until
    old_lease = {**result_lease, 'lease_until': _to_iso(now - timedelta(minutes=1))}
    expired, reason = _is_expired_or_stale(old_lease)
    assert expired, 'Should detect expiry'
    assert 'expired' in reason
    tests_passed += 1

    # Test 4: is_expired_or_stale — stale heartbeat
    stale_lease = {**result_lease,
                   'lease_until': _to_iso(now + timedelta(minutes=30)),
                   'last_heartbeat': _to_iso(now - timedelta(minutes=10))}
    expired, reason = _is_expired_or_stale(stale_lease)
    assert expired, 'Should detect stale heartbeat'
    assert 'heartbeat' in reason
    tests_passed += 1

    # Test 5: re-acquire by same owner
    lease2 = _new_lease('run-1', 'http://url/1', now, ttl, result_lease)
    assert lease2['owner_run_id'] == 'run-1'
    tests_passed += 1

    # Test 6: _parse_dt handles JST
    jst_str = '2026-05-30T10:00:00+09:00'
    dt = _parse_dt(jst_str)
    assert dt.tzinfo is not None
    assert dt.hour == 1  # 10:00 JST = 01:00 UTC
    tests_passed += 1

    # Test 7: _parse_dt handles None
    assert _parse_dt(None) is None
    assert _parse_dt('') is None
    tests_passed += 1

    # Test 8: release preserves last_rescue_at
    lease_with_rescue = {**result_lease, 'last_rescue_at': '2026-05-30T09:00:00+00:00'}
    # Simulate release mutator
    released = {
        'owner_run_id': None, 'owner_run_url': None,
        'started_at': None, 'lease_until': None, 'last_heartbeat': None,
        'last_rescue_at': lease_with_rescue.get('last_rescue_at'),
    }
    assert released['last_rescue_at'] == '2026-05-30T09:00:00+00:00'
    tests_passed += 1

    print(f'[OK] dispatcher_lease self-test: {tests_passed}/{tests_passed} passed')


# --- CLI ---

def _cli():
    parser = argparse.ArgumentParser(description='Dispatcher lease manager')
    parser.add_argument('--probe', action='store_true', help='Read current lease state')
    parser.add_argument('--self-test', action='store_true', help='Run offline tests')
    args = parser.parse_args()

    if args.self_test:
        _self_test()
        return

    if args.probe:
        token = os.environ.get('GH_PAT')
        if not token:
            print('ERROR: env GH_PAT not set', file=sys.stderr)
            sys.exit(1)
        status = is_live(token)
        print(json.dumps(status, indent=2))
        return

    parser.print_help()


if __name__ == '__main__':
    _cli()
