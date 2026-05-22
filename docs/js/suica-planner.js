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
      populateDatalist();
      $('planner-load-status').textContent =
        `Loaded ${state.stations.length} stations · ${Object.keys(state.fares).length} known fares`;
    } catch (err) {
      $('planner-load-status').innerHTML =
        `<span class="status-badge status-failure">Failed to load fare data: ${err.message}</span>`;
    }
  }

  function populateDatalist() {
    const dl = $('planner-stations-dl');
    dl.innerHTML = state.stations
      .map((s) => `<option value="${s}"></option>`)
      .join('');
  }

  // ────── Import stations from a loaded history ──────
  // suica-history.js dispatches 'suica:loaded' with detail = MonthlyHistory
  window.addEventListener('suica:loaded', (ev) => {
    const h = ev.detail; if (!h || !h.entries) return;
    const fresh = new Set(state.stations);
    h.entries.forEach((e) => { if (e.station) fresh.add(e.station); });
    if (fresh.size !== state.stations.length) {
      state.stations = Array.from(fresh).sort((x, y) => x.localeCompare(y, 'ja'));
      populateDatalist();
      $('planner-load-status').textContent =
        `Loaded ${state.stations.length} stations (incl. from history) · ${Object.keys(state.fares).length} known fares`;
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
    const from = $('planner-from').value.trim();
    const to = $('planner-to').value.trim();
    const out = $('planner-fare-out');
    const addBtns = document.querySelectorAll('[data-planner-add]');
    if (!from || !to) { out.textContent = '—'; out.className = 'text-sm text-muted-foreground font-mono'; addBtns.forEach((b) => b.setAttribute('disabled', '')); return; }
    if (from === to) { out.textContent = 'pick different stations'; out.className = 'text-sm text-muted-foreground font-mono'; addBtns.forEach((b) => b.setAttribute('disabled', '')); return; }
    const r = lookupFare(from, to);
    if (!r) { out.textContent = '—'; addBtns.forEach((b) => b.setAttribute('disabled', '')); return; }
    out.innerHTML = `${fmtYen(r.fare)} <span class="text-xs text-muted-foreground">(${r.source === 'known' ? 'known IC' : 'estimate · will resolve via API'})</span>`;
    out.className = 'text-sm font-mono ' + (r.source === 'known' ? 'text-foreground' : 'text-muted-foreground');
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
    const from = $('planner-from').value.trim();
    const to = $('planner-to').value.trim();
    if (!from || !to || from === to) return null;
    return pairKey(from, to);
  }

  function swap() {
    const f = $('planner-from'); const t = $('planner-to');
    const tmp = f.value; f.value = t.value; t.value = tmp;
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

  // ────── UI actions ──────
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
    // Wire inputs
    ['planner-from', 'planner-to'].forEach((id) => {
      $(id).addEventListener('input', updateFareDisplay);
      $(id).addEventListener('change', updateFareDisplay);
    });
    $('planner-swap').addEventListener('click', swap);
    $('planner-add-commute').addEventListener('click', addCommute);
    $('planner-add-leisure').addEventListener('click', addLeisure);

    // Settings inputs
    const bind = (id, key, isNum) => {
      const el = $(id); el.value = state.settings[key];
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

    // Output buttons
    $('planner-copy-preset').addEventListener('click', (e) => copy(JSON.stringify(buildPreset(), null, 2), e.currentTarget));
    $('planner-copy-cli').addEventListener('click', (e) => copy(buildCli(), e.currentTarget));
    $('planner-download').addEventListener('click', () => download(JSON.stringify(buildPreset(), null, 2), 'preset.json', 'application/json'));
    $('planner-load-sample').addEventListener('click', loadSamplePlan);
    $('planner-clear').addEventListener('click', clearPlan);

    renderPattern(); renderLeisure(); renderEstimate();
    loadFares();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
