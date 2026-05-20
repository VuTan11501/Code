#!/usr/bin/env python3
"""Shared OpenAI-compatible HTTP client for GitHub Models / Azure AI.
Zero external dependencies (stdlib only). Reused by P2 Anomaly Detective and P4.

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


def chat_completion(messages, model="gpt-4o-mini", tools=None, temperature=0.2,
                    max_tokens=800, timeout=30):
    """Non-streaming chat completion. Returns parsed response dict or None on failure.

    Retries up to 2 times on 429/5xx with exponential backoff.
    Never raises — returns None on terminal failure.
    """
    if not AI_TOKEN:
        _log("ERROR: GH_PAT not set, cannot call AI")
        return None

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
    for attempt in range(max_retries + 1):
        try:
            req = urllib.request.Request(url, data=body, headers=headers, method="POST")
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                data = json.loads(resp.read())
                _log(f"OK model={model} tokens={data.get('usage', {})}")
                return _wrap_response(data)
        except urllib.error.HTTPError as e:
            status = e.code
            err_body = e.read().decode(errors="replace")[:300]
            _log(f"HTTP {status} (attempt {attempt+1}/{max_retries+1}): {err_body}")
            if status in (429, 500, 502, 503, 504) and attempt < max_retries:
                wait = 2 ** (attempt + 1)
                _log(f"Retrying in {wait}s...")
                time.sleep(wait)
                continue
            return None
        except Exception as e:
            _log(f"Error (attempt {attempt+1}): {e}")
            if attempt < max_retries:
                time.sleep(2 ** (attempt + 1))
                continue
            return None
    return None


class _wrap_response:
    """Lightweight wrapper to access response content easily."""

    def __init__(self, data):
        self._data = data

    @property
    def content(self):
        choices = self._data.get("choices", [])
        if choices:
            return choices[0].get("message", {}).get("content", "")
        return ""

    def __getitem__(self, key):
        return self._data[key]

    def get(self, key, default=None):
        return self._data.get(key, default)
