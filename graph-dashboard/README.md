# Knowledge Graph Dashboard (Cloudflare Pages)

Static, read-only build of the **Understand-Anything** knowledge-graph dashboard for
this repo. It runs in **demo mode** (no access token gate) and loads the graph data
that sits next to it (`knowledge-graph.json` + `meta.json`).

It is deployed **separately** from the main PWA (which lives on GitHub Pages at
`docs/`). This directory is meant to be served as-is by **Cloudflare Pages** under its
own subdomain — no build step on Cloudflare's side.

> ⚠️ This repo is **public**, so the published graph (code structure + summaries, no
> secrets) is public too.

---

## What's in here

| Path | Role |
|---|---|
| `index.html` | Dashboard shell (absolute `/assets/...` paths, base `/`) |
| `assets/` | Built JS/CSS bundles (vendored from the plugin build) |
| `knowledge-graph.json` | The graph data the app fetches at runtime |
| `meta.json` | Repo metadata (commit, file count) |
| `favicon.*` | Icons |

The **shell** (`index.html` + `assets/`) rarely changes — only when the plugin is
upgraded. The **data** (`knowledge-graph.json` + `meta.json`) changes every time you
regenerate the graph with `/understand`.

---

## Deployed

This dashboard is **already deployed** as a Cloudflare Pages **direct-upload**
project named **`code-graph`**:

- Production URL: **https://code-graph.pages.dev**

It was deployed with:

```bash
wrangler pages project create code-graph --production-branch=main   # one-time
wrangler pages deploy graph-dashboard --project-name=code-graph --branch=main
```

### Attach a custom subdomain

1. Cloudflare → **Workers & Pages → `code-graph` → Custom domains → Set up a custom domain**.
2. Enter e.g. `graph.yourdomain.com`.
3. If the domain's DNS is on Cloudflare, the CNAME is added automatically. Otherwise
   add a `CNAME` record at your DNS provider:
   ```
   graph   CNAME   code-graph.pages.dev
   ```
4. Wait for TLS to provision (usually < 1 min on Cloudflare DNS).

---

## Auto-deploy & refreshing the graph

Because this is a **direct-upload** project (not Git-connected), pushes don't deploy
by themselves — the **`sync-graph-dashboard.yml`** workflow does it. On every push that
changes `.understand-anything/knowledge-graph.json`, it:

1. mirrors the graph JSON into `graph-dashboard/`, commits it, and
2. runs `wrangler pages deploy` to publish to `code-graph.pages.dev`.

**To enable the auto-deploy step**, add two repo secrets (Settings → Secrets and
variables → Actions):

| Secret | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | A token with **Account → Cloudflare Pages → Edit** permission |
| `CLOUDFLARE_ACCOUNT_ID` | `a896a3a2d8ca89b680f7fa9642d66f0d` |

Without the token the workflow still mirrors + commits the graph, then skips the deploy
(you can deploy manually with the `wrangler pages deploy` command above).

What CI **cannot** do is regenerate the graph: a full `/understand` run needs the LLM
agent, which doesn't run in plain GitHub Actions. So the flow is:

1. **Locally**, regenerate the graph (ask the agent to run `/understand`).
2. Sync it into this directory:
   ```bash
   node scripts/sync-graph-dashboard.mjs
   ```
   (Or just commit `.understand-anything/knowledge-graph.json` — the workflow mirrors
   and deploys it automatically.)
3. `git push` → workflow redeploys the updated graph.

---

## Rebuilding the shell (rare)

Only needed when the Understand-Anything plugin is upgraded. From the plugin's
dashboard package:

```bash
# in <plugin>/packages/dashboard
npx vite build --config vite.config.demo.ts --base=/
```
with env `VITE_GRAPH_URL=/knowledge-graph.json` and `VITE_META_URL=/meta.json`.
Then copy `dist/*` over this directory and re-run the sync script.
