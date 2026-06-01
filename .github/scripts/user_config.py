"""Centralized user configuration for DokoKin automation scripts.

All user-specific values are read from environment variables with sensible
defaults (matching the original author's setup). A new user only needs to
set the relevant env vars (via GitHub repository variables or .env file)
to customize the system for their own account.

Environment variables:
  EMPLOYEE_ID        — DokoKin employee ID (integer)
  GIST_ID            — Legacy shared GitHub Gist ID (all domains)
  GIST_ID_TIMESHEET  — Optional timesheet shard gist ID
  GIST_ID_PAYSLIP    — Optional payslip shard gist ID
  BASE_HOURLY_RATE   — Base hourly rate in JPY for OT calculations
  USER_DISPLAY_NAME  — Display name for notifications/AI prompts
  USER_SHORT_NAME    — Short username (e.g. "TanVC")

All values have defaults matching the original setup so existing deployments
continue to work without any env var changes.
"""
import os

# ── Employee identity ──
EMPLOYEE_ID = int(os.environ.get("EMPLOYEE_ID", "8883"))
USER_DISPLAY_NAME = os.environ.get("USER_DISPLAY_NAME", "Vu Cao Tan")
USER_SHORT_NAME = os.environ.get("USER_SHORT_NAME", "TanVC")

# ── Gist storage ──
# Single legacy gist (back-compat). Per-domain shards can override:
#   GIST_ID_TIMESHEET → timesheet-history.json
#   GIST_ID_PAYSLIP   → payslip-history.json
# Both fall back to GIST_ID when unset.
GIST_ID = os.environ.get("GIST_ID") or "abc2a47c0a396025a72a6580227ff493"
GIST_ID_TIMESHEET = os.environ.get("GIST_ID_TIMESHEET") or GIST_ID
GIST_ID_PAYSLIP = os.environ.get("GIST_ID_PAYSLIP") or GIST_ID

# ── Compensation ──
BASE_HOURLY_RATE = int(os.environ.get("BASE_HOURLY_RATE", "1563"))

# ── DokoKin API ──
API_BASE = os.environ.get("DOKOKIN_API_BASE", "https://api.fjpservice.com/api/")

# ── Azure AD (rarely changed, but abstractable) ──
AZURE_APP_ID = os.environ.get("AZURE_APP_ID", "f5be0f68-7285-4365-b979-10af0f3f4106")
AZURE_TENANT = os.environ.get("AZURE_TENANT", "f01e930a-b52e-42b1-b70f-a8882b5d043b")

# ── Convenience: account dict (used by timesheet/payslip fetchers) ──
ACCOUNT = {
    "employee_id": EMPLOYEE_ID,
    "display_name": USER_DISPLAY_NAME,
    "short_name": USER_SHORT_NAME,
}
