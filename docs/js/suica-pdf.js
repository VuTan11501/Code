// ═══════════════════════════════════════════════════
//  SUICA PDF RENDERER (client-side)
//  Builds an HTML "Mobile Suica 残高ご利用明細" document
//  from a MonthlyHistory object, then uses html2pdf.js
//  (html2canvas + jsPDF) to render & download a PDF
//  visually matching the real Mobile Suica statement.
//
//  Layout reference: real JR East mobile Suica PDF
//  (header "モバイル Ｓｕｉｃａ 残高ご利用明細",
//   8-col table 月日種別利用駅種別利用駅残高入金・利用額,
//   ~50 rows per page, footer with disclaimer + 東日本旅客鉄道).
//
//  Port of the layout intent in
//    .github/skills/suica-history-generator/scripts/pdf_export.py
//  (the Python version redacts a template PDF; this version
//   renders from scratch as image-PDF — visually identical
//   but text is rasterized).
// ═══════════════════════════════════════════════════
(function () {
  'use strict';

  const ROWS_PER_PAGE = 50;

  function pad2(n) { return String(n).padStart(2, '0'); }
  function fmtBalance(n) { return '¥' + Math.round(n).toLocaleString('en-US'); }
  function fmtAmount(n, sign) {
    if (n === 0 || n == null) return '0';
    const abs = Math.abs(Math.round(n)).toLocaleString('en-US');
    return (sign === '+' ? '+' : '-') + abs;
  }
  function fmtDate(d) { return `${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()}`; }
  function randomCardNo(seed) {
    // Stable 16-digit "JE…" card number derived from seed for reproducibility
    let s = seed | 0;
    const rng = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967295; };
    const digits = () => String(Math.floor(rng() * 9000) + 1000);
    return `JE80${digits()}${digits()}${digits()}${digits()}`;
  }

  // ─────────────────────────────────────────────────
  //  Collapse IN/OUT pairs into single rows (Suica convention)
  //  + prepend opening-balance "繰" row.
  //  Mirror of pdf_export.py _collapse_in_out().
  // ─────────────────────────────────────────────────
  function collapseEntries(history) {
    const rows = [];
    const entries = history.entries || [];
    const initial = history.initial_balance ?? (entries[0] ? entries[0].balance_yen : 0);
    const first = entries[0];
    if (first) {
      const at = new Date(first.at.replace(' ', 'T'));
      rows.push({
        month: pad2(at.getMonth() + 1),
        day: pad2(at.getDate()),
        type: '繰',
        sf_type: '', sf: '',
        st_type: '', st: '',
        balance: initial,
        amount: null,
      });
    }
    let pendingIn = null;
    for (const e of entries) {
      const at = new Date(e.at.replace(' ', 'T'));
      const M = pad2(at.getMonth() + 1), D = pad2(at.getDate());
      if (e.kind === '入') { pendingIn = e; continue; }
      if (e.kind === '出' && pendingIn) {
        rows.push({
          month: M, day: D,
          type: '入',
          sf_type: '入', sf: pendingIn.station,
          st_type: '出', st: e.station,
          balance: e.balance_yen,
          amount: -e.fare_yen,
        });
        pendingIn = null; continue;
      }
      // Auto-topup
      if (e.kind === 'ｵｰﾄﾁｬｰｼﾞ' || e.kind.indexOf('ｵ') === 0 || e.kind === 'カード' || e.kind === 'ｶｰﾄﾞ') {
        rows.push({
          month: M, day: D,
          type: 'ｶｰﾄﾞ',
          sf_type: '', sf: 'モバイル',
          st_type: '', st: '',
          balance: e.balance_yen,
          amount: +e.fare_yen,
        });
        continue;
      }
      // Shopping
      if (e.kind === '物販') {
        rows.push({
          month: M, day: D,
          type: '物販',
          sf_type: '', sf: e.station || '',
          st_type: '', st: '',
          balance: e.balance_yen,
          amount: -e.fare_yen,
        });
        continue;
      }
    }
    return rows;
  }

  // ─────────────────────────────────────────────────
  //  Build the HTML document (one .suica-page per 50 rows)
  // ─────────────────────────────────────────────────
  function buildHtml(history, opts) {
    const rows = collapseEntries(history);
    const cardNo = randomCardNo(opts.seed || 42);
    const printedAt = opts.printedAt ? new Date(opts.printedAt) : new Date();
    const total = rows.length;
    const pageCount = Math.max(1, Math.ceil(total / ROWS_PER_PAGE));

    const pages = [];
    for (let p = 0; p < pageCount; p++) {
      const slice = rows.slice(p * ROWS_PER_PAGE, (p + 1) * ROWS_PER_PAGE);
      const tbody = slice.map(r => {
        const amountStr = r.amount == null
          ? ''
          : (r.amount > 0 ? '+' + r.amount.toLocaleString('en-US') : (r.amount === 0 ? '0' : r.amount.toLocaleString('en-US')));
        return `<tr>
          <td>${r.month}</td>
          <td>${r.day}</td>
          <td>${r.type}</td>
          <td>${r.sf_type}</td>
          <td>${r.sf}</td>
          <td>${r.st_type}</td>
          <td>${r.st}</td>
          <td class="num">${fmtBalance(r.balance)}</td>
          <td class="num">${amountStr}</td>
        </tr>`;
      }).join('');

      pages.push(`
        <div class="suica-page">
          <div class="pdf-h1">モバイル　Ｓｕｉｃａ　残高ご利用明細</div>
          <div class="pdf-card-no">${cardNo.slice(0,4)} ${cardNo.slice(4,8)} ${cardNo.slice(8,12)} ${cardNo.slice(12,16)}</div>
          <div class="pdf-section">残高履歴 （${total}件）</div>
          <table class="pdf-table">
            <thead>
              <tr>
                <th>月</th><th>日</th><th>種別</th>
                <th>種別</th><th>利用駅</th>
                <th>種別</th><th>利用駅</th>
                <th class="num">残高</th><th class="num">入金・利用額</th>
              </tr>
            </thead>
            <tbody>${tbody}</tbody>
          </table>
          <div class="pdf-footer">
            <div>ご利用ありがとうございます。</div>
            <div>システムの都合上、最新のご利用明細が反映されていない場合があります。</div>
            <div class="right">${fmtDate(printedAt)}</div>
            <div class="right">東日本旅客鉄道株式会社</div>
            <div class="pdf-page-no">(${p+1}/${pageCount})</div>
          </div>
        </div>
      `);
    }
    return pages.join('');
  }

  // ─────────────────────────────────────────────────
  //  Main entry
  // ─────────────────────────────────────────────────
  async function generate(history, opts) {
    opts = opts || {};
    if (typeof html2pdf === 'undefined') {
      throw new Error('html2pdf.js not loaded — check CDN script tag');
    }
    const container = document.getElementById('suica-pdf-render');
    if (!container) throw new Error('#suica-pdf-render container missing in HTML');

    container.innerHTML = buildHtml(history, opts);

    // Ensure web fonts are loaded before html2canvas snapshots the DOM,
    // otherwise Japanese glyphs may render with wrong metrics on first run.
    if (document.fonts && document.fonts.ready) {
      try { await document.fonts.ready; } catch (_) {}
    }

    const filename = opts.filename || `suica-${history.month || 'history'}.pdf`;
    const pdfOpts = {
      margin: 0,
      filename,
      image: { type: 'jpeg', quality: 0.96 },
      html2canvas: {
        scale: 2,           // higher dpi for sharper kanji
        backgroundColor: '#ffffff',
        useCORS: true,
        logging: false,
      },
      jsPDF: { unit: 'pt', format: 'a4', orientation: 'portrait' },
      pagebreak: { mode: ['css', 'legacy'] },
    };

    try {
      await html2pdf().set(pdfOpts).from(container).save();
    } finally {
      // Clear the off-screen render to free memory; keep the container.
      setTimeout(() => { container.innerHTML = ''; }, 1000);
    }
    return { filename, pages: Math.max(1, Math.ceil(collapseEntries(history).length / ROWS_PER_PAGE)) };
  }

  window.SuicaPDF = { generate, collapseEntries, buildHtml };
})();
