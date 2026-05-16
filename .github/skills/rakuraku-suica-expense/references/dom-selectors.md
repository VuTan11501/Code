# Rakuraku Seisan — DOM Selectors & JS API Reference

Verified against `rssieve.rakurakuseisan.jp/eQLXncaNvJa/` as of **2026-05-16**.
If selectors break, this is the file to patch first.

---

## 1. Login

URL: any unauthenticated page redirects to login.

| Element | Selector | Notes |
|---|---|---|
| Username input | `[name="loginId"]` | Plain text |
| Password input | `[name="password"]` | Type=password |
| Submit button | `#submitBtn` | Triggers form POST |

After successful POST → `…/sapTopPage/mainView`. Wrong creds → back to login with banner.

```js
() => {
  document.querySelector('[name="loginId"]').value = '<USER>';
  document.querySelector('[name="password"]').value = '<PASS>';
  document.getElementById('submitBtn').click();
}
```

---

## 2. New Voucher — Empty Form

URL: `…/sapKotsuhiDenpyo/initializeView`

Form name: `sapKotsuhiDenpyoActionForm` (Java Struts).

Auto-filled by server based on logged-in user: 担当者名, 部門, default date range.
Click 確定 → `insertMeisai` view.

---

## 3. Meisai List View (Inline Input)

URL: `…/sapKotsuhiDenpyo/insertMeisai`

The top of the meisai table has inline input fields. Enter values here, then click
the row's 確定 button — page reloads with new row appended below.

| Field | Selector | Example value |
|---|---|---|
| Date | `[name="meisaiDate"]` | `"2026/04/15"` (YYYY/MM/DD) |
| From station | `[name="meisaiSyuppatsuName"]` | `"鶴見"` |
| To station | `[name="meisaiToutyakuName"]` | `"川崎"` |
| Amount | `[name="meisaiKingaku"]` | `"199"` (string of integer) |
| 確定 button (per row) | `button.kakutei`, `button[onclick*="kakuteiMeisai"]` | Click to commit |

### CRITICAL — Event firing pattern

Setting `.value` directly **does not** trigger Rakuraku's subtotal/validation
listeners. Must use React-style native setter + dispatch all 3 events:

```js
const sV = (el, v) => {
  const proto = Object.getPrototypeOf(el);
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
  ['input', 'change', 'blur'].forEach(t =>
    el.dispatchEvent(new Event(t, {bubbles: true}))
  );
};
```

Drop any one event and you'll see dialog: **「Subtotalの計算に失敗しました」**.

### Per-row action buttons

| Button | Selector | onclick |
|---|---|---|
| Edit (鉛筆) | `button.editMeisai` | `Denpyo.editMeisai(this)` |
| Delete (×) | `button.delMeisai` | (handler bound; click triggers confirm dialog) |
| Copy (複写) | `button.copyMeisai`, icon `file_copy` | `Denpyo.copyMeisai(this)` |
| Favorite (★) | icon `star` | (saves trip as quick template) |

Delete confirm dialog: a modal `<button>` whose text is exactly `OK` (offsetParent !== null).

### Bottom-of-page actions

| Button | Selector | Action |
|---|---|---|
| 一時保存 | `button` with text `一時保存`, class includes `save` | Saves as draft → `…/save` |
| 申請 | `button` with text `申請`, calls `Denpyo.shinsei()` | **DO NOT CLICK AUTOMATICALLY** |
| キャンセル | `button` with text `キャンセル` | Discards |

---

## 4. Voucher List / Search

URL: `…/sapKotsuhiKensaku/initializeView`

Two tabs (`<a class="d_listTab">` inside `<li>` wrappers):

| Tab text | Selector | Switches to URL |
|---|---|---|
| 申請一覧 (submitted) | `a.d_listTab` text=`申請一覧` | `…/initializeView` |
| 一時保存 (drafts) | `a.d_listTab` text=`一時保存` | `…/tmpView` |

Switching is JS-driven: `DenpyoKensaku.switchTab(this, 'tmpView')`.

Search button: `<button>` text contains `検索`. Click after changing filters.

Row structure: `<tr>` with cells in order — checkbox / Voucher No. / Request Date /
Name / 明細開始日 / 明細終了日 / Note / Total / 承認 (3 check_circle icons) / 状態.

To find a specific voucher:
```js
[...document.querySelectorAll('tr')].filter(r => r.textContent.includes('20260500993'))
```

---

## 5. Voucher Detail / Edit

URL: `…/sapKotsuhiDenpyo/detailView?tmpFlg=false&eDenpyoNo=<URL-ENC>&huriwakeYear=YYYY`

- `tmpFlg=true` for drafts opens in edit mode (delete/edit buttons visible).
- `tmpFlg=false` for submitted is read-only.
- `eDenpyoNo` is server-encrypted, take from the row's link href — do not construct manually.
- Opens in a new tab — use `browser_tabs` to switch.

In edit mode, each meisai `<tr>` contains the per-row action buttons listed in
§3. Row index of `button.delMeisai` matches the displayed row number minus 1
(0-based).

---

## 6. Global JS API (`window.Denpyo`)

| Function | Purpose | Safe to call? |
|---|---|---|
| `Denpyo.insertMeisai()` | Commits the inline input row | ✅ Used via 確定 click |
| `Denpyo.editMeisai(btnEl)` | Loads row into inline editor | ✅ |
| `Denpyo.delMeisai(btnEl)` | Triggers delete confirm dialog | ✅ (then click OK) |
| `Denpyo.copyMeisai(btnEl)` | Duplicates row into editor | ✅ |
| `Denpyo.saveTemporary()` | Save as draft | ✅ |
| `Denpyo.shinsei()` | **SUBMIT for approval** | ❌ **NEVER call from automation** |

`window.DenpyoKensaku.switchTab(el, viewName)` — see §4.

---

## 7. URL Cheatsheet (all under `/eQLXncaNvJa/`)

| Path | Page |
|---|---|
| `/sapTopPage/mainView` | Post-login home |
| `/sapKotsuhiDenpyo/initializeView` | New transit voucher (empty form) |
| `/sapKotsuhiDenpyo/insertMeisai` | Meisai list with inline input row |
| `/sapKotsuhiDenpyo/delMeisai` | Returned URL after row deletion |
| `/sapKotsuhiDenpyo/save` | Returned URL after 一時保存 |
| `/sapKotsuhiDenpyo/detailView` | Voucher detail/edit (query: `eDenpyoNo`, `huriwakeYear`, `tmpFlg`) |
| `/sapKotsuhiKensaku/initializeView` | Voucher search (申請一覧 default) |
| `/sapKotsuhiKensaku/tmpView` | Drafts (一時保存) tab |
| `/sapKotsuhiKensaku/search` | URL after submitting search filters |

---

## 8. Anti-patterns

- ❌ `fetch('/sapKotsuhiDenpyo/insertMeisai', {method:'POST', body:fd})` in a batch loop — Struts token becomes stale after first synthetic POST → silent fail / duplicate rows.
- ❌ `el.value = v` without dispatching events → Subtotal calc dialog.
- ❌ Calling `browser_click` / `browser_type` / `browser_fill_form` on this relay — schema bug, always errors. Use `browser_evaluate`.
- ❌ Constructing `eDenpyoNo` query param — it's server-encrypted, must be taken from a real `<a>` href.
- ❌ Skipping the `検索` re-click after changing the active tab — list is cached.
