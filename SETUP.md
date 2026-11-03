# Fork Setup Guide

Quick guide to set up your own DokoKin automation instance after forking this repo.

## Prerequisites

- GitHub account (public repo for unlimited Actions minutes)
- FJP Azure AD credentials (same as DokoKin mobile app)
- A GitHub Gist for schedule/OT storage

## Step 1: Fork & Clone

```bash
gh repo fork VuTan11501/Code --clone
cd Code
```

## Step 2: Create Your Gist

Create a **secret** Gist with these files:
- `scheduled-runs.json` — content: `{"entries":[]}`
- `ot-requests.json` — content: `[]`
- `user-settings.json` — content: `{}`

Note the Gist ID from the URL (e.g. `abc123def456...`).

> ⚠️ **Keep the Gist secret — never public.** It will contain your work
> hours, timesheets, OT records and (transiently) token state, and Gist
> revision history keeps every past version. A secret Gist works everywhere:
> the workflows read/write it with your `GH_PAT`, and the dashboard reads it
> with your own GitHub PAT at the login screen (or via the Worker proxy —
> see Step 6).

## Step 3: Set Repository Variables

Go to **Settings → Secrets and variables → Actions → Variables** tab:

| Variable | Value | Required |
|---|---|---|
| `GIST_ID` | Your Gist ID | ✅ |
| `EMPLOYEE_ID` | Your FJP employee number | ✅ |
| `BASE_HOURLY_RATE` | Your base hourly rate (¥) | Optional (default: 1563) |

## Step 4: Set Repository Secrets

Go to **Settings → Secrets and variables → Actions → Secrets** tab:

| Secret | Value | Notes |
|---|---|---|
| `AZURE_REFRESH_TOKEN` | Azure AD refresh token | Run `python .github/skills/dokokin-azure-login/scripts/azure_login.py` to obtain |
| `GH_PAT` | Classic PAT with `repo` + `gist` + `workflow` scopes | For dispatching workflows + Gist writes |
| `SMTP_USER` | Gmail address | For email notifications |
| `SMTP_PASS` | Gmail App Password | [Generate here](https://myaccount.google.com/apppasswords) |
| `NOTIFY_EMAIL` | Email to receive notifications | Can be same as SMTP_USER |
| `LINE_NOTIFY_TOKEN` | LINE Notify token | Optional — for failure alerts |

## Step 5: Get Azure AD Token

```bash
cd .github/skills/dokokin-azure-login/scripts
python azure_login.py --setup
```

Follow the browser prompt to authenticate. Copy the refresh token and set it:
```bash
gh secret set AZURE_REFRESH_TOKEN --body "<your_refresh_token>"
```

## Step 6: Configure Dashboard

Open the PWA dashboard. In **Settings**, the following are auto-configured from your localStorage:
- **Gist ID** — set `wf_dash_gist_id` in localStorage (or it uses the code default)
- **Owner/Repo** — set `wf_dash_owner` and `wf_dash_repo`

Or simply edit `docs/js/app.js` lines 4-7 with your values before deploying.

**Gist access — the dashboard never reads the Gist unauthenticated**, so your secret Gist works with one of:

1. **Login screen (simplest)** — when the dashboard opens, paste a classic GitHub PAT (`ghp_...`) with the same scopes as your `GH_PAT` (`repo` + `gist` + `workflow`). It is encrypted in your browser (AES-256-GCM) and only ever sent to `api.github.com`.
2. **Worker proxy (recommended — no PAT in the browser)** — deploy `worker/` per `worker/SETUP-GUIDE.md` (`wrangler deploy`), then set its URL in **Settings → GitHub API Proxy** on the dashboard. The PAT stays encrypted in the Worker; DevTools shows no `Authorization` header.

## Step 7: Enable GitHub Pages

Go to **Settings → Pages** → Source: `Deploy from a branch` → Branch: `main`, folder: `/docs`.

## Step 8: Verify

1. Manually trigger `Scheduled Run Dispatcher` workflow
2. Check Actions tab — dispatcher should start its 2h loop
3. Add a test schedule entry via the dashboard
4. Confirm it dispatches within 30s

## Optional: External Heartbeat

For maximum reliability, set up a Cloudflare Worker or cron-job.org to POST `repository_dispatch` events:

```bash
cd cloudflare-worker
# Edit wrangler.toml with your repo details
wrangler secret put GH_PAT
wrangler deploy
```

## Environment Variables Reference

All backend scripts read from `user_config.py` which checks these env vars:

| Env Var | Default | Description |
|---|---|---|
| `EMPLOYEE_ID` | `8883` | FJP Employee ID |
| `GIST_ID` | `abc2a47c...` | GitHub Gist for storage |
| `BASE_HOURLY_RATE` | `1563` | Base hourly rate (¥) |
| `API_BASE` | `https://api.fjpservice.com/api/` | DokoKin API base URL |
| `AZURE_APP_ID` | `f5be0f68-...` | Azure AD App ID |
| `AZURE_TENANT` | `f01e930a-...` | Azure AD Tenant ID |
| `USER_DISPLAY_NAME` | `TanVC` | Display name in notifications |
