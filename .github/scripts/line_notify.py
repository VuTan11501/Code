#!/usr/bin/env python3
"""Send LINE Notify message. Requires LINE_NOTIFY_TOKEN env var.

Usage:
    python line_notify.py "Your message here"
    echo "message" | python line_notify.py --stdin

Zero external dependencies (stdlib only).
"""
import os
import sys
import urllib.parse
import urllib.request


def send(message):
    """Send a message via LINE Notify API."""
    token = os.environ.get("LINE_NOTIFY_TOKEN")
    if not token:
        print("LINE_NOTIFY_TOKEN not set, skipping")
        return False

    data = urllib.parse.urlencode({"message": message}).encode()
    req = urllib.request.Request(
        "https://notify-api.line.me/api/notify",
        data=data,
        headers={"Authorization": f"Bearer {token}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as res:
            print(f"LINE Notify: {res.status}")
            return res.status == 200
    except Exception as e:
        print(f"LINE Notify error: {e}", file=sys.stderr)
        return False


if __name__ == "__main__":
    if "--stdin" in sys.argv:
        msg = sys.stdin.read().strip()
    else:
        msg = " ".join(a for a in sys.argv[1:] if a != "--stdin")

    if not msg:
        msg = "Test notification"

    success = send(msg)
    sys.exit(0 if success else 1)
