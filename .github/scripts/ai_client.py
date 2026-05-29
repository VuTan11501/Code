#!/usr/bin/env python3
"""Shared OpenAI-compatible HTTP client for GitHub Models / Azure AI.
Zero external dependencies (stdlib only). Reused by P2 Anomaly Detective and P4.

Returns structured result dict:
  {"ok": bool, "content": str, "error": str, "status": int, "model": str, "usage": dict|None}

Env vars:
  AI_API_BASE  — endpoint (default: https://models.inference.ai.azure.com)
  GH_PAT       — bearer token for GitHub Models
"""
import json
import os
import sys
import time
import urllib.request
import urllib.error

_PREFIX = "[ai_client]"

AI_API_BASE = os.environ.get("AI_API_BASE", "https://models.inference.ai.azure.com")
AI_TOKEN = os.environ.get("GH_PAT", "")


def _log(msg):
    print(f"{_PREFIX} {msg}", file=sys.stderr)


def _result(ok, content="", error="", status=0, model="", usage=None):
    """Build a structured result dict."""
    return {
        "ok": ok,
        "content": content,
        "error": error,
        "status": status,
        "model": model,
        "usage": usage,
    }


def chat_completion(messages, model="gpt-4o-mini", tools=None, temperature=0.2,
                    max_tokens=800, timeout=30):
    """Non-streaming chat completion. Returns structured result dict (never raises).

    Retries up to 2 times on 429/5xx with exponential backoff.
    """
    if not AI_TOKEN:
        _log("ERROR: GH_PAT not set, cannot call AI")
        return _result(False, error="GH_PAT not set", model=model)

    url = f"{AI_API_BASE.rstrip('/')}/chat/completions"
    payload = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    if tools:
        payload["tools"] = tools

    body = json.dumps(payload).encode("utf-8")
    headers = {
        "Authorization": f"Bearer {AI_TOKEN}",
        "Content-Type": "application/json",
    }

    max_retries = 2
    last_err = ""
    for attempt in range(max_retries + 1):
        try:
            req = urllib.request.Request(url, data=body, headers=headers, method="POST")
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
                try:
                    data = json.loads(raw)
                except (json.JSONDecodeError, ValueError) as je:
                    _log(f"JSON parse error: {je}")
                    return _result(False, error=f"JSON parse error: {je}",
                                   status=200, model=model)
                usage = data.get("usage")
                _log(f"OK model={model} tokens={usage}")
                choices = data.get("choices", [])
                content = ""
                if choices:
                    content = choices[0].get("message", {}).get("content", "") or ""
                return _result(True, content=content, status=200,
                               model=model, usage=usage)
        except urllib.error.HTTPError as e:
            status = e.code
            err_body = e.read().decode(errors="replace")[:300]
            last_err = f"HTTP {status}: {err_body}"
            _log(f"HTTP {status} (attempt {attempt+1}/{max_retries+1}): {err_body}")
            if status in (429, 500, 502, 503, 504) and attempt < max_retries:
                wait = 2 ** (attempt + 1)
                _log(f"Retrying in {wait}s...")
                time.sleep(wait)
                continue
            return _result(False, error=last_err, status=status, model=model)
        except urllib.error.URLError as e:
            last_err = f"URLError: {e.reason}"
            _log(f"URLError (attempt {attempt+1}): {e.reason}")
            if attempt < max_retries:
                time.sleep(2 ** (attempt + 1))
                continue
        except TimeoutError as e:
            last_err = f"Timeout: {e}"
            _log(f"Timeout (attempt {attempt+1}): {e}")
            if attempt < max_retries:
                time.sleep(2 ** (attempt + 1))
                continue
        except Exception as e:
            last_err = f"Error: {e}"
            _log(f"Error (attempt {attempt+1}): {e}")
            if attempt < max_retries:
                time.sleep(2 ** (attempt + 1))
                continue
            return _result(False, error=last_err, status=0, model=model)

    return _result(False, error=f"retries exhausted: {last_err}", status=0, model=model)


# ── Self-test ──

def _self_test():
    """Validate result shape without hitting real API."""
    import unittest.mock

    fake_response_body = json.dumps({
        "choices": [{"message": {"content": "Hello"}}],
        "usage": {"prompt_tokens": 5, "completion_tokens": 3},
    }).encode()

    mock_resp = unittest.mock.MagicMock()
    mock_resp.read.return_value = fake_response_body
    mock_resp.__enter__ = lambda s: s
    mock_resp.__exit__ = unittest.mock.MagicMock(return_value=False)

    # Temporarily set token at module level
    global AI_TOKEN
    orig = AI_TOKEN
    with unittest.mock.patch("urllib.request.urlopen", return_value=mock_resp):
        AI_TOKEN = "fake-token-for-test"
        try:
            r = chat_completion([{"role": "user", "content": "hi"}], model="test-model")
        finally:
            AI_TOKEN = orig

    # Shape assertions
    assert isinstance(r, dict), f"Expected dict, got {type(r)}"
    assert r["ok"] is True, f"Expected ok=True, got {r}"
    assert r["content"] == "Hello", f"Content mismatch: {r['content']}"
    assert r["error"] == "", f"Error should be empty: {r['error']}"
    assert r["status"] == 200
    assert r["model"] == "test-model"
    assert r["usage"] is not None

    # Test error path (no token)
    AI_TOKEN = ""
    r2 = chat_completion([{"role": "user", "content": "hi"}])
    AI_TOKEN = orig
    assert r2["ok"] is False
    assert "GH_PAT" in r2["error"]
    assert r2["content"] == ""

    print(f"{_PREFIX} [OK] Self-test passed - result shape OK")


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        _self_test()
    else:
        print("Usage: python ai_client.py --self-test")
        sys.exit(1)
