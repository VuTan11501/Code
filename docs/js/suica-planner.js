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
    stations: [],                 // ["東京", "新宿", …] unique, sorted
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
    },
  };

  function defaultNextMonth() {
    const d = new Date();
    d.setMonth(d.getMonth() + 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  // ────── Load fare data ──────
  async function loadFares() {
    const setStatus = (html, variant) => {
      const box = $('planner-load-status');
      box.innerHTML = `<span data-icon="${variant === 'error' ? 'alert' : 'info'}" data-size="14"></span><div class="flex-1">${html}</div>`;
      if (window.refreshIcons) window.refreshIcons(box);
    };
    try {
      const res = await fetch('data/kanto_fares.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      state.fares = data.fares || {};
      const set = new Set();
      Object.keys(state.fares).forEach((k) => {
        const [a, b] = k.split('↔');
        if (a) set.add(a); if (b) set.add(b);
      });
      state.stations = Array.from(set).sort((x, y) => x.localeCompare(y, 'ja'));
      populateComboboxes();
      setStatus(
        `<strong>${state.stations.length}</strong> Kanto stations · <strong>${Object.keys(state.fares).length}</strong> known IC fares loaded. Pick a route above to add it to your plan.`,
        'info'
      );
    } catch (err) {
      setStatus(`Failed to load fare data: ${err.message}`, 'error');
    }
  }

  // ────── Combobox component (shadcn-style) ──────
  function createCombobox(wrapper, opts) {
    const trigger = wrapper.querySelector('.combobox-trigger');
    const placeholderText = (opts && opts.placeholder) || 'Pick…';
    let options = (opts && opts.options) || [];
    let value = (opts && opts.value) || '';
    let panel = null;
    let listEl = null;
    let searchEl = null;
    let activeIdx = -1;
    let filtered = options.slice();

    function render() {
      if (value) {
        trigger.innerHTML = `<span>${value}</span>`;
      } else {
        trigger.innerHTML = `<span class="combobox-placeholder">${placeholderText}</span>`;
      }
    }
    function open() {
      if (panel) return;
      panel = document.createElement('div');
      panel.className = 'combobox-panel';
      panel.innerHTML = `
        <input type="text" class="input input-sm combobox-search" placeholder="Search station…" autocomplete="off">
        <div class="combobox-list" role="listbox"></div>
      `;
      wrapper.appendChild(panel);
      trigger.classList.add('is-open');
      trigger.setAttribute('aria-expanded', 'true');
      searchEl = panel.querySelector('.combobox-search');
      listEl = panel.querySelector('.combobox-list');
      filtered = options.slice();
      activeIdx = Math.max(0, options.indexOf(value));
      renderList();
      searchEl.addEventListener('input', () => {
        const q = searchEl.value.trim().toLowerCase();
        filtered = !q ? options.slice() : options.filter((o) => o.toLowerCase().includes(q));
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
      listEl.innerHTML = filtered.map((o, i) => {
        const cls = ['combobox-item'];
        if (o === value) cls.push('is-selected');
        if (i === activeIdx) cls.push('is-active');
        return `<div class="${cls.join(' ')}" data-i="${i}" role="option">${o}</div>`;
      }).join('');
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
      setOptions(newOpts) { options = newOpts.slice(); },
      setValue(v) { value = v || ''; render(); },
      getValue() { return value; },
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
  function lookupFare(a, b) {
    if (!a || !b || a === b) return null;
    const key = pairKey(a, b);
    if (state.fares[key] != null) return { fare: state.fares[key], source: 'known' };
    // Heuristic estimate: median of known fares as fallback (CLI will resolve via API)
    const vals = Object.values(state.fares);
    if (!vals.length) return null;
    const sorted = vals.slice().sort((x, y) => x - y);
    const median = sorted[Math.floor(sorted.length / 2)];
    return { fare: median, source: 'estimate' };
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
    if (!from || !to) { setBadge('Pick from & to', 'status-skipped'); addBtns.forEach((b) => b.setAttribute('disabled', '')); return; }
    if (from === to) { setBadge('Pick different stations', 'status-failure'); addBtns.forEach((b) => b.setAttribute('disabled', '')); return; }
    const r = lookupFare(from, to);
    if (!r) { setBadge('No data', 'status-skipped'); addBtns.forEach((b) => b.setAttribute('disabled', '')); return; }
    if (r.source === 'known') {
      setBadge(`${fmtYen(r.fare)} · known IC`, 'status-success');
    } else {
      setBadge(`${fmtYen(r.fare)} · estimate (will resolve via API)`, 'status-pending');
    }
    addBtns.forEach((b) => b.removeAttribute('disabled'));
  }

  // ────── Add / remove routes ──────
  function addCommute() {
    const r = currentRoute(); if (!r) return;
    const days = DAYS.slice(0, 5); // Mon-Fri default
    days.forEach((day) => {
      if (!state.pattern[day].some((x) => x.route === r)) {
        state.pattern[day].push({ route: r, type: 'commute' });
      }
    });
    renderPattern();
    renderEstimate();
  }

  function addLeisure() {
    const r = currentRoute(); if (!r) return;
    if (state.leisure.some((x) => x.route === r)) return;
    state.leisure.push({ route: r, weight: 1 });
    renderLeisure();
    renderEstimate();
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
    DAYS.forEach((day) => {
      const row = document.createElement('div');
      row.className = 'flex items-center gap-2 py-1.5 border-b border-border last:border-b-0';
      const label = document.createElement('div');
      label.className = 'text-xs text-muted-foreground font-medium w-10 flex-none';
      label.textContent = DAY_LABELS[day];
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
          chip.innerHTML = `<span class="font-mono">${t.route}</span><button class="ml-1 hover:text-destructive" aria-label="remove">×</button>`;
          chip.querySelector('button').addEventListener('click', () => {
            state.pattern[day].splice(idx, 1);
            renderPattern(); renderEstimate();
          });
          chips.appendChild(chip);
        });
      }
      row.appendChild(chips);
      wrap.appendChild(row);
    });
  }

  // ────── Render: leisure pool ──────
  function renderLeisure() {
    const wrap = $('planner-leisure'); wrap.innerHTML = '';
    if (!state.leisure.length) {
      wrap.innerHTML = '<div class="text-xs text-muted-foreground italic py-2">No leisure routes — add some for weekend trips</div>';
      return;
    }
    state.leisure.forEach((l, idx) => {
      const row = document.createElement('div');
      row.className = 'flex items-center gap-2 py-1.5 border-b border-border last:border-b-0';
      row.innerHTML = `
        <span class="status-badge status-pending font-mono flex-none">${l.route}</span>
        <span class="text-xs text-muted-foreground">weight</span>
        <input type="number" min="1" max="20" value="${l.weight}" class="input w-16 text-sm" data-leisure-weight="${idx}">
        <span class="text-xs text-muted-foreground font-mono ml-auto">${fmtYen((state.fares[l.route] || 0))}</span>
        <button class="btn sm btn-ghost" data-leisure-remove="${idx}" aria-label="remove">×</button>
      `;
      wrap.appendChild(row);
    });
    wrap.querySelectorAll('[data-leisure-weight]').forEach((input) => {
      input.addEventListener('change', (e) => {
        const i = +e.target.dataset.leisureWeight;
        state.leisure[i].weight = Math.max(1, +e.target.value || 1);
        renderEstimate();
      });
    });
    wrap.querySelectorAll('[data-leisure-remove]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const i = +e.target.closest('[data-leisure-remove]').dataset.leisureRemove;
        state.leisure.splice(i, 1);
        renderLeisure(); renderEstimate();
      });
    });
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
      const dayFare = trips.reduce((sum, t) => sum + (state.fares[t.route] || lookupFare(...t.route.split('↔'))?.fare || 0), 0);
      commuteSpend += dayFare * monthInfo.counts[day];
    });
    // Each "trip" in pattern = one round-trip (IN+OUT = 2 taps but ONE fare debit)
    // Actually IC fare is per-segment. The skill bills 1 fare per OUT tap. So 1 entry = 1 fare debit.
    // For leisure: avg = (min+max)/2 monthly outings, each outing = 1 round trip → 2 fare debits at avg leisure fare.
    const totW = state.leisure.reduce((s, l) => s + l.weight, 0);
    const avgLeisureFare = totW
      ? state.leisure.reduce((s, l) => s + (state.fares[l.route] || 0) * l.weight, 0) / totW
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
    if (target) {
      const pct = ((diff / target) * 100).toFixed(1);
      diffEl.textContent = `${diff >= 0 ? '+' : ''}${fmtYen(diff)} vs target (${pct}%)`;
      diffEl.className = 'text-xs font-mono mt-1 ' + (Math.abs(diff) / target < 0.15 ? 'text-primary' : 'text-warning');
    } else diffEl.textContent = '';
  }

  // ────── Build preset JSON ──────
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
      const fare = fares[fareKey] || 0;
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
        const fare = fares[pairKey(a,b)] || 0;
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

  async function generatePDF(btn) {
    const status = $('planner-pdf-status');
    const setStatus = (txt, cls) => { status.textContent = txt || ''; status.className = 'text-xs ' + (cls || 'text-muted-foreground'); };
    try {
      const totalRoutes = DAYS.reduce((s, d) => s + state.pattern[d].length, 0) + state.leisure.length;
      if (!totalRoutes) { setStatus('Add at least one commute or leisure route first.', 'text-warning'); return; }
      if (typeof html2pdf === 'undefined') { setStatus('PDF library not loaded — refresh and try again.', 'text-destructive'); return; }
      btn.setAttribute('disabled', '');
      setStatus('Generating history…', 'text-muted-foreground');
      const history = generateMonthlyHistory();
      // Surface the generated history to the viewer below so user sees what got rendered.
      if (window.renderSuicaHistory) {
        try { window.renderSuicaHistory(history); } catch (_) {}
      }
      setStatus(`Rendering PDF (${history.entries.length} entries)…`, 'text-muted-foreground');
      const result = await window.SuicaPDF.generate(history, {
        seed: state.settings.seed,
        filename: `suica-${history.month}.pdf`,
      });
      setStatus(`✓ Downloaded ${result.filename} (${result.pages} page${result.pages > 1 ? 's' : ''})`, 'text-primary');
    } catch (err) {
      console.error(err);
      setStatus(`Failed: ${err.message}`, 'text-destructive');
    } finally {
      btn.removeAttribute('disabled');
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

  function loadSamplePlan() {
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
    renderPattern(); renderLeisure(); renderEstimate();
  }

  function clearPlan() {
    DAYS.forEach((d) => { state.pattern[d] = []; });
    state.leisure = [];
    renderPattern(); renderLeisure(); renderEstimate();
  }

  // ────── Init ──────
  function init() {
    // Wire comboboxes (replaces the old datalist <input>)
    const fromWrap = document.querySelector('[data-combobox-id="planner-from"]');
    const toWrap = document.querySelector('[data-combobox-id="planner-to"]');
    if (fromWrap) cbFrom = createCombobox(fromWrap, { options: state.stations, placeholder: '東京 / Tokyo', onChange: updateFareDisplay });
    if (toWrap)   cbTo   = createCombobox(toWrap,   { options: state.stations, placeholder: '新宿 / Shinjuku', onChange: updateFareDisplay });

    $('planner-swap').addEventListener('click', swap);
    $('planner-add-commute').addEventListener('click', addCommute);
    $('planner-add-leisure').addEventListener('click', addLeisure);

    // Settings inputs
    const bind = (id, key, isNum) => {
      const el = $(id); if (!el) return;
      el.value = state.settings[key];
      el.addEventListener('change', () => { state.settings[key] = isNum ? +el.value : el.value; renderEstimate(); });
    };
    bind('planner-month', 'month', false);
    bind('planner-target', 'target', true);
    bind('planner-seed', 'seed', true);
    bind('planner-initial', 'initial_balance', true);
    bind('planner-topup-threshold', 'topup_threshold', true);
    bind('planner-topup-amount', 'topup_amount', true);
    bind('planner-leisure-min', 'leisure_min', true);
    bind('planner-leisure-max', 'leisure_max', true);

    // Primary: in-browser PDF
    const pdfBtn = $('planner-generate-pdf');
    if (pdfBtn) pdfBtn.addEventListener('click', (e) => generatePDF(e.currentTarget));

    // Secondary export menu
    $('planner-copy-preset').addEventListener('click', (e) => copy(JSON.stringify(buildPreset(), null, 2), e.currentTarget));
    $('planner-copy-cli').addEventListener('click', (e) => copy(buildCli(), e.currentTarget));
    $('planner-download').addEventListener('click', () => download(JSON.stringify(buildPreset(), null, 2), 'preset.json', 'application/json'));
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

    renderPattern(); renderLeisure(); renderEstimate();
    loadFares();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
