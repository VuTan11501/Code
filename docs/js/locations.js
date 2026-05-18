// ═══════════════════════════════════════════════════
//  LOCATIONS MANAGER
//  Defaults + custom (localStorage) for DokoKin GPS stamping
// ═══════════════════════════════════════════════════
const LOCATIONS_KEY = 'workflow_locations_v1';

const DEFAULT_LOCATIONS = {
  office: {
    key: 'office',
    name: 'Office — NEC Tamagawa',
    lat: 35.5202417,
    lon: 139.620325,
    icon: '🏢',
    isDefault: true,
  },
  home: {
    key: 'home',
    name: 'Home — FPT Residence Tsurumi',
    lat: 35.51386,
    lon: 139.6749183,
    icon: '🏠',
    isDefault: true,
  },
};

function loadCustomLocations() {
  try {
    const raw = localStorage.getItem(LOCATIONS_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return (obj && typeof obj === 'object') ? obj : {};
  } catch { return {}; }
}

function saveCustomLocations(obj) {
  localStorage.setItem(LOCATIONS_KEY, JSON.stringify(obj));
}

function getAllLocations() {
  // Merge defaults (immutable) + custom (overrides metadata but not isDefault flag)
  const custom = loadCustomLocations();
  const merged = {};
  for (const [k, v] of Object.entries(DEFAULT_LOCATIONS)) merged[k] = { ...v };
  for (const [k, v] of Object.entries(custom)) merged[k] = { ...v, isDefault: false };
  return merged;
}

function getLocation(key) {
  return getAllLocations()[key] || null;
}

function generateLocationKey(name) {
  const slug = name.toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24) || 'loc';
  // Ensure uniqueness against existing keys
  const all = getAllLocations();
  let key = slug;
  let i = 1;
  while (all[key]) { key = `${slug}_${i++}`; }
  return key;
}

function addCustomLocation({ name, lat, lon, icon }) {
  if (!name || typeof name !== 'string') throw new Error('Name is required');
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('Invalid coordinates');
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new Error('Coordinates out of range');
  const custom = loadCustomLocations();
  const key = generateLocationKey(name);
  custom[key] = {
    key,
    name: name.trim(),
    lat: parseFloat(lat.toFixed(7)),
    lon: parseFloat(lon.toFixed(7)),
    icon: icon || '📍',
  };
  saveCustomLocations(custom);
  return custom[key];
}

function deleteCustomLocation(key) {
  if (DEFAULT_LOCATIONS[key]) return false;
  const custom = loadCustomLocations();
  if (!custom[key]) return false;
  delete custom[key];
  saveCustomLocations(custom);
  return true;
}

