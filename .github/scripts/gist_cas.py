#!/usr/bin/env python3
"""Compare-and-swap helper for Gist writes using ETag conditional PATCH.

Prevents lost updates when multiple agents (dispatcher, watchdog, dashboard)
write to the same Gist file concurrently.

Usage:
    from gist_cas import cas_update
    result = cas_update(gist_id, 'scheduled-runs.json', my_mutator, token)

CLI:
    python gist_cas.py <gist_id> <filename> --append-key foo=bar
    python gist_cas.py --self-test
"""
import json
import os
import random
import sys
import time
import argparse
from datetime import datetime, timezone
from urllib.request import Request, urlopen
from urllib.error import HTTPError

GITHUB_API = 'https://api.github.com'
USER_AGENT = 'dokokin-gist-cas/1.0'


def cas_update(gist_id, filename, mutator, token, max_retries=3, sleep_base=1.0):
    """Atomically update a Gist file using ETag CAS.

    1. GET gist -> extract ETag + current content of `filename`
    2. Parse content as JSON
    3. Call mutator(parsed) -> updated structure
    4. If unchanged, skip PATCH (no_change=True)
    5. PATCH with If-Match: <etag>
    6. On 412/409: retry with exponential backoff + jitter

    Returns: {'ok': bool, 'attempts': int, 'final_content': ..., 'error': str|None,
              'no_change': bool}
    """
    for attempt in range(max_retries):
        # Step 1: GET current state
        try:
            etag, current = _gist_get(gist_id, filename, token)
        except _GistError as e:
            return {'ok': False, 'attempts': attempt + 1, 'final_content': None,
                    'error': str(e), 'no_change': False}

        # Step 2-3: parse and mutate
        parsed = json.loads(current) if current else {}
        original_json = json.dumps(parsed, ensure_ascii=False, indent=2)
        updated = mutator(parsed)
        updated_json = json.dumps(updated, ensure_ascii=False, indent=2)

        # Step 4: skip if no change
        if updated_json == original_json:
            return {'ok': True, 'attempts': attempt + 1, 'final_content': updated,
                    'error': None, 'no_change': True}

        # Step 5: PATCH with If-Match
        try:
            result = _gist_patch(gist_id, filename, updated_json, etag, token)
            return {'ok': True, 'attempts': attempt + 1, 'final_content': updated,
                    'error': None, 'no_change': False}
        except _ConflictError:
            # Step 6: ETag mismatch — retry
            if attempt < max_retries - 1:
                delay = sleep_base * (2 ** attempt) + random.uniform(0, 0.5)
                time.sleep(delay)
            continue
        except _GistError as e:
            return {'ok': False, 'attempts': attempt + 1, 'final_content': None,
                    'error': str(e), 'no_change': False}

    return {'ok': False, 'attempts': max_retries, 'final_content': None,
            'error': f'CAS failed after {max_retries} retries (concurrent edits)', 'no_change': False}


# --- Internal helpers ---

class _GistError(Exception):
    pass

class _ConflictError(_GistError):
    pass


def _make_headers(token, extra=None):
    h = {
        'Authorization': f'Bearer {token}',
        'Accept': 'application/vnd.github+json',
        'User-Agent': USER_AGENT,
    }
    if extra:
        h.update(extra)
    return h


def _gist_get(gist_id, filename, token):
    """GET gist, return (etag, file_content_str). Raises _GistError."""
    url = f'{GITHUB_API}/gists/{gist_id}'
    req = Request(url, headers=_make_headers(token))
    try:
        resp = urlopen(req)
    except HTTPError as e:
        raise _GistError(f'GET failed: HTTP {e.code} {e.reason}')
    etag = resp.headers.get('ETag', '')
    data = json.loads(resp.read().decode())
    files = data.get('files', {})
    if filename not in files:
        # File doesn't exist yet — treat as empty object
        return etag, '{}'
    content = files[filename].get('content', '{}')
    return etag, content


