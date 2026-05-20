// ═══════════════════════════════════════════════════
//  AI MONTHLY INSIGHT — Dashboard widget
//  Reads monthly-insights.json from the Gist (written by
//  .github/workflows/ai-monthly-insight.yml) and renders the
//  latest month's summary as a card above workflowGrid.
// ═══════════════════════════════════════════════════
(function () {
  'use strict';

  const GIST_ID = (typeof window !== 'undefined' && window.GIST_ID) || 'abc2a47c0a396025a72a6580227ff493';
  const GIST_FILE = 'monthly-insights.json';
  let _lastFetched = 0;
  let _cache = null;

  function _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function _fmtMonth(monthStr) {
    if (!monthStr) return '';
    const m = /^(\d{4})-(\d{2})$/.exec(monthStr);
    if (!m) return monthStr;
    const d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, 1);
    try { return d.toLocaleDateString('vi-VN', { month: 'long', year: 'numeric' }); } catch { return monthStr; }
  }

  function _fmtYen(n) {
    if (n == null || isNaN(n)) return '—';
    return '¥' + Math.round(Number(n)).toLocaleString('ja-JP');
  }
  function _fmtHours(n) {
    if (n == null || isNaN(n)) return '—';
    return Number(n).toFixed(1) + 'h';
  }

  function _renderMarkdown(text) {
    if (!text) return '';
    // Minimal: paragraph + line breaks. Escape first, then transform.
    return _esc(text)
      .split(/\n\n+/).map(p => `<p style="margin:0 0 8px">${p.replace(/\n/g, '<br>')}</p>`).join('');
  }

  async function loadInsights() {
    // Cache for 5 minutes — dashboard polls aggressively
    if (_cache && Date.now() - _lastFetched < 5 * 60 * 1000) return _cache;
    const token = (typeof sessionToken !== 'undefined' && sessionToken) ? sessionToken : null;
    if (!token) return null;
    try {
      const r = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json' },
      });
      if (!r.ok) return null;
      const g = await r.json();
      const f = g.files && g.files[GIST_FILE];
      if (!f || !f.content) return null;
      const data = JSON.parse(f.content);
      _cache = Array.isArray(data) ? data : (data.insights || data.months || []);
      _lastFetched = Date.now();
      return _cache;
    } catch (e) {
      console.warn('[insights] load failed', e);
      return null;
    }
  }

  async function renderLatestInsight() {
    const sec = document.getElementById('insightSection');
    const content = document.getElementById('insightContent');
    if (!sec || !content) return;
    const insights = await loadInsights();
    if (!insights || !insights.length) {
      sec.hidden = true;
      return;
    }
    // Pick latest by month string descending
    const sorted = insights.slice().sort((a, b) => String(b.month || '').localeCompare(String(a.month || '')));
    const top = sorted[0];
    if (!top) { sec.hidden = true; return; }

    const stats = top.stats || {};
    const prose = top.prose || top.summary || top.ai_summary || '';
    const generated = top.generated_at || top.created_at || '';

    const statRows = [
      ['Total income', _fmtYen(stats.total_income ?? stats.net_take_home)],
      ['OT hours', _fmtHours(stats.ot_hours)],
      ['OT income', _fmtYen(stats.ot_income)],
      ['Workdays', stats.workdays != null ? String(stats.workdays) : '—'],
    ].filter(r => r[1] !== '—');

    content.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:10px">
        <div>
          <div style="font-weight:600;font-size:var(--fs-md)">${_esc(_fmtMonth(top.month))}</div>
          ${generated ? `<div style="font-size:var(--fs-xs);color:var(--muted-foreground);margin-top:2px">Generated ${_esc(new Date(generated).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }))}</div>` : ''}
        </div>
        <button class="btn btn-secondary sm" type="button" onclick="navigate('#ai')" data-tooltip="Ask AI about this report">
          <span data-icon="sparkles" data-size="13"></span> Ask AI
        </button>
      </div>
      ${statRows.length ? `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin-bottom:10px">
        ${statRows.map(([k, v]) => `<div style="background:var(--muted);padding:8px 10px;border-radius:var(--radius-sm)">
          <div style="font-size:var(--fs-xs);color:var(--muted-foreground)">${_esc(k)}</div>
          <div style="font-weight:600;font-family:var(--font-mono);font-size:var(--fs-sm)">${_esc(v)}</div>
        </div>`).join('')}
      </div>` : ''}
      ${prose ? `<div style="font-size:var(--fs-sm);line-height:1.55;color:var(--foreground)">${_renderMarkdown(prose)}</div>` : ''}
    `;
    sec.hidden = false;
    if (typeof renderIcons === 'function') renderIcons(content);
  }

  window.AIInsights = { loadInsights, renderLatestInsight };
})();