// ═══════════════════════════════════════════════════
//  GOOGLE MAPS URL → LAT/LON EXTRACTOR (regex only)
// ═══════════════════════════════════════════════════
function parseGoogleMapsUrl(input) {
  if (!input || typeof input !== 'string') return null;
  const s = input.trim();

  // 1) Plain "lat, lng" string
  let m = s.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (m) return { lat: parseFloat(m[1]), lon: parseFloat(m[2]), source: 'plain' };

  // 2) @lat,lng,zoom (most common, e.g. /maps/place/.../@35.52,139.62,17z)
  m = s.match(/[/@](-?\d+\.\d+),(-?\d+\.\d+)(?:,[\d.]+z)?/);
  if (m) return { lat: parseFloat(m[1]), lon: parseFloat(m[2]), source: 'at' };

  // 3) !3d<lat>!4d<lng> (place data block)
  m = s.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  if (m) return { lat: parseFloat(m[1]), lon: parseFloat(m[2]), source: 'place' };

  // 4) Query params: ?q=lat,lng / ?ll=lat,lng / ?destination=lat,lng / ?center=lat,lng
  m = s.match(/[?&](?:q|ll|destination|center|sll)=(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m) return { lat: parseFloat(m[1]), lon: parseFloat(m[2]), source: 'query' };

  return null;
}

// ═══════════════════════════════════════════════════
//  UI: SETTINGS PAGE LIST
// ═══════════════════════════════════════════════════
function renderLocationList() {
  const container = document.getElementById('locationList');
  if (!container) return;
  const all = getAllLocations();
  const html = Object.values(all).map(loc => {
    const isDefault = loc.isDefault;
    const deleteBtn = isDefault
      ? `<span class="badge badge-sm" style="font-size:0.7em;padding:2px 8px;background:var(--primary);color:#fff;border-radius:999px;">Default</span>`
      : `<button class="btn danger sm" onclick="confirmDeleteLocation('${loc.key}')" title="Delete">${typeof ICON !== 'undefined' ? ICON('trash', 14) : '🗑'}</button>`;
    return `
      <div class="location-item" style="display:flex;align-items:center;gap:10px;padding:10px 14px;border:1px solid var(--border);border-radius:8px;background:var(--card);">
        <span style="font-size:1.3em;">${loc.icon || '📍'}</span>
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:0.9em;">${escapeHtml(loc.name)}</div>
          <div style="font-size:0.75em;color:var(--muted-foreground);font-family:var(--font-mono)">${loc.lat}, ${loc.lon}</div>
        </div>
        ${deleteBtn}
      </div>`;
  }).join('');
  container.innerHTML = html;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

async function confirmDeleteLocation(key) {
  const loc = getLocation(key);
  if (!loc) return;
  const ok = await uiConfirm({
    title: 'Delete location?',
    message: `Delete location "${loc.name}"?\n\nExisting schedule entries using this location will fall back to office.`,
    confirmText: 'Delete',
    danger: true,
  });
  if (!ok) return;
  if (deleteCustomLocation(key)) {
    renderLocationList();
    populateLocationDropdowns();
    if (typeof toast === 'function') toast(`✅ Deleted "${loc.name}"`);
  }
}

// ═══════════════════════════════════════════════════
//  ADD LOCATION MODAL
// ═══════════════════════════════════════════════════
function openAddLocationModal() {
  const modal = document.getElementById('addLocationModal');
  if (!modal) return;
  // Reset form
  document.getElementById('addLocName').value = '';
  document.getElementById('addLocIcon').value = '📍';
  document.getElementById('addLocUrl').value = '';
  document.getElementById('addLocLat').value = '';
  document.getElementById('addLocLon').value = '';
  document.getElementById('addLocStatus').textContent = '';
  document.getElementById('addLocStatus').className = 'text-xs mt-2';
  modal.classList.add('open');
}

function closeAddLocationModal() {
  document.getElementById('addLocationModal')?.classList.remove('open');
}

function extractLatLonFromUrl() {
  const url = document.getElementById('addLocUrl').value.trim();
  const statusEl = document.getElementById('addLocStatus');
  if (!url) {
    statusEl.textContent = 'Paste a Google Maps URL above first.';
    statusEl.className = 'text-xs mt-2 text-muted-foreground';
    return;
  }
  const result = parseGoogleMapsUrl(url);
  if (!result) {
    statusEl.innerHTML = `✗ Couldn't extract coordinates. <br>Tip: shortlinks (goo.gl, maps.app.goo.gl) need to be opened in browser first, then copy the full URL with <code>@lat,lng</code> or <code>!3d…!4d…</code>.`;
    statusEl.className = 'text-xs mt-2';
    statusEl.style.color = 'var(--red, #ef4444)';
    return;
  }
  document.getElementById('addLocLat').value = result.lat;
  document.getElementById('addLocLon').value = result.lon;
  statusEl.textContent = `✓ Extracted from ${result.source}: ${result.lat}, ${result.lon}`;
  statusEl.className = 'text-xs mt-2';
  statusEl.style.color = 'var(--green, #22c55e)';
}

function saveAddLocation() {
  const name = document.getElementById('addLocName').value.trim();
  const icon = document.getElementById('addLocIcon').value.trim() || '📍';
  const latStr = document.getElementById('addLocLat').value.trim();
  const lonStr = document.getElementById('addLocLon').value.trim();
  const statusEl = document.getElementById('addLocStatus');

  if (!name) {
    statusEl.textContent = '✗ Name is required';
    statusEl.style.color = 'var(--red, #ef4444)';
    return;
  }
  const lat = parseFloat(latStr);
  const lon = parseFloat(lonStr);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    statusEl.textContent = '✗ Latitude / Longitude must be numbers';
    statusEl.style.color = 'var(--red, #ef4444)';
    return;
  }
  try {
    const loc = addCustomLocation({ name, lat, lon, icon });
    closeAddLocationModal();
    renderLocationList();
    populateLocationDropdowns();
    if (typeof toast === 'function') toast(`✅ Added "${loc.name}"`);
  } catch (e) {
    statusEl.textContent = '✗ ' + e.message;
    statusEl.style.color = 'var(--red, #ef4444)';
  }
}

// ═══════════════════════════════════════════════════
//  DROPDOWN POPULATION (schedLocation + editSchedLocation)
// ═══════════════════════════════════════════════════
function populateLocationDropdowns() {
  const all = getAllLocations();
  const optionsHtml = Object.values(all).map(loc =>
    `<option value="${loc.key}">${loc.icon || '📍'} ${escapeHtml(loc.name)}</option>`
  ).join('');
  ['schedLocation', 'editSchedLocation'].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = optionsHtml;
    if (all[prev]) sel.value = prev;
  });
}

// Init on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  renderLocationList();
  populateLocationDropdowns();
});
