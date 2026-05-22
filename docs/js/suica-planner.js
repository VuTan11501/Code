// ═══════════════════════════════════════════════════
//  SUICA TRIP PLANNER
//  Pick FROM/TO stations, build weekly pattern + leisure pool,
//  estimate monthly fare, and copy the matching CLI command
//  or download a preset JSON consumable by scripts/generate.py.
//
//  Data source: docs/data/kanto_fares.json (mirror of the
//  skill's data/kanto_fares.json — IC fares 2026-03 schedule).
// ═══════════════════════════════════════════════════
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const fmtYen = (n) => '¥' + Math.round(n).toLocaleString('en-US');
  const sortPair = (a, b) => [a, b].sort((x, y) => x.localeCompare(y, 'ja'));
  const pairKey = (a, b) => { const [x, y] = sortPair(a, b); return `${x}↔${y}`; };

  const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  const DAY_LABELS = { monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed', thursday: 'Thu', friday: 'Fri', saturday: 'Sat', sunday: 'Sun' };

  // ────── State ──────
  const state = {
    fares: {},                    // "東京↔新宿" → 210
    fareOverrides: {},            // "東京↔新宿" → 250 (user-edited; takes precedence over fares)
    fareVerifiedAt: {},           // "東京↔新宿" → ISO date string (when this fare was last verified)
    stations: [],                 // ["東京", "新宿", …] unique, sorted (canonical kanji names)
    stationMeta: {},              // "東京" → { kana, romaji, alt:[] } — for combobox search & display
    pattern: { monday: [], tuesday: [], wednesday: [], thursday: [], friday: [], saturday: [], sunday: [] },
    leisure: [],                  // [{ route: "新宿↔横浜", weight: 3 }]
    settings: {
      month: defaultNextMonth(),
      target: 25000,
      seed: 42,
      initial_balance: 3000,
      topup_threshold: 1500,
      topup_amount: 3000,
      leisure_min: 2,
      leisure_max: 4,
      seedPinned: false,
    },
  };

  function defaultNextMonth() {
    const d = new Date();
    d.setMonth(d.getMonth() + 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  // ────── Persistence ──────
  // Survives reload via localStorage. We persist only user-authored data:
  // weekly pattern, leisure pool, settings, and the last-picked route — NOT
  // fare/station catalogues (those are reloaded from the network each visit).
  const STORAGE_KEY = 'suica-planner-v2';
  let _saveTimer = null;
  function saveState() {
    if (_saveTimer) return;
    _saveTimer = setTimeout(() => {
      _saveTimer = null;
      try {
        const payload = {
          v: 2,
          pattern: state.pattern,
          leisure: state.leisure,
          settings: state.settings,
          fareOverrides: state.fareOverrides || {},
          lastRoute: {
            from: (typeof cbFrom !== 'undefined' && cbFrom) ? cbFrom.getValue() : '',
            to:   (typeof cbTo !== 'undefined' && cbTo)   ? cbTo.getValue()   : '',
          },
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      } catch (_) { /* quota or private-mode — ignore */ }
    }, 200);
  }
  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const p = JSON.parse(raw);
      if (!p || p.v !== 2) return null;
      // Merge defensively — schema may evolve
      if (p.pattern && typeof p.pattern === 'object') {
        DAYS.forEach((d) => {
          if (Array.isArray(p.pattern[d])) state.pattern[d] = p.pattern[d].filter((t) => t && t.route);
        });
      }
      if (Array.isArray(p.leisure)) {
        state.leisure = p.leisure.filter((l) => l && l.route).map((l) => ({ route: l.route, weight: Math.max(1, +l.weight || 1) }));
      }
      if (p.settings && typeof p.settings === 'object') {
        Object.keys(state.settings).forEach((k) => {
          if (p.settings[k] != null) state.settings[k] = p.settings[k];
        });
      }
      if (p.fareOverrides && typeof p.fareOverrides === 'object') {
        state.fareOverrides = {};
        Object.keys(p.fareOverrides).forEach((k) => {
          const v = +p.fareOverrides[k];
          if (isFinite(v) && v > 0 && v <= 20000) state.fareOverrides[k] = v;
        });
      }
      return p;
    } catch (_) { return null; }
  }

  // ────── Recent generations (last 5) ──────
  // Stored separately from STORAGE_KEY so users can prune one without the other.
  const RECENT_KEY = 'suica-planner-recent-v1';
  const RECENT_MAX = 5;
  function loadRecent() {
    try {
      const raw = localStorage.getItem(RECENT_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.slice(0, RECENT_MAX) : [];
    } catch (_) { return []; }
  }
  function saveRecent(arr) {
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(arr.slice(0, RECENT_MAX))); } catch (_) {}
  }
  function recordGeneration(meta) {
    // meta = { filename, month, target, seed, routes:[…], runUrl, when }
    const list = loadRecent();
    list.unshift({ ...meta, when: meta.when || Date.now() });
    saveRecent(list);
    renderRecent();
  }
  function _renderSparkline(values) {
    if (!values || values.length < 2) return '';
    const w = 120, h = 28, pad = 2;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const stepX = (w - pad * 2) / (values.length - 1);
    const pts = values.map((v, i) => {
      const x = pad + i * stepX;
      const y = h - pad - ((v - min) / range) * (h - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    const last = values[values.length - 1];
    const lastPrev = values[values.length - 2];
    const trendCls = last >= lastPrev ? 'text-success' : 'text-warning';
    const trendArrow = last >= lastPrev ? '▲' : '▼';
    const tooltip = (function () {
      const vmin = Math.min(...values);
      const vmax = Math.max(...values);
      const vavg = Math.round(values.reduce((a, b) => a + b, 0) / values.length);
      return `Target ¥ trend (last ${values.length}): ${values.map((v) => '¥' + v.toLocaleString()).join(' → ')}\nmin ¥${vmin.toLocaleString()} · avg ¥${vavg.toLocaleString()} · max ¥${vmax.toLocaleString()}\nRight-click to save PNG`;
    })();
    return `
      <div class="flex items-center gap-2 mb-2 text-xs text-muted-foreground" data-tooltip="${tooltip}" data-spark-trend="1">
        <span>Trend:</span>
        <svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true" style="overflow:visible;cursor:context-menu" data-spark-svg="1">
          <polyline fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" points="${pts.join(' ')}" style="color:var(--primary,#3b82f6)"></polyline>
          <circle cx="${pts[pts.length - 1].split(',')[0]}" cy="${pts[pts.length - 1].split(',')[1]}" r="2.5" fill="currentColor" style="color:var(--primary,#3b82f6)"></circle>
        </svg>
        <span class="${trendCls} font-mono">${trendArrow} ¥${last.toLocaleString()}</span>
      </div>
    `;
  }

  function _exportSparkAsPng(svgEl) {
    if (!svgEl) return;
    // Inline current text colour because the rendered SVG uses currentColor.
    const cs = getComputedStyle(svgEl);
    const colour = cs.color || '#3b82f6';
    const clone = svgEl.cloneNode(true);
    clone.querySelectorAll('[style*="currentColor"], polyline, circle').forEach((el) => {
      const s = el.getAttribute('style') || '';
      el.setAttribute('style', s.replace(/var\(--primary[^)]*\)/g, colour));
      if (el.getAttribute('stroke') === 'currentColor') el.setAttribute('stroke', colour);
      if (el.getAttribute('fill') === 'currentColor') el.setAttribute('fill', colour);
    });
    const width = +(clone.getAttribute('width') || 120);
    const height = +(clone.getAttribute('height') || 28);
    const scale = 4; // upscale for retina
    const svgStr = new XMLSerializer().serializeToString(clone);
    const blob = new Blob(['<?xml version="1.0"?>' + svgStr], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = width * scale; canvas.height = height * scale;
      const ctx = canvas.getContext('2d');
      // White background so the PNG looks right on light AND dark surfaces.
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob((pngBlob) => {
        if (!pngBlob) { if (window.Toast) window.Toast.error('PNG export failed'); return; }
        const dl = document.createElement('a');
        dl.href = URL.createObjectURL(pngBlob);
        dl.download = `suica-target-trend-${new Date().toISOString().slice(0,10)}.png`;
        dl.click();
        setTimeout(() => URL.revokeObjectURL(dl.href), 5000);
        if (window.Toast) window.Toast.success('Sparkline PNG saved');
      }, 'image/png');
    };
    img.onerror = () => { URL.revokeObjectURL(url); if (window.Toast) window.Toast.error('PNG export failed'); };
    img.src = url;
  }

  // Delegate right-click on any rendered sparkline to the PNG exporter so we
  // don't have to re-bind after every renderRecent.
  document.addEventListener('contextmenu', (e) => {
    const svg = e.target.closest && e.target.closest('svg[data-spark-svg]');
    if (!svg) return;
    e.preventDefault();
    _exportSparkAsPng(svg);
  });

  function renderRecent() {
    const section = $('planner-recent-section');
    const wrap = $('planner-recent-list');
    if (!wrap || !section) return;
    let list = loadRecent();
    if (!list.length) { section.classList.add('hidden'); return; }
    section.classList.remove('hidden');
    fetchWorkflowHealth();
    wrap.innerHTML = '';
    // Filter chip row (All / 7d / 30d). Filter state is held on the wrap element.
    const filter = wrap.dataset.recentFilter || 'all';
    const search = (wrap.dataset.recentSearch || '').trim().toLowerCase();
    const now = Date.now();
    const DAY_MS = 86400000;
    const filtered = list.filter((r) => {
      if (filter !== 'all') {
        const age = (now - new Date(r.when).getTime()) / DAY_MS;
        if (filter === '7d' && age > 7) return false;
        if (filter === '30d' && age > 30) return false;
      }
      if (search) {
        const hay = ((r.filename || '') + ' ' + (r.routes || []).join(' ') + ' ' + r.month).toLowerCase();
        if (hay.indexOf(search) < 0) return false;
      }
      return true;
    });
    // Search input row
    const searchRow = document.createElement('div');
    searchRow.className = 'mb-2';
    searchRow.innerHTML = `
      <input type="search" id="planner-recent-search" class="input input-sm w-full" placeholder="Search filename, route, or YYYY-MM…" value="${(wrap.dataset.recentSearch || '').replace(/"/g, '&quot;')}" autocomplete="off">
    `;
    wrap.appendChild(searchRow);
    const searchInput = searchRow.querySelector('#planner-recent-search');
    searchInput.addEventListener('input', () => {
      wrap.dataset.recentSearch = searchInput.value;
      const focusPos = searchInput.selectionStart;
      renderRecent();
      // re-grab and restore focus + caret because renderRecent rebuilds the DOM
      const fresh = $('planner-recent-search');
      if (fresh) { fresh.focus(); if (typeof focusPos === 'number') fresh.setSelectionRange(focusPos, focusPos); }
    });
    const selCount = filtered.filter((r) => _recentSel.has(r.when)).length;
    const chipRow = document.createElement('div');
    chipRow.className = 'flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground mb-2 flex-wrap';
    chipRow.innerHTML = `
      <span class="mr-1">Filter:</span>
      ${['all', '7d', '30d'].map((f) => `
        <button type="button" data-recent-filter="${f}" class="btn btn-ghost sm text-[10px] ${filter === f ? 'bg-muted' : ''}">${f === 'all' ? 'All' : 'Last ' + f}</button>
      `).join('')}
      ${selCount > 0 ? `<button type="button" data-recent-bulk-del class="btn sm text-[10px] text-destructive border border-destructive/40 ml-1" data-tooltip="Delete the ${selCount} selected run${selCount === 1 ? '' : 's'} from local history">Delete ${selCount}</button>
      <button type="button" data-recent-sel-clear class="btn btn-ghost sm text-[10px]" data-tooltip="Clear selection">Clear sel</button>` : ''}
      <span class="ml-auto text-muted-foreground normal-case tracking-normal">${filtered.length}/${list.length}</span>
    `;
    wrap.appendChild(chipRow);
    chipRow.querySelectorAll('[data-recent-filter]').forEach((b) => b.addEventListener('click', (e) => {
      wrap.dataset.recentFilter = e.currentTarget.getAttribute('data-recent-filter');
      renderRecent();
    }));
    const bulkDel = chipRow.querySelector('[data-recent-bulk-del]');
    if (bulkDel) bulkDel.addEventListener('click', () => {
      const ids = Array.from(_recentSel);
      if (!ids.length) return;
      if (!confirm(`Delete ${ids.length} run${ids.length === 1 ? '' : 's'} from your local history? This does not affect GitHub Actions.`)) return;
      const remaining = list.filter((r) => !_recentSel.has(r.when));
      const removed = list.filter((r) => _recentSel.has(r.when));
      saveRecent(remaining);
      _recentSel.clear();
      renderRecent();
      if (window.Toast) window.Toast.info(`${removed.length} run${removed.length === 1 ? '' : 's'} deleted`, {
        duration: 6000,
        action: { label: 'Undo', onClick: () => { saveRecent([...removed, ...loadRecent()].slice(0, 50)); renderRecent(); } },
      });
    });
    const selClear = chipRow.querySelector('[data-recent-sel-clear]');
    if (selClear) selClear.addEventListener('click', () => { _recentSel.clear(); renderRecent(); });
    // Sparkline of target ¥ from the most recent (oldest→newest in viz, so reverse)
    const targets = list.slice(0, 6).map((r) => +r.target).filter((n) => isFinite(n)).reverse();
    const sparkHtml = _renderSparkline(targets);
    if (sparkHtml) {
      const sparkWrap = document.createElement('div');
      sparkWrap.innerHTML = sparkHtml;
      wrap.appendChild(sparkWrap.firstElementChild);
    }
    if (!filtered.length) {
      const empty = document.createElement('div');
      empty.className = 'text-xs text-muted-foreground italic py-2';
      empty.textContent = 'No runs match the current filter.';
      wrap.appendChild(empty);
      return;
    }
    filtered.forEach((r) => {
      const row = document.createElement('div');
      row.className = 'flex items-start gap-3 py-2 border-b border-border last:border-b-0 flex-wrap';
      const when = new Date(r.when);
      const dt = when.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
      const rowId = r.when;
      const isSel = _recentSel.has(rowId);
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = isSel;
      cb.className = 'mt-1 flex-none';
      cb.setAttribute('aria-label', 'Select this run for bulk delete');
      cb.setAttribute('data-tooltip', 'Select for bulk delete');
      cb.addEventListener('change', () => {
        if (cb.checked) _recentSel.add(rowId); else _recentSel.delete(rowId);
        renderRecent();
      });
      row.appendChild(cb);
      const routeList = (r.routes || []);
      const visible = routeList.slice(0, 6);
      const remaining = routeList.length - visible.length;
      const chipsHtml = routeList.length
        ? `<div class="flex flex-wrap gap-1 mt-1" data-tooltip="${routeList.join(', ')}">
             ${visible.map((rt) => `<span class="status-badge font-mono text-[10px]">${rt}</span>`).join('')}
             ${remaining > 0 ? `<span class="status-badge font-mono text-[10px] opacity-70">+${remaining}</span>` : ''}
           </div>`
        : '<div class="text-xs text-muted-foreground italic mt-1">no routes recorded</div>';
      row.innerHTML = `
        <div class="flex flex-col gap-0.5 flex-1 min-w-[220px]">
          <div class="text-sm font-mono font-medium">${r.filename || ('suica-' + r.month + '.pdf')}</div>
          <div class="text-xs text-muted-foreground">${dt}</div>
          ${chipsHtml}
        </div>
        <span class="status-badge status-info font-mono">${r.month}</span>
        <span class="status-badge status-pending font-mono">¥${(+r.target).toLocaleString('en-US')}</span>
        <span class="status-badge font-mono">seed ${r.seed}</span>
        ${r.runUrl ? `<a class="btn btn-ghost sm text-xs" href="${r.runUrl}" target="_blank" rel="noopener" data-tooltip="Open the GitHub Actions run">Run ↗</a>` : ''}
        <button type="button" class="btn btn-ghost sm text-xs" data-restore-recent data-tooltip="Reuse this month + target + seed in the planner">
          <span data-icon="undo" data-size="12"></span>
          <span class="btn-label">Reuse</span>
        </button>
      `;
      const restoreBtn = row.querySelector('[data-restore-recent]');
      if (restoreBtn) restoreBtn.addEventListener('click', () => {
        state.settings.month = r.month;
        state.settings.target = +r.target;
        state.settings.seed = +r.seed;
        ['planner-month', 'planner-target', 'planner-seed'].forEach((id, i) => {
          const el = $(id); if (el) el.value = [r.month, r.target, r.seed][i];
        });
        renderEstimate(); saveState();
        const s = $('planner-pdf-status'); if (s) { s.textContent = `Restored settings from ${r.filename || ('run on ' + dt)}`; s.className = 'text-xs text-primary'; }
      });
      wrap.appendChild(row);
    });
    if (window.refreshIcons) window.refreshIcons(wrap);
  }
  function currentPlanRoutes() {
    const set = new Set();
    DAYS.forEach((d) => state.pattern[d].forEach((t) => set.add(t.route)));
    state.leisure.forEach((l) => set.add(l.route));
    return Array.from(set);
  }

  // ────── Load fare data + station catalogue ──────
  async function loadFares() {
    const setStatus = (html, variant) => {
      const box = $('planner-load-status');
      box.innerHTML = `<span data-icon="${variant === 'error' ? 'alert' : 'info'}" data-size="14"></span><div class="flex-1">${html}</div>`;
      if (window.refreshIcons) window.refreshIcons(box);
    };
    try {
      const [faresRes, stationsRes] = await Promise.all([
        fetch('data/kanto_fares.json', { cache: 'no-cache' }),
        fetch('data/kanto_stations.json', { cache: 'no-cache' }).catch(() => null),
      ]);
      if (!faresRes.ok) throw new Error('HTTP ' + faresRes.status);
      const data = await faresRes.json();
      // Normalize all fare keys to canonical pairKey form so the JSON file
      // can be authored or sorted in any order (Python sort vs JS localeCompare
      // produce different orderings for CJK strings).
      const rawFares = data.fares || {};
      // Official JR East IC fare schedule effective 2026-03-14
      const OFFICIAL_FARE_DATE = data.effective_date || '2026-03-14T00:00:00Z';
      state.fares = {};
      state.fareVerifiedAt = {};
      Object.keys(rawFares).forEach((k) => {
        const [a, b] = k.split('↔');
        if (!a || !b) return;
        const key = pairKey(a, b);
        state.fares[key] = rawFares[k];
        state.fareVerifiedAt[key] = OFFICIAL_FARE_DATE;
      });

      const set = new Set();
      Object.keys(state.fares).forEach((k) => {
        const [a, b] = k.split('↔');
        if (a) set.add(a); if (b) set.add(b);
      });

      state.stationMeta = {};
      let withCoords = 0;
      if (stationsRes && stationsRes.ok) {
        try {
          const sdata = await stationsRes.json();
          // Dedupe by name: for ambiguous names (~9 in Kanto) keep the entry
          // with the most lines (heuristic for "more well-known"). User-visible
          // sub-label still shows the prefecture so it's never confusing.
          const byName = {};
          (sdata.stations || []).forEach((s) => {
            if (!s || !s.name) return;
            const cur = byName[s.name];
            const score = (s.lines || []).length;
            if (!cur || score > cur._score) {
              byName[s.name] = Object.assign({}, s, { _score: score });
            }
          });
          Object.values(byName).forEach((s) => {
            set.add(s.name);
            state.stationMeta[s.name] = {
              pref: s.pref || '',
              kana: s.kana || '',
              romaji: (s.romaji || '').toLowerCase(),
              alt: (s.alt || []).map((x) => String(x).toLowerCase()),
              lat: typeof s.lat === 'number' ? s.lat : null,
              lon: typeof s.lon === 'number' ? s.lon : null,
              lines: s.lines || [],
            };
            if (state.stationMeta[s.name].lat != null) withCoords++;
          });
        } catch (e) { console.warn('stations.json parse failed:', e); }
      }
      state.stations = Array.from(set).sort((x, y) => x.localeCompare(y, 'ja'));
      buildFareGraph();
      populateComboboxes();
      const ageMs = Date.now() - new Date(OFFICIAL_FARE_DATE).getTime();
      const ageDays = Math.max(0, Math.floor(ageMs / 86400000));
      const ageLabel = ageDays < 1 ? 'today'
        : ageDays < 30 ? `${ageDays}d ago`
        : ageDays < 365 ? `${Math.floor(ageDays / 30)}mo ago`
        : `${(ageDays / 365).toFixed(1)}yr ago`;
      const ageVariant = ageDays < 60 ? 'status-success' : ageDays < 180 ? 'status-pending' : 'status-warning';
      setStatus(
        `<strong>${state.stations.length}</strong> Kanto stations · <strong>${withCoords}</strong> with coordinates · <strong>${Object.keys(state.fares).length}</strong> verified IC fares. Search supports kanji, kana, and romaji.
         <span class="ml-2 status-badge ${ageVariant} text-[10px]" data-tooltip="JR East IC fare schedule effective ${new Date(OFFICIAL_FARE_DATE).toLocaleDateString()}">fares verified ${ageLabel}</span>
         <button type="button" id="planner-fares-refresh" class="btn btn-ghost xs text-[10px] ml-1" data-tooltip="Re-fetch kanto_fares.json (bypasses HTTP cache)">↻ refresh</button>`,
        'info'
      );
      const refreshBtn = document.getElementById('planner-fares-refresh');
      if (refreshBtn) refreshBtn.addEventListener('click', () => {
        refreshBtn.disabled = true; refreshBtn.textContent = 'refreshing…';
        loadFares().then(() => { if (window.Toast) window.Toast.success('Fare data reloaded'); });
      });
    } catch (err) {
      setStatus(`Failed to load fare data: ${err.message}`, 'error');
    }
  }

  // ────── Geodesic distance + JR East IC tariff (Tier-3 fallback) ──────
  // Source: JR East publicly-published IC運賃 brackets (本州3社, post-2026/03).
  // We use these as conservative upper-bound estimates for any pair whose
  // exact fare we don't know and which the Dijkstra graph cannot connect.
  function _haversineKm(a, b) {
    const m1 = state.stationMeta[a], m2 = state.stationMeta[b];
    if (!m1 || !m2 || m1.lat == null || m2.lat == null) return null;
    const R = 6371; // km
    const toRad = (x) => x * Math.PI / 180;
    const dLat = toRad(m2.lat - m1.lat);
    const dLon = toRad(m2.lon - m1.lon);
    const la1 = toRad(m1.lat), la2 = toRad(m2.lat);
    const h = Math.sin(dLat/2)**2 + Math.cos(la1)*Math.cos(la2)*Math.sin(dLon/2)**2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  // Distance brackets are great-circle km × 1.25 detour factor → tariff km.
  // Source: JR East 幹線 IC運賃, effective 2026-03-14 (urban discount zones
  // 山手線内 / 電車特定区間 abolished; everything merged into 幹線).
  // Ref: https://www.jreast.co.jp/2026unchin-kaitei/
  function _tariffYen(rawKm) {
    const km = rawKm * 1.25;
    if (km <= 3)   return 155;
    if (km <= 6)   return 199;
    if (km <= 10)  return 209;
    if (km <= 15)  return 253;
    if (km <= 20)  return 341;
    if (km <= 25)  return 440;
    if (km <= 30)  return 528;
    if (km <= 35)  return 616;
    if (km <= 40)  return 715;
    if (km <= 45)  return 803;
    if (km <= 50)  return 902;
    if (km <= 60)  return 1034;
    if (km <= 70)  return 1221;
    if (km <= 80)  return 1408;
    if (km <= 90)  return 1595;
    if (km <= 100) return 1782;
    if (km <= 120) return 2090;
    if (km <= 140) return 2420;
    if (km <= 160) return 2750;
    if (km <= 180) return 3190;
    if (km <= 200) return 3520;
    // Beyond 200 km, the table continues at roughly +¥210 per +20 km
    return Math.round(3520 + (km - 200) * 10.5);
  }

  // ────── Combobox component (shadcn-style) ──────
  // Options are canonical kanji station names (strings). For each option we
  // optionally look up state.stationMeta[name] to enable kana/romaji search
  // and render a secondary romaji label.
  function _searchHaystack(name) {
    const m = state.stationMeta && state.stationMeta[name];
    if (!m) return name.toLowerCase();
    return (
      name + ' ' + (m.kana || '') + ' ' + (m.romaji || '') + ' ' +
      (m.alt || []).join(' ') + ' ' + (m.pref || '') + ' ' + (m.lines || []).join(' ')
    ).toLowerCase();
  }
  function _renderOption(name) {
    const m = state.stationMeta && state.stationMeta[name];
    if (!m) return `<span class="combobox-item-name">${name}</span>`;
    const sub = m.romaji || '';
    const pref = m.pref ? ` · ${m.pref}` : '';
    return `<span class="combobox-item-name">${name}</span><span class="combobox-item-sub">${sub}${pref}</span>`;
  }
  function createCombobox(wrapper, opts) {
    const trigger = wrapper.querySelector('.combobox-trigger');
    const placeholderText = (opts && opts.placeholder) || 'Pick…';
    let options = (opts && opts.options) || [];
    let value = (opts && opts.value) || '';
    let baseFilter = (opts && opts.baseFilter) || null;
    let panel = null;
    let listEl = null;
    let searchEl = null;
    let activeIdx = -1;
    let filtered = options.slice();

    function render() {
      if (value) {
        const m = state.stationMeta && state.stationMeta[value];
        const sub = m && m.romaji ? ` <span class="combobox-trigger-sub">· ${m.romaji}</span>` : '';
        trigger.innerHTML = `<span>${value}${sub}</span>`;
      } else {
        trigger.innerHTML = `<span class="combobox-placeholder">${placeholderText}</span>`;
      }
    }
    function open() {
      if (panel) return;
      panel = document.createElement('div');
      panel.className = 'combobox-panel';
      panel.innerHTML = `
        <input type="text" class="input input-sm combobox-search" placeholder="Search by kanji, kana, or romaji…" autocomplete="off">
        <div class="combobox-list" role="listbox"></div>
      `;
      wrapper.appendChild(panel);
      trigger.classList.add('is-open');
      trigger.setAttribute('aria-expanded', 'true');
      searchEl = panel.querySelector('.combobox-search');
      listEl = panel.querySelector('.combobox-list');
      const _baseList = () => baseFilter ? options.filter(baseFilter) : options.slice();
      filtered = _baseList();
      activeIdx = Math.max(0, filtered.indexOf(value));
      renderList();
      searchEl.addEventListener('input', () => {
        const q = searchEl.value.trim().toLowerCase();
        const baseList = baseFilter ? options.filter(baseFilter) : options;
        if (!q) {
          filtered = baseList.slice();
        } else {
          // Rank: prefix-match on any field beats substring match
          const scored = [];
          for (const o of baseList) {
            const hay = _searchHaystack(o);
            const idx = hay.indexOf(q);
            if (idx < 0) continue;
            // Prefer matches at word boundaries (start of haystack or after space)
            const boundary = idx === 0 || hay[idx - 1] === ' ';
            scored.push({ o, score: (boundary ? 0 : 100) + idx });
          }
          scored.sort((a, b) => a.score - b.score);
          filtered = scored.map((s) => s.o);
        }
        activeIdx = 0;
        renderList();
      });
      searchEl.addEventListener('keydown', onKey);
      document.addEventListener('mousedown', onOutside);
      setTimeout(() => searchEl.focus(), 0);
    }
    function renderList() {
      if (!filtered.length) {
        listEl.innerHTML = '<div class="combobox-empty">No matches</div>';
        return;
      }
      // Cap rendered DOM nodes for perf with ~2000 stations.
      const MAX = 200;
      const shown = filtered.slice(0, MAX);
      const overflow = filtered.length - shown.length;
      listEl.innerHTML = shown.map((o, i) => {
        const cls = ['combobox-item'];
        if (o === value) cls.push('is-selected');
        if (i === activeIdx) cls.push('is-active');
        return `<div class="${cls.join(' ')}" data-i="${i}" role="option">${_renderOption(o)}</div>`;
      }).join('') + (overflow > 0 ? `<div class="combobox-empty">+ ${overflow} more — keep typing to narrow</div>` : '');
      listEl.querySelectorAll('.combobox-item').forEach((el) => {
        el.addEventListener('click', () => choose(filtered[+el.dataset.i]));
        el.addEventListener('mousemove', () => { activeIdx = +el.dataset.i; updateActive(); });
      });
      const active = listEl.querySelector('.is-active');
      if (active) active.scrollIntoView({ block: 'nearest' });
    }
    function updateActive() {
      listEl.querySelectorAll('.combobox-item').forEach((el, i) => {
        el.classList.toggle('is-active', i === activeIdx);
      });
    }
    function onKey(e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); activeIdx = Math.min(filtered.length - 1, activeIdx + 1); updateActive(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); activeIdx = Math.max(0, activeIdx - 1); updateActive(); }
      else if (e.key === 'Enter') { e.preventDefault(); if (filtered[activeIdx]) choose(filtered[activeIdx]); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
    }
    function onOutside(e) { if (!wrapper.contains(e.target)) close(); }
    function close() {
      if (!panel) return;
      panel.remove(); panel = null; listEl = null; searchEl = null;
      trigger.classList.remove('is-open');
      trigger.setAttribute('aria-expanded', 'false');
      document.removeEventListener('mousedown', onOutside);
    }
    function choose(v) {
      value = v;
      render();
      close();
      if (opts && opts.onChange) opts.onChange(value);
    }
    trigger.addEventListener('click', () => { panel ? close() : open(); });

    render();
    return {
      setOptions(newOpts) {
        options = newOpts.slice();
        if (panel) { filtered = options.slice(); activeIdx = Math.max(0, options.indexOf(value)); renderList(); }
        else render();
      },
      setValue(v) { value = v || ''; render(); },
      getValue() { return value; },
      setBaseFilter(fn) { baseFilter = fn; if (panel) { filtered = baseFilter ? options.filter(baseFilter) : options.slice(); activeIdx = 0; renderList(); } },
    };
  }

  let cbFrom = null, cbTo = null;

  function populateComboboxes() {
    if (cbFrom) cbFrom.setOptions(state.stations);
    if (cbTo) cbTo.setOptions(state.stations);
  }

  // ────── Import stations from a loaded history ──────
  window.addEventListener('suica:loaded', (ev) => {
    const h = ev.detail; if (!h || !h.entries) return;
    const fresh = new Set(state.stations);
    h.entries.forEach((e) => { if (e.station) fresh.add(e.station); });
    if (fresh.size !== state.stations.length) {
      state.stations = Array.from(fresh).sort((x, y) => x.localeCompare(y, 'ja'));
      populateComboboxes();
      const box = $('planner-load-status');
      box.innerHTML = `<span data-icon="check" data-size="14"></span><div class="flex-1"><strong>${state.stations.length}</strong> stations (including from your loaded history) · <strong>${Object.keys(state.fares).length}</strong> known IC fares.</div>`;
      if (window.refreshIcons) window.refreshIcons(box);
    }
  });

  // ────── Fare lookup ──────
  // Build an adjacency list from state.fares so we can route unknown pairs
  // through 1+ intermediate stations (sum of known IC fares = upper bound
  // estimate, but vastly more realistic than the median fallback).
  function buildFareGraph() {
    const g = {};
    Object.keys(state.fares).forEach((k) => {
      const [a, b] = k.split('↔');
      if (!a || !b) return;
      const w = state.fares[k];
      (g[a] = g[a] || []).push({ to: b, w });
      (g[b] = g[b] || []).push({ to: a, w });
    });
    state.fareGraph = g;
    state._fareCache = {}; // invalidate cached estimates
  }

  function shortestFare(a, b) {
    const g = state.fareGraph || {};
    if (!g[a] || !g[b]) return null;
    const dist = { [a]: 0 };
    const prev = {};
    // Tiny graph (~21 nodes) — linear-scan priority queue is fine.
    const visited = new Set();
    while (true) {
      let u = null, best = Infinity;
      for (const node in dist) {
        if (!visited.has(node) && dist[node] < best) { best = dist[node]; u = node; }
      }
      if (u == null) break;
      if (u === b) break;
      visited.add(u);
      for (const e of (g[u] || [])) {
        const nd = dist[u] + e.w;
        if (nd < (dist[e.to] == null ? Infinity : dist[e.to])) {
          dist[e.to] = nd;
          prev[e.to] = u;
        }
      }
    }
    if (dist[b] == null) return null;
    const path = [b];
    let cur = b;
    while (prev[cur]) { cur = prev[cur]; path.unshift(cur); }
    return { fare: dist[b], path };
  }

  function fareOf(routeKey) {
    if (state.fareOverrides && state.fareOverrides[routeKey] != null) return state.fareOverrides[routeKey];
    if (state.fares[routeKey] != null) return state.fares[routeKey];
    const [a, b] = routeKey.split('↔');
    const r = lookupFare(a, b);
    return r ? r.fare : 0;
  }

  // Inline-edit a verified fare. Stored separately in state.fareOverrides so
  // the original verified value (state.fares) is preserved and can be restored.
  function editFareOverride(routeKey) {
    const cur = state.fareOverrides && state.fareOverrides[routeKey] != null
      ? state.fareOverrides[routeKey]
      : (state.fares[routeKey] || 0);
    const input = prompt(`Override fare for ${routeKey} (enter 0 or blank to clear override).\nCurrent: ¥${cur.toLocaleString('en-US')}`, String(cur));
    if (input === null) return; // cancel
    const v = +input;
    state.fareOverrides = state.fareOverrides || {};
    if (!input.trim() || v === 0) {
      delete state.fareOverrides[routeKey];
      if (window.Toast) window.Toast.info(`Override cleared for ${routeKey}`, { duration: 2500 });
    } else if (!isFinite(v) || v < 0 || v > 20000) {
      if (window.Toast) window.Toast.error('Enter a value between ¥1 and ¥20,000.');
      return;
    } else {
      state.fareOverrides[routeKey] = v;
      if (window.Toast) window.Toast.success(`Override set: ${routeKey} → ¥${v.toLocaleString('en-US')}`);
    }
    updateFareDisplay(); renderEstimate(); saveState();
  }

  function lookupFare(a, b) {
    if (!a || !b || a === b) return null;
    const key = pairKey(a, b);
    if (state.fares[key] != null) return { fare: state.fares[key], source: 'known' };
    state._fareCache = state._fareCache || {};
    if (state._fareCache[key]) return state._fareCache[key];
    const sp = shortestFare(a, b);
    // Also compute distance-based tariff. We pick the smaller of (graph, tariff)
    // because graph estimates are upper bounds (real express routes are shorter).
    const km = _haversineKm(a, b);
    const tariffYen = km != null ? _tariffYen(km) : null;
    let r;
    if (sp && tariffYen != null) {
      // Both available — pick the lower (tighter upper bound)
      if (tariffYen <= sp.fare) {
        r = { fare: tariffYen, source: 'distance', km };
      } else {
        const hops = sp.path.length - 1;
        const via = hops > 1 ? sp.path.slice(1, -1).join('→') : '';
        r = { fare: sp.fare, source: 'graph', hops, via };
      }
    } else if (sp) {
      const hops = sp.path.length - 1;
      const via = hops > 1 ? sp.path.slice(1, -1).join('→') : '';
      r = { fare: sp.fare, source: 'graph', hops, via };
    } else if (tariffYen != null) {
      r = { fare: tariffYen, source: 'distance', km };
    } else {
      const vals = Object.values(state.fares);
      if (!vals.length) return null;
      const sorted = vals.slice().sort((x, y) => x - y);
      r = { fare: sorted[Math.floor(sorted.length / 2)], source: 'estimate' };
    }
    state._fareCache[key] = r;
    return r;
  }

  // Render station meta hints (kana, romaji, lines) for the current From/To picks.
  // Pulls from state.stationMeta which was populated from the HeartRails catalogue
  // at boot. Falls back gracefully when meta is missing.
  function humanAgo(iso) {
    if (!iso) return '';
    const t = new Date(iso).getTime();
    if (!t || isNaN(t)) return '';
    const ms = Date.now() - t;
    if (ms < 0) return 'just now';
    const m = ms / 60000;
    if (m < 1) return 'just now';
    if (m < 60) return `verified ${Math.floor(m)}m ago`;
    const h = m / 60;
    if (h < 24) return `verified ${Math.floor(h)}h ago`;
    const d = h / 24;
    if (d < 30) return `verified ${Math.floor(d)}d ago`;
    const mo = d / 30;
    if (mo < 12) return `verified ${Math.floor(mo)}mo ago`;
    return `verified ${Math.floor(d/365)}y ago`;
  }

  function forceReverify(from, to) {
    if (!FARE_API_URL || !from || !to) return;
    const key = pairKey(from, to);
    // Drop cached fare so verifyFareLive() falls through to network
    delete state.fares[key];
    delete state.fareVerifiedAt[key];
    if (window.Toast) window.Toast.info(`Re-verifying ${from}↔${to}…`);
    updateFareDisplay();
  }

  function renderStationHints() {
    const wrap = $('planner-station-hints');
    if (!wrap) return;
    const from = cbFrom ? cbFrom.getValue() : '';
    const to = cbTo ? cbTo.getValue() : '';
    if (!from && !to) { wrap.classList.add('hidden'); wrap.innerHTML = ''; return; }
    const card = (name) => {
      if (!name) return '';
      const m = state.stationMeta[name] || {};
      const lines = (m.lines || []).slice(0, 4);
      const linesHtml = lines.length
        ? lines.map((l) => `<span class="status-badge status-info font-mono text-[10px]">${l}</span>`).join(' ')
        : '<span class="text-[10px] text-muted-foreground italic">no line data</span>';
      return `
        <div class="flex-1 min-w-[140px] flex flex-col gap-1">
          <div class="text-sm font-medium flex items-baseline gap-2">
            <span>${name}</span>
            ${m.kana ? `<span class="text-[10px] text-muted-foreground">${m.kana}</span>` : ''}
            ${m.romaji ? `<span class="text-[10px] text-muted-foreground font-mono uppercase">${m.romaji}</span>` : ''}
          </div>
          <div class="flex flex-wrap gap-1">${linesHtml}</div>
        </div>`;
    };
    const fromCard = card(from);
    const toCard = card(to);
    if (!fromCard && !toCard) { wrap.classList.add('hidden'); wrap.innerHTML = ''; return; }
    wrap.classList.remove('hidden');
    wrap.innerHTML = `<div class="flex flex-wrap gap-4">${fromCard}${toCard ? '<span class="text-muted-foreground self-center">↔</span>' + toCard : ''}</div>`;
    if (window.refreshIcons) window.refreshIcons(wrap);
  }

  function updateFareDisplay() {
    const from = cbFrom ? cbFrom.getValue() : '';
    const to = cbTo ? cbTo.getValue() : '';
    const out = $('planner-fare-out');
    const addBtns = document.querySelectorAll('[data-planner-add]');
    const setBadge = (text, variant) => {
      out.className = 'status-badge ' + variant;
      out.textContent = text;
    };
    const disableAdd = () => addBtns.forEach((b) => b.setAttribute('disabled', ''));
    const enableAdd  = () => addBtns.forEach((b) => b.removeAttribute('disabled'));
    renderStationHints();
    if (!from || !to)   { setBadge('Pick from & to', 'status-skipped'); disableAdd(); return; }
    if (from === to)    { setBadge('Pick different stations', 'status-failure'); disableAdd(); return; }
    const key = pairKey(from, to);
    // Strict mode: only verified fares are usable. If we already have it in
    // state.fares (either pre-seeded from kanto_fares.json or promoted from a
    // prior live verification) it's "verified". Otherwise we must call the
    // worker to verify before allowing Add.
    if (state.fares[key] != null) {
      const at = state.fareVerifiedAt[key];
      const ago = at ? humanAgo(at) : '';
      const overridden = state.fareOverrides && state.fareOverrides[key] != null;
      const displayFare = overridden ? state.fareOverrides[key] : state.fares[key];
      const label = overridden
        ? `${fmtYen(displayFare)} · override (was ${fmtYen(state.fares[key])})`
        : `${fmtYen(displayFare)} · verified IC fare${ago ? ' · ' + ago : ''}`;
      setBadge(label, overridden ? 'status-pending' : 'status-success');
      enableAdd();
      // Show refresh-fare button if live API is configured (so user can force re-verify)
      const refreshWrap = $('planner-fare-refresh');
      if (refreshWrap) {
        refreshWrap.classList.remove('hidden');
        const editBtnHtml = `
          <button type="button" id="planner-fare-edit-btn" class="btn btn-ghost sm text-xs" data-tooltip="Override this fare manually (kept locally)">
            <span data-icon="edit" data-size="12"></span><span class="btn-label">Edit</span>
          </button>`;
        const refreshBtnHtml = FARE_API_URL ? `
          <button type="button" id="planner-fare-refresh-btn" class="btn btn-ghost sm text-xs" data-tooltip="Force re-verify against Yahoo!路線情報">
            <span data-icon="refresh" data-size="12"></span><span class="btn-label">Re-verify</span>
          </button>` : '';
        refreshWrap.innerHTML = editBtnHtml + refreshBtnHtml;
        const edBtn = refreshWrap.querySelector('#planner-fare-edit-btn');
        if (edBtn) edBtn.addEventListener('click', () => editFareOverride(key));
        const btn = refreshWrap.querySelector('#planner-fare-refresh-btn');
        if (btn) btn.addEventListener('click', () => forceReverify(from, to));
        if (window.refreshIcons) window.refreshIcons(refreshWrap);
      }
      return;
    }
    const refreshWrap = $('planner-fare-refresh');
    if (refreshWrap) refreshWrap.classList.add('hidden');
    if (!FARE_API_URL) {
      setBadge('Not in verified table · live API not configured', 'status-failure');
      disableAdd();
      return;
    }
    // Need to verify live
    setBadge('⟳ Verifying via Yahoo!路線情報…', 'status-pending');
    disableAdd();
    verifyFareLive(from, to, setBadge, enableAdd);
  }

  // ────── Live fare verification via Cloudflare Worker proxy ──────
  // Scrapes Yahoo!路線情報 server-side (CORS-blocked from browser). Result is
  // cached 30 days in the worker's KV. Frontend debounces by 300ms and aborts
  // any in-flight request when the user picks a new station so we never paint
  // stale data.
  //
  // Strict-verified mode: a pair is only added to state.fares (and thus shown
  // with a green "verified IC fare" badge) when either (a) it was pre-seeded
  // from kanto_fares.json — which we treat as ground truth (JR East official
  // 2026-03-14 rates) — or (b) the worker returned a live Yahoo!路線情報 hit.
  // Estimates (Dijkstra-graph or km-tariff) are never persisted.
  const FARE_API_URL = (typeof window !== 'undefined' && window.SUICA_FARE_API) || '';
  let _liveFareCtrl = null;
  let _liveFareTimer = null;
  const _liveFareInFlight = {}; // key → Promise (dedupe concurrent calls)

  function verifyFareLive(from, to, setBadge, onSuccess) {
    if (!FARE_API_URL) return Promise.resolve(null);
    const key = pairKey(from, to);
    if (state.fares[key] != null) {
      if (setBadge) setBadge(`${fmtYen(state.fares[key])} · verified IC fare`, 'status-success');
      if (onSuccess) onSuccess();
      return Promise.resolve(state.fares[key]);
    }
    if (_liveFareInFlight[key]) return _liveFareInFlight[key];
    if (_liveFareTimer) clearTimeout(_liveFareTimer);
    if (_liveFareCtrl) _liveFareCtrl.abort();
    const p = new Promise((resolve) => {
      _liveFareTimer = setTimeout(async () => {
        _liveFareCtrl = new AbortController();
        const url = `${FARE_API_URL.replace(/\/+$/, '')}/fare?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
        try {
          const r = await fetch(url, { signal: _liveFareCtrl.signal });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const data = await r.json();
          if (!data.ok || typeof data.fare !== 'number') throw new Error('bad response');
          // Promote to verified table — same status as pre-seeded entries.
          state.fares[key] = data.fare;
          state.fareVerifiedAt[key] = new Date().toISOString();
          // Guard: only paint if the current selection still matches.
          const stillCurrent = cbFrom && cbTo && cbFrom.getValue() === from && cbTo.getValue() === to;
          if (stillCurrent && setBadge) {
            setBadge(`${fmtYen(data.fare)} · verified IC fare`, 'status-success');
          }
          if (stillCurrent && onSuccess) onSuccess();
          // Re-render downstream so monthly history uses the freshly-verified fare.
          if (typeof renderEstimate === 'function') renderEstimate();
          resolve(data.fare);
        } catch (e) {
          if (e && e.name === 'AbortError') { resolve(null); return; }
          const stillCurrent = cbFrom && cbTo && cbFrom.getValue() === from && cbTo.getValue() === to;
          if (stillCurrent && setBadge) {
            setBadge('⚠ Verification failed — try again or pick a JR-served station', 'status-failure');
          }
          resolve(null);
        } finally {
          _liveFareCtrl = null;
          delete _liveFareInFlight[key];
        }
      }, 300);
    });
    _liveFareInFlight[key] = p;
    return p;
  }

  // ────── Add / remove routes ──────
  function addCommute() {
    const r = currentRoute(); if (!r) return;
    pushHistory();
    const days = DAYS.slice(0, 5); // Mon-Fri default
    days.forEach((day) => {
      if (!state.pattern[day].some((x) => x.route === r)) {
        state.pattern[day].push({ route: r, type: 'commute' });
      }
    });
    renderPattern();
    renderEstimate();
    saveState();
  }

  function addLeisure() {
    const r = currentRoute(); if (!r) return;
    if (state.leisure.some((x) => x.route === r)) return;
    pushHistory();
    state.leisure.push({ route: r, weight: 1 });
    renderLeisure();
    renderEstimate();
    saveState();
  }

  function currentRoute() {
    const from = cbFrom ? cbFrom.getValue() : '';
    const to = cbTo ? cbTo.getValue() : '';
    if (!from || !to || from === to) return null;
    return pairKey(from, to);
  }

  function swap() {
    if (!cbFrom || !cbTo) return;
    const f = cbFrom.getValue(), t = cbTo.getValue();
    cbFrom.setValue(t); cbTo.setValue(f);
    updateFareDisplay();
  }

  // ────── Render: weekly pattern ──────
  function renderPattern() {
    const wrap = $('planner-pattern'); wrap.innerHTML = '';
    const allEmpty = DAYS.every((d) => !state.pattern[d].length);
    if (allEmpty) {
      const empty = document.createElement('div');
      empty.className = 'rounded-md border border-dashed border-border bg-muted/30 p-3 text-center mb-2';
      empty.innerHTML = `
        <svg viewBox="0 0 220 60" width="180" height="50" aria-hidden="true" style="display:block;margin:0 auto 6px;opacity:.55;color:var(--muted-foreground);">
          <line x1="6" y1="48" x2="214" y2="48" stroke="currentColor" stroke-width="1.4"/>
          <g stroke="currentColor" stroke-width="1" opacity=".5">
            <line x1="14"  y1="52" x2="14"  y2="56"/><line x1="44"  y1="52" x2="44"  y2="56"/>
            <line x1="74"  y1="52" x2="74"  y2="56"/><line x1="104" y1="52" x2="104" y2="56"/>
            <line x1="134" y1="52" x2="134" y2="56"/><line x1="164" y1="52" x2="164" y2="56"/>
            <line x1="194" y1="52" x2="194" y2="56"/>
          </g>
          <g fill="currentColor">
            <rect x="60" y="20" width="100" height="24" rx="5"/>
            <rect x="156" y="14" width="12" height="30" rx="3"/>
          </g>
          <g fill="var(--card)" stroke="var(--card)">
            <rect x="68" y="26" width="14" height="10" rx="1.5"/>
            <rect x="88" y="26" width="14" height="10" rx="1.5"/>
            <rect x="108" y="26" width="14" height="10" rx="1.5"/>
            <rect x="128" y="26" width="14" height="10" rx="1.5"/>
          </g>
          <circle cx="78" cy="48" r="4" fill="currentColor"/>
          <circle cx="142" cy="48" r="4" fill="currentColor"/>
        </svg>
        <div class="text-sm font-medium mb-0.5">No commute set yet</div>
        <div class="text-xs text-muted-foreground mb-2">Pick a From↔To above, then tap <b>Auto-suggest from target</b> to fill weekdays.</div>
        <button type="button" id="planner-empty-suggest" class="btn sm btn-outline" data-tooltip="Auto-fill weekdays from the current From↔To and ¥ target">
          <span data-icon="wand" data-size="12"></span><span class="btn-label">Auto-suggest now</span>
        </button>`;
      wrap.appendChild(empty);
      const btn = empty.querySelector('#planner-empty-suggest');
      if (btn) btn.addEventListener('click', () => {
        const real = $('planner-auto-suggest'); if (real) real.click();
      });
      if (window.refreshIcons) window.refreshIcons(empty);
    }
    // Density meter — small 7-bar gauge showing trip count per weekday so a
    // glance reveals whether the pattern is light or heavy.
    if (!allEmpty) {
      const counts = DAYS.map((d) => state.pattern[d].length);
      const max = Math.max(1, ...counts);
      const meter = document.createElement('div');
      meter.className = 'flex items-end gap-1 mb-2 px-1';
      meter.setAttribute('data-tooltip', `Trip count per day: ${DAYS.map((d, i) => `${DAY_LABELS[d]}=${counts[i]}`).join(' · ')}`);
      DAYS.forEach((d, i) => {
        const h = Math.max(3, Math.round((counts[i] / max) * 22));
        const isWeekend = (d === 'saturday' || d === 'sunday');
        const bg = counts[i] === 0 ? 'background:var(--muted);opacity:.4' : (isWeekend ? 'background:var(--warning,#eab308)' : 'background:var(--primary,#3b82f6)');
        const bar = document.createElement('div');
        bar.style.cssText = `width:14px;height:${h}px;border-radius:2px;${bg};transition:height .2s ease`;
        bar.title = `${DAY_LABELS[d]}: ${counts[i]} trip${counts[i] === 1 ? '' : 's'}`;
        meter.appendChild(bar);
      });
      const sumLabel = document.createElement('div');
      sumLabel.className = 'ml-auto text-[10px] text-muted-foreground font-mono';
      const total = counts.reduce((a, b) => a + b, 0);
      sumLabel.textContent = `${total} trip${total === 1 ? '' : 's'}/wk`;
      meter.appendChild(sumLabel);
      wrap.appendChild(meter);
    }
    // Quick-add: a single chip per day that, on click, appends the currently
    // selected From↔To route to that day. Lets users seed a custom schedule
    // (e.g. only Tue/Thu) without going through the bulk Mon-Fri commute add.
    {
      const route = currentRoute();
      const qa = document.createElement('div');
      qa.className = 'flex items-center gap-1 mb-2 px-1 flex-wrap text-[10px]';
      qa.innerHTML = `<span class="text-muted-foreground uppercase tracking-wide mr-1">Quick add:</span>`;
      DAYS.forEach((d) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn btn-ghost sm text-[10px] px-1.5 py-0.5';
        b.disabled = !route;
        if (!route) b.classList.add('opacity-40', 'cursor-not-allowed');
        const exists = route && state.pattern[d].some((x) => x.route === route);
        b.setAttribute('data-tooltip', route ? (exists ? `${route} already on ${DAY_LABELS[d]} — click to remove` : `Add ${route} to ${DAY_LABELS[d]}`) : 'Pick a From↔To above first');
        b.innerHTML = `<span class="${exists ? 'text-primary font-semibold' : ''}">${DAY_LABELS[d]}</span>`;
        b.addEventListener('click', () => {
          if (!route) return;
          pushHistory();
          const idx = state.pattern[d].findIndex((x) => x.route === route);
          if (idx >= 0) state.pattern[d].splice(idx, 1);
          else state.pattern[d].push({ route, type: 'commute' });
          renderPattern(); renderEstimate(); saveState();
        });
        qa.appendChild(b);
      });
      wrap.appendChild(qa);
    }
    const JP_DAYS = { monday: '月', tuesday: '火', wednesday: '水', thursday: '木', friday: '金', saturday: '土', sunday: '日' };
    DAYS.forEach((day) => {
      const row = document.createElement('div');
      row.className = 'flex items-center gap-2 py-1.5 border-b border-border last:border-b-0';
      const label = document.createElement('div');
      label.className = 'text-xs text-muted-foreground font-medium w-10 flex-none flex items-center gap-1';
      label.setAttribute('data-tooltip', `${DAY_LABELS[day]} · 日本語: ${JP_DAYS[day]}曜日`);
      label.innerHTML = `<span>${DAY_LABELS[day]}</span><span class="font-mono text-[10px] opacity-60">${JP_DAYS[day]}</span>`;
      row.appendChild(label);
      const chips = document.createElement('div');
      chips.className = 'flex flex-wrap gap-1.5 flex-1';
      if (!state.pattern[day].length) {
        const empty = document.createElement('span');
        empty.className = 'text-xs text-muted-foreground italic';
        empty.textContent = 'no trips';
        chips.appendChild(empty);
      } else {
        state.pattern[day].forEach((t, idx) => {
          const chip = document.createElement('span');
          chip.className = 'status-badge status-info inline-flex items-center gap-1';
          chip.innerHTML = `<span class="font-mono">${t.route}</span><button class="ml-1 hover:text-destructive" aria-label="Remove ${t.route} from ${DAY_LABELS[day]}">×</button>`;
          chip.querySelector('button').addEventListener('click', () => {
            state.pattern[day].splice(idx, 1);
            renderPattern(); renderEstimate(); saveState();
          });
          chips.appendChild(chip);
        });
      }
      row.appendChild(chips);
      // "Clone previous day" — appears on every row except Monday (which has no
      // previous in our weekly sense). Convenient when most days share trips.
      {
        const dayIdx = DAYS.indexOf(day);
        if (dayIdx > 0) {
          const prev = DAYS[dayIdx - 1];
          if (state.pattern[prev].length) {
            const cloneBtn = document.createElement('button');
            cloneBtn.type = 'button';
            cloneBtn.className = 'btn btn-ghost sm text-xs flex-none';
            cloneBtn.setAttribute('aria-label', `Clone ${DAY_LABELS[prev]} trips into ${DAY_LABELS[day]}`);
            cloneBtn.setAttribute('data-tooltip', `Clone ${DAY_LABELS[prev]} (${state.pattern[prev].length} trips) into ${DAY_LABELS[day]}`);
            cloneBtn.textContent = '⤴';
            cloneBtn.addEventListener('click', () => {
              pushHistory();
              state.pattern[day] = state.pattern[prev].map((t) => ({ ...t }));
              renderPattern(); renderEstimate(); saveState();
              if (window.Toast) window.Toast.info(`${DAY_LABELS[prev]} → ${DAY_LABELS[day]}`, {
                duration: 3500,
                actionLabel: 'Undo',
                onAction: () => { try { undo(); } catch (_) {} },
              });
            });
            row.appendChild(cloneBtn);
          }
        }
      }
      // "Clear day" button — only shown when this day has trips
      if (state.pattern[day].length) {
        const clearBtn = document.createElement('button');
        clearBtn.type = 'button';
        clearBtn.className = 'btn btn-ghost sm text-xs flex-none text-destructive';
        clearBtn.setAttribute('aria-label', `Clear all trips for ${DAY_LABELS[day]}`);
        clearBtn.setAttribute('data-tooltip', `Remove all trips from ${DAY_LABELS[day]}`);
        clearBtn.innerHTML = '<span data-icon="x" data-size="12"></span>';
        clearBtn.addEventListener('click', () => {
          if (state.pattern[day].length > 1 && !confirm(`Clear ${state.pattern[day].length} trips from ${DAY_LABELS[day]}?`)) return;
          pushHistory();
          state.pattern[day] = [];
          renderPattern(); renderEstimate(); saveState();
          if (window.Toast) window.Toast.info(`${DAY_LABELS[day]} cleared`, {
            duration: 5000,
            actionLabel: 'Undo',
            onAction: () => { try { undo(); } catch (_) {} },
          });
        });
        row.appendChild(clearBtn);
        if (window.refreshIcons) window.refreshIcons(clearBtn);
      }
      // "Copy to other weekdays" button — only shown when this day has trips
      // and there is at least one other weekday to copy to.
      // For weekend days (Sat/Sun), this button mirrors to the other weekend day.
      if (state.pattern[day].length) {
        const isWeekend = day === 'saturday' || day === 'sunday';
        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'btn btn-ghost sm text-xs flex-none';
        if (isWeekend) {
          const otherDay = day === 'saturday' ? 'sunday' : 'saturday';
          copyBtn.setAttribute('aria-label', `Mirror ${DAY_LABELS[day]} pattern to ${DAY_LABELS[otherDay]}`);
          copyBtn.setAttribute('data-tooltip', `Copy to ${DAY_LABELS[otherDay]}`);
          copyBtn.innerHTML = '<span data-icon="chevronRight" data-size="12"></span>';
          copyBtn.addEventListener('click', () => {
            pushHistory();
            state.pattern[otherDay] = state.pattern[day].map((t) => ({ ...t }));
            renderPattern(); renderEstimate(); saveState();
            if (window.Toast) window.Toast.info(`${DAY_LABELS[day]} → ${DAY_LABELS[otherDay]}`, { duration: 2200 });
          });
        } else {
          copyBtn.setAttribute('aria-label', `Copy ${DAY_LABELS[day]} pattern to other weekdays`);
          copyBtn.setAttribute('data-tooltip', 'Copy to other weekdays (Mon–Fri)');
          copyBtn.innerHTML = '<span data-icon="chevronRight" data-size="12"></span>';
          copyBtn.addEventListener('click', () => {
            const weekdays = DAYS.slice(0, 5);
            const target = state.pattern[day].map((t) => ({ ...t }));
            weekdays.forEach((d) => { if (d !== day) state.pattern[d] = target.map((t) => ({ ...t })); });
            renderPattern(); renderEstimate(); saveState();
          });
        }
        row.appendChild(copyBtn);
        if (window.refreshIcons) window.refreshIcons(copyBtn);
      }
      // Copy this day to the day-clipboard (for paste-into any other day).
      if (state.pattern[day].length) {
        const copyClipBtn = document.createElement('button');
        copyClipBtn.type = 'button';
        copyClipBtn.className = 'btn btn-ghost sm text-xs flex-none';
        copyClipBtn.setAttribute('aria-label', `Copy ${DAY_LABELS[day]} to day-clipboard`);
        copyClipBtn.setAttribute('data-tooltip', `Copy ${DAY_LABELS[day]} (${state.pattern[day].length} trip${state.pattern[day].length === 1 ? '' : 's'}) to clipboard for pasting elsewhere`);
        copyClipBtn.textContent = '📋';
        copyClipBtn.addEventListener('click', () => {
          _dayClipboard = { day, trips: state.pattern[day].map((t) => ({ ...t })) };
          renderPattern();
          if (window.Toast) window.Toast.info(`${DAY_LABELS[day]} (${_dayClipboard.trips.length} trips) copied — click 📥 on another day to paste`, { duration: 5000 });
        });
        row.appendChild(copyClipBtn);
      }
      // Paste day-clipboard into this day (only when clipboard has content + not same day).
      if (_dayClipboard && _dayClipboard.day !== day) {
        const pasteBtn = document.createElement('button');
        pasteBtn.type = 'button';
        pasteBtn.className = 'btn btn-ghost sm text-xs flex-none text-primary';
        pasteBtn.setAttribute('aria-label', `Paste clipboard (${_dayClipboard.trips.length} trips from ${DAY_LABELS[_dayClipboard.day]}) into ${DAY_LABELS[day]}`);
        pasteBtn.setAttribute('data-tooltip', `Paste ${_dayClipboard.trips.length} trips from ${DAY_LABELS[_dayClipboard.day]} into ${DAY_LABELS[day]} (replaces current)`);
        pasteBtn.textContent = '📥';
        pasteBtn.addEventListener('click', () => {
          pushHistory();
          state.pattern[day] = _dayClipboard.trips.map((t) => ({ ...t }));
          renderPattern(); renderEstimate(); saveState();
          if (window.Toast) window.Toast.info(`${DAY_LABELS[_dayClipboard.day]} → ${DAY_LABELS[day]}`, {
            duration: 4000,
            actionLabel: 'Undo',
            onAction: () => { try { undo(); } catch (_) {} },
          });
        });
        row.appendChild(pasteBtn);
      }
      wrap.appendChild(row);
    });
  }

  // ────── Render: leisure pool ──────
  function renderLeisure() {
    const wrap = $('planner-leisure'); wrap.innerHTML = '';
    if (!state.leisure.length) {
      wrap.innerHTML = `
        <div class="rounded-md border border-dashed border-border bg-muted/30 p-3 text-center">
          <div class="text-sm font-medium mb-0.5">No leisure routes yet</div>
          <div class="text-xs text-muted-foreground mb-2">Add weekend trips (e.g. shopping, day-out) so target spending isn't dependent only on commute.</div>
          <button type="button" id="planner-empty-leisure-suggest" class="btn sm btn-outline" data-tooltip="Auto-suggest 2 random leisure routes from station catalogue">
            <span data-icon="sparkles" data-size="12"></span><span class="btn-label">Pick 2 for me</span>
          </button>
        </div>`;
      const btn = wrap.querySelector('#planner-empty-leisure-suggest');
      if (btn) btn.addEventListener('click', () => {
        const real = $('planner-auto-suggest'); if (real) real.click();
      });
      if (window.refreshIcons) window.refreshIcons(wrap);
      return;
    }
    // Sort toolbar — affects render order only, not state order.
    const sortMode = wrap.dataset.leisureSort || 'manual';
    const tagFilter = wrap.dataset.leisureTag || '';
    // Tag filter chip row — only shown when at least one row has a tag.
    const allTags = Array.from(new Set(state.leisure.map((l) => (l.tag || '').trim()).filter(Boolean))).sort();
    if (allTags.length) {
      const tagBar = document.createElement('div');
      tagBar.className = 'flex items-center gap-1 pb-1.5 text-xs text-muted-foreground flex-wrap';
      tagBar.innerHTML = `<span class="mr-1">Tag:</span>
        <button type="button" class="btn xs ${!tagFilter ? 'btn-default' : 'btn-ghost'}" data-leisure-tag-filter="">All</button>
        ${allTags.map((t) => `<button type="button" class="btn xs ${tagFilter===t?'btn-default':'btn-ghost'}" data-leisure-tag-filter="${t}">${t}</button>`).join('')}`;
      tagBar.querySelectorAll('[data-leisure-tag-filter]').forEach((b) => {
        b.addEventListener('click', () => { wrap.dataset.leisureTag = b.dataset.leisureTagFilter; renderLeisure(); });
      });
      wrap.appendChild(tagBar);
    }
    if (state.leisure.length >= 2) {
      const bar = document.createElement('div');
      bar.className = 'flex items-center gap-1 pb-1.5 text-xs text-muted-foreground';
      bar.innerHTML = `
        <span class="mr-1">Sort:</span>
        ${['manual','fare','weight','name'].map((m) => `<button type="button" class="btn xs ${sortMode===m?'btn-default':'btn-ghost'}" data-leisure-sort="${m}">${m}</button>`).join('')}
      `;
      bar.querySelectorAll('[data-leisure-sort]').forEach((b) => {
        b.addEventListener('click', () => {
          wrap.dataset.leisureSort = b.dataset.leisureSort;
          renderLeisure();
        });
      });
      wrap.appendChild(bar);
    }
    const indexed = state.leisure.map((l, idx) => ({ l, idx }))
      .filter(({ l }) => !tagFilter || (l.tag || '').trim() === tagFilter);
    if (sortMode === 'fare') indexed.sort((a, b) => fareOf(b.l.route) - fareOf(a.l.route));
    else if (sortMode === 'weight') indexed.sort((a, b) => b.l.weight - a.l.weight);
    else if (sortMode === 'name') indexed.sort((a, b) => a.l.route.localeCompare(b.l.route, 'ja'));
    // Build leisure-route popularity from Recent history so users see which
    // routes the generator has actually been picking.
    const recentList = (function () { try { return loadRecent(); } catch (_) { return []; } })();
    const popularity = Object.create(null);
    let popMax = 0;
    recentList.forEach((r) => {
      (r.routes || []).forEach((rt) => {
        popularity[rt] = (popularity[rt] || 0) + 1;
        if (popularity[rt] > popMax) popMax = popularity[rt];
      });
    });
    indexed.forEach(({ l, idx }) => {
      const row = document.createElement('div');
      const muted = +l.weight === 0;
      row.className = 'flex items-center gap-2 py-1.5 border-b border-border last:border-b-0' + (muted ? ' opacity-50' : '');
      row.draggable = (sortMode === 'manual' && !tagFilter);
      row.dataset.leisureRow = String(idx);
      if (row.draggable) {
        row.style.cursor = 'grab';
        row.setAttribute('data-tooltip', 'Drag to reorder');
        row.addEventListener('dragstart', (e) => {
          row.classList.add('opacity-30');
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', String(idx));
        });
        row.addEventListener('dragend', () => row.classList.remove('opacity-30'));
        row.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; row.style.borderTopColor = 'var(--primary)'; });
        row.addEventListener('dragleave', () => { row.style.borderTopColor = ''; });
        row.addEventListener('drop', (e) => {
          e.preventDefault();
          row.style.borderTopColor = '';
          const from = +e.dataTransfer.getData('text/plain');
          const to = idx;
          if (!isFinite(from) || from === to) return;
          pushHistory();
          const moved = state.leisure.splice(from, 1)[0];
          state.leisure.splice(to, 0, moved);
          renderLeisure(); renderEstimate(); saveState();
        });
      }
      const pop = popularity[l.route] || 0;
      const filled = popMax ? Math.round((pop / popMax) * 5) : 0;
      const dotsStr = (recentList.length && pop)
        ? `<span class="font-mono text-[10px] text-muted-foreground" data-tooltip="Picked in ${pop} of the last ${recentList.length} generations">${'●'.repeat(filled)}${'○'.repeat(5 - filled)}</span>`
        : (recentList.length
            ? `<span class="font-mono text-[10px] text-muted-foreground/50" data-tooltip="Not yet picked in the last ${recentList.length} generations">○○○○○</span>`
            : '<span class="font-mono text-[10px] text-muted-foreground/40" data-tooltip="No generation history yet">—</span>');
      row.innerHTML = `
        <button class="btn sm btn-ghost text-xs flex-none" data-leisure-mute="${idx}" data-tooltip="${muted ? 'Re-enable this route in the random pool' : 'Mute (weight=0) — keep in the list but exclude from random picks'}" aria-label="${muted ? 'Unmute' : 'Mute'} ${l.route}">${muted ? '🙈' : '👁'}</button>
        <span class="status-badge ${muted ? 'status-pending' : 'status-pending'} font-mono flex-none ${muted ? 'line-through' : ''}">${l.route}</span>
        ${dotsStr}
        <input type="text" maxlength="14" value="${(l.tag || '').replace(/"/g, '&quot;')}" placeholder="tag" class="input w-20 text-xs" data-leisure-tag="${idx}" data-tooltip="Optional tag (e.g. shopping, family) — filterable">
        <span class="text-xs text-muted-foreground">weight</span>
        <input type="number" min="0" max="20" value="${l.weight}" class="input w-16 text-sm" data-leisure-weight="${idx}" ${muted ? 'disabled' : ''}>
        <span class="text-xs text-muted-foreground font-mono ml-auto">${fmtYen(fareOf(l.route))}</span>
        <button class="btn sm btn-ghost" data-leisure-clone="${idx}" aria-label="Duplicate ${l.route}" data-tooltip="Duplicate this row (same route, same weight)">⎘</button>
        <button class="btn sm btn-ghost" data-leisure-remove="${idx}" aria-label="Remove ${l.route} from leisure pool">×</button>
      `;
      wrap.appendChild(row);
    });
    wrap.querySelectorAll('[data-leisure-mute]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const i = +e.currentTarget.dataset.leisureMute;
        const cur = state.leisure[i];
        if (+cur.weight === 0) {
          cur.weight = Math.max(1, +cur._prevWeight || 1);
          delete cur._prevWeight;
        } else {
          cur._prevWeight = +cur.weight;
          cur.weight = 0;
        }
        renderLeisure(); renderEstimate(); saveState();
      });
    });
    wrap.querySelectorAll('[data-leisure-weight]').forEach((input) => {
      input.addEventListener('change', (e) => {
        const i = +e.target.dataset.leisureWeight;
        state.leisure[i].weight = Math.max(0, +e.target.value || 0);
        renderEstimate();
        saveState();
      });
    });
    wrap.querySelectorAll('[data-leisure-tag]').forEach((input) => {
      input.addEventListener('change', (e) => {
        const i = +e.target.dataset.leisureTag;
        const v = String(e.target.value || '').trim().slice(0, 14);
        if (v) state.leisure[i].tag = v;
        else delete state.leisure[i].tag;
        saveState();
        renderLeisure();
      });
    });
    wrap.querySelectorAll('[data-leisure-clone]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const i = +e.currentTarget.dataset.leisureClone;
        const src = state.leisure[i];
        if (!src) return;
        pushHistory();
        state.leisure.splice(i + 1, 0, { ...src });
        renderLeisure(); renderEstimate(); saveState();
        if (window.Toast) window.Toast.info(`Duplicated ${src.route}`, {
          duration: 4000, actionLabel: 'Undo', onAction: () => { try { undo(); } catch (_) {} },
        });
      });
    });
    wrap.querySelectorAll('[data-leisure-remove]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const i = +e.target.closest('[data-leisure-remove]').dataset.leisureRemove;
        state.leisure.splice(i, 1);
        renderLeisure(); renderEstimate(); saveState();
      });
    });
  }

  let _wfHealthFetched = false;
  async function fetchWorkflowHealth() {
    if (_wfHealthFetched) return;
    _wfHealthFetched = true;
    const el = document.getElementById('planner-wf-health');
    if (!el) return;
    try {
      const url = `https://api.github.com/repos/VuTan11501/Code/actions/workflows/suica-pdf-generate.yml/runs?per_page=10`;
      const res = await fetch(url, { headers: { 'Accept': 'application/vnd.github+json' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const runs = (data.workflow_runs || []).filter((r) => r.conclusion);
      if (!runs.length) return;
      const total = runs.length;
      const ok = runs.filter((r) => r.conclusion === 'success').length;
      const pct = Math.round((ok / total) * 100);
      const variant = pct >= 90 ? 'status-success' : pct >= 60 ? 'status-pending' : 'status-warning';
      el.className = `status-badge ${variant} text-[10px] ml-1`;
      el.textContent = `${pct}% · ${ok}/${total} ok`;
      el.setAttribute('data-tooltip', `Last ${total} workflow runs: ${ok} success, ${total - ok} failed/cancelled. Newest: ${new Date(runs[0].created_at).toLocaleString()}`);
      el.classList.remove('hidden');
    } catch (e) {
      // silently swallow — unauthenticated rate limit can hit easily
    }
  }

  // ────── Estimate monthly spend ──────
  function countWeekdaysInMonth(monthStr) {
    // monthStr "YYYY-MM"; returns {weekdayCounts: {monday:5, …, sunday:4}}
    const [y, m] = monthStr.split('-').map(Number);
    if (!y || !m) return null;
    const last = new Date(y, m, 0).getDate();
    const counts = { monday: 0, tuesday: 0, wednesday: 0, thursday: 0, friday: 0, saturday: 0, sunday: 0 };
    const jsToKey = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    for (let d = 1; d <= last; d++) {
      const dow = new Date(y, m - 1, d).getDay();
      counts[jsToKey[dow]]++;
    }
    return { last, counts };
  }

  function renderEstimate() {
    const monthInfo = countWeekdaysInMonth(state.settings.month);
    if (!monthInfo) { $('planner-estimate').textContent = '—'; return; }
    let commuteSpend = 0;
    DAYS.forEach((day) => {
      const trips = state.pattern[day];
      const dayFare = trips.reduce((sum, t) => sum + fareOf(t.route), 0);
      commuteSpend += dayFare * monthInfo.counts[day];
    });
    const totW = state.leisure.reduce((s, l) => s + l.weight, 0);
    const avgLeisureFare = totW
      ? state.leisure.reduce((s, l) => s + fareOf(l.route) * l.weight, 0) / totW
      : 0;
    const avgOutings = (state.settings.leisure_min + state.settings.leisure_max) / 2;
    const leisureSpend = avgLeisureFare * avgOutings * 2;
    const total = commuteSpend + leisureSpend;
    $('planner-estimate-commute').textContent = fmtYen(commuteSpend);
    $('planner-estimate-leisure').textContent = fmtYen(leisureSpend);
    $('planner-estimate-total').textContent = fmtYen(total);
    // Diff vs target
    const target = +state.settings.target || 0;
    const diff = total - target;
    const diffEl = $('planner-estimate-diff');
    const bar = $('planner-estimate-bar');
    const barTargetLabel = $('planner-estimate-bar-target');
    const barWrap = $('planner-estimate-bar-wrap');
    if (target) {
      const pct = ((diff / target) * 100).toFixed(1);
      diffEl.textContent = `${diff >= 0 ? '+' : ''}${fmtYen(diff)} vs target (${pct}%)`;
      const absPct = Math.abs(diff) / target;
      const tone = absPct <= 0.10 ? 'text-primary' : (absPct <= 0.25 ? 'text-warning' : 'text-destructive');
      diffEl.className = 'text-xs font-mono ' + tone;
      // Progress bar fill % = total/target, capped at 150%
      if (bar) {
        const fillPct = Math.min(150, (total / target) * 100);
        bar.style.width = fillPct + '%';
        // Color tiers
        bar.classList.remove('bg-primary', 'bg-warning', 'bg-destructive', 'bg-muted-foreground');
        const cls = absPct <= 0.10 ? 'bg-primary' : (absPct <= 0.25 ? 'bg-warning' : 'bg-destructive');
        bar.classList.add(cls);
      }
      if (barTargetLabel) barTargetLabel.textContent = `Target ${fmtYen(target)} · ${total.toLocaleString()} / ${target.toLocaleString()}`;
      if (barWrap) barWrap.removeAttribute('aria-hidden');
    } else {
      diffEl.textContent = '';
      if (bar) bar.style.width = '0%';
      if (barTargetLabel) barTargetLabel.textContent = 'Target ¥—';
      if (barWrap) barWrap.setAttribute('aria-hidden', 'true');
    }
    renderWarnings({ total, target, commuteSpend, leisureSpend, monthInfo });
    renderCalendar();
    // Per-day spend breakdown bars (commute only — leisure is randomized).
    const dayBd = document.getElementById('planner-estimate-day-breakdown');
    if (dayBd) {
      dayBd.innerHTML = '';
      const perDay = DAYS.map((day) => {
        const fare = state.pattern[day].reduce((s, t) => s + fareOf(t.route), 0);
        return fare * (monthInfo.counts[day] || 0);
      });
      const maxDay = Math.max(1, ...perDay);
      const JP = { monday:'月', tuesday:'火', wednesday:'水', thursday:'木', friday:'金', saturday:'土', sunday:'日' };
      DAYS.forEach((day, i) => {
        const v = perDay[i];
        const h = Math.max(2, Math.round((v / maxDay) * 40));
        const col = document.createElement('div');
        col.className = 'flex flex-col items-center gap-0.5';
        col.setAttribute('data-tooltip', `${DAY_LABELS[day]} (${monthInfo.counts[day]}× this month): ${fmtYen(v)} from commute`);
        const isWk = day === 'saturday' || day === 'sunday';
        col.innerHTML = `
          <div style="width:18px;height:${h}px;border-radius:2px;background:${v ? (isWk ? 'var(--warning,#eab308)' : 'var(--primary,#3b82f6)') : 'var(--muted)'};opacity:${v ? 1 : .4};"></div>
          <div class="font-mono text-[9px] text-muted-foreground">${JP[day]}</div>
        `;
        dayBd.appendChild(col);
      });
      const tot = document.createElement('div');
      tot.className = 'flex flex-col items-end ml-2 text-[10px] font-mono text-muted-foreground';
      tot.innerHTML = `<div>${fmtYen(commuteSpend)}</div><div class="opacity-60">commute/mo</div>`;
      dayBd.appendChild(tot);
    }
  }

  // ────── Validation: surface non-blocking warnings ──────
  // Pure: looks at current state + computed totals and returns an array of
  // {severity:'warn'|'error'|'info', msg, fix?}. Rendered into #planner-warnings.
  function computeWarnings(ctx) {
    const out = [];
    const target = +(ctx && ctx.target) || +state.settings.target || 0;
    const total = +(ctx && ctx.total) || 0;
    const monthInfo = ctx && ctx.monthInfo;
    if (target && total) {
      const diffPct = Math.abs(total - target) / target;
      if (diffPct > 0.25) {
        out.push({ severity: total > target ? 'error' : 'warn',
          msg: `Estimate is ${(diffPct*100).toFixed(0)}% ${total > target ? 'over' : 'under'} target — consider Auto-suggest`,
          fix: 'auto-suggest' });
      }
    }
    // Empty plan
    const totalTrips = DAYS.reduce((s, d) => s + (state.pattern[d]?.length || 0), 0) + state.leisure.length;
    if (!totalTrips) {
      out.push({ severity: 'warn', msg: 'Plan is empty — add a commute or pick a preset' });
    }
    // Invalid month
    if (!monthInfo) {
      out.push({ severity: 'error', msg: 'Month is not a valid YYYY-MM' });
    }
    // Routes missing fare data
    const missing = new Set();
    DAYS.forEach((d) => state.pattern[d].forEach((t) => { if (!state.fares[t.route]) missing.add(t.route); }));
    state.leisure.forEach((l) => { if (!state.fares[l.route]) missing.add(l.route); });
    if (missing.size) {
      out.push({ severity: 'error', msg: `Missing fare data for: ${Array.from(missing).slice(0,3).join(', ')}${missing.size > 3 ? ` (+${missing.size-3})` : ''}` });
    }
    // Leisure min > max
    if (+state.settings.leisure_min > +state.settings.leisure_max) {
      out.push({ severity: 'error', msg: `Leisure min (${state.settings.leisure_min}) is greater than max (${state.settings.leisure_max})` });
    }
    // Suspiciously low initial balance
    if (+state.settings.initial_balance < 1000) {
      out.push({ severity: 'info', msg: 'Initial balance < ¥1000 — first day may trigger immediate top-up' });
    }
    // Top-up threshold > amount
    if (+state.settings.topup_threshold > +state.settings.topup_amount) {
      out.push({ severity: 'warn', msg: 'Top-up amount is lower than threshold — balance may stay below trigger after top-up' });
    }
    // No weekend trips and target requires them
    if (target && totalTrips && !state.leisure.length) {
      const weekdaySpend = DAYS.slice(0, 5).reduce((s, d) => {
        return s + state.pattern[d].reduce((ss, t) => ss + (fareOf(t.route) || 0), 0) * (monthInfo?.counts[d] || 0);
      }, 0);
      if (weekdaySpend < target * 0.6) {
        out.push({ severity: 'info', msg: 'Weekdays alone cover <60% of target — add leisure routes for variety' });
      }
    }
    return out;
  }

  function renderWarnings(ctx) {
    const panel = $('planner-warnings');
    if (!panel) return;
    const allWarns = computeWarnings(ctx);
    const visible = allWarns.filter((w) => !_dismissedWarnings.has(w.msg));
    if (!visible.length) { panel.classList.add('hidden'); panel.innerHTML = ''; return; }
    panel.classList.remove('hidden');
    const sevFilter = panel.dataset.sevFilter || 'all';
    const warns = sevFilter === 'all' ? visible : visible.filter((w) => w.severity === sevFilter);
    const counts = { error: 0, warn: 0, info: 0 };
    visible.forEach((w) => { counts[w.severity] = (counts[w.severity] || 0) + 1; });
    const iconFor = (s) => s === 'error' ? 'alertTriangle' : s === 'warn' ? 'alert' : 'info';
    const toneFor = (s) => s === 'error' ? 'text-destructive' : s === 'warn' ? 'text-warning' : 'text-muted-foreground';
    const hidden = allWarns.length - visible.length;
    const chip = (key, label, n) => `<button type="button" data-warn-sev="${key}" class="btn xs ${sevFilter === key ? 'btn-default' : 'btn-ghost'} text-[10px]">${label}${n != null ? ` (${n})` : ''}</button>`;
    panel.innerHTML = `
      <div class="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-2 uppercase tracking-wide flex-wrap">
        <span data-icon="alert" data-size="12"></span> Plan checks (${warns.length}${hidden ? ` · ${hidden} hidden` : ''})
        <span class="ml-auto flex items-center gap-1 normal-case tracking-normal">
          ${chip('all', 'All', visible.length)}
          ${counts.error ? chip('error', '✕', counts.error) : ''}
          ${counts.warn ? chip('warn', '!', counts.warn) : ''}
          ${counts.info ? chip('info', 'i', counts.info) : ''}
        </span>
      </div>
      <ul class="flex flex-col gap-1.5">
        ${warns.map((w, i) => `
          <li class="flex items-start gap-2 text-xs ${toneFor(w.severity)}">
            <span data-icon="${iconFor(w.severity)}" data-size="12" class="mt-0.5 flex-none"></span>
            <span class="flex-1">${w.msg}</span>
            ${w.fix === 'auto-suggest' ? '<button type="button" class="btn btn-ghost sm text-[10px] py-0.5 px-2" data-warn-fix="auto-suggest">Fix</button>' : ''}
            <button type="button" class="btn btn-ghost sm text-[10px] py-0.5 px-1.5 opacity-60 hover:opacity-100" data-warn-dismiss="${i}" aria-label="Dismiss warning" data-tooltip="Dismiss until the plan changes">×</button>
          </li>`).join('')}
      </ul>`;
    if (window.refreshIcons) window.refreshIcons(panel);
    panel.querySelectorAll('[data-warn-fix="auto-suggest"]').forEach((b) => {
      b.addEventListener('click', () => { const real = $('planner-auto-suggest'); if (real) real.click(); });
    });
    panel.querySelectorAll('[data-warn-dismiss]').forEach((b) => {
      b.addEventListener('click', () => {
        const i = +b.dataset.warnDismiss;
        if (warns[i]) _dismissedWarnings.add(warns[i].msg);
        renderWarnings(ctx);
      });
    });
    panel.querySelectorAll('[data-warn-sev]').forEach((b) => {
      b.addEventListener('click', () => { panel.dataset.sevFilter = b.dataset.warnSev; renderWarnings(ctx); });
    });
  }

  // ────── Calendar preview ──────
  // Renders a 7-column month grid for state.settings.month. Each cell shows
  // the date, and a small dot/badge per scheduled trip on that weekday so
  // the user can see at-a-glance how dense the month will be. Weekends are
  // shaded; today is highlighted.
  function renderCalendar() {
    const wrap = $('planner-calendar');
    if (!wrap) return;
    const monthInfo = countWeekdaysInMonth(state.settings.month);
    if (!monthInfo) { wrap.classList.add('hidden'); wrap.innerHTML = ''; return; }
    wrap.classList.remove('hidden');
    const [y, m] = state.settings.month.split('-').map(Number);
    const first = new Date(y, m - 1, 1);
    const startDow = first.getDay(); // 0=Sun..6=Sat
    const last = monthInfo.last;
    const today = new Date();
    const isToday = (d) => today.getFullYear() === y && today.getMonth() + 1 === m && today.getDate() === d;
    const dayKeyByJs = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const weekendIdx = new Set([0, 6]); // Sun, Sat
    const cells = [];
    // Leading blanks (Sun-aligned)
    for (let i = 0; i < startDow; i++) cells.push({ blank: true });
    for (let d = 1; d <= last; d++) {
      const js = new Date(y, m - 1, d).getDay();
      const dayKey = dayKeyByJs[js];
      const trips = state.pattern[dayKey] || [];
      cells.push({
        d, dayKey, weekend: weekendIdx.has(js),
        today: isToday(d),
        tripCount: trips.length,
        leisureChance: weekendIdx.has(js) ? (state.leisure.length > 0 ? 1 : 0) : 0,
        routes: trips.map((t) => t.route),
      });
    }
    while (cells.length % 7) cells.push({ blank: true });
    const HEADERS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const html = `
      <div class="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-2 uppercase tracking-wide">
        <span data-icon="calendar" data-size="12"></span> ${state.settings.month} preview
        <span class="ml-auto text-[10px] normal-case tracking-normal text-muted-foreground/70">${last} days · ${monthInfo.counts.saturday + monthInfo.counts.sunday} weekend days</span>
      </div>
      <div class="grid grid-cols-7 gap-1 text-[10px]">
        ${HEADERS.map((h, i) => `<div class="text-center text-muted-foreground font-medium pb-1 ${weekendIdx.has(i) ? 'text-warning/80' : ''}">${h}</div>`).join('')}
        ${cells.map((c) => {
          if (c.blank) return '<div class="aspect-square"></div>';
          const bg = c.today ? 'bg-primary/20 border-primary' :
                     c.weekend ? 'bg-muted/40 border-border' :
                     'bg-card border-border';
          const dotCount = c.tripCount + (c.weekend && c.leisureChance ? 1 : 0);
          const dots = dotCount > 0
            ? `<div class="flex justify-center gap-0.5 mt-0.5">${Array.from({length: Math.min(3, dotCount)}).map(() => '<span class="w-1 h-1 rounded-full bg-primary"></span>').join('')}${dotCount > 3 ? `<span class="text-[8px] text-primary">+${dotCount-3}</span>` : ''}</div>`
            : '';
          const labelMap = { monday:'Mon', tuesday:'Tue', wednesday:'Wed', thursday:'Thu', friday:'Fri', saturday:'Sat', sunday:'Sun' };
          const dayLabel = labelMap[c.dayKey] || c.dayKey;
          const fareTotal = c.routes.reduce((s, r) => s + (fareOf(r) || 0), 0);
          let tooltip;
          if (c.routes.length) {
            const breakdown = c.routes.map((r) => `${r} · ${fmtYen(fareOf(r) || 0)}`).join('\n');
            tooltip = `${dayLabel} ${c.d}\n${breakdown}\nTotal: ${fmtYen(fareTotal)}`;
          } else if (c.weekend) {
            tooltip = `${dayLabel} ${c.d}\nWeekend — random leisure pick from ${state.leisure.length} routes`;
          } else {
            tooltip = `${dayLabel} ${c.d}\nNo commute trips scheduled`;
          }
          return `<div class="aspect-square border rounded ${bg} flex flex-col items-center justify-center" data-tooltip="${tooltip.replace(/"/g, '&quot;')}">
            <div class="font-mono ${c.today ? 'font-bold text-primary' : ''}">${c.d}</div>
            ${dots}
          </div>`;
        }).join('')}
      </div>`;
    wrap.innerHTML = html;
    if (window.refreshIcons) window.refreshIcons(wrap);
  }


  function buildPreset() {
    const pattern = {};
    DAYS.forEach((d) => { pattern[d] = state.pattern[d].map((t) => ({ route: t.route, type: 'commute' })); });
    return {
      _meta: {
        name: 'Custom plan',
        description: 'Built via dashboard trip planner',
        version: 1,
        generated_at: new Date().toISOString(),
      },
      initial_balance: +state.settings.initial_balance,
      auto_topup: { threshold: +state.settings.topup_threshold, amount: +state.settings.topup_amount },
      teiki: [],
      weekly_pattern: pattern,
      leisure_pool: state.leisure.map((l) => ({ route: l.route, weight: +l.weight })),
      leisure_monthly_count: [+state.settings.leisure_min, +state.settings.leisure_max],
      off_days: [],
      timing: {
        morning_commute: { base: '08:30', sigma_min: 8 },
        evening_commute: { base: '19:00', sigma_min: 15 },
        weekend_leisure: { window: ['10:00', '20:00'] },
      },
    };
  }

  // ────── Build CLI command ──────
  function buildCli() {
    const s = state.settings;
    return [
      'python scripts/generate.py',
      `  --preset preset.json`,
      `  --month ${s.month}`,
      `  --target ${s.target}`,
      `  --seed ${s.seed}`,
      `  --out out/${s.month}.json`,
    ].join(' \\\n');
  }

  // ────── In-browser Monthly History Generator ──────
  // Simplified JS port of .github/skills/suica-history-generator/scripts/generate.py
  // Builds a deterministic MonthlyHistory from the planner state without needing the CLI.
  function mulberry32(seed) {
    let s = (seed >>> 0) || 1;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function jpDateTime(y, m, d, hour, min) { return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')} ${String(hour).padStart(2,'0')}:${String(min).padStart(2,'0')}:00`; }

  function generateMonthlyHistory() {
    const { settings, pattern, leisure, fares } = state;
    const rng = mulberry32(settings.seed || 42);
    const pickWeighted = (pool) => {
      const tot = pool.reduce((s, x) => s + x.weight, 0); if (!tot) return null;
      let r = rng() * tot;
      for (const x of pool) { r -= x.weight; if (r <= 0) return x; }
      return pool[pool.length - 1];
    };
    const [y, m] = (settings.month || '').split('-').map(Number);
    if (!y || !m) throw new Error('Invalid month — use YYYY-MM');
    const lastDay = new Date(y, m, 0).getDate();
    const dayKeys = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];

    // Pick leisure days
    const weekendDays = [];
    for (let d = 1; d <= lastDay; d++) {
      const dow = new Date(y, m - 1, d).getDay();
      if (dow === 0 || dow === 6) weekendDays.push(d);
    }
    const lmin = +settings.leisure_min || 0, lmax = Math.max(lmin, +settings.leisure_max || 0);
    const leisureCount = lmin + Math.floor(rng() * (lmax - lmin + 1));
    const leisureDays = new Map(); // day -> route
    const wPool = [...weekendDays];
    for (let i = 0; i < leisureCount && wPool.length && leisure.length; i++) {
      const idx = Math.floor(rng() * wPool.length);
      const day = wPool.splice(idx, 1)[0];
      const pick = pickWeighted(leisure);
      if (pick) leisureDays.set(day, pick.route);
    }

    const entries = [];
    let balance = +settings.initial_balance || 0;
    const topupThr = +settings.topup_threshold || 0;
    const topupAmt = +settings.topup_amount || 0;

    const emitTopupIfNeeded = (atY, atM, atD, atH, atMin, nextFare) => {
      if (balance - nextFare < topupThr && topupAmt > 0) {
        balance += topupAmt;
        let hh = atH, mm = atMin - 6;
        if (mm < 0) { mm += 60; hh = Math.max(0, hh - 1); }
        entries.push({ kind: 'ｵｰﾄﾁｬｰｼﾞ', at: jpDateTime(atY, atM, atD, hh, mm), station: 'モバイル', fare_yen: topupAmt, balance_yen: balance });
      }
    };

    const emitTrip = (d, route, slot) => {
      const [a, b] = route.split('↔');
      const fareKey = pairKey(a, b);
      const fare = fareOf(fareKey);
      // direction
      const morningOutbound = slot === 'morning';
      const from = morningOutbound ? a : b;
      const to   = morningOutbound ? b : a;
      // timing
      let hh, mm;
      if (slot === 'morning')      { hh = 8;  mm = 25 + Math.floor(rng() * 12); }
      else if (slot === 'evening') { hh = 18; mm = 30 + Math.floor(rng() * 50); if (mm >= 60) { hh += Math.floor(mm/60); mm %= 60; } }
      else                          { hh = 10 + Math.floor(rng() * 10); mm = Math.floor(rng() * 60); }
      const dur = 18 + Math.floor(rng() * 28);
      let outH = hh, outM = mm + dur;
      if (outM >= 60) { outH += Math.floor(outM / 60); outM %= 60; }

      emitTopupIfNeeded(y, m, d, hh, mm, fare);
      entries.push({ kind: '入', at: jpDateTime(y, m, d, hh, mm), station: from, fare_yen: 0, balance_yen: balance });
      balance -= fare;
      entries.push({ kind: '出', at: jpDateTime(y, m, d, outH, outM), station: to, fare_yen: fare, balance_yen: balance });
    };

    for (let d = 1; d <= lastDay; d++) {
      const dow = new Date(y, m - 1, d).getDay();
      const dowKey = dayKeys[dow];
      const commute = (pattern[dowKey] || []);
      // Weekday commute: morning + evening for each route in pattern
      commute.forEach((p) => {
        emitTrip(d, p.route, 'morning');
        emitTrip(d, p.route, 'evening');
      });
      // Weekend leisure: one out + return
      if (leisureDays.has(d)) {
        const route = leisureDays.get(d);
        emitTrip(d, route, 'weekend');
        // return trip ~3-5h later
        const [a, b] = route.split('↔');
        const fare = fareOf(pairKey(a,b));
        const hh = 16 + Math.floor(rng() * 4);
        const mm = Math.floor(rng() * 60);
        emitTopupIfNeeded(y, m, d, hh, mm, fare);
        entries.push({ kind: '入', at: jpDateTime(y, m, d, hh, mm), station: b, fare_yen: 0, balance_yen: balance });
        balance -= fare;
        const dur = 20 + Math.floor(rng() * 30);
        let oH = hh, oM = mm + dur; if (oM >= 60) { oH += Math.floor(oM/60); oM %= 60; }
        entries.push({ kind: '出', at: jpDateTime(y, m, d, oH, oM), station: a, fare_yen: fare, balance_yen: balance });
      }
    }

    entries.sort((x, z) => x.at.localeCompare(z.at));
    const totalSpent   = entries.filter((e) => e.kind === '出').reduce((s, e) => s + e.fare_yen, 0);
    const totalCharged = entries.filter((e) => e.kind.indexOf('ｵ') === 0).reduce((s, e) => s + e.fare_yen, 0);
    return {
      month: settings.month,
      initial_balance: +settings.initial_balance,
      final_balance: balance,
      total_spent: totalSpent,
      total_charged: totalCharged,
      entries,
    };
  }

  // ────── Workflow-based PDF generation ──────
  // Dispatches the "Suica PDF Generate" GitHub Action with the current
  // preset, polls until the run completes, downloads the artifact zip,
  // extracts the PDF in-browser via JSZip, and saves it to the user.
  // This produces a PDF visually indistinguishable from a real Mobile
  // Suica statement (template-redaction approach in pdf_export.py).
  const GH_API = 'https://api.github.com';
  const GH_OWNER = 'VuTan11501';
  const GH_REPO = 'Code';
  const GH_WF_FILE = 'suica-pdf-generate.yml';

  function getSessionToken() {
    try { return sessionStorage.getItem('wf_dash_session') || null; }
    catch (_) { return null; }
  }
  function ghHeaders(token) {
    return {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  // Holds the currently-running workflow context so the log modal can poll.
  const _logCtx = { token: null, runId: null, jobId: null, completed: false, pollTimer: null };

  function _showOverlay(label, sub) {
    let overlay = document.getElementById('suicaPdfOverlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'suicaPdfOverlay';
      overlay.className = 'spinner-overlay';
      overlay.innerHTML = `
        <div class="spinner-overlay-content">
          <div class="spinner-ring" role="status" aria-label="Generating Suica PDF"></div>
          <div class="spinner-overlay-label"></div>
          <div class="spinner-overlay-sub text-xs text-muted-foreground"></div>
          <div class="spinner-overlay-actions" style="margin-top:12px; display:flex; gap:8px; justify-content:center;">
            <button type="button" id="suicaPdfViewLogsBtn" class="btn sm btn-ghost" disabled style="font-size:12px;">
              <span data-icon="terminal" data-size="12"></span>
              <span class="btn-label">View logs</span>
            </button>
            <a id="suicaPdfRunLink" href="#" target="_blank" rel="noopener" class="btn sm btn-ghost" style="display:none; font-size:12px;">
              <span data-icon="external-link" data-size="12"></span>
              <span class="btn-label">Open on GitHub</span>
            </a>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      overlay.querySelector('#suicaPdfViewLogsBtn').addEventListener('click', _openLogModal);
      if (window.refreshIcons) window.refreshIcons(overlay);
    }
    const lbl = overlay.querySelector('.spinner-overlay-label');
    if (lbl) lbl.textContent = label || 'Generating…';
    const subEl = overlay.querySelector('.spinner-overlay-sub');
    if (subEl) subEl.textContent = sub || '';
    // Reset action buttons every time overlay opens
    const logsBtn = overlay.querySelector('#suicaPdfViewLogsBtn');
    if (logsBtn) logsBtn.setAttribute('disabled', '');
    const link = overlay.querySelector('#suicaPdfRunLink');
    if (link) { link.style.display = 'none'; link.href = '#'; }
    overlay.classList.add('open');
    return overlay;
  }
  function _updateOverlay(sub) {
    const overlay = document.getElementById('suicaPdfOverlay');
    if (!overlay) return;
    const subEl = overlay.querySelector('.spinner-overlay-sub');
    if (subEl) subEl.textContent = sub || '';
  }
  // Enable the "View logs" button + Open-on-GitHub link once we have a run.
  function _wireOverlayRun(run) {
    const overlay = document.getElementById('suicaPdfOverlay');
    if (!overlay) return;
    const logsBtn = overlay.querySelector('#suicaPdfViewLogsBtn');
    if (logsBtn) logsBtn.removeAttribute('disabled');
    const link = overlay.querySelector('#suicaPdfRunLink');
    if (link && run && run.html_url) {
      link.href = run.html_url;
      link.style.display = '';
    }
  }
  function _hideOverlay() {
    const overlay = document.getElementById('suicaPdfOverlay');
    if (overlay) overlay.classList.remove('open');
  }

  // ────── Log viewer modal ──────
  // Per-step log UI is rendered by docs/js/log-viewer.js (window.LogViewer).
  // We just pass it the run id + token; it handles fetch, parse, polling,
  // step expand/collapse, copy-log, and cancel.
  async function _openLogModal() {
    if (!_logCtx.runId || !_logCtx.token) return;
    if (!window.LogViewer || typeof window.LogViewer.open !== 'function') {
      console.error('[suica-planner] LogViewer module not loaded');
      return;
    }
    window.LogViewer.open({
      token: _logCtx.token,
      owner: GH_OWNER,
      repo:  GH_REPO,
      runId: _logCtx.runId,
      status: _logCtx.completed ? 'completed' : 'in_progress',
      title: 'Suica PDF — workflow run logs',
    });
  }
  function _closeLogModal() {
    if (window.LogViewer && typeof window.LogViewer.close === 'function') {
      window.LogViewer.close();
    }
  }
  async function _refreshLog() { /* now handled internally by LogViewer */ }

  async function _dispatchWorkflow(token, preset) {
    const body = {
      ref: 'main',
      inputs: {
        preset_json: JSON.stringify(preset),
        month: String(state.settings.month),
        target: String(state.settings.target),
        seed: String(state.settings.seed),
      },
    };
    const res = await fetch(`${GH_API}/repos/${GH_OWNER}/${GH_REPO}/actions/workflows/${GH_WF_FILE}/dispatches`, {
      method: 'POST',
      headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status !== 204) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Dispatch failed: HTTP ${res.status}${txt ? ' — ' + txt.slice(0, 120) : ''}`);
    }
  }

  // Poll for the run we just dispatched. We match by created_at >= dispatchedAt
  // and event=workflow_dispatch, returning the first run found that finishes.
  async function _waitForRun(token, dispatchedAt) {
    const TIMEOUT_MS = 5 * 60 * 1000;
    const start = Date.now();
    await new Promise((r) => setTimeout(r, 4000));
    let runId = null;
    while (Date.now() - start < TIMEOUT_MS) {
      try {
        const url = `${GH_API}/repos/${GH_OWNER}/${GH_REPO}/actions/workflows/${GH_WF_FILE}/runs?per_page=5&event=workflow_dispatch`;
        const res = await fetch(url, { headers: ghHeaders(token) });
        if (res.ok) {
          const data = await res.json();
          const runs = (data && data.workflow_runs) || [];
          // Pick the most recent run created at or after dispatch time.
          const candidate = runs.find((r) => new Date(r.created_at).getTime() >= dispatchedAt - 5000);
          if (candidate) {
            runId = candidate.id;
            // Expose run + (lazily) job id to the log modal
            if (_logCtx.runId !== candidate.id) {
              _logCtx.runId = candidate.id;
              _logCtx.jobId = null;
              _wireOverlayRun(candidate);
            }
            const elapsed = Math.floor((Date.now() - start) / 1000);
            _updateOverlay(`Run #${candidate.run_number} · ${candidate.status} · ${elapsed}s`);
            if (candidate.status === 'completed') {
              _logCtx.completed = true;
              if (candidate.conclusion !== 'success') {
                throw new Error(`Workflow finished with status: ${candidate.conclusion}`);
              }
              return candidate;
            }
          } else {
            _updateOverlay(`Waiting for run to appear… ${Math.floor((Date.now() - start) / 1000)}s`);
          }
        }
      } catch (e) {
        if (e && /Workflow finished/.test(e.message)) throw e;
        // ignore transient errors
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
    throw new Error('Timed out waiting for workflow run (5 min)');
  }

  async function _downloadArtifact(token, runId) {
    _updateOverlay('Fetching artifact…');
    const listRes = await fetch(`${GH_API}/repos/${GH_OWNER}/${GH_REPO}/actions/runs/${runId}/artifacts`, {
      headers: ghHeaders(token),
    });
    if (!listRes.ok) throw new Error(`List artifacts failed: HTTP ${listRes.status}`);
    const listData = await listRes.json();
    const arts = (listData && listData.artifacts) || [];
    const art = arts.find((a) => a.name.indexOf('suica-pdf-') === 0) || arts[0];
    if (!art) throw new Error('No artifact produced by workflow');

    // The /zip endpoint returns 302 → presigned S3 URL. Browsers follow it
    // and strip our Authorization header on the cross-origin redirect, which
    // is exactly the desired behavior — the presigned URL doesn't need auth.
    const zipRes = await fetch(art.archive_download_url, {
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json' },
    });
    if (!zipRes.ok) throw new Error(`Download artifact failed: HTTP ${zipRes.status}`);
    return await zipRes.arrayBuffer();
  }

  async function _extractAndSavePdf(zipBuffer, fallbackName) {
    if (typeof JSZip === 'undefined') throw new Error('JSZip not loaded');
    if (!zipBuffer || zipBuffer.byteLength < 1024) {
      throw new Error(`Artifact download too small (${zipBuffer ? zipBuffer.byteLength : 0} bytes) — likely a transient GitHub error, please retry`);
    }
    const zip = await JSZip.loadAsync(zipBuffer);
    const pdfFile = Object.values(zip.files).find((f) => !f.dir && /\.pdf$/i.test(f.name));
    if (!pdfFile) throw new Error('No PDF found inside artifact zip');
    const blob = await pdfFile.async('blob');
    // Sanity-check: a real Mobile-Suica PDF is ~50-100KB+. Anything under 10KB
    // means something went wrong server-side (template missing, font failed,
    // etc.) and we'd rather surface the error than save a blank document.
    if (blob.size < 10 * 1024) {
      console.warn('[suica-planner] Extracted PDF is suspiciously small:', blob.size, 'bytes');
    }
    const filename = pdfFile.name.split('/').pop() || fallbackName;
    const a = document.createElement('a');
    const url = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }));
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 200);
    console.info(`[suica-planner] Saved ${filename} (${blob.size.toLocaleString()} bytes from artifact ${zipBuffer.byteLength.toLocaleString()} bytes)`);
    return filename;
  }

  async function generatePDF(btn) {
    const status = $('planner-pdf-status');
    let progressToast = null;
    const setStatus = (txt, cls) => {
      status.textContent = txt || '';
      status.className = 'text-xs ' + (cls || 'text-muted-foreground');
      if (progressToast && txt) {
        const variant = cls && cls.includes('destructive') ? 'error'
                      : cls && cls.includes('warning') ? 'warning'
                      : cls && cls.includes('primary') ? 'success'
                      : 'info';
        progressToast.update(txt, { variant });
      }
    };
    try {
      const totalRoutes = DAYS.reduce((s, d) => s + state.pattern[d].length, 0) + state.leisure.length;
      if (!totalRoutes) { setStatus('Add at least one commute or leisure route first.', 'text-warning'); return; }

      const token = getSessionToken();
      if (!token) {
        setStatus('🔒 Open & unlock the main dashboard first (session token required).', 'text-warning');
        return;
      }
      if (typeof JSZip === 'undefined') {
        setStatus('JSZip library not loaded — refresh the page.', 'text-destructive');
        return;
      }

      btn.setAttribute('disabled', '');
      const origHtml = btn.innerHTML;
      btn.innerHTML = '<span data-icon="refresh" data-size="14" class="animate-spin"></span><span class="btn-label">Generating…</span>';
      if (window.refreshIcons) window.refreshIcons(btn);

      // Batch generation: read user-selected months count (1..6). When > 1, we
      // iterate the month + seed locally between dispatches and restore the
      // originals at the end so the UI looks unchanged.
      const batchEl = $('planner-batch-months');
      const batchN = Math.max(1, Math.min(12, +(batchEl && batchEl.value) || 1));
      const origMonth = state.settings.month;
      const origSeed = +state.settings.seed;
      const monthInput = $('planner-month');
      const seedInput = $('planner-seed');
      function _bumpMonth(ym) {
        const [y, m] = ym.split('-').map(Number);
        const d = new Date(y, (m - 1) + 1, 1);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      }
      const filenames = [];

      if (window.Toast) {
        progressToast = window.Toast.info(batchN > 1 ? `Dispatching workflow (1/${batchN})…` : 'Dispatching workflow…', {
          title: batchN > 1 ? `Generating ${batchN} Suica PDFs` : 'Generating Suica PDF',
          duration: 0,
        });
      }
      _showOverlay(batchN > 1 ? `Generating ${batchN} Suica PDFs` : 'Generating Suica PDF', 'Dispatching workflow…');

      for (let i = 0; i < batchN; i++) {
        const tag = batchN > 1 ? ` (${i + 1}/${batchN})` : '';
        const preset = buildPreset();
        // Reset log context for this run
        _logCtx.token = token;
        _logCtx.runId = null;
        _logCtx.jobId = null;
        _logCtx.completed = false;
        if (_logCtx.pollTimer) { clearInterval(_logCtx.pollTimer); _logCtx.pollTimer = null; }
        setStatus(`Dispatching workflow${tag}…`, 'text-muted-foreground');
        const dispatchedAt = Date.now();
        await _dispatchWorkflow(token, preset);
        setStatus(`Workflow dispatched${tag} — waiting for run…`, 'text-muted-foreground');

        const run = await _waitForRun(token, dispatchedAt);
        setStatus(`Run #${run.run_number}${tag} succeeded — downloading PDF…`, 'text-muted-foreground');
        const zipBuf = await _downloadArtifact(token, run.id);
        const filename = await _extractAndSavePdf(zipBuf, `suica-${state.settings.month}.pdf`);
        filenames.push(filename);
        setStatus(`✓ Downloaded ${filename}${tag}`, 'text-primary');

        // Record this generation for the "Recent" panel
        try {
          recordGeneration({
            filename,
            month: state.settings.month,
            target: +state.settings.target,
            seed: +state.settings.seed,
            routes: currentPlanRoutes(),
            runUrl: run && run.html_url ? run.html_url : null,
          });
        } catch (_) {}

        // Prepare next iteration (don't bump after last one)
        if (i < batchN - 1) {
          state.settings.month = _bumpMonth(state.settings.month);
          state.settings.seed = +state.settings.seed + 1;
          if (monthInput) monthInput.value = state.settings.month;
          if (seedInput) seedInput.value = String(state.settings.seed);
        }
      }

      // Restore originals so the planner UI keeps the user's authored values.
      if (batchN > 1) {
        state.settings.month = origMonth;
        state.settings.seed = origSeed;
        if (monthInput) monthInput.value = origMonth;
        if (seedInput) seedInput.value = String(origSeed);
        saveState();
      }

      if (progressToast) { progressToast.dismiss(); progressToast = null; }
      if (window.Toast) window.Toast.success(
        batchN > 1 ? `Saved ${filenames.length} PDFs` : `Saved ${filenames[0]}`,
        { title: batchN > 1 ? 'Suica batch ready' : 'Suica PDF ready' }
      );

      // Preview last-generated history in the viewer below.
      if (window.renderSuicaHistory) {
        try { window.renderSuicaHistory(generateMonthlyHistory()); } catch (_) {}
      }

      btn.innerHTML = origHtml;
      if (window.refreshIcons) window.refreshIcons(btn);
    } catch (err) {
      console.error('[suica-planner] generatePDF failed:', err);
      setStatus(`Failed: ${err.message}`, 'text-destructive');
      if (progressToast) { progressToast.dismiss(); progressToast = null; }
      if (window.Toast) {
        // Pair the error toast with a one-tap retry of the same dispatch.
        // Default retries use the same seed; a follow-up "seed +1" toast
        // (shown when the user picks Retry) lets them dodge a flaky seed.
        const retrySame = () => { try { generatePDF(btn); } catch (_) {} };
        const retryNewSeed = () => {
          const seedEl = $('planner-seed');
          if (seedEl) { seedEl.value = String((+seedEl.value || 0) + 1); state.settings.seed = +seedEl.value; saveState(); }
          try { generatePDF(btn); } catch (_) {}
        };
        window.Toast.error(err.message, {
          title: 'PDF generation failed',
          duration: 12000,
          actionLabel: 'Retry',
          onAction: () => {
            // Offer a follow-up choice once the user opts in to a retry
            if (window.Toast) window.Toast.info('Same seed retry started — if it fails again, try the next seed.', {
              title: 'Retrying…',
              actionLabel: 'Use seed +1 instead',
              onAction: retryNewSeed,
              duration: 8000,
            });
            retrySame();
          },
        });
      }
      btn.innerHTML = '<span data-icon="download" data-size="14"></span><span class="btn-label">Generate Suica PDF</span>';
      if (window.refreshIcons) window.refreshIcons(btn);
    } finally {
      btn.removeAttribute('disabled');
      _hideOverlay();
      if (_logCtx.pollTimer) { clearInterval(_logCtx.pollTimer); _logCtx.pollTimer = null; }
      // Allow user to still open the log modal after the run finished by leaving
      // _logCtx.runId set; they just won't get the live spinner overlay anymore.
    }
  }

  function copy(text, btn) {
    navigator.clipboard.writeText(text).then(() => {
      const orig = btn.innerHTML;
      btn.innerHTML = '<span data-icon="check" data-size="14"></span><span class="btn-label">Copied!</span>';
      if (window.refreshIcons) window.refreshIcons(btn);
      setTimeout(() => { btn.innerHTML = orig; if (window.refreshIcons) window.refreshIcons(btn); }, 1500);
    });
  }

  function download(text, filename, mime) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
  }

  // ────── Quick presets (pre-built scenarios) ──────
  // Each preset describes a typical Suica spending pattern. They are pure data,
  // so they survive station/fare list changes — applyPreset() only sets routes
  // that exist in the current fare catalogue and gracefully degrades otherwise.
  const PRESETS = [
    {
      id: 'tokyo-shinjuku-commute',
      label: 'Tokyo↔Shinjuku commute',
      desc: 'Daily JR commute, 2-3 weekend trips',
      target: 18000,
      pattern: ['東京↔新宿', '東京↔新宿', '東京↔新宿', '東京↔新宿', '東京↔新宿'],
      leisure: [['新宿↔横浜', 3], ['東京↔上野', 2]],
      leisure_min: 2, leisure_max: 3,
    },
    {
      id: 'shibuya-yokohama-heavy',
      label: 'Shibuya↔Yokohama heavy',
      desc: 'Long commute + many weekend trips',
      target: 35000,
      pattern: ['渋谷↔横浜', '渋谷↔横浜', '渋谷↔横浜', '渋谷↔横浜', '渋谷↔横浜'],
      leisure: [['渋谷↔新宿', 3], ['横浜↔鎌倉', 2], ['東京↔上野', 1]],
      leisure_min: 4, leisure_max: 6,
    },
    {
      id: 'light-3day',
      label: 'Light hybrid (3 days/wk)',
      desc: 'Hybrid worker — Mon/Wed/Fri office',
      target: 10000,
      pattern: ['東京↔新宿', '', '東京↔新宿', '', '東京↔新宿'],
      leisure: [['新宿↔渋谷', 2]],
      leisure_min: 1, leisure_max: 2,
    },
    {
      id: 'weekend-only',
      label: 'Weekend tourist',
      desc: 'No commute, just Sat/Sun outings',
      target: 8000,
      pattern: ['', '', '', '', ''],
      leisure: [['東京↔上野', 2], ['新宿↔横浜', 2], ['東京↔秋葉原', 2]],
      leisure_min: 4, leisure_max: 6,
    },
    {
      id: 'student-pass',
      label: 'Student-style',
      desc: 'Short commute, occasional outings',
      target: 6000,
      pattern: ['東京↔上野', '東京↔上野', '東京↔上野', '東京↔上野', '東京↔上野'],
      leisure: [['東京↔秋葉原', 2], ['上野↔池袋', 1]],
      leisure_min: 1, leisure_max: 3,
    },
  ];

  function applyPreset(preset) {
    if (!preset) return;
    pushHistory();
    const isKnown = (r) => r && state.fares && state.fares[r] != null;
    let appliedCommute = 0, skippedCommute = 0;
    DAYS.forEach((d, idx) => {
      if (idx >= 5) { state.pattern[d] = []; return; }
      const r = preset.pattern[idx];
      if (!r) { state.pattern[d] = []; return; }
      if (isKnown(r)) { state.pattern[d] = [{ route: r, type: 'commute' }]; appliedCommute++; }
      else { state.pattern[d] = []; skippedCommute++; }
    });
    state.leisure = preset.leisure
      .filter(([r]) => isKnown(r))
      .map(([route, weight]) => ({ route, weight }));
    const skippedLeisure = preset.leisure.length - state.leisure.length;
    state.settings.leisure_min = preset.leisure_min;
    state.settings.leisure_max = preset.leisure_max;
    if (preset.target) state.settings.target = preset.target;
    const targetEl = $('planner-target'); if (targetEl && preset.target) targetEl.value = preset.target;
    const minEl = $('planner-leisure-min'); if (minEl) minEl.value = preset.leisure_min;
    const maxEl = $('planner-leisure-max'); if (maxEl) maxEl.value = preset.leisure_max;
    renderPattern(); renderLeisure(); renderEstimate(); saveState();
    const status = $('planner-pdf-status');
    const skipped = skippedCommute + skippedLeisure;
    const msg = `Applied "${preset.label}"` + (skipped ? ` — ${skipped} route(s) skipped (no fare data)` : '');
    if (status) { status.textContent = msg; status.className = 'text-xs ' + (skipped ? 'text-warning' : 'text-primary'); }
    if (window.Toast) {
      if (skipped) window.Toast.warning(msg, { title: 'Preset applied (partial)' });
      else window.Toast.success(`Target ¥${preset.target.toLocaleString('en-US')}`, { title: 'Preset applied' });
    }
  }

  // ────── Plan snapshots ──────
  // User-named saved plans stored under SNAPSHOTS_KEY. Each snapshot is a deep
  // clone of {pattern, leisure, settings, lastRoute} at the moment of save.
  // Caps at 20 snapshots; oldest is evicted.
  const SNAPSHOTS_KEY = 'suica-planner-snapshots-v1';
  function loadSnapshots() {
    try { return JSON.parse(localStorage.getItem(SNAPSHOTS_KEY) || '[]'); }
    catch (_) { return []; }
  }
  function saveSnapshots(arr) {
    try { localStorage.setItem(SNAPSHOTS_KEY, JSON.stringify(arr.slice(-20))); } catch (_) {}
  }
  function captureSnapshot(name) {
    const snap = {
      id: 'snap-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      name: name || `Snapshot ${new Date().toLocaleString()}`,
      created_at: new Date().toISOString(),
      pattern: JSON.parse(JSON.stringify(state.pattern)),
      leisure: JSON.parse(JSON.stringify(state.leisure)),
      settings: JSON.parse(JSON.stringify(state.settings)),
      route: currentRoute(),
    };
    const list = loadSnapshots();
    list.push(snap);
    saveSnapshots(list);
    renderSnapshots();
    if (window.Toast) window.Toast.success(`"${snap.name}"`, { title: 'Plan snapshot saved' });
  }
  function restoreSnapshot(id) {
    const list = loadSnapshots();
    const s = list.find((x) => x.id === id);
    if (!s) return;
    pushHistory();
    state.pattern = JSON.parse(JSON.stringify(s.pattern));
    state.leisure = JSON.parse(JSON.stringify(s.leisure));
    state.settings = JSON.parse(JSON.stringify(s.settings));
    // Mirror settings into inputs
    ['month', 'target', 'seed', 'initial_balance', 'topup_threshold', 'topup_amount', 'leisure_min', 'leisure_max'].forEach((k) => {
      const el = $('planner-' + k.replace(/_/g, '-')); if (el) el.value = state.settings[k];
    });
    const tEl = $('planner-target'); if (tEl) tEl.value = state.settings.target;
    const mEl = $('planner-month'); if (mEl) mEl.value = state.settings.month;
    const sEl = $('planner-seed'); if (sEl) sEl.value = state.settings.seed;
    const iEl = $('planner-initial'); if (iEl) iEl.value = state.settings.initial_balance;
    const tThr = $('planner-topup-threshold'); if (tThr) tThr.value = state.settings.topup_threshold;
    const tAmt = $('planner-topup-amount'); if (tAmt) tAmt.value = state.settings.topup_amount;
    const lMin = $('planner-leisure-min'); if (lMin) lMin.value = state.settings.leisure_min;
    const lMax = $('planner-leisure-max'); if (lMax) lMax.value = state.settings.leisure_max;
    renderPattern(); renderLeisure(); renderEstimate(); saveState();
    if (window.Toast) window.Toast.success(`Loaded "${s.name}"`, {
      title: 'Snapshot restored',
      duration: 7000,
      actionLabel: 'Undo',
      onAction: () => { try { undo(); } catch (_) {} },
    });
  }
  function deleteSnapshot(id) {
    const list = loadSnapshots().filter((x) => x.id !== id);
    saveSnapshots(list);
    renderSnapshots();
  }
  function renameSnapshot(id) {
    const list = loadSnapshots();
    const s = list.find((x) => x.id === id);
    if (!s) return;
    const next = prompt('Rename snapshot:', s.name);
    if (next === null) return;
    const trimmed = String(next).trim().slice(0, 80);
    if (!trimmed || trimmed === s.name) return;
    s.name = trimmed;
    saveSnapshots(list);
    renderSnapshots();
    if (window.Toast) window.Toast.success(`Renamed to "${trimmed}"`);
  }
  function togglePinSnapshot(id) {
    const list = loadSnapshots();
    const s = list.find((x) => x.id === id);
    if (!s) return;
    s.pinned = !s.pinned;
    saveSnapshots(list);
    renderSnapshots();
    if (window.Toast) window.Toast.info(s.pinned ? `Pinned "${s.name}" to top` : `Unpinned "${s.name}"`);
  }
  let _snapCompareA = null;
  function _diffRoutesArr(a, b) {
    const sa = new Set(a || []);
    const sb = new Set(b || []);
    const added = [...sb].filter((x) => !sa.has(x));
    const removed = [...sa].filter((x) => !sb.has(x));
    return { added, removed, kept: [...sa].filter((x) => sb.has(x)) };
  }
  function _openSnapshotDiff(snapA, snapB) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay open';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9998;display:flex;align-items:center;justify-content:center;padding:1rem;';
    const card = document.createElement('div');
    card.className = 'card';
    card.style.cssText = 'max-width:780px;width:100%;max-height:80vh;overflow:auto;padding:1rem;';
    const dayRows = DAYS.map((d) => {
      const ra = (snapA.pattern[d] || []).map((t) => t.route);
      const rb = (snapB.pattern[d] || []).map((t) => t.route);
      const diff = _diffRoutesArr(ra, rb);
      const same = !diff.added.length && !diff.removed.length;
      const chips = [
        ...diff.kept.map((r) => `<span class="status-badge font-mono text-[10px]">${r}</span>`),
        ...diff.removed.map((r) => `<span class="status-badge status-failure font-mono text-[10px]">− ${r}</span>`),
        ...diff.added.map((r) => `<span class="status-badge status-success font-mono text-[10px]">+ ${r}</span>`),
      ].join(' ');
      return `<tr class="${same ? 'opacity-60' : ''}"><td class="py-1 pr-3 text-xs text-muted-foreground">${DAY_LABELS[d]}</td><td class="py-1">${chips || '<span class="text-xs italic text-muted-foreground">no trips</span>'}</td></tr>`;
    }).join('');
    const lA = (snapA.leisure || []).map((l) => l.route);
    const lB = (snapB.leisure || []).map((l) => l.route);
    const ld = _diffRoutesArr(lA, lB);
    const leisureHtml = [
      ...ld.kept.map((r) => `<span class="status-badge font-mono text-[10px]">${r}</span>`),
      ...ld.removed.map((r) => `<span class="status-badge status-failure font-mono text-[10px]">− ${r}</span>`),
      ...ld.added.map((r) => `<span class="status-badge status-success font-mono text-[10px]">+ ${r}</span>`),
    ].join(' ') || '<span class="text-xs italic text-muted-foreground">none</span>';
    const settingsKeys = Object.keys({ ...snapA.settings, ...snapB.settings });
    const settingsHtml = settingsKeys.map((k) => {
      const va = snapA.settings[k];
      const vb = snapB.settings[k];
      const same = va === vb;
      return `<tr class="${same ? 'opacity-60' : ''}"><td class="py-0.5 pr-3 text-xs text-muted-foreground font-mono">${k}</td><td class="py-0.5 text-xs font-mono">${va ?? '∅'}</td><td class="py-0.5 text-xs font-mono ${same ? '' : 'text-success'}">${vb ?? '∅'}</td></tr>`;
    }).join('');
    card.innerHTML = `
      <div class="flex items-center gap-2 mb-3">
        <h3 class="font-semibold text-sm flex-1">Compare snapshots</h3>
        <button type="button" class="btn btn-ghost sm" data-close>×</button>
      </div>
      <div class="text-xs text-muted-foreground mb-3">
        <strong>A:</strong> ${snapA.name} · <strong>B:</strong> ${snapB.name}
        — green = added in B · red = removed from A · grey = unchanged
      </div>
      <h4 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">Weekly pattern</h4>
      <table class="w-full mb-3"><tbody>${dayRows}</tbody></table>
      <h4 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">Leisure pool</h4>
      <div class="mb-3">${leisureHtml}</div>
      <h4 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">Settings (A vs B)</h4>
      <table class="w-full"><tbody>${settingsHtml}</tbody></table>
    `;
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    const close = () => { overlay.remove(); };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    card.querySelector('[data-close]').addEventListener('click', close);
    document.addEventListener('keydown', function onEsc(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onEsc); } });
  }

  // Fare-table modal. Lists every known IC fare in state.fares with override
  // info and a search/sort UI. Read-only catalogue browser (fare edits still
  // live on the verify badge in the From↔To picker).
  function _openFareTable() {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay open';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9998;display:flex;align-items:center;justify-content:center;padding:1rem;';
    const card = document.createElement('div');
    card.className = 'card';
    card.style.cssText = 'max-width:680px;width:100%;max-height:80vh;overflow:auto;padding:1rem;';
    const sortKeyAttr = 'data-fare-sort';
    let sortBy = 'route';
    let sortDir = 1;
    let search = '';
    function render() {
      const overrides = state.fareOverrides || {};
      const all = Object.keys(state.fares).map((k) => ({
        route: k,
        fare: state.fares[k],
        override: overrides[k] != null ? overrides[k] : null,
      }));
      const q = search.trim().toLowerCase();
      const filtered = q ? all.filter((r) => r.route.toLowerCase().indexOf(q) >= 0) : all;
      filtered.sort((a, b) => {
        let av, bv;
        if (sortBy === 'route') { av = a.route; bv = b.route; return sortDir * av.localeCompare(bv, 'ja'); }
        if (sortBy === 'fare') { av = a.override != null ? a.override : a.fare; bv = b.override != null ? b.override : b.fare; }
        if (sortBy === 'override') { av = a.override == null ? 0 : 1; bv = b.override == null ? 0 : 1; }
        return sortDir * (av - bv);
      });
      const overrideCount = all.filter((r) => r.override != null).length;
      const rows = filtered.slice(0, 500).map((r) => `
        <tr class="border-b border-border/40">
          <td class="py-1 pr-3 font-mono text-xs">${r.route}</td>
          <td class="py-1 pr-3 font-mono text-xs text-right">${fmtYen(r.fare)}</td>
          <td class="py-1 pr-3 font-mono text-xs text-right ${r.override != null ? 'text-warning' : 'text-muted-foreground'}">${r.override != null ? fmtYen(r.override) : '—'}</td>
        </tr>
      `).join('');
      card.innerHTML = `
        <div class="flex items-center gap-2 mb-3">
          <h3 class="font-semibold text-sm flex-1">Fare table · ${all.length} routes · ${overrideCount} overridden</h3>
          <button type="button" class="btn btn-ghost sm" data-close>×</button>
        </div>
        <input type="search" id="fare-table-search" placeholder="Filter by route (kanji)…" class="input input-sm w-full mb-2" value="${search.replace(/"/g, '&quot;')}" autocomplete="off">
        <div class="text-[10px] text-muted-foreground mb-1">Click headers to sort. Showing first 500 rows; refine the search to see more.</div>
        <table class="w-full text-xs">
          <thead><tr class="text-muted-foreground border-b border-border">
            <th class="py-1 pr-3 text-left cursor-pointer select-none" ${sortKeyAttr}="route">Route ${sortBy==='route'?(sortDir>0?'↑':'↓'):''}</th>
            <th class="py-1 pr-3 text-right cursor-pointer select-none" ${sortKeyAttr}="fare">IC fare ${sortBy==='fare'?(sortDir>0?'↑':'↓'):''}</th>
            <th class="py-1 pr-3 text-right cursor-pointer select-none" ${sortKeyAttr}="override">Override ${sortBy==='override'?(sortDir>0?'↑':'↓'):''}</th>
          </tr></thead>
          <tbody>${rows || '<tr><td colspan="3" class="py-3 text-center text-muted-foreground italic">No matches</td></tr>'}</tbody>
        </table>
      `;
      const inp = card.querySelector('#fare-table-search');
      if (inp) inp.addEventListener('input', () => {
        const pos = inp.selectionStart;
        search = inp.value;
        render();
        const fresh = card.querySelector('#fare-table-search');
        if (fresh) { fresh.focus(); if (typeof pos === 'number') fresh.setSelectionRange(pos, pos); }
      });
      card.querySelectorAll('[' + sortKeyAttr + ']').forEach((th) => {
        th.addEventListener('click', () => {
          const k = th.getAttribute(sortKeyAttr);
          if (sortBy === k) sortDir = -sortDir;
          else { sortBy = k; sortDir = 1; }
          render();
        });
      });
      card.querySelector('[data-close]').addEventListener('click', close);
    }
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    const close = () => { overlay.remove(); };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', function onEsc(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onEsc); } });
    render();
  }
  function pickSnapshotForCompare(id) {
    const list = loadSnapshots();
    const snap = list.find((x) => x.id === id);
    if (!snap) return;
    if (!_snapCompareA) {
      _snapCompareA = snap;
      if (window.Toast) window.Toast.info(`A: ${snap.name}. Click Compare on another snapshot to diff.`, { title: 'Pick B…', duration: 6000 });
      renderSnapshots();
      return;
    }
    if (_snapCompareA.id === snap.id) {
      _snapCompareA = null;
      if (window.Toast) window.Toast.info('Compare selection cleared.');
      renderSnapshots();
      return;
    }
    const a = _snapCompareA;
    _snapCompareA = null;
    _openSnapshotDiff(a, snap);
    renderSnapshots();
  }

  function renderSnapshots() {
    const wrap = $('planner-snapshots-list');
    if (!wrap) return;
    const list = loadSnapshots();
    if (!list.length) {
      wrap.innerHTML = '<div class="text-xs text-muted-foreground italic py-2">No snapshots yet — click "Save snapshot" to capture the current plan.</div>';
      return;
    }
    wrap.innerHTML = '';
    // Search box (only when there are enough snapshots to warrant it)
    const search = (wrap.dataset.snapSearch || '').trim().toLowerCase();
    if (list.length > 5) {
      const sb = document.createElement('div');
      sb.className = 'mb-2';
      sb.innerHTML = `<input type="search" id="snap-search" class="input input-sm w-full" placeholder="Filter ${list.length} snapshots by name…" value="${(wrap.dataset.snapSearch || '').replace(/"/g, '&quot;')}" autocomplete="off">`;
      wrap.appendChild(sb);
      const inp = sb.querySelector('#snap-search');
      inp.addEventListener('input', () => {
        const pos = inp.selectionStart;
        wrap.dataset.snapSearch = inp.value;
        renderSnapshots();
        const fresh = document.getElementById('snap-search');
        if (fresh) { fresh.focus(); if (typeof pos === 'number') fresh.setSelectionRange(pos, pos); }
      });
    }
    const filtered = search ? list.filter((s) => (s.name || '').toLowerCase().indexOf(search) >= 0) : list;
    if (!filtered.length) {
      const empty = document.createElement('div');
      empty.className = 'text-xs text-muted-foreground italic py-2';
      empty.textContent = `No snapshots match "${search}".`;
      wrap.appendChild(empty);
      return;
    }
    // Sort: pinned snapshots float to the top; within each group, newest first.
    const ordered = filtered.slice().sort((a, b) => {
      const pa = a.pinned ? 1 : 0, pb = b.pinned ? 1 : 0;
      if (pa !== pb) return pb - pa;
      return (new Date(b.created_at).getTime() || 0) - (new Date(a.created_at).getTime() || 0);
    });
    ordered.forEach((s) => {
      const row = document.createElement('div');
      row.className = 'flex items-center gap-3 py-2 border-b border-border last:border-b-0 flex-wrap';
      if (s.pinned) row.style.background = 'color-mix(in srgb, var(--primary) 6%, transparent)';
      const when = new Date(s.created_at).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
      const tripCount = DAYS.reduce((sum, d) => sum + (s.pattern[d]?.length || 0), 0);
      const isCompareA = _snapCompareA && _snapCompareA.id === s.id;
      row.innerHTML = `
        <div class="flex flex-col gap-0.5 flex-1 min-w-[160px]">
          <div class="text-sm font-medium flex items-center gap-1.5">
            <button type="button" class="btn btn-ghost sm text-[12px] p-0.5 ${s.pinned ? 'text-primary' : 'opacity-40 hover:opacity-100'}" data-snap-pin="${s.id}" aria-label="${s.pinned ? 'Unpin snapshot' : 'Pin snapshot to top'}" data-tooltip="${s.pinned ? 'Unpin snapshot' : 'Pin to top of list'}">📌</button>
            <span data-snap-name>${s.name}</span>${isCompareA ? '<span class="status-badge status-info text-[10px]">A</span>' : ''}
            <button type="button" class="btn btn-ghost sm text-[10px] p-0.5 opacity-50 hover:opacity-100" data-snap-rename="${s.id}" aria-label="Rename snapshot" data-tooltip="Rename snapshot">
              <span data-icon="edit" data-size="11"></span>
            </button>
          </div>
          <div class="text-xs text-muted-foreground">${when} · ${tripCount} commute trips · ${s.leisure.length} leisure · target ¥${(+s.settings.target).toLocaleString('en-US')}</div>
        </div>
        <button type="button" class="btn btn-ghost sm text-xs" data-snap-compare="${s.id}" data-tooltip="${isCompareA ? 'Cancel compare selection' : (_snapCompareA ? `Diff vs "${_snapCompareA.name}"` : 'Pick as A, then click on another snapshot to diff')}">
          <span data-icon="list" data-size="12"></span><span class="btn-label">${isCompareA ? 'Cancel A' : (_snapCompareA ? 'Compare with A' : 'Compare')}</span>
        </button>
        <button type="button" class="btn btn-ghost sm text-xs" data-snap-restore="${s.id}">
          <span data-icon="undo" data-size="12"></span><span class="btn-label">Restore</span>
        </button>
        <button type="button" class="btn btn-ghost sm text-xs" data-snap-delete="${s.id}" aria-label="Delete snapshot">
          <span data-icon="trash" data-size="12"></span>
        </button>`;
      wrap.appendChild(row);
    });
    wrap.querySelectorAll('[data-snap-pin]').forEach((b) => b.addEventListener('click', (e) => togglePinSnapshot(e.currentTarget.getAttribute('data-snap-pin'))));
    wrap.querySelectorAll('[data-snap-restore]').forEach((b) => b.addEventListener('click', (e) => restoreSnapshot(e.currentTarget.getAttribute('data-snap-restore'))));
    wrap.querySelectorAll('[data-snap-delete]').forEach((b) => b.addEventListener('click', (e) => deleteSnapshot(e.currentTarget.getAttribute('data-snap-delete'))));
    wrap.querySelectorAll('[data-snap-compare]').forEach((b) => b.addEventListener('click', (e) => pickSnapshotForCompare(e.currentTarget.getAttribute('data-snap-compare'))));
    wrap.querySelectorAll('[data-snap-rename]').forEach((b) => b.addEventListener('click', (e) => renameSnapshot(e.currentTarget.getAttribute('data-snap-rename'))));
    if (window.refreshIcons) window.refreshIcons(wrap);
  }

  // ────── Share via URL hash ──────
  // Encodes the user's plan (pattern, leisure, settings, currentRoute) into a
  // base64-url-safe blob in the URL fragment. We use CompressionStream where
  // available; otherwise plain base64 of JSON. On load, init() inspects the
  // hash and, if present, offers to import.
  // Defaults used for share-link minification — fields equal to these are
  // omitted from the encoded payload to keep URLs short.
  const _SHARE_DEFAULTS = {
    initial_balance: 3000,
    topup_threshold: 1500,
    topup_amount: 3000,
    leisure_min: 2,
    leisure_max: 4,
    seedPinned: false,
  };
  function planForShare() {
    // Drop empty weekday arrays — recipient's state.pattern initializer
    // already supplies them.
    const slimPattern = {};
    DAYS.forEach((d) => { if (state.pattern[d] && state.pattern[d].length) slimPattern[d] = state.pattern[d]; });
    // Settings: drop fields that match defaults; round numerics.
    const slimSettings = {};
    Object.keys(state.settings).forEach((k) => {
      const v = state.settings[k];
      if (v == null || v === '') return;
      if (_SHARE_DEFAULTS[k] != null && v === _SHARE_DEFAULTS[k]) return;
      slimSettings[k] = v;
    });
    return {
      v: 1,
      pattern: slimPattern,
      leisure: state.leisure,
      settings: slimSettings,
      route: currentRoute(),
    };
  }
  async function encodePlanToHash(obj) {
    const json = JSON.stringify(obj);
    const bytes = new TextEncoder().encode(json);
    let out;
    if (typeof CompressionStream === 'function') {
      const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
      const buf = await new Response(stream).arrayBuffer();
      out = new Uint8Array(buf);
    } else {
      out = bytes;
    }
    let s = '';
    for (let i = 0; i < out.length; i++) s += String.fromCharCode(out[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  async function decodeHashToPlan(b64url) {
    const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    let jsonBytes;
    if (typeof DecompressionStream === 'function') {
      try {
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        const buf = await new Response(stream).arrayBuffer();
        jsonBytes = new Uint8Array(buf);
      } catch (_) { jsonBytes = bytes; }
    } else { jsonBytes = bytes; }
    return JSON.parse(new TextDecoder().decode(jsonBytes));
  }
  async function shareLinkAsQr() {
    try {
      const slim = planForShare();
      const blob = await encodePlanToHash(slim);
      const url = `${location.origin}${location.pathname}#p=${blob}`;
      // QR codes top out around ~2.9 KB at L EC; we warn the user if the link
      // exceeds 1500 chars since the resulting QR will be huge / unscannable.
      const tooLong = url.length > 1500;
      const overlay = document.createElement('div');
      overlay.id = 'planner-qr-overlay';
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:120;display:flex;align-items:center;justify-content:center;padding:1rem;';
      const card = document.createElement('div');
      card.className = 'card';
      card.style.cssText = 'max-width:400px;width:100%;padding:1rem;background:var(--card);color:var(--card-foreground);border:1px solid var(--border);border-radius:.5rem;';
      const qrSize = 300;
      const qrSrc = `https://api.qrserver.com/v1/create-qr-code/?size=${qrSize}x${qrSize}&ecc=L&margin=4&data=${encodeURIComponent(url)}`;
      card.innerHTML = `
        <div class="flex items-center justify-between mb-2">
          <div class="font-semibold text-sm">Share via QR</div>
          <button type="button" class="btn btn-ghost sm" data-qr-close aria-label="Close">×</button>
        </div>
        ${tooLong ? `<div class="status-badge status-warning text-[10px] mb-2 block">⚠ Link is ${url.length} chars — QR may be hard to scan. Consider simplifying the plan first.</div>` : ''}
        <div class="flex justify-center bg-white p-3 rounded mb-2" style="min-height:${qrSize + 24}px;">
          <img alt="QR code for share link" width="${qrSize}" height="${qrSize}" src="${qrSrc}"
               onerror="this.replaceWith(Object.assign(document.createElement('div'), {className:'text-xs text-destructive p-4 text-center', textContent:'QR service unreachable — copy the link instead.'}))">
        </div>
        <div class="text-[10px] text-muted-foreground break-all mb-2">${url}</div>
        <div class="flex gap-2">
          <button type="button" class="btn sm btn-outline flex-1" data-qr-copy>Copy link</button>
          <a class="btn sm btn-outline flex-1 text-center" href="${qrSrc}" download="suica-plan-qr.png" target="_blank" rel="noopener">Download PNG</a>
        </div>
      `;
      overlay.appendChild(card);
      document.body.appendChild(overlay);
      const close = () => overlay.remove();
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
      card.querySelector('[data-qr-close]').addEventListener('click', close);
      card.querySelector('[data-qr-copy]').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(url); if (window.Toast) window.Toast.success('Link copied'); } catch (_) {}
      });
      document.addEventListener('keydown', function onEsc(e) {
        if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onEsc); }
      });
    } catch (e) {
      if (window.Toast) window.Toast.error(e.message || 'Could not build QR', { title: 'QR failed' });
    }
  }
  async function copyShareLink() {
    try {
      const fullJsonBytes = new TextEncoder().encode(JSON.stringify({
        v: 1, pattern: state.pattern, leisure: state.leisure, settings: state.settings, route: currentRoute(),
      })).length;
      const slim = planForShare();
      const slimJsonBytes = new TextEncoder().encode(JSON.stringify(slim)).length;
      const blob = await encodePlanToHash(slim);
      const url = `${location.origin}${location.pathname}#p=${blob}`;
      await navigator.clipboard.writeText(url);
      const ratio = fullJsonBytes ? Math.round((1 - slimJsonBytes / fullJsonBytes) * 100) : 0;
      if (window.Toast) window.Toast.success(
        `${url.length} chars · JSON ${slimJsonBytes}B (was ${fullJsonBytes}B, −${ratio}%)`,
        { title: 'Share link copied' }
      );
    } catch (e) {
      if (window.Toast) window.Toast.error(e.message || 'Could not encode plan', { title: 'Share failed' });
    }
  }
  async function maybeImportFromHash() {
    const m = (location.hash || '').match(/[#&]p=([A-Za-z0-9_\-]+)/);
    if (!m) return;
    try {
      const obj = await decodeHashToPlan(m[1]);
      if (!obj || obj.v !== 1) return;
      const ok = confirm('A shared plan is in this link. Import it now? Your current plan will be replaced.');
      if (!ok) return;
      if (obj.pattern) {
        // Empty pattern object replaces nothing; assignments are per-day so
        // a slim share link doesn't wipe untouched days.
        DAYS.forEach((d) => {
          state.pattern[d] = Array.isArray(obj.pattern[d]) ? obj.pattern[d] : [];
        });
      }
      if (obj.leisure) state.leisure = obj.leisure;
      if (obj.settings) state.settings = Object.assign(state.settings, obj.settings);
      if (obj.route && cbFrom && cbTo) {
        const [a, b] = obj.route.split('↔');
        if (a && b) { cbFrom.setValue(a); cbTo.setValue(b); }
      }
      ['month', 'target', 'seed', 'initial', 'topup-threshold', 'topup-amount', 'leisure-min', 'leisure-max'].forEach((k) => {
        const stateKey = k === 'initial' ? 'initial_balance' : k.replace(/-/g, '_');
        const el = $('planner-' + k); if (el && state.settings[stateKey] != null) el.value = state.settings[stateKey];
      });
      renderPattern(); renderLeisure(); renderEstimate(); updateFareDisplay(); saveState();
      if (window.Toast) window.Toast.success('Plan imported from share link', { title: 'Imported' });
      // Strip hash so reload doesn't re-prompt
      history.replaceState(null, '', location.pathname + location.search);
    } catch (e) {
      console.warn('[share-link] decode failed:', e);
    }
  }

  // ────── Undo/redo stack ──────
  // Snapshots only the user-mutable pieces: pattern, leisure, settings.
  // Capped at 20 entries each direction. Ctrl+Z / Cmd+Z = undo,
  // Ctrl+Shift+Z / Cmd+Shift+Z (or Ctrl+Y) = redo.
  const _hist = { stack: [], redo: [], suppress: false, max: 20 };
  function _snapshotState() {
    return {
      pattern: JSON.parse(JSON.stringify(state.pattern)),
      leisure: JSON.parse(JSON.stringify(state.leisure)),
      settings: JSON.parse(JSON.stringify(state.settings)),
    };
  }
  const _dismissedWarnings = new Set();
  const _recentSel = new Set();
  let _dayClipboard = null; // { day: string, trips: [{route,type}, ...] }
  function pushHistory() {
    if (_hist.suppress) return;
    _hist.stack.push(_snapshotState());
    if (_hist.stack.length > _hist.max) _hist.stack.shift();
    _hist.redo.length = 0;
    // Any user-initiated state change should re-surface dismissed warnings.
    _dismissedWarnings.clear();
  }
  function applyHistorySnap(snap) {
    _hist.suppress = true;
    try {
      state.pattern = snap.pattern;
      state.leisure = snap.leisure;
      state.settings = snap.settings;
      // Mirror into inputs
      const ids = { 'planner-month': 'month', 'planner-target': 'target', 'planner-seed': 'seed',
        'planner-initial': 'initial_balance', 'planner-topup-threshold': 'topup_threshold',
        'planner-topup-amount': 'topup_amount', 'planner-leisure-min': 'leisure_min',
        'planner-leisure-max': 'leisure_max' };
      Object.entries(ids).forEach(([id, k]) => { const el = $(id); if (el && state.settings[k] != null) el.value = state.settings[k]; });
      renderPattern(); renderLeisure(); renderEstimate(); saveState();
    } finally { _hist.suppress = false; }
  }
  function undo() {
    if (!_hist.stack.length) {
      if (window.Toast) window.Toast.info('Nothing to undo');
      return;
    }
    const prev = _hist.stack.pop();
    _hist.redo.push(_snapshotState());
    applyHistorySnap(prev);
    if (window.Toast) window.Toast.info(`Undone (${_hist.stack.length} left)`);
  }
  function redo() {
    if (!_hist.redo.length) {
      if (window.Toast) window.Toast.info('Nothing to redo');
      return;
    }
    const next = _hist.redo.pop();
    _hist.stack.push(_snapshotState());
    applyHistorySnap(next);
    if (window.Toast) window.Toast.info(`Redone (${_hist.redo.length} left)`);
  }

  // ────── Export schedule as .ics (iCalendar) ──────
  // Generates ONE event per scheduled trip in the configured month:
  //   - weekday commute: round-trip morning + evening events
  //   - weekend leisure: random sample N times where N = (min+max)/2
  // Calendar can be imported into Google Calendar / Outlook to preview the
  // synthesized history before generating the PDF.
  function exportIcs() {
    const monthInfo = countWeekdaysInMonth(state.settings.month);
    if (!monthInfo) {
      if (window.Toast) window.Toast.warning('Set a valid YYYY-MM month first');
      return;
    }
    const [y, m] = state.settings.month.split('-').map(Number);
    const last = monthInfo.last;
    const dayKeyByJs = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const pad = (n) => String(n).padStart(2, '0');
    const fmtDt = (yr, mo, d, h, mi) => `${yr}${pad(mo)}${pad(d)}T${pad(h)}${pad(mi)}00`;
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//SuicaPlanner//Dashboard//EN',
      'CALSCALE:GREGORIAN',
      `X-WR-CALNAME:Suica plan ${state.settings.month}`,
    ];
    let eventCount = 0;
    const addEvent = (date, hour, min, durMin, summary, desc) => {
      const start = fmtDt(date.getFullYear(), date.getMonth() + 1, date.getDate(), hour, min);
      const endDate = new Date(date.getTime() + durMin * 60000);
      const end = fmtDt(endDate.getFullYear(), endDate.getMonth() + 1, endDate.getDate(), endDate.getHours(), endDate.getMinutes());
      const uid = `${state.settings.month}-${eventCount}-${state.settings.seed}@suica-planner`;
      lines.push('BEGIN:VEVENT');
      lines.push(`UID:${uid}`);
      lines.push(`DTSTAMP:${fmtDt(date.getFullYear(), date.getMonth() + 1, date.getDate(), 0, 0)}Z`);
      lines.push(`DTSTART:${start}`);
      lines.push(`DTEND:${end}`);
      lines.push(`SUMMARY:${summary.replace(/[,;]/g, '\\$&')}`);
      if (desc) lines.push(`DESCRIPTION:${desc.replace(/[,;]/g, '\\$&').replace(/\n/g, '\\n')}`);
      lines.push('END:VEVENT');
      eventCount++;
    };
    // Weekday commute: morning ~08:30 + evening ~19:00, 30min duration
    for (let d = 1; d <= last; d++) {
      const date = new Date(y, m - 1, d);
      const dayKey = dayKeyByJs[date.getDay()];
      const trips = state.pattern[dayKey] || [];
      trips.forEach((t) => {
        const fare = fareOf(t.route);
        addEvent(date, 8, 30, 30, `→ ${t.route}`, `Morning commute · ¥${fare}`);
        addEvent(date, 19, 0, 30, `← ${t.route}`, `Evening commute · ¥${fare}`);
      });
    }
    // Weekend leisure samples
    if (state.leisure.length) {
      const outings = Math.round((+state.settings.leisure_min + +state.settings.leisure_max) / 2);
      const weekendDates = [];
      for (let d = 1; d <= last; d++) {
        const date = new Date(y, m - 1, d);
        const dow = date.getDay();
        if (dow === 0 || dow === 6) weekendDates.push(date);
      }
      // Deterministic-ish pick using seed
      let seed = +state.settings.seed || 1;
      for (let i = 0; i < outings && weekendDates.length; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        const dateIdx = seed % weekendDates.length;
        const date = weekendDates.splice(dateIdx, 1)[0];
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        const route = state.leisure[seed % state.leisure.length].route;
        addEvent(date, 12, 0, 30, `→ ${route}`, `Leisure outing · ¥${fareOf(route)}`);
        addEvent(date, 18, 0, 30, `← ${route}`, `Leisure return · ¥${fareOf(route)}`);
      }
    }
    lines.push('END:VCALENDAR');
    const content = lines.join('\r\n');
    const blob = new Blob([content], { type: 'text/calendar' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `suica-${state.settings.month}.ics`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    if (window.Toast) window.Toast.success(`${eventCount} events · ${state.settings.month}.ics`, { title: 'Calendar exported' });
  }

  // ────── Bulk-add leisure routes from text input ──────
  // User pastes "東京↔新宿\n渋谷↔横浜" or comma-separated; we validate against
  // state.fares (must be a verified pair) and report skipped count.
  // Internal: parse a free-form bulk text block into added/skipped/dup counts.
  function _bulkAddLeisureFromText(raw, sourceLabel) {
    const items = raw.split(/[\n,;]+/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
    if (!items.length) return;
    pushHistory();
    let added = 0, skipped = 0, bumped = 0;
    items.forEach((s) => {
      // Accept optional ",weight" or "\tweight" suffix.
      let weight = 1;
      const wm = s.match(/[\,\t]\s*(\d+(?:\.\d+)?)\s*$/);
      if (wm) { weight = Math.max(1, Math.round(+wm[1])) || 1; s = s.slice(0, wm.index).trim(); }
      const m = s.match(/^(.+?)\s*[↔⇄<>↔]+\s*(.+)$/);
      if (!m) { skipped++; return; }
      const key = pairKey(m[1].trim(), m[2].trim());
      if (!state.fares[key]) { skipped++; return; }
      const existing = state.leisure.find((l) => l.route === key);
      if (existing) {
        existing.weight = Math.max(1, (+existing.weight || 0) + weight);
        delete existing._prevWeight;
        bumped++;
        return;
      }
      state.leisure.push({ route: key, weight });
      added++;
    });
    renderLeisure(); renderEstimate(); saveState();
    const detail = `${added} added · ${bumped} merged · ${skipped} invalid${sourceLabel ? ` (from ${sourceLabel})` : ''}`;
    if (window.Toast) {
      const opts = { actionLabel: 'Undo', onAction: () => { try { undo(); } catch (_) {} } };
      if ((added || bumped) && !skipped) window.Toast.success(detail, { title: 'Leisure routes updated', ...opts });
      else if (added || bumped) window.Toast.warning(detail, { title: 'Leisure routes updated (partial)', ...opts });
      else window.Toast.error(detail, { title: 'No routes added' });
    }
  }

  function bulkAddLeisure() {
    const raw = prompt('Paste leisure routes (one per line or comma-separated). Use form "東京↔新宿":\n\nTip: cancel here and use the file picker for CSV/TSV import.');
    if (!raw) return;
    _bulkAddLeisureFromText(raw);
  }

  function bulkAddLeisureFromFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = String(e.target.result || '');
      _bulkAddLeisureFromText(text, file.name);
    };
    reader.onerror = () => { if (window.Toast) window.Toast.error('Could not read file', { title: 'Import failed' }); };
    reader.readAsText(file);
  }

  function loadSamplePlan() {
    pushHistory();
    state.pattern = {
      monday: [{ route: '東京↔新宿', type: 'commute' }],
      tuesday: [{ route: '東京↔新宿', type: 'commute' }],
      wednesday: [{ route: '東京↔新宿', type: 'commute' }],
      thursday: [{ route: '東京↔新宿', type: 'commute' }],
      friday: [{ route: '東京↔新宿', type: 'commute' }],
      saturday: [],
      sunday: [],
    };
    state.leisure = [
      { route: '新宿↔横浜', weight: 3 },
      { route: '東京↔上野', weight: 2 },
      { route: '渋谷↔横浜', weight: 2 },
    ];
    renderPattern(); renderLeisure(); renderEstimate(); saveState();
  }

  function clearPlan() {
    pushHistory();
    DAYS.forEach((d) => { state.pattern[d] = []; });
    state.leisure = [];
    renderPattern(); renderLeisure(); renderEstimate(); saveState();
  }

  // ────── Auto-suggest from target + current route ──────
  // Given the currently picked From↔To and state.settings.target, fill Mon-Fri
  // commute with that route (2 fares/day = round trip) and tune the leisure
  // pool so total monthly spend lands near the target.
  // - If no route is picked, try last-used or '東京↔新宿' as fallback.
  // - Picks leisure variants from known fares around the same endpoint.
  // Pure builder: returns a plan {pattern, leisure, settings, projected, commuteSpend, outings, weekdayCount, leisureCandidates}
  // WITHOUT mutating state. Used by both autoSuggest (single) and multiSuggest (3 variants).
  function buildSuggestion(opts) {
    const route = opts.route;
    const target = +opts.target || 0;
    const monthInfo = opts.monthInfo;
    const weekdayDays = opts.weekdayDays || 5; // 4 = skip Friday (light), 5 = full week (standard)
    const leisureMultiplier = opts.leisureMultiplier || 1.0; // 0.5 / 1.0 / 1.6 etc
    if (!route || !target || !monthInfo) return null;
    const commuteFare = fareOf(route);
    if (!commuteFare) return null;
    const weekdayCount = (
      monthInfo.counts.monday + monthInfo.counts.tuesday +
      monthInfo.counts.wednesday + monthInfo.counts.thursday +
      (weekdayDays >= 5 ? monthInfo.counts.friday : 0)
    );
    const commuteSpend = 2 * commuteFare * weekdayCount;
    const remainder = Math.max(0, target - commuteSpend);
    const [a, b] = route.split('↔');
    const nearby = [];
    Object.keys(state.fares).forEach((k) => {
      if (k === route) return;
      const [x, y] = k.split('↔');
      if (x === a || x === b || y === a || y === b) {
        const f = state.fares[k];
        if (f >= 150 && f <= 800) nearby.push({ k, f });
      }
    });
    nearby.sort((p, q) => Math.abs((remainder/8) - p.f) - Math.abs((remainder/8) - q.f));
    let leisureCandidates = nearby.slice(0, 3).map((n) => n.k);
    if (!leisureCandidates.length) {
      const any = Object.keys(state.fares).filter((k) => state.fares[k] >= 200 && state.fares[k] <= 800).slice(0, 2);
      leisureCandidates = any;
    }
    const avgLeisureFare = leisureCandidates.length
      ? leisureCandidates.reduce((s, k) => s + (state.fares[k] || 0), 0) / leisureCandidates.length
      : 0;
    let outings = avgLeisureFare > 0 ? Math.round((remainder * leisureMultiplier) / (2 * avgLeisureFare)) : 0;
    outings = Math.max(0, Math.min(12, outings));
    const leisureMin = Math.max(0, outings - 1);
    const leisureMax = Math.min(20, outings + 1);
    const projected = commuteSpend + (avgLeisureFare * outings * 2);
    const pattern = {};
    DAYS.forEach((d, idx) => {
      const isWeekday = idx < 5;
      const includeFriday = weekdayDays >= 5 || idx !== 4;
      pattern[d] = (isWeekday && includeFriday) ? [{ route, type: 'commute' }] : [];
    });
    return {
      route, pattern,
      leisure: leisureCandidates.map((k) => ({ route: k, weight: 2 })),
      settings: { leisure_min: leisureMin, leisure_max: leisureMax },
      projected, commuteSpend, outings, weekdayCount,
      leisureCandidates, avgLeisureFare,
    };
  }

  // Apply a suggestion (returned by buildSuggestion) into state + DOM.
  function applySuggestion(s) {
    if (!s) return;
    pushHistory();
    DAYS.forEach((d) => { state.pattern[d] = s.pattern[d] ? s.pattern[d].map((t) => ({ ...t })) : []; });
    state.leisure = s.leisure.map((l) => ({ ...l }));
    state.settings.leisure_min = s.settings.leisure_min;
    state.settings.leisure_max = s.settings.leisure_max;
    const minEl = $('planner-leisure-min'); if (minEl) minEl.value = s.settings.leisure_min;
    const maxEl = $('planner-leisure-max'); if (maxEl) maxEl.value = s.settings.leisure_max;
    renderPattern(); renderLeisure(); renderEstimate(); saveState();
  }

  function autoSuggest() {
    const status = $('planner-pdf-status');
    const note = (txt, cls) => { if (status) { status.textContent = txt; status.className = 'text-xs ' + (cls || 'text-muted-foreground'); } };
    const target = +state.settings.target || 0;
    if (!target || target < 1000) { note('Set a target (≥ ¥1000) first.', 'text-warning'); return; }
    let route = currentRoute();
    if (!route) {
      try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
        if (saved && saved.lastRoute && saved.lastRoute.from && saved.lastRoute.to && saved.lastRoute.from !== saved.lastRoute.to) {
          route = pairKey(saved.lastRoute.from, saved.lastRoute.to);
          if (cbFrom && cbTo) { cbFrom.setValue(saved.lastRoute.from); cbTo.setValue(saved.lastRoute.to); updateFareDisplay(); }
        }
      } catch (_) {}
    }
    if (!route && state.stations.includes('東京') && state.stations.includes('新宿')) {
      route = '東京↔新宿';
      if (cbFrom && cbTo) { cbFrom.setValue('東京'); cbTo.setValue('新宿'); updateFareDisplay(); }
    }
    if (!route) { note('Pick a From and To station first.', 'text-warning'); return; }
    const monthInfo = countWeekdaysInMonth(state.settings.month);
    if (!monthInfo) { note('Set a valid YYYY-MM month first.', 'text-warning'); return; }
    const s = buildSuggestion({ route, target, monthInfo, weekdayDays: 5, leisureMultiplier: 1.0 });
    if (!s) { note('Selected route has no verified fare — pick a JR-served pair.', 'text-warning'); return; }
    applySuggestion(s);
    const msg = `Auto-filled: ${route} weekdays + ${s.leisureCandidates.length} leisure route(s), ~${s.outings} outings/mo`;
    const detail = `Projected ${fmtYen(s.projected)} vs target ${fmtYen(target)}`;
    note(`${msg} → ${detail}`, 'text-primary');
    if (window.Toast) window.Toast.success(detail, { title: 'Auto-suggest applied' });
  }

  // Show 3-card alternatives: Light, Standard, Heavy
  function multiSuggest() {
    const status = $('planner-pdf-status');
    const note = (txt, cls) => { if (status) { status.textContent = txt; status.className = 'text-xs ' + (cls || 'text-muted-foreground'); } };
    const target = +state.settings.target || 0;
    if (!target || target < 1000) { note('Set a target (≥ ¥1000) first.', 'text-warning'); return; }
    let route = currentRoute();
    if (!route && state.stations.includes('東京') && state.stations.includes('新宿')) {
      route = '東京↔新宿';
      if (cbFrom && cbTo) { cbFrom.setValue('東京'); cbTo.setValue('新宿'); updateFareDisplay(); }
    }
    if (!route) { note('Pick a From and To station first.', 'text-warning'); return; }
    const monthInfo = countWeekdaysInMonth(state.settings.month);
    if (!monthInfo) { note('Set a valid YYYY-MM month first.', 'text-warning'); return; }
    const variants = [
      { id: 'light',    label: 'Light',    desc: 'Mon-Thu commute, fewer outings', opts: { weekdayDays: 4, leisureMultiplier: 0.6 } },
      { id: 'standard', label: 'Standard', desc: 'Mon-Fri commute, balanced',       opts: { weekdayDays: 5, leisureMultiplier: 1.0 } },
      { id: 'heavy',    label: 'Heavy',    desc: 'Mon-Fri + more weekend trips',    opts: { weekdayDays: 5, leisureMultiplier: 1.6 } },
    ];
    const built = variants.map((v) => ({
      ...v, suggestion: buildSuggestion({ route, target, monthInfo, ...v.opts }),
    })).filter((v) => v.suggestion);
    if (!built.length) { note('No verified fare for this route.', 'text-warning'); return; }

    const panel = $('planner-multi-suggest-panel');
    if (!panel) return;
    panel.classList.remove('hidden');
    panel.innerHTML = `
      <div class="card-header pb-2">
        <div class="card-title flex items-center gap-2 text-sm">
          <span data-icon="sparkles" data-size="14"></span> Choose a variant
          <button type="button" class="ml-auto btn sm btn-ghost" id="planner-multi-close" aria-label="Close">
            <span data-icon="x" data-size="12"></span>
          </button>
        </div>
        <div class="card-description text-xs">Target ¥${target.toLocaleString('en-US')} · Route ${route}</div>
      </div>
      <div class="card-content">
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
          ${built.map((v) => {
            const delta = v.suggestion.projected - target;
            const deltaPct = target ? Math.abs(delta / target) * 100 : 0;
            const tone = deltaPct <= 10 ? 'status-success' : deltaPct <= 25 ? 'status-pending' : 'status-failure';
            const s = v.suggestion;
            const explain = [
              `Commute base: ${fmtYen(s.commuteSpend)} (${s.weekdayCount} weekdays × 2 × ${fmtYen(fareOf(s.route))})`,
              `Leisure budget: ${fmtYen(s.projected - s.commuteSpend)} (${s.outings} outings × 2 × avg ${fmtYen(Math.round(s.avgLeisureFare || 0))})`,
              `Pool: ${(s.leisureCandidates || []).slice(0, 3).join(', ') || '(none)'}`,
              `→ Projected: ${fmtYen(s.projected)} vs target ${fmtYen(target)} (${delta >= 0 ? '+' : ''}${fmtYen(delta)})`,
            ].join('\n');
            return `
              <div class="rounded-md border border-border bg-card p-3 flex flex-col gap-2" data-variant-card="${v.id}" data-tooltip="${explain.replace(/"/g, '&quot;')}">
                <div class="flex items-center gap-2">
                  <span class="font-semibold text-sm">${v.label}</span>
                  <span class="status-badge ${tone} font-mono text-[10px] ml-auto">${delta >= 0 ? '+' : ''}${fmtYen(delta)}</span>
                </div>
                <div class="text-xs text-muted-foreground">${v.desc}</div>
                <div class="text-xs font-mono">${v.suggestion.weekdayCount} weekdays · ${v.suggestion.outings} outings</div>
                <div class="text-sm font-mono font-bold text-primary">${fmtYen(v.suggestion.projected)}</div>
                <button type="button" class="btn sm primary mt-auto" data-variant-apply="${v.id}">
                  <span data-icon="check" data-size="12"></span><span class="btn-label">Apply</span>
                </button>
              </div>`;
          }).join('')}
        </div>
      </div>`;
    if (window.refreshIcons) window.refreshIcons(panel);
    panel.querySelector('#planner-multi-close').addEventListener('click', () => panel.classList.add('hidden'));
    panel.querySelectorAll('[data-variant-apply]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const id = e.currentTarget.getAttribute('data-variant-apply');
        const v = built.find((x) => x.id === id);
        if (!v) return;
        applySuggestion(v.suggestion);
        panel.classList.add('hidden');
        const detail = `${v.label} variant: ${fmtYen(v.suggestion.projected)} (target ${fmtYen(target)})`;
        if (window.Toast) window.Toast.success(detail, { title: 'Variant applied' });
        note(detail, 'text-primary');
      });
    });
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // ────── Keyboard shortcuts ──────
  // g  → Generate PDF       a → Auto-suggest      c → Compare 3 options
  // s  → Save snapshot      r → Re-roll seed      ? → Show this help
  // Esc → Close any open popover (multi-suggest panel, presets menu, snapshot prompt)
  // Skipped while user is typing in an input/textarea.
  function bindKeyboardShortcuts() {
    const isTyping = (e) => {
      const t = e.target;
      if (!t) return false;
      const tag = (t.tagName || '').toLowerCase();
      return tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable;
    };
    const triggerClick = (id) => { const el = $(id); if (el && !el.hasAttribute('disabled')) el.click(); };
    document.addEventListener('keydown', (e) => {
      // Ctrl/Cmd+Z = undo, Ctrl/Cmd+Shift+Z or Ctrl+Y = redo. Allowed even
      // while focus is in an input — most apps do this.
      const meta = e.ctrlKey || e.metaKey;
      if (meta && (e.key === 'z' || e.key === 'Z')) {
        if (e.shiftKey) { redo(); } else { undo(); }
        e.preventDefault();
        return;
      }
      if (meta && (e.key === 'y' || e.key === 'Y')) { redo(); e.preventDefault(); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTyping(e)) return;
      // Single-key shortcuts (lowercase)
      switch ((e.key || '').toLowerCase()) {
        case 'g': triggerClick('planner-generate-pdf'); e.preventDefault(); break;
        case 'a': triggerClick('planner-auto-suggest'); e.preventDefault(); break;
        case 'c': triggerClick('planner-multi-suggest'); e.preventDefault(); break;
        case 'r': triggerClick('planner-seed-reroll'); e.preventDefault(); break;
        case 's': triggerClick('planner-snapshot-save'); e.preventDefault(); break;
        case '?': showShortcutsHelp(); e.preventDefault(); break;
        case 'escape': {
          // Close any open <details> popovers + the multi-suggest panel
          document.querySelectorAll('details[open]').forEach((d) => d.removeAttribute('open'));
          const ms = $('planner-multi-suggest-panel'); if (ms && !ms.classList.contains('hidden')) ms.classList.add('hidden');
          const help = $('planner-shortcuts-help'); if (help && !help.classList.contains('hidden')) help.classList.add('hidden');
          break;
        }
      }
    });
  }
  function showShortcutsHelp() {
    const wrap = $('planner-shortcuts-help');
    if (!wrap) return;
    if (!wrap.dataset.built) {
      wrap.innerHTML = `
        <div class="card">
          <div class="card-header pb-2">
            <div class="card-title flex items-center gap-2 text-sm">
              <span data-icon="key" data-size="14"></span> Keyboard shortcuts
              <button type="button" class="ml-auto btn sm btn-ghost" id="planner-shortcuts-close" aria-label="Close">
                <span data-icon="x" data-size="12"></span>
              </button>
            </div>
          </div>
          <div class="card-content">
            <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <dt><kbd class="kbd-key">G</kbd></dt><dd>Generate PDF</dd>
              <dt><kbd class="kbd-key">A</kbd></dt><dd>Auto-suggest from target</dd>
              <dt><kbd class="kbd-key">C</kbd></dt><dd>Compare 3 options</dd>
              <dt><kbd class="kbd-key">R</kbd></dt><dd>Re-roll seed</dd>
              <dt><kbd class="kbd-key">S</kbd></dt><dd>Save snapshot</dd>
              <dt><kbd class="kbd-key">Ctrl</kbd>+<kbd class="kbd-key">Z</kbd></dt><dd>Undo</dd>
              <dt><kbd class="kbd-key">Ctrl</kbd>+<kbd class="kbd-key">Shift</kbd>+<kbd class="kbd-key">Z</kbd></dt><dd>Redo</dd>
              <dt><kbd class="kbd-key">?</kbd></dt><dd>Show this help</dd>
              <dt><kbd class="kbd-key">Esc</kbd></dt><dd>Close popovers</dd>
            </dl>
          </div>
        </div>`;
      wrap.dataset.built = '1';
      wrap.querySelector('#planner-shortcuts-close').addEventListener('click', () => wrap.classList.add('hidden'));
      if (window.refreshIcons) window.refreshIcons(wrap);
    }
    wrap.classList.remove('hidden');
    wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // ────── Init ──────
  function init() {
    // Restore persisted state BEFORE first render so user sees their plan instantly.
    const persisted = loadState();

    // Wire comboboxes (replaces the old datalist <input>)
    const fromWrap = document.querySelector('[data-combobox-id="planner-from"]');
    const toWrap = document.querySelector('[data-combobox-id="planner-to"]');
    const onComboChange = () => { updateFareDisplay(); saveState(); if (typeof applyFareRangeFilter === 'function') applyFareRangeFilter(); renderPattern(); };
    if (fromWrap) cbFrom = createCombobox(fromWrap, { options: state.stations, placeholder: '東京 / Tokyo', onChange: onComboChange });
    if (toWrap)   cbTo   = createCombobox(toWrap,   { options: state.stations, placeholder: '新宿 / Shinjuku', onChange: onComboChange });

    // Restore last-picked route into the comboboxes (best-effort; values may
    // not be in the catalogue yet if it loads asynchronously — combobox
    // accepts arbitrary text and will validate on selection)
    if (persisted && persisted.lastRoute) {
      if (cbFrom && persisted.lastRoute.from) cbFrom.setValue(persisted.lastRoute.from);
      if (cbTo && persisted.lastRoute.to) cbTo.setValue(persisted.lastRoute.to);
    }

    $('planner-swap').addEventListener('click', swap);
    $('planner-add-commute').addEventListener('click', addCommute);
    $('planner-add-leisure').addEventListener('click', addLeisure);

    // ────── Fare-range filter for To-station combobox ──────
    const fareMinEl = $('planner-fare-min');
    const fareMaxEl = $('planner-fare-max');
    const fareRangeStatus = $('planner-fare-range-status');
    function applyFareRangeFilter() {
      if (!cbTo) return;
      const minV = +(fareMinEl && fareMinEl.value) || 0;
      const maxV = +(fareMaxEl && fareMaxEl.value) || 0;
      const fromName = cbFrom ? cbFrom.getValue() : '';
      if (!minV && !maxV) {
        cbTo.setBaseFilter(null);
        if (fareRangeStatus) fareRangeStatus.textContent = '';
        return;
      }
      if (!fromName) {
        cbTo.setBaseFilter(null);
        if (fareRangeStatus) fareRangeStatus.textContent = 'pick From first';
        return;
      }
      const lo = minV || 0;
      const hi = maxV || Infinity;
      let matchCount = 0;
      cbTo.setBaseFilter((cand) => {
        if (cand === fromName) return false;
        const key = pairKey(fromName, cand);
        const fare = state.fares[key];
        if (typeof fare !== 'number') return false;
        const ok = fare >= lo && fare <= hi;
        if (ok) matchCount++;
        return ok;
      });
      if (fareRangeStatus) fareRangeStatus.textContent = `${matchCount} match${matchCount === 1 ? '' : 'es'}`;
    }
    if (fareMinEl) fareMinEl.addEventListener('input', applyFareRangeFilter);
    if (fareMaxEl) fareMaxEl.addEventListener('input', applyFareRangeFilter);
    const fareRangeClear = $('planner-fare-range-clear');
    if (fareRangeClear) fareRangeClear.addEventListener('click', () => {
      if (fareMinEl) fareMinEl.value = '';
      if (fareMaxEl) fareMaxEl.value = '';
      applyFareRangeFilter();
    });

    // Settings inputs
    const bind = (id, key, isNum) => {
      const el = $(id); if (!el) return;
      el.value = state.settings[key];
      el.addEventListener('change', () => {
        state.settings[key] = isNum ? +el.value : el.value;
        renderEstimate();
        saveState();
      });
    };
    bind('planner-month', 'month', false);
    bind('planner-target', 'target', true);
    bind('planner-seed', 'seed', true);
    bind('planner-initial', 'initial_balance', true);
    bind('planner-topup-threshold', 'topup_threshold', true);
    bind('planner-topup-amount', 'topup_amount', true);
    bind('planner-leisure-min', 'leisure_min', true);
    bind('planner-leisure-max', 'leisure_max', true);

    // Month +/- step buttons
    function _stepMonth(delta) {
      const cur = state.settings.month || '';
      const m = cur.match(/^(\d{4})-(\d{2})$/);
      if (!m) return;
      const d = new Date(+m[1], +m[2] - 1 + delta, 1);
      const next = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      pushHistory();
      state.settings.month = next;
      const el = $('planner-month'); if (el) el.value = next;
      renderEstimate(); renderCalendar && renderCalendar(); saveState();
    }
    const monthPrev = $('planner-month-prev');
    const monthNext = $('planner-month-next');
    if (monthPrev) monthPrev.addEventListener('click', () => _stepMonth(-1));
    if (monthNext) monthNext.addEventListener('click', () => _stepMonth(1));

    // Primary: in-browser PDF
    const pdfBtn = $('planner-generate-pdf');
    if (pdfBtn) pdfBtn.addEventListener('click', (e) => generatePDF(e.currentTarget));

    // Backup menu (preset + history JSON download)
    const cpPreset = $('planner-copy-preset');
    if (cpPreset) cpPreset.addEventListener('click', (e) => copy(JSON.stringify(buildPreset(), null, 2), e.currentTarget));
    const cpCli = $('planner-copy-cli');
    if (cpCli) cpCli.addEventListener('click', (e) => copy(buildCli(), e.currentTarget));
    const dlPreset = $('planner-download');
    if (dlPreset) dlPreset.addEventListener('click', () => download(JSON.stringify(buildPreset(), null, 2), 'preset.json', 'application/json'));
    const dlJson = $('planner-download-json');
    if (dlJson) dlJson.addEventListener('click', () => {
      try {
        const h = generateMonthlyHistory();
        download(JSON.stringify(h, null, 2), `suica-${h.month}.json`, 'application/json');
      } catch (err) {
        const s = $('planner-pdf-status'); if (s) { s.textContent = 'Failed: ' + err.message; s.className = 'text-xs text-destructive'; }
      }
    });
    $('planner-load-sample').addEventListener('click', loadSamplePlan);
    $('planner-clear').addEventListener('click', clearPlan);
    const sgBtn = $('planner-auto-suggest');
    if (sgBtn) sgBtn.addEventListener('click', autoSuggest);
    const msBtn = $('planner-multi-suggest');
    if (msBtn) msBtn.addEventListener('click', multiSuggest);
    const presetsMenu = $('planner-presets-menu');
    if (presetsMenu) {
      presetsMenu.innerHTML = '';
      PRESETS.forEach((p) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-ghost sm justify-start text-left';
        btn.innerHTML = `
          <div class="flex flex-col items-start gap-0.5 flex-1">
            <span class="text-sm font-medium">${p.label}</span>
            <span class="text-[10px] text-muted-foreground">${p.desc} · ¥${p.target.toLocaleString('en-US')}</span>
          </div>`;
        btn.addEventListener('click', () => {
          applyPreset(p);
          const det = presetsMenu.closest('details'); if (det) det.removeAttribute('open');
        });
        presetsMenu.appendChild(btn);
      });
    }
    const seedReroll = $('planner-seed-reroll');
    if (seedReroll) seedReroll.addEventListener('click', () => {
      if (state.settings.seedPinned) {
        if (window.Toast) window.Toast.warning('Seed is pinned. Unpin (📌) to change it.');
        return;
      }
      const seedEl = $('planner-seed');
      const current = +state.settings.seed || 0;
      const next = current + 1;
      state.settings.seed = next;
      if (seedEl) seedEl.value = next;
      saveState();
      if (window.Toast) window.Toast.info(`Seed → ${next}`, { title: 'Try another schedule' });
      const status = $('planner-pdf-status');
      if (status) { status.textContent = `Seed bumped to ${next} — same plan, different schedule. Click Generate to render.`; status.className = 'text-xs text-primary'; }
    });
    const seedPinBtn = $('planner-seed-pin');
    function _renderSeedPin() {
      if (!seedPinBtn) return;
      const pinned = !!state.settings.seedPinned;
      seedPinBtn.setAttribute('aria-pressed', pinned ? 'true' : 'false');
      seedPinBtn.style.opacity = pinned ? '1' : '0.5';
      seedPinBtn.style.transform = pinned ? 'rotate(-20deg)' : '';
      seedPinBtn.setAttribute('data-tooltip', pinned ? 'Seed pinned — unpin to allow reroll/randomize' : 'Pin this seed so reroll/randomize won\'t change it');
      const seedEl = $('planner-seed');
      if (seedEl) seedEl.readOnly = pinned;
    }
    if (seedPinBtn) {
      seedPinBtn.addEventListener('click', () => {
        state.settings.seedPinned = !state.settings.seedPinned;
        _renderSeedPin(); saveState();
        if (window.Toast) window.Toast.info(state.settings.seedPinned ? 'Seed pinned' : 'Seed unpinned');
      });
      _renderSeedPin();
    }
    const bulkBtn = $('planner-leisure-bulk');
    if (bulkBtn) bulkBtn.addEventListener('click', bulkAddLeisure);
    const clearLeisureBtn = $('planner-leisure-clear');
    if (clearLeisureBtn) clearLeisureBtn.addEventListener('click', () => {
      if (!state.leisure.length) return;
      if (state.leisure.length > 3 && !confirm(`Clear all ${state.leisure.length} leisure routes?`)) return;
      pushHistory();
      state.leisure = [];
      renderLeisure(); renderEstimate(); saveState();
      if (window.Toast) window.Toast.info('Leisure pool cleared', {
        duration: 6000,
        actionLabel: 'Undo',
        onAction: () => { try { undo(); } catch (_) {} },
      });
    });
    const bulkFileBtn = $('planner-leisure-bulk-file');
    const bulkFileInput = $('planner-leisure-bulk-file-input');
    if (bulkFileBtn && bulkFileInput) {
      bulkFileBtn.addEventListener('click', () => bulkFileInput.click());
      bulkFileInput.addEventListener('change', (e) => {
        const f = e.target.files && e.target.files[0];
        if (f) bulkAddLeisureFromFile(f);
        e.target.value = '';
      });
    }
    const bulkPasteBtn = $('planner-leisure-bulk-paste');
    if (bulkPasteBtn) bulkPasteBtn.addEventListener('click', () => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:120;display:flex;align-items:center;justify-content:center;padding:1rem;';
      const card = document.createElement('div');
      card.className = 'card';
      card.style.cssText = 'max-width:520px;width:100%;padding:1rem;background:var(--card);color:var(--card-foreground);border:1px solid var(--border);border-radius:.5rem;';
      const placeholder = `東京↔新宿\n新宿↔横浜,3\n# lines starting with # are ignored\n渋谷↔池袋\t2`;
      card.innerHTML = `
        <div class="flex items-center justify-between mb-2">
          <div class="font-semibold text-sm">Paste leisure routes</div>
          <button type="button" class="btn btn-ghost sm" data-bp-close aria-label="Close">×</button>
        </div>
        <div class="text-xs text-muted-foreground mb-2">One per line. Accepts <code class="font-mono">route</code> or <code class="font-mono">route,weight</code> (comma/tab). Lines starting with # are ignored. Duplicates by route name are skipped.</div>
        <textarea id="bp-text" rows="8" class="input w-full font-mono text-xs" placeholder="${placeholder.replace(/"/g, '&quot;')}" autocomplete="off" spellcheck="false"></textarea>
        <div class="flex gap-2 mt-3 justify-end">
          <button type="button" class="btn sm btn-outline" data-bp-close>Cancel</button>
          <button type="button" class="btn sm btn-primary" data-bp-add>Add to pool</button>
        </div>
      `;
      overlay.appendChild(card);
      document.body.appendChild(overlay);
      const close = () => overlay.remove();
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
      card.querySelectorAll('[data-bp-close]').forEach((b) => b.addEventListener('click', close));
      const ta = card.querySelector('#bp-text');
      ta.focus();
      card.querySelector('[data-bp-add]').addEventListener('click', () => {
        const text = ta.value || '';
        if (!text.trim()) { if (window.Toast) window.Toast.warning('Nothing to import'); return; }
        _bulkAddLeisureFromText(text, 'pasted');
        close();
      });
      document.addEventListener('keydown', function onEsc(e) {
        if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onEsc); }
      });
    });
    const tgtShuffle = $('planner-target-shuffle');
    if (tgtShuffle) tgtShuffle.addEventListener('click', () => {
      const current = +state.settings.target || 0;
      if (!current) { if (window.Toast) window.Toast.warning('Set a target first'); return; }
      // ±15%, snap to nearest ¥500
      const delta = (Math.random() * 0.30 - 0.15);
      const raw = current * (1 + delta);
      const next = Math.max(500, Math.round(raw / 500) * 500);
      pushHistory();
      state.settings.target = next;
      const el = $('planner-target'); if (el) el.value = next;
      renderEstimate(); saveState();
      if (window.Toast) window.Toast.success(`¥${current.toLocaleString('en-US')} → ¥${next.toLocaleString('en-US')}`, { title: 'Target randomized' });
    });
    const tgtSpread = $('planner-target-spread');
    if (tgtSpread) tgtSpread.addEventListener('click', () => {
      const totalStr = prompt('Total spend to spread across N months (¥):', String((+state.settings.target || 50000) * 6));
      if (totalStr === null) return;
      const total = +String(totalStr).replace(/[^\d.-]/g, '');
      if (!(total > 0)) { if (window.Toast) window.Toast.warning('Enter a positive total'); return; }
      const nStr = prompt('Spread across how many months? (1–12)', '6');
      if (nStr === null) return;
      const n = Math.max(1, Math.min(12, Math.round(+nStr || 0)));
      if (!n) return;
      const per = Math.max(500, Math.round((total / n) / 500) * 500);
      pushHistory();
      state.settings.target = per;
      const el = $('planner-target'); if (el) el.value = per;
      const batchEl = $('planner-batch-months');
      if (batchEl) {
        // Add the option on demand if it isn't present.
        const wanted = String(n);
        if (!Array.from(batchEl.options).some((o) => o.value === wanted)) {
          const opt = document.createElement('option'); opt.value = wanted; opt.textContent = `× ${wanted}`;
          batchEl.appendChild(opt);
        }
        batchEl.value = wanted;
      }
      renderEstimate(); saveState();
      if (window.Toast) window.Toast.success(
        `Target set to ¥${per.toLocaleString('en-US')}/month — Batch dropdown set to × ${n}. Press Generate to roll ${n} PDFs totaling ~¥${(per * n).toLocaleString('en-US')}.`,
        { title: 'Spread applied', duration: 8000 }
      );
    });
    const snapSave = $('planner-snapshot-save');
    if (snapSave) snapSave.addEventListener('click', () => {
      const name = prompt('Name this snapshot:', `Plan ${new Date().toLocaleDateString()}`);
      if (name === null) return;
      captureSnapshot(name.trim() || null);
      const det = snapSave.closest('details'); if (det) det.removeAttribute('open');
    });
    const snapExport = $('planner-snapshots-export');
    if (snapExport) snapExport.addEventListener('click', () => {
      const list = loadSnapshots();
      const det = snapExport.closest('details'); if (det) det.removeAttribute('open');
      if (!list.length) { if (window.Toast) window.Toast.warning('No snapshots to export'); return; }
      const payload = { kind: 'suica-planner-snapshots', v: 1, exported_at: new Date().toISOString(), snapshots: list };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      a.href = URL.createObjectURL(blob);
      a.download = `suica-snapshots-${ts}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      if (window.Toast) window.Toast.success(`${list.length} snapshot${list.length === 1 ? '' : 's'} exported`);
    });
    const snapImport = $('planner-snapshots-import');
    if (snapImport) snapImport.addEventListener('click', () => {
      const det = snapImport.closest('details'); if (det) det.removeAttribute('open');
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = 'application/json,.json';
      inp.addEventListener('change', () => {
        const file = inp.files && inp.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          try {
            const obj = JSON.parse(String(reader.result || ''));
            const incoming = Array.isArray(obj) ? obj : (Array.isArray(obj.snapshots) ? obj.snapshots : null);
            if (!incoming || !incoming.length) throw new Error('No snapshots found in file');
            const existing = loadSnapshots();
            const byId = new Map(existing.map((s) => [s.id, s]));
            let added = 0, skipped = 0;
            incoming.forEach((s) => {
              if (!s || !s.id || !s.pattern || !s.settings) { skipped++; return; }
              if (byId.has(s.id)) { skipped++; return; }
              existing.push(s);
              added++;
            });
            saveSnapshots(existing);
            renderSnapshots();
            if (window.Toast) window.Toast.success(`Imported ${added} snapshot${added === 1 ? '' : 's'}${skipped ? ` · ${skipped} skipped (duplicate/invalid)` : ''}`);
          } catch (err) {
            if (window.Toast) window.Toast.error(err.message || 'Invalid JSON', { title: 'Import failed' });
          }
        };
        reader.readAsText(file);
      });
      inp.click();
    });
    const shareBtn = $('planner-share-link');
    if (shareBtn) shareBtn.addEventListener('click', () => {
      copyShareLink();
      const det = shareBtn.closest('details'); if (det) det.removeAttribute('open');
    });
    const qrBtn = $('planner-share-qr');
    if (qrBtn) qrBtn.addEventListener('click', () => {
      shareLinkAsQr();
      const det = qrBtn.closest('details'); if (det) det.removeAttribute('open');
    });
    const icsBtn = $('planner-export-ics');
    if (icsBtn) icsBtn.addEventListener('click', () => {
      exportIcs();
      const det = icsBtn.closest('details'); if (det) det.removeAttribute('open');
    });
    const fareTableBtn = $('planner-fare-table');
    if (fareTableBtn) fareTableBtn.addEventListener('click', () => {
      const det = fareTableBtn.closest('details'); if (det) det.removeAttribute('open');
      _openFareTable();
    });
    renderSnapshots();
    // Offer to import a plan if the URL hash contains one
    maybeImportFromHash();
    const recentClearBtn = $('planner-recent-clear');
    if (recentClearBtn) recentClearBtn.addEventListener('click', () => {
      saveRecent([]); renderRecent();
    });
    const recentCsvBtn = $('planner-recent-export-csv');
    if (recentCsvBtn) recentCsvBtn.addEventListener('click', () => {
      const list = loadRecent();
      if (!list.length) { if (window.Toast) window.Toast.warning('No recent generations to export'); return; }
      const esc = (s) => {
        const v = String(s == null ? '' : s);
        return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
      };
      const header = ['when_iso','filename','month','target','seed','routes','run_url'];
      const rows = list.map((r) => [
        new Date(r.when).toISOString(),
        r.filename || '',
        r.month || '',
        r.target ?? '',
        r.seed ?? '',
        (r.routes || []).join('|'),
        r.runUrl || '',
      ].map(esc).join(','));
      const csv = '\uFEFF' + [header.join(','), ...rows].join('\r\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `suica-recent-${new Date().toISOString().slice(0,10)}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      if (window.Toast) window.Toast.success(`Exported ${list.length} rows`);
    });
    renderRecent();

    renderPattern(); renderLeisure(); renderEstimate();
    bindKeyboardShortcuts();
    loadFares();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