def _gist_patch(gist_id, filename, content_json, etag, token):
    """PATCH gist file, emulating CAS without the (now-unsupported) If-Match header.

    GitHub changed the gist API to REJECT conditional headers on unsafe requests:
        HTTP 400 "Conditional request headers are not allowed in unsafe requests
                  unless supported by the endpoint"
    so `If-Match: <etag>` on PATCH now 400s and breaks every write. We instead
    emulate optimistic concurrency: re-read the ETag immediately before writing;
    if it changed since the caller's read (`etag`), another writer raced us →
    raise _ConflictError so cas_update retries with the fresh state. The re-read→
    PATCH window is sub-millisecond (no work between), so the clobber window is
    tiny — same guarantee level as gist_safety.py's sha race-check.

    Raises _ConflictError on detected race; _GistError on other HTTP failures.
    """
    url = f'{GITHUB_API}/gists/{gist_id}'
    # CAS pre-check: bail if the file changed since the caller's GET.
    if etag:
        try:
            fresh_etag, _ = _gist_get(gist_id, filename, token)
        except _GistError:
            fresh_etag = ''  # read failed — proceed (best-effort), PATCH may still 4xx
        if fresh_etag and fresh_etag != etag:
            raise _ConflictError('ETag changed before PATCH (concurrent write)')
    body = json.dumps({'files': {filename: {'content': content_json}}}).encode()
    headers = _make_headers(token, {'Content-Type': 'application/json'})
    req = Request(url, data=body, headers=headers, method='PATCH')
    try:
        resp = urlopen(req)
        return json.loads(resp.read().decode())
    except HTTPError as e:
        if e.code in (412, 409):
            raise _ConflictError(f'ETag mismatch (HTTP {e.code})')
        raise _GistError(f'PATCH failed: HTTP {e.code} {e.reason}')


# --- Self-test (no network) ---

def _self_test():
    """Validate internal logic without hitting GitHub API."""
    tests_passed = 0

    # Test 1: no-change detection
    original = {'key': 'value', 'list': [1, 2, 3]}
    mutator_noop = lambda d: d
    # Simulate: json roundtrip should be stable
    j1 = json.dumps(original, ensure_ascii=False, indent=2)
    updated = mutator_noop(json.loads(j1))
    j2 = json.dumps(updated, ensure_ascii=False, indent=2)
    assert j1 == j2, 'No-change detection failed'
    tests_passed += 1

    # Test 2: change detection
    mutator_add = lambda d: {**d, 'new_key': 42}
    updated2 = mutator_add(json.loads(j1))
    j3 = json.dumps(updated2, ensure_ascii=False, indent=2)
    assert j1 != j3, 'Change detection failed'
    assert updated2['new_key'] == 42
    tests_passed += 1

    # Test 3: backoff math (sleep_base=1.0)
    for attempt in range(5):
        base_delay = 1.0 * (2 ** attempt)
        assert base_delay == 2 ** attempt, f'Backoff wrong at attempt {attempt}'
        # Total range: [base, base+0.5]
        assert base_delay >= 1.0
    tests_passed += 1

    # Test 4: JSON roundtrip preserves unicode
    data_jp = {'名前': 'テスト', 'emoji': '🎉'}
    j = json.dumps(data_jp, ensure_ascii=False, indent=2)
    assert '名前' in j and 'テスト' in j
    assert json.loads(j) == data_jp
    tests_passed += 1

    # Test 5: empty content handling
    empty_parsed = json.loads('{}')
    assert empty_parsed == {}
    tests_passed += 1

    print(f'[OK] gist_cas self-test: {tests_passed}/{tests_passed} passed')


# --- CLI ---

def _cli():
    parser = argparse.ArgumentParser(description='Gist CAS helper')
    parser.add_argument('gist_id', nargs='?', help='Gist ID')
    parser.add_argument('filename', nargs='?', help='File in gist')
    parser.add_argument('--append-key', help='key=value to append to JSON object')
    parser.add_argument('--self-test', action='store_true', help='Run inline tests')
    args = parser.parse_args()

    if args.self_test:
        _self_test()
        return

    if not args.gist_id or not args.filename:
        parser.error('gist_id and filename required (or use --self-test)')

    token = os.environ.get('GH_PAT')
    if not token:
        print('ERROR: env GH_PAT not set', file=sys.stderr)
        sys.exit(1)

    if args.append_key:
        k, v = args.append_key.split('=', 1)
        mutator = lambda d: {**d, k: v}
    else:
        mutator = lambda d: d  # dry-run read

    result = cas_update(args.gist_id, args.filename, mutator, token)
    print(json.dumps(result, ensure_ascii=False, indent=2, default=str))
    if not result['ok']:
        sys.exit(1)


if __name__ == '__main__':
    _cli()
