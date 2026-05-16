---
name: rakuraku-suica-expense
description: 'Automate filing Mobile Suica transit expenses into Rakuraku Seisan (楽楽精算) web app. USE WHEN: user has a Suica/PASMO PDF statement (e.g. JE80FE...remapped.pdf) and wants to bulk-create a transit expense voucher (交通費伝票) in rssieve.rakurakuseisan.jp, saving as draft (一時保存) for manual review before 申請. Handles PDF parsing → trips.json → browser automation via Playwright MCP relay → meisai insertion loop → 一時保存 → verification via list/detail view → duplicate detection & cleanup. DO NOT USE FOR: actually submitting (申請) the voucher — user always reviews and submits manually; non-Suica expense types; other Japanese expense systems (Concur, freee, etc.).'
---

# Rakuraku Seisan — Bulk Suica Expense Filing

End-to-end automation that turns a Mobile Suica PDF statement into a draft transit-expense voucher (交通費伝票) in **Rakuraku Seisan** (`rssieve.rakurakuseisan.jp/eQLXncaNvJa/`), ready for the user to review and submit manually.

## When to Use

- User attaches / mentions a Mobile Suica PDF (e.g. `JE80FE*_*_remapped.pdf`).
- User asks to "nhập / 登録 / file / submit / tạo denpyo Suica" for travel expenses.
- User wants bulk creation of many train trips into a single voucher.

**Do NOT use for**: submitting (申請) — always stop at 一時保存. Other expense categories. Other apps.

## Required Tools / MCP

| Tool | Purpose | Notes |
|---|---|---|
| `read_file`, `create_file`, `replace_string_in_file` | Manage `trips.json`, `.env`, helper scripts | Built-in |
| `run_in_terminal` / `execution_subagent` | Run Python PDF parser, install deps | Built-in |
| **Playwright MCP relay** (`vijaynirmal.playwright-mcp-relay`) | Drive Rakuraku web UI | Must be installed; provides `browser_navigate`, `browser_evaluate`, `browser_tabs` |
| `browser_evaluate` | **ALL** DOM interaction | The relay's schema bug breaks `browser_click` / `browser_type` / `browser_fill_form` — never use those |
| Skill `suica-pdf-editor` (optional) | If the PDF needs date-remap / fare adjustment first | Load before this skill if user wants edits |

If Playwright MCP tools are not visible, ask user to enable the `vijaynirmal.playwright-mcp-relay` extension and confirm a browser is open.

## Inputs

1. **PDF path** — e.g. `c:\Users\Admin\Desktop\Code\JE80FE*_remapped.pdf`.
2. **Credentials** — load from `.env` in workspace root:
   ```
   RAKURAKU_USERNAME=...
   RAKURAKU_PASSWORD=...
   ```
   If missing, ask user — never hardcode. Warn to rotate after session.
3. **Voucher metadata** (optional, ask if unclear): name/担当, date range. Rakuraku auto-fills based on logged-in user.

## Procedure

### Step 1 — Parse PDF → `trips.json`

Run the bundled parser — it handles year auto-detection, station name quirks (地/＊/full-width space), thousands commas, skips charges/purchases/zero-yen taps, and reverses to chronological order:

```pwsh
# from workspace root (needs pypdf in venv)
.venv\Scripts\python.exe .github\skills\rakuraku-suica-expense\scripts\parse_suica.py <PDF_PATH>
```

Outputs: `trips.json` (array of `{date, weekday, from, to, amount}`) + `trips_preview.md` (markdown table with grand total).

See [scripts/parse_suica.py](./scripts/parse_suica.py) — flags `--year`, `--out`, `--preview` available.

**Sanity check**: show the preview total to the user; it MUST equal the PDF total. If mismatch, fix parser before continuing — do not let mismatches propagate.

### Step 2 — Login to Rakuraku

