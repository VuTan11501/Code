// suica-history.js — Standalone viewer for suica-history-generator JSON output.
// All processing is local; no network calls except optional --load-from-url.
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const fmt = (n) => '¥' + Number(n || 0).toLocaleString('en-US');

  // ─── Loaders ─────────────────────────────────────────────
  function readFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsText(file);
    });
  }

  function showError(msg) {
    const el = $('loader-error');
    el.textContent = msg;
    el.classList.remove('hidden');
  }
  function clearError() { $('loader-error').classList.add('hidden'); }

  async function handleFile(file) {
    clearError();
    if (!file) return;
    try {
      const text = await readFile(file);
      const data = JSON.parse(text);
      render(data);
    } catch (e) {
      showError('Failed to parse JSON: ' + (e.message || e));
    }
  }

  // Drag & drop on loader card
  const loader = $('loader');
  loader.addEventListener('dragover', (e) => {
    e.preventDefault(); loader.classList.add('drop-active');
  });
  loader.addEventListener('dragleave', () => loader.classList.remove('drop-active'));
  loader.addEventListener('drop', (e) => {
    e.preventDefault(); loader.classList.remove('drop-active');
    if (e.dataTransfer.files && e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });
  $('file-input').addEventListener('change', (e) => handleFile(e.target.files[0]));

  $('load-from-url').addEventListener('click', async () => {
    const url = prompt('JSON URL?');
    if (!url) return;
    clearError();
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      render(await r.json());
    } catch (e) { showError(String(e.message || e)); }
  });

  $('load-sample').addEventListener('click', () => render(sampleData()));

  // ─── Sample (small synthetic) ───────────────────────────
  function sampleData() {
    const entries = [];
    let bal = 3000;
    const stations = ['東京', '新宿', '渋谷', '横浜', '品川'];
    const startDay = new Date('2026-05-01T08:00:00+09:00').getTime();
    for (let i = 0; i < 30; i++) {
      if (i % 7 === 6) continue; // skip Sunday
      const day = new Date(startDay + i * 86400000);
      const a = stations[i % stations.length];
      const b = stations[(i + 1) % stations.length];
      const fare = 178 + (i % 4) * 50;
      const inTime = new Date(day); inTime.setHours(8, 12 + (i % 30));
      const outTime = new Date(day); outTime.setHours(8, 45 + (i % 30));
      entries.push({ kind: '入', datetime: inTime.toISOString(), station: a, fare_yen: 0, balance_yen: bal });
      bal -= fare;
      entries.push({ kind: '出', datetime: outTime.toISOString(), station: b, fare_yen: fare, balance_yen: bal });
      // Return trip evening
      const inE = new Date(day); inE.setHours(18, 30);
      const outE = new Date(day); outE.setHours(19, 5);
      entries.push({ kind: '入', datetime: inE.toISOString(), station: b, fare_yen: 0, balance_yen: bal });
      bal -= fare;
      entries.push({ kind: '出', datetime: outE.toISOString(), station: a, fare_yen: fare, balance_yen: bal });
    }
    return {
      month: '2026-05', initial_balance: 3000, final_balance: bal,
      total_spent: 3000 - bal, total_charged: 0, entries,
    };
  }

  // ─── Renderer ───────────────────────────────────────────
  let CURRENT = null;

  function render(data) {
    if (!data || !Array.isArray(data.entries)) {
      showError('Invalid history JSON: missing "entries" array');
      return;
    }
    CURRENT = data;
    $('report').classList.remove('hidden');

    // KPIs
    $('kpi-month').textContent = data.month || '—';
    $('kpi-spent').textContent = fmt(data.total_spent);

    const pairs = countTrips(data.entries);
    $('kpi-trips').textContent = pairs.length;

    // Avg / weekday: sum fare on entries with kind=='出' grouped by weekday !== Sun (0).
    const dailyMap = aggregateDaily(data.entries);
    const weekdays = Array.from(dailyMap.entries()).filter(([d]) => new Date(d).getDay() !== 0);
    const avg = weekdays.length ? weekdays.reduce((s, [,v]) => s + v, 0) / weekdays.length : 0;
    $('kpi-avg').textContent = fmt(Math.round(avg));

    // Daily chart
    renderDailyChart(dailyMap, data.month);

    // Top stations / routes
    renderTopStations(data.entries);
    renderTopRoutes(pairs);

    // Entries table
    renderEntries(data.entries);

    // What-if
    initWhatIf(data);
  }

  function countTrips(entries) {
    const pairs = [];
    let pending = null;
    for (const e of entries) {
      if (e.kind === '入') pending = e;
      else if (e.kind === '出' && pending) {
        pairs.push({ from: pending.station, to: e.station, fare: e.fare_yen, at: pending.datetime });
        pending = null;
      } else {
        pending = null; // reset on other kinds
      }
    }
    return pairs;
  }

  function aggregateDaily(entries) {
    const out = new Map(); // YYYY-MM-DD -> yen
    for (const e of entries) {
      if (e.kind !== '出' && e.kind !== '物販') continue;
      const day = e.datetime.slice(0, 10);
      out.set(day, (out.get(day) || 0) + Number(e.fare_yen || 0));
    }
    return out;
  }

  function renderDailyChart(dailyMap, month) {
    const chart = $('daily-chart');
    chart.innerHTML = '';
    if (!month) return;
    const [y, m] = month.split('-').map(Number);
    const days = new Date(y, m, 0).getDate();
    const max = Math.max(1, ...Array.from(dailyMap.values()));
    for (let d = 1; d <= days; d++) {
      const key = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const yen = dailyMap.get(key) || 0;
      const dow = new Date(key).getDay();
      const colour = yen === 0 ? 'bg-slate-200 dark:bg-slate-800'
                   : dow === 0 ? 'bg-red-400'
                   : dow === 6 ? 'bg-amber-400'
                   : 'bg-blue-500';
      const h = yen === 0 ? 4 : Math.max(6, Math.round((yen / max) * 100));
      const bar = document.createElement('div');
      bar.className = `bar flex-1 rounded-t ${colour}`;
      bar.style.height = h + '%';
      bar.title = `${key}: ${fmt(yen)}`;
      chart.appendChild(bar);
    }
  }

  function renderTopStations(entries) {
    const ct = new Map();
    for (const e of entries) {
      if (e.kind === '入' || e.kind === '出') ct.set(e.station, (ct.get(e.station) || 0) + 1);
    }
    const sorted = [...ct.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    const ol = $('top-stations');
    ol.innerHTML = '';
    const total = sorted.reduce((s, [,n]) => s + n, 0) || 1;
    for (const [name, n] of sorted) {
      const li = document.createElement('li');
      const pct = Math.round((n / total) * 100);
      li.innerHTML = `<div class="flex justify-between"><span>${escapeHtml(name)}</span><span class="text-slate-500">${n}× (${pct}%)</span></div>
                      <div class="h-1 bg-slate-100 dark:bg-slate-800 rounded mt-1"><div class="h-1 bg-blue-500 rounded" style="width:${pct}%"></div></div>`;
      ol.appendChild(li);
    }
  }

  function renderTopRoutes(pairs) {
    const ct = new Map();
    for (const p of pairs) {
      const key = `${p.from} → ${p.to}`;
      const cur = ct.get(key) || { n: 0, total: 0 };
      cur.n += 1; cur.total += Number(p.fare || 0);
      ct.set(key, cur);
    }
    const sorted = [...ct.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 10);
    const ol = $('top-routes');
    ol.innerHTML = '';
    for (const [key, v] of sorted) {
      const li = document.createElement('li');
      li.innerHTML = `<div class="flex justify-between"><span>${escapeHtml(key)}</span><span class="text-slate-500">${v.n}× · ${fmt(v.total)}</span></div>`;
      ol.appendChild(li);
    }
  }

  function renderEntries(entries) {
    const tb = $('entries-tbody');
    tb.innerHTML = '';
    entries.forEach((e, i) => {
      const tr = document.createElement('tr');
      tr.className = i % 2 ? 'bg-slate-50 dark:bg-slate-900/50' : '';
      const ts = (e.datetime || '').replace('T', ' ').slice(0, 16);
      tr.innerHTML =
        `<td class="py-0.5 pr-2 text-slate-400">${i + 1}</td>` +
        `<td class="pr-2">${escapeHtml(ts)}</td>` +
        `<td class="pr-2">${escapeHtml(e.kind || '')}</td>` +
        `<td class="pr-2">${escapeHtml(e.station || '')}</td>` +
        `<td class="pr-2 text-right">${e.fare_yen ? fmt(e.fare_yen) : ''}</td>` +
        `<td class="text-right">${fmt(e.balance_yen)}</td>`;
      tb.appendChild(tr);
    });
  }

  function initWhatIf(data) {
    const slider = $('whatif-slider');
    const scaleEl = $('whatif-scale');
    const targetEl = $('whatif-target');
    const baseSpent = Number(data.total_spent || 0);
    const update = () => {
      const s = Number(slider.value);
      scaleEl.textContent = s.toFixed(2) + 'x';
      targetEl.textContent = fmt(Math.round(baseSpent * s));
    };
    slider.oninput = update;
    update();
    $('whatif-copy').onclick = () => {
      const s = Number(slider.value);
      const newTarget = Math.round(baseSpent * s);
      const cmd =
        `python -m scripts.generate \\\n` +
        `    --config data/presets/tokyo-commuter.json \\\n` +
        `    --month ${data.month} \\\n` +
        `    --target ${newTarget} \\\n` +
        `    --seed 42 \\\n` +
        `    --out out/${data.month}-whatif.json`;
      navigator.clipboard.writeText(cmd).then(() => {
        $('whatif-copy').textContent = 'Copied!';
        setTimeout(() => ($('whatif-copy').textContent = 'Copy CLI command'), 1500);
      });
    };
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
  }
})();