Navigate, then fill via `browser_evaluate` (NOT `browser_type` — it's broken in this relay):

```js
// browser_evaluate
() => {
  document.querySelector('[name="loginId"]').value = '<USERNAME>';
  document.querySelector('[name="password"]').value = '<PASSWORD>';
  document.getElementById('submitBtn').click();
}
```

Success URL: `…/sapTopPage/mainView`. If redirected back to login, credentials wrong.

### Step 3 — Open new transit-expense form

Navigate to the kotsuhi (交通費) new-voucher screen. Easiest: from top page click the 交通費 tile, or go to `…/sapKotsuhiDenpyo/initializeView` directly. After first 確定 click the URL becomes `…/sapKotsuhiDenpyo/insertMeisai` — this is the list view where meisai input fields are inline at the top of the table.

### Step 4 — Insert meisai (one call per record)

Selectors and the critical event-dispatch pattern are documented in [references/dom-selectors.md §3](./references/dom-selectors.md). Per-trip body:

```js
// browser_evaluate — per trip
({date, from, to, amount}) => {
  const q = n => document.querySelector(`[name="${n}"]`);
  const sV = (el, v) => {
    const proto = Object.getPrototypeOf(el);
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    ['input','change','blur'].forEach(t =>
      el.dispatchEvent(new Event(t, {bubbles: true}))
    );
  };
  sV(q('meisaiDate'), date);
  sV(q('meisaiSyuppatsuName'), from);
  sV(q('meisaiToutyakuName'), to);
  sV(q('meisaiKingaku'), String(amount));
  document.querySelector('button.kakutei, button[onclick*="kakuteiMeisai"]').click();
  return {ok: true};
}
```

Loop one `browser_evaluate` call per trip. Pass the trip object via function arg. After each call the page reloads with the new row appended.

**DO NOT batch via `fetch()` POST `/insertMeisai`.** Tried, fails: server's Struts token (CSRF) goes stale after the first synthetic POST, subsequent calls silently no-op OR insert wrong data, causing duplicates (history: 04/27 鶴見→川崎 199円 duplicated, voucher ended up ¥199 over). One call per record is the safe rate.

### Step 5 — Save as draft (`一時保存`)

```js
// browser_evaluate
() => {
  [...document.querySelectorAll('button')]
    .find(b => /一時保存/.test(b.textContent) && b.offsetParent !== null)
    .click();
}
```

URL becomes `…/sapKotsuhiDenpyo/save`. A new voucher number like `20260500993` appears. Note it.

**NEVER click 申請 / shinsei.** User reviews and submits manually. If user explicitly asks to submit, confirm twice before proceeding.

### Step 6 — Verify

1. Navigate to `…/sapKotsuhiKensaku/initializeView` then click the **一時保存** tab (`a.d_listTab` whose text is `一時保存`, fires `DenpyoKensaku.switchTab(this, 'tmpView')`).
2. Find the row containing the voucher number — confirm `Total` equals expected sum.
3. If total mismatches, open the detail view and enumerate meisai:

   ```js
   // browser_evaluate — list (date, amount) per meisai row
   () => {
     const rows = [...document.querySelectorAll('tr')]
       .filter(r => /\d{4}\/\d{2}\/\d{2}/.test(r.textContent));
     const summary = rows.map(r => {
       const cells = [...r.querySelectorAll('td')]
         .map(c => c.textContent.replace(/\s+/g,' ').trim());
       const date = cells.find(c => /^\d{4}\/\d{2}\/\d{2}/.test(c));
       const amt  = cells.find(c => /^[\d,]+$/.test(c) && parseInt(c.replace(/,/g,'')) >= 100);
       return date && amt ? `${date.slice(0,10)}|${amt}` : null;
     }).filter(Boolean);
     const tally = {};
     summary.forEach(s => tally[s] = (tally[s]||0)+1);
     return {count: summary.length, dupes: Object.entries(tally).filter(([,v])=>v>1)};
   }
   ```

   Compare against expected counts from `trips.json`.

4. **Delete duplicate** (if any):
   ```js
   // Find delete btn for row N, click, then click OK in confirm dialog
   () => {
     const btns = [...document.querySelectorAll('button.delMeisai')];
     btns[N].click(); // N = 0-based index of the duplicate row
   }
   // After dialog appears, second call:
   () => {
     [...document.querySelectorAll('button')]
       .find(b => /^OK$/.test(b.textContent.trim()) && b.offsetParent !== null)
       .click();
   }
   ```
   Then re-save with 一時保存. Re-verify.

### Step 7 — Report

Tell user:
- Voucher number (e.g. `20260500993`)
- Date range, total, record count
- Status: `一時保存` (draft) — **awaiting manual 申請**
- Any anomalies fixed during verification

## Key URLs and JS API

Full selector + URL + global-JS reference: [references/dom-selectors.md](./references/dom-selectors.md).

Quick recap: never call `Denpyo.shinsei()` from automation. Switch draft tab via the `<a class="d_listTab">` whose text is `一時保存` (fires `DenpyoKensaku.switchTab`).

## Common Pitfalls

| Symptom | Cause | Fix |
|---|---|---|
| Browser tools missing | Relay extension disabled / no browser open | Ask user to enable `vijaynirmal.playwright-mcp-relay` and open browser |
| `browser_click/type/fill_form` schema error | Relay bug | Use `browser_evaluate` for everything |
| "Subtotalの計算に失敗" dialog | Setter skipped `input`/`change`/`blur` | Always dispatch all three events after `.value` set |
| Silent fail / duplicate after first fetch batch | Struts token stale | Don't batch via `fetch()` — loop `browser_evaluate` per record |
| Voucher number not in list after save | On wrong tab (申請一覧 vs 一時保存) | Click the `a.d_listTab` with text `一時保存` to switch to `tmpView` |
| List shows stale total | Page cache | Reload kensaku list + re-click 検索 button |
| Browser session expired mid-run | Long idle | Re-login via Step 2; resume from last-inserted record (compare list count vs `trips.json`) |

## Safety Rules

- **Never** click 申請 / `Denpyo.shinsei()` without explicit double-confirmation from user.
- **Never** hardcode credentials — always load from `.env`; remind user to rotate.
- Before destructive actions (delete meisai, 取下げ voucher), state what's about to happen and which row index.
- If verification shows total mismatch with no obvious duplicate, **stop and ask** — do not guess which row to delete.

## Quick Resume Cheatsheet

User says "tiếp tục" or returns mid-flow:
1. Check `browser_tabs` — what page is open?
2. If on `insertMeisai`: count rows currently in table, compare to `trips.json`, resume from next index.
3. If on `save` or kensaku: voucher already created → go to verify step.
4. If browser closed / session dead: re-login, navigate to `/sapKotsuhiKensaku/tmpView`, find existing voucher, open in edit mode to continue.
