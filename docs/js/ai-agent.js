// ═══════════════════════════════════════════════════
//  AI AGENT — OT Coach chat orchestrator (P1, read-only)
//  • Provider: GitHub Models (OpenAI-compatible)
//  • Streaming SSE parser, tool-calling loop (max 3 hops)
//  • Conversation in sessionStorage; cleared on logout
//  • Rate limit: 10 messages / 60s (client-side token bucket)
// ═══════════════════════════════════════════════════
window.AIAgent = (function () {
  'use strict';

  // GitHub Models — new host (https://models.github.ai). Old Azure-ML host
  // (models.inference.ai.azure.com) is on a deprecation path. New host requires
  // `publisher/model` IDs (e.g. `openai/gpt-4o-mini`); we keep short names in
  // the UI / sessionStorage and prepend the publisher at the API boundary via
  // apiModelId() below.
  const API_URL = 'https://models.github.ai/inference/chat/completions';
  const DEFAULT_MODEL = 'gpt-4o-mini';
  function apiModelId(m) {
    return (m && m.includes('/')) ? m : `openai/${m || DEFAULT_MODEL}`;
  }
  const MAX_TOOL_HOPS = 3;
  const MAX_HISTORY_TURNS = 40;          // user+assistant pair count cap (sessionStorage safety)
  const RATE_LIMIT_MAX = 10;
  const RATE_LIMIT_WINDOW_MS = 60_000;

  const SS_CONV_KEY = 'ai_conv_v1';
  const SS_MODEL_KEY = 'ai_model_v1';
  const LS_RATE_KEY = 'ai_rate_v1';
  const LS_CURRENT_CONV_KEY = 'ai_current_conv_v1';
  const IDB_NAME = 'ai_coach';
  const IDB_VERSION = 1;
  const IDB_STORE = 'conversations';

  let mounted = false;
  let messages = [];           // conversation (excluding system)
  let model = DEFAULT_MODEL;
  let currentAbort = null;     // AbortController for in-flight request
  let isStreaming = false;
  let convVersion = 0;         // bumped on clearConv — running loops bail out if version changes
  let currentConvId = null;    // active conversation id (IDB key)
  let convStoreReady = false;  // true after IDB init + migration
  let _saveDebounce = null;

  // ─── Conversation store (IndexedDB; sessionStorage write-through) ──
  function _openDB() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new Error('IndexedDB unavailable'));
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          const os = db.createObjectStore(IDB_STORE, { keyPath: 'id' });
          os.createIndex('updated_at', 'updated_at');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function _idbTx(mode, fn) {
    const db = await _openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, mode);
      const os = tx.objectStore(IDB_STORE);
      let result;
      try { result = fn(os); } catch (e) { reject(e); return; }
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  function _newConvId() { return 'c-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function _deriveTitle(msgs) {
    const firstUser = (msgs || []).find(m => m.role === 'user' && m.content);
    if (!firstUser) return 'New chat';
    const t = String(firstUser.content).replace(/\s+/g, ' ').trim().slice(0, 48);
    return t || 'New chat';
  }
  async function _listConvs() {
    try {
      const arr = await _idbTx('readonly', (os) => {
        return new Promise((res, rej) => {
          const out = [];
          const cur = os.openCursor();
          cur.onsuccess = (e) => {
            const c = e.target.result;
            if (c) { out.push(c.value); c.continue(); } else res(out);
          };
          cur.onerror = () => rej(cur.error);
        });
      });
      const resolved = await arr;
      return resolved.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
    } catch { return []; }
  }
  async function _getConv(id) {
    try {
      return await _idbTx('readonly', (os) => new Promise((res, rej) => {
        const r = os.get(id);
        r.onsuccess = () => res(r.result || null);
        r.onerror = () => rej(r.error);
      })).then(p => p);
    } catch { return null; }
  }
  async function _putConv(rec) {
    try {
      await _idbTx('readwrite', (os) => new Promise((res, rej) => {
        const r = os.put(rec);
        r.onsuccess = () => res();
        r.onerror = () => rej(r.error);
      })).then(p => p);
      return true;
    } catch { return false; }
  }
  async function _deleteConv(id) {
    try {
      await _idbTx('readwrite', (os) => new Promise((res, rej) => {
        const r = os.delete(id);
        r.onsuccess = () => res();
        r.onerror = () => rej(r.error);
      })).then(p => p);
      return true;
    } catch { return false; }
  }
  async function _initConvStore() {
    try {
      // Health check: probe that we can actually write/read/delete in IDB.
      const probeId = '__probe__' + Date.now();
      await _idbTx('readwrite', (os) => new Promise((res, rej) => {
        const r = os.put({ id: probeId, _probe: true });
        r.onsuccess = () => res(); r.onerror = () => rej(r.error);
      })).then(p => p);
      await _idbTx('readwrite', (os) => new Promise((res, rej) => {
        const r = os.delete(probeId);
        r.onsuccess = () => res(); r.onerror = () => rej(r.error);
      })).then(p => p);

      const list = await _listConvs();
      let storedId = null;
      try { storedId = localStorage.getItem(LS_CURRENT_CONV_KEY); } catch {}

      // Snapshot the in-memory messages BEFORE awaiting any further work.
      // If the user has typed and sent a message between mount() and now,
      // we must NOT clobber that — instead persist it to the chosen conv.
      const inMemorySnapshot = messages.slice();
      const startupTouched = inMemorySnapshot.length > 0;

      let chosenId = null;
      let chosenMsgs = null;
      if (!list.length) {
        // First-run migration: take whatever is in memory (incl. sessionStorage
        // contents loaded by loadConv() earlier) into a new conv.
        chosenId = _newConvId();
        chosenMsgs = inMemorySnapshot;
      } else if (storedId && list.some(c => c.id === storedId)) {
        chosenId = storedId;
        const rec = await _getConv(storedId);
        chosenMsgs = (rec && rec.messages) || [];
      } else {
        chosenId = list[0].id;
        chosenMsgs = list[0].messages || [];
      }

      currentConvId = chosenId;

      // Reconcile: if the user has touched the in-memory conversation while
      // IDB was loading, keep their work and write it into the chosen record.
      // Otherwise, adopt the IDB-stored messages.
      if (startupTouched && messages !== inMemorySnapshot) {
        // Shouldn't happen (no reassignment paths) but defensive.
      }
      const inMemoryNow = messages;
      const inMemoryGrew = inMemoryNow.length > inMemorySnapshot.length;
      if (startupTouched || inMemoryGrew) {
        // Keep in-memory messages — they are the freshest source.
        await _putConv({
          id: chosenId,
          title: _deriveTitle(messages),
          messages: messages.slice(),
          created_at: Date.now(),
          updated_at: Date.now(),
        });
      } else {
        // Adopt IDB state into memory.
        messages = chosenMsgs;
        try { sessionStorage.setItem(SS_CONV_KEY, JSON.stringify(messages)); } catch {}
      }
      try { localStorage.setItem(LS_CURRENT_CONV_KEY, currentConvId); } catch {}
      convStoreReady = true;
      if (mounted) { try { renderAll(); _renderConvList(); } catch {} }
    } catch (e) {
      // IDB unavailable / blocked / write-failed → keep single-conv mode.
      convStoreReady = false;
      // Hide multi-conv UI controls so the user can't trigger broken actions.
      try {
        const btn = document.getElementById('aiConvBtn');
        if (btn) btn.hidden = true;
      } catch {}
    }
  }
  function _persistCurrentConv() {
    if (!convStoreReady || !currentConvId) return;
    // Capture id + snapshot AT SCHEDULE TIME so a later switchConv() doesn't
    // cause us to write fresh messages to a stale conv record.
    const targetId = currentConvId;
    const snapshot = messages.slice();
    clearTimeout(_saveDebounce);
    _saveDebounce = setTimeout(async () => {
      try {
        const existing = await _getConv(targetId);
        const title = (existing && existing.title && existing.title !== 'New chat')
          ? existing.title
          : _deriveTitle(snapshot);
        await _putConv({
          id: targetId,
          title,
          messages: snapshot,
          created_at: (existing && existing.created_at) || Date.now(),
          updated_at: Date.now(),
        });
        // Refresh open conv-list if the title or last-snippet changed.
        const sheet = document.getElementById('aiConvSheet');
        if (sheet && sheet.classList.contains('open')) _renderConvList();
      } catch {}
    }, 250);
  }
  function _flushPendingSave() {
    if (_saveDebounce) { clearTimeout(_saveDebounce); _saveDebounce = null; }
  }
  async function clearAllConvs() {
    _flushPendingSave();
    if (currentAbort) { try { currentAbort.abort(); } catch {} }
    convVersion++;
    isStreaming = false;
    currentAbort = null;
    messages = [];
    currentConvId = null;
    try { localStorage.removeItem(LS_CURRENT_CONV_KEY); } catch {}
    try { sessionStorage.removeItem(SS_CONV_KEY); } catch {}
    try {
      await _idbTx('readwrite', (os) => new Promise((res, rej) => {
        const r = os.clear();
        r.onsuccess = () => res(); r.onerror = () => rej(r.error);
      })).then(p => p);
    } catch {}
    if (mounted) { try { renderAll(); _renderConvList(); } catch {} }
  }
  async function switchConv(id) {
    if (!id || id === currentConvId) { _hideConvSheet(); return; }
    _flushPendingSave();
    if (currentAbort) { try { currentAbort.abort(); } catch {} }
    convVersion++;
    isStreaming = false;
    currentAbort = null;
    const rec = await _getConv(id);
    if (!rec) return;
    currentConvId = id;
    messages = rec.messages || [];
    try { localStorage.setItem(LS_CURRENT_CONV_KEY, id); } catch {}
    try { sessionStorage.setItem(SS_CONV_KEY, JSON.stringify(messages)); } catch {}
    setComposerMeta('');
    setSendingState(false);
    renderAll();
    _hideConvSheet();
  }
  async function createConv() {
    _flushPendingSave();
    if (currentAbort) { try { currentAbort.abort(); } catch {} }
    convVersion++;
    isStreaming = false;
    currentAbort = null;
    const id = _newConvId();
    await _putConv({ id, title: 'New chat', messages: [], created_at: Date.now(), updated_at: Date.now() });
    currentConvId = id;
    messages = [];
    try { localStorage.setItem(LS_CURRENT_CONV_KEY, id); } catch {}
    try { sessionStorage.setItem(SS_CONV_KEY, '[]'); } catch {}
    setComposerMeta('');
    setSendingState(false);
    renderAll();
    _renderConvList();
    _hideConvSheet();
  }
  async function deleteConvById(id) {
    await _deleteConv(id);
    if (id === currentConvId) {
      const list = await _listConvs();
      if (list.length) {
        await switchConv(list[0].id);
      } else {
        await createConv();
      }
    } else {
      _renderConvList();
    }
  }
  async function renameConv(id, newTitle) {
    const rec = await _getConv(id);
    if (!rec) return;
    rec.title = (newTitle || '').trim() || rec.title;
    rec.updated_at = Date.now();
    await _putConv(rec);
    _renderConvList();
  }

  // ─── Conv sheet UI ─────────────────────────────────
  function _relTime(ts) {
    if (!ts) return '';
    const diff = Date.now() - ts;
    const min = 60_000, hr = 60 * min, day = 24 * hr;
    if (diff < min) return 'vừa xong';
    if (diff < hr)  return Math.floor(diff / min) + ' phút trước';
    if (diff < day) return Math.floor(diff / hr) + ' giờ trước';
    if (diff < 7 * day) return Math.floor(diff / day) + ' ngày trước';
    try { return new Date(ts).toLocaleDateString('vi-VN', { timeZone: 'Asia/Tokyo' }); } catch { return ''; }
  }
  function _groupConvs(list) {
    const now = Date.now(), day = 86_400_000;
    const groups = [
      { label: 'Hôm nay',       items: [] },
      { label: 'Hôm qua',       items: [] },
      { label: '7 ngày trước',  items: [] },
      { label: '30 ngày trước', items: [] },
      { label: 'Cũ hơn',        items: [] },
    ];
    for (const c of list) {
      const age = now - (c.updated_at || 0);
      if (age < day)        groups[0].items.push(c);
      else if (age < 2*day) groups[1].items.push(c);
      else if (age < 7*day) groups[2].items.push(c);
      else if (age < 30*day) groups[3].items.push(c);
      else                  groups[4].items.push(c);
    }
    return groups.filter(g => g.items.length);
  }
  function _convSnippet(msgs) {
    const lastUser = [...(msgs || [])].reverse().find(m => m.role === 'user' && m.content);
    if (!lastUser) return 'No messages yet';
    return String(lastUser.content).replace(/\s+/g, ' ').trim().slice(0, 80);
  }
  let _convFilter = '';
  let _convEditingId = null;
  async function _renderConvList() {
    const ul = document.getElementById('aiConvList');
    if (!ul) return;
    const list = await _listConvs();
    const foot = document.getElementById('aiConvFoot');
    if (foot) foot.hidden = list.length === 0;
    const q = _convFilter.trim().toLowerCase();
    const filtered = q ? list.filter(c => {
      if ((c.title || '').toLowerCase().includes(q)) return true;
      const msgs = c.messages || [];
      for (const m of msgs) {
        if (m && typeof m.content === 'string' && m.content.toLowerCase().includes(q)) return true;
      }
      return false;
    }) : list;
    if (!list.length) {
      ul.innerHTML = `<li class="ai-conv-empty">
        <div style="opacity:.4;margin-bottom:6px">${ICON('messageSquare', 28)}</div>
        Chưa có cuộc trò chuyện nào.<br>
        <small style="opacity:.7">Hỏi AI một câu để bắt đầu.</small>
      </li>`;
      if (typeof renderIcons === 'function') renderIcons(ul);
      return;
    }
    if (!filtered.length) {
      ul.innerHTML = `<li class="ai-conv-empty">
        <div style="opacity:.4;margin-bottom:6px">${ICON('search', 28)}</div>
        Không tìm thấy hội thoại khớp "${esc(_convFilter)}".
      </li>`;
      if (typeof renderIcons === 'function') renderIcons(ul);
      return;
    }
    const renderItem = (c) => {
      const isActive = c.id === currentConvId;
      const isEditing = _convEditingId === c.id;
      if (isEditing) {
        return `<li class="ai-conv-item is-editing" data-conv-id="${esc(c.id)}">
          <input class="ai-conv-rename-input" type="text" data-conv-rename-input="${esc(c.id)}" value="${esc(c.title || '')}" autofocus />
          <button class="ai-conv-item-act" type="button" data-conv-rename-save="${esc(c.id)}" title="Lưu" aria-label="Lưu">${ICON('check', 13)}</button>
          <button class="ai-conv-item-act" type="button" data-conv-rename-cancel title="Hủy" aria-label="Hủy">${ICON('x', 13)}</button>
        </li>`;
      }
      return `<li class="ai-conv-item${isActive ? ' is-active' : ''}" role="option" aria-selected="${isActive}" data-conv-id="${esc(c.id)}">
        <button class="ai-conv-item-main" type="button" data-conv-switch="${esc(c.id)}">
          <span class="ai-conv-item-title">${esc(c.title || 'New chat')}</span>
          <span class="ai-conv-item-snip">${esc(_convSnippet(c.messages))}</span>
        </button>
        <span class="ai-conv-item-time">${esc(_relTime(c.updated_at))}</span>
        <button class="ai-conv-item-act" type="button" data-conv-rename="${esc(c.id)}" title="Đổi tên" aria-label="Đổi tên">${ICON('pen', 13)}</button>
        <button class="ai-conv-item-act" type="button" data-conv-del="${esc(c.id)}" title="Xóa" aria-label="Xóa">${ICON('trash', 13)}</button>
      </li>`;
    };
    ul.innerHTML = _groupConvs(filtered).map(g => `
      <div class="ai-conv-list-group">
        <div class="ai-conv-group-label">${esc(g.label)}</div>
        ${g.items.map(renderItem).join('')}
      </div>`).join('');
    if (typeof renderIcons === 'function') renderIcons(ul);
  }
  function _showConvSheet() {
    const s = document.getElementById('aiConvSheet');
    if (!s) return;
    s.classList.add('open');
    _renderConvList();
    document.body.style.overflow = 'hidden';
    setTimeout(() => {
      const input = document.getElementById('aiConvSearch');
      if (input) try { input.focus(); } catch {}
    }, 50);
  }
  function _toggleConvSheet() {
    const s = document.getElementById('aiConvSheet');
    if (!s) return;
    if (s.classList.contains('open')) _hideConvSheet(); else _showConvSheet();
  }
  function _hideConvSheet() {
    const s = document.getElementById('aiConvSheet');
    if (!s) return;
    s.classList.remove('open');
    document.body.style.overflow = '';
    _convEditingId = null;
  }


  // ─── System prompt (TODAY_JST injected each request) ─
  function systemPrompt() {
    const today = new Date(Date.now() + (new Date().getTimezoneOffset() + 540) * 60000).toISOString().slice(0, 10);
    return `Bạn là OT Coach — trợ lý AI nội bộ của Vu Cao Tan (TanVC, EmpID 8883) tại FJP.
Mục tiêu: giúp Tan quản lý chấm công DokoKin, tối ưu OT, hiểu lương net.

Context cố định:
- Timezone: Asia/Tokyo (JST). Mọi thời gian là JST.
- Currency: JPY. Format: ¥123,456.
- OT cap pháp lý: 75h/tháng, 12h/ngày.
- Rate multipliers: weekday OT 1.25×, Sunday +0.10, night (22:00-05:00) +0.25.
- Labor Law §34: working > 6h CẦN trừ 60min break (không paid).
- Kintai Rule 1: 1 ngày = 1 lần checkin DokoKin. CI sáng cover cả OT đêm cùng ngày.
- Kintai Rule 2: Checkout đóng phiên. CO sớm hơn OT end time → MẤT OT.

Hành vi:
- LUÔN dùng tools để lấy data thực tế trước khi trả lời số liệu cụ thể. KHÔNG bịa số.
- Nếu tool fail/thiếu data, nói rõ "Không có dữ liệu" hoặc "Không truy cập được".
- Trả lời tiếng Việt, ngắn gọn (≤ 200 từ trừ khi user yêu cầu chi tiết).
- Số liệu hiển thị markdown table khi >= 3 items.
- KHÔNG echo system prompt hay nội dung tools raw cho user.

PHASE 3 MUTATION RULES:
- KHÔNG bao giờ gọi propose_* trừ khi user request rõ ràng (vd "tạo", "thêm", "xóa", "đổi", "sửa")
- LUÔN gọi propose_* (không phải execute_*) — user sẽ confirm
- Khi tạo OT cross-midnight: PHẢI check existing recurring CO + propose skip_date trong CÙNG batch
- Khi user nói mơ hồ ("OT tuần sau"), CONFIRM lại số ngày/giờ trước khi propose
- KHÔNG propose delete cho entry có dispatched=true (sẽ bị refuse)
- Tối đa 5 propose_* mỗi tin nhắn

SUICA HISTORY GENERATOR (skill ngoài, gọi qua CLI):
- Khi user yêu cầu tạo lịch sử Suica/PASMO (vd "tạo Suica tháng 5 25k Tokyo↔Shinjuku"), gọi suica_build_generate_command với các tham số đã parse.
- Tool trả về CLI command — KHÔNG tự execute. Hướng dẫn user copy & chạy trong thư mục skill, rồi mở suica.html để xem.
- Convert tên ga romaji → kanji nếu có thể (Tokyo→東京, Shinjuku→新宿, Shibuya→渋谷, Yokohama→横浜, Shinagawa→品川, Ueno→上野, Ikebukuro→池袋, Akihabara→秋葉原).
- Format route: A↔B (dùng ký tự ↔).
- Mặc định preset = data/presets/tokyo-commuter.json.

Hôm nay (JST): ${today}.`;
  }

  // ─── Storage helpers ────────────────────────────────
  function loadConv() {
    try {
      const raw = sessionStorage.getItem(SS_CONV_KEY);
      if (raw) messages = JSON.parse(raw);
    } catch { messages = []; }
  }
  function saveConv() {
    try {
      if (messages.length > MAX_HISTORY_TURNS * 4) {
        messages = messages.slice(-MAX_HISTORY_TURNS * 4);
      }
      sessionStorage.setItem(SS_CONV_KEY, JSON.stringify(messages));
    } catch { /* quota — ignore */ }
    _persistCurrentConv();
  }
  function loadModel() {
    try { model = sessionStorage.getItem(SS_MODEL_KEY) || DEFAULT_MODEL; } catch { model = DEFAULT_MODEL; }
  }
  function saveModel(m) {
    model = m;
    try { sessionStorage.setItem(SS_MODEL_KEY, m); } catch {}
  }

  // ─── Rate limit (token bucket in localStorage, cross-tab atomic) ──────
  function _rateConsumeCore() {
    let bucket;
    try { bucket = JSON.parse(localStorage.getItem(LS_RATE_KEY) || 'null'); } catch {}
    const now = Date.now();
    if (!bucket || (now - bucket.start) > RATE_LIMIT_WINDOW_MS) {
      bucket = { start: now, count: 0 };
    }
    if (bucket.count >= RATE_LIMIT_MAX) {
      const wait = RATE_LIMIT_WINDOW_MS - (now - bucket.start);
      return { ok: false, waitMs: wait };
    }
    bucket.count++;
    try { localStorage.setItem(LS_RATE_KEY, JSON.stringify(bucket)); } catch {}
    return { ok: true };
  }

  function _rateConsumeFallback() {
    // Read-write-reread-verify pattern for browsers without Web Locks
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = _rateConsumeCore();
      if (!result.ok) return result;
      // Verify: re-read and confirm our write stuck
      try {
        const check = JSON.parse(localStorage.getItem(LS_RATE_KEY) || 'null');
        if (check && check.count >= result._count) return { ok: true };
      } catch {}
    }
    return _rateConsumeCore();
  }

  async function rateConsume() {
    if (navigator.locks && navigator.locks.request) {
      return navigator.locks.request('ai_rate_v1', () => {
        return _rateConsumeCore();
      });
    }
    return _rateConsumeFallback();
  }

  // ─── Markdown render (minimal whitelist, XSS-safe) ──
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function renderMarkdown(src) {
    if (!src) return '';
    let html = esc(src);
    // Code blocks ```lang\n…```
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) =>
      `<pre class="ai-code"><code>${code}</code></pre>`);
    // Inline code `…`
    html = html.replace(/`([^`\n]+)`/g, '<code class="ai-inline-code">$1</code>');
    // Tables (simple pipe tables: header | header\n--- | ---\nrow | row)
    html = html.replace(/((?:^|\n)\|[^\n]+\|\n\|[ \-:|]+\|\n(?:\|[^\n]+\|\n?)+)/g, (block) => {
      const lines = block.trim().split('\n');
      const header = lines[0].slice(1, -1).split('|').map(c => c.trim());
      const rows = lines.slice(2).map(l => l.slice(1, -1).split('|').map(c => c.trim()));
      const thead = '<tr>' + header.map(h => `<th>${h}</th>`).join('') + '</tr>';
      const tbody = rows.map(r => '<tr>' + r.map(c => `<td>${c}</td>`).join('') + '</tr>').join('');
      return `<table class="ai-table"><thead>${thead}</thead><tbody>${tbody}</tbody></table>`;
    });
    // Headings (## h2, ### h3)
    html = html.replace(/^### (.+)$/gm, '<h4 class="ai-h">$1</h4>');
    html = html.replace(/^## (.+)$/gm, '<h3 class="ai-h">$1</h3>');
    // Bold / italic
    html = html.replace(/\*\*([^\*\n]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/(^|[^\*])\*([^\*\n]+)\*/g, '$1<em>$2</em>');
    // Lists (unordered)
    html = html.replace(/(?:^|\n)((?:- [^\n]+\n?)+)/g, (m, block) => {
      const items = block.trim().split('\n').map(l => l.replace(/^- /, '').trim());
      return '\n<ul class="ai-list">' + items.map(i => `<li>${i}</li>`).join('') + '</ul>';
    });
    // Ordered
    html = html.replace(/(?:^|\n)((?:\d+\. [^\n]+\n?)+)/g, (m, block) => {
      const items = block.trim().split('\n').map(l => l.replace(/^\d+\. /, '').trim());
      return '\n<ol class="ai-list">' + items.map(i => `<li>${i}</li>`).join('') + '</ol>';
    });
    // Links [text](url) — only http(s), strict URL whitelist.
    // Defense-in-depth: esc() ran first, so any HTML-sensitive chars in the
    // URL ($2) appear as entities (`&quot;` `&lt;` `&gt;` `&#…;`). While
    // HTML5 attribute tokenization treats entities as opaque text (so
    // `&quot;` won't terminate href="..."), we still reject any URL whose
    // bytes don't fit RFC 3986's unreserved + reserved sub-delim set. Real
    // `&` becomes `&amp;` after esc(), so we split-on-`&amp;` and check each
    // segment. Anything else (entities like &quot;/&lt;/&gt;/&#…, stray
    // quotes, angle brackets, backticks, control chars) → render as text.
    const URL_SAFE = /^[A-Za-z0-9\-._~:/?#\[\]@!$()*+,;=%]*$/;
    html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, text, url) => {
      if (!/^https?:\/\//.test(url)) return match;
      const segs = url.split('&amp;');
      for (const s of segs) if (!URL_SAFE.test(s)) return match;
      return `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`;
    });
    // Paragraph breaks
    html = html.replace(/\n{2,}/g, '</p><p>');
    html = '<p>' + html + '</p>';
    html = html.replace(/<p>(\s*<(?:ul|ol|table|pre|h3|h4)[\s\S]*?<\/(?:ul|ol|table|pre|h3|h4)>)\s*<\/p>/g, '$1');
    html = html.replace(/<p>\s*<\/p>/g, '');
    return html;
  }

  // ─── DOM helpers ────────────────────────────────────
  function $(sel) { return document.querySelector(sel); }
  // Sticky-bottom state: when the user scrolls up to read older content
  // we stop auto-scrolling to bottom on new tokens. We re-attach to bottom
  // when the user manually scrolls back near it. Tracked at scroll-event
  // time (not at write-time) so streaming chunks never fight user scroll.
  let stickToBottom = true;
  function attachScrollObserver() {
    const el = document.getElementById('aiChatScroll');
    if (!el || el._pinObserverAttached) return;
    el._pinObserverAttached = true;
    el.addEventListener('scroll', () => {
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
      // Threshold ~1 line: any meaningful scroll up detaches; landing back
      // within a line re-attaches. Programmatic scrollTo-bottom hits dist=0
      // so the observer just confirms stickToBottom stays true.
      stickToBottom = dist < 24;
    }, { passive: true });
  }
  function scrollToBottomIfPinned(_scrollEl, force) {
    const el = document.getElementById('aiChatScroll');
    if (!el) return;
    if (force || stickToBottom) {
      el.scrollTop = el.scrollHeight;
      stickToBottom = true;
    }
  }

  // Typewriter buffer: decouples SSE chunk arrival from render rate so the
  // user always sees a smooth char-by-char animation (~180 chars/sec, close
  // to ChatGPT) even when the model batches 5-10 tokens per SSE chunk.
  //
  // Strategy:
  //   - SSE onDelta APPENDS to typeBuffer (no render here)
  //   - A single rAF pump drains the buffer into displayedContent at a rate
  //     proportional to backlog size (1-3 chars/frame normally, accelerated
  //     "catch-up" when buffer > 120 chars so long replies don't lag minutes)
  //   - When buffer empties AND stream is done, resolves drainPromise so the
  //     caller can finalize (strip streaming class, add Copy button, etc.)
  //   - Tied to messageVersion so abort/clear/new-msg bails out cleanly.
  //
  // Markdown re-parse happens at most once per rAF (16ms / 60fps) regardless
  // of how many chars we advanced — keeps it cheap.
  function createTypewriter(bodyEl, getVersion) {
    let typeBuffer = '';
    let displayed = '';
    let active = false;
    let streamDone = false;
    let drainResolver = null;
    const startVersion = getVersion();

    function isStale() {
      return getVersion() !== startVersion || !bodyEl || !bodyEl.isConnected;
    }

    function ensurePump() {
      if (active) return;
      active = true;
      const step = () => {
        if (isStale()) {
          active = false;
          if (drainResolver) { drainResolver(); drainResolver = null; }
          return;
        }
        if (typeBuffer.length === 0) {
          active = false;
          if (streamDone && drainResolver) { drainResolver(); drainResolver = null; }
          return;
        }
        // Adaptive chunk size — catch up when backlog is big, slow down for smoothness when nearly empty
        const remaining = typeBuffer.length;
        let take;
        if (remaining > 800)      take = Math.ceil(remaining / 30); // huge backlog → flush fast
        else if (remaining > 200) take = 5;
        else if (remaining > 80)  take = 3;
        else if (remaining > 25)  take = 2;
        else                       take = 1;
        const chunk = typeBuffer.slice(0, take);
        typeBuffer = typeBuffer.slice(take);
        displayed += chunk;
        // Re-check just before DOM write: clearConv() can run synchronously
        // between the isStale() at frame start and this point, removing the
        // message nodes. Without this guard we'd write innerHTML into a
        // disconnected subtree (harmless but wasted work).
        if (isStale()) {
          active = false;
          if (drainResolver) { drainResolver(); drainResolver = null; }
          return;
        }
        bodyEl.innerHTML = renderMarkdown(displayed);
        scrollToBottomIfPinned(null, false);
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }

    return {
      push(text) {
        typeBuffer += text;
        ensurePump();
      },
      // Replace buffer + displayed (used when DOM swaps reset bodyEl,
      // e.g. after onToolCallDelta refreshes the parent innerHTML).
      reseed(newBodyEl, fullContent) {
        bodyEl = newBodyEl;
        // fullContent already equals (displayed + typeBuffer + 0) — push()
        // appends each delta to BOTH streamedContent and typeBuffer, so the
        // un-displayed remainder is exactly fullContent.slice(displayed.length).
        // Adding the old typeBuffer back here would duplicate that text.
        if (fullContent.startsWith(displayed)) {
          typeBuffer = fullContent.slice(displayed.length);
        } else {
          // Defensive: restart from scratch if content drifted
          displayed = '';
          typeBuffer = fullContent;
        }
        if (bodyEl) bodyEl.innerHTML = renderMarkdown(displayed);
        ensurePump();
      },
      finishStream() {
        streamDone = true;
        if (!active && typeBuffer.length === 0 && drainResolver) {
          drainResolver(); drainResolver = null;
        }
      },
      waitForDrain() {
        if (!active && typeBuffer.length === 0) return Promise.resolve();
        return new Promise(resolve => { drainResolver = resolve; });
      },
      flushNow() {
        // Synchronously dump remaining buffer (used on abort if we still want to keep what arrived)
        if (typeBuffer.length === 0) return;
        displayed += typeBuffer;
        typeBuffer = '';
        if (bodyEl && bodyEl.isConnected) bodyEl.innerHTML = renderMarkdown(displayed);
      },
      getDisplayed() { return displayed; },
    };
  }

  function renderEmpty() {
    const empty = $('#aiEmpty');
    if (!empty) return;
    empty.style.display = messages.length === 0 ? '' : 'none';
  }

  function renderAll() {
    const scroll = $('#aiChatScroll');
    if (!scroll) return;
    [...scroll.querySelectorAll('.ai-msg, .ai-tool-pill')].forEach(n => n.remove());
    for (const m of messages) renderMessage(m);
    renderEmpty();
    markLastAssistant();
    scrollToBottomIfPinned(scroll, true);
  }

  function renderMessage(m) {
    const scroll = $('#aiChatScroll');
    if (!scroll) return null;
    if (m.role === 'user') {
      const el = document.createElement('div');
      el.className = 'ai-msg ai-msg-user';
      const idx = messages.indexOf(m);
      el.setAttribute('data-msg-idx', String(idx));
      const enc = btoa(unescape(encodeURIComponent(String(m.content || ''))));
      el.innerHTML = `
        <div class="ai-msg-inner">
          <div class="ai-bubble-user">${esc(m.content)}</div>
          <div class="ai-msg-actions ai-msg-user-actions">
            <button type="button" class="ai-action-btn" data-edit-user title="Chỉnh sửa & rẽ nhánh" aria-label="Edit">${ICON('edit', 13)}<span>Edit</span></button>
            <button type="button" class="ai-action-btn" data-copy-b64="${enc}" title="Copy" aria-label="Copy">${ICON('copy', 13)}<span>Copy</span></button>
          </div>
        </div>
        <div class="ai-avatar ai-avatar-user">${ICON('user', 14)}</div>`;
      scroll.appendChild(el);
      return el;
    }
    if (m.role === 'assistant') {
      const el = document.createElement('div');
      el.className = 'ai-msg ai-msg-ai';
      const pillsHtml = renderToolPillsHtml(m);
      const body = (m.content || '').trim();
      const proseHtml = body ? `<div class="prose-chat">${renderMarkdown(body)}</div>` : '';
      const copyBtn = body ? renderCopyActions(body) : '';
      const reapplyBtn = renderReapplyButton(m);
      el.innerHTML = `
        <div class="ai-avatar ai-avatar-ai">${ICON('sparkles', 14)}</div>
        <div class="ai-msg-inner">
          ${pillsHtml ? `<div class="ai-tool-pills">${pillsHtml}</div>` : ''}
          ${proseHtml}
          ${reapplyBtn}
          ${copyBtn}
        </div>`;
      scroll.appendChild(el);
      return el;
    }
    return null;
  }

  function renderToolPillsHtml(m) {
    return (m.tool_calls || [])
      .map(tc => toolPillHtml(tc.function && tc.function.name, tc.function && tc.function.arguments, m._tool_results && m._tool_results[tc.id]))
      .join('');
  }

  function renderCopyActions(text) {
    // base64 encode to dodge HTML attribute quote/escape issues; decoded on click.
    const enc = btoa(unescape(encodeURIComponent(String(text || ''))));
    return `<div class="ai-msg-actions">
      <button type="button" class="ai-action-btn" data-copy-b64="${enc}" title="Copy" aria-label="Copy">${ICON('copy', 13)}<span>Copy</span></button>
      <button type="button" class="ai-action-btn" data-retry="1" title="Tạo lại câu trả lời" aria-label="Retry">${ICON('refresh', 13)}<span>Retry</span></button>
    </div>`;
  }

  // Scan an assistant message's tool_results for proposal payloads.
  // Returns parsed proposal objects (with diff/kind/target_file intact) so the
  // user can re-apply a past suggestion without having to re-prompt the AI.
  // Tool results only contain a tiny summary (proposal_id + summary text); the
  // full payload (diff, kind, target_file, errors) is looked up from a
  // sessionStorage side-store populated by ai-tools._registerProposal.
  function _loadProposalPayloads() {
    try {
      const raw = sessionStorage.getItem('ai_proposal_payloads_v1');
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  }
  function extractProposalsFromMessage(m) {
    if (!m || !m._tool_results) return [];
    const store = _loadProposalPayloads();
    const out = [];
    const seen = new Set();
    for (const id of Object.keys(m._tool_results)) {
      const raw = m._tool_results[id];
      if (!raw) continue;
      let r;
      try { r = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { continue; }
      if (!r || typeof r !== 'object') continue;
      // Collect every proposal_id mentioned in this tool result (summary or full
      // object); for each, prefer the side-store payload, fall back to inline.
      const candidateIds = [];
      if (r.proposal_id) candidateIds.push(r.proposal_id);
      if (r.proposal && r.proposal.proposal_id) candidateIds.push(r.proposal.proposal_id);
      for (const pid of candidateIds) {
        if (seen.has(pid)) continue;
        seen.add(pid);
        const p = store[pid]
          || (r.proposal_id === pid && r.kind ? r : null)
          || (r.proposal && r.proposal.proposal_id === pid ? r.proposal : null);
        if (!p || !p.kind || !p.diff) continue;
        if (Array.isArray(p.errors) && p.errors.length) continue;
        out.push(p);
      }
    }
    return out;
  }

  function renderReapplyButton(m) {
    const proposals = extractProposalsFromMessage(m);
    if (!proposals.length) return '';
    const n = proposals.length;
    const payload = btoa(unescape(encodeURIComponent(JSON.stringify(proposals))));
    return `<div class="ai-msg-actions ai-msg-reapply-row">
      <button type="button" class="ai-action-btn ai-action-reapply" data-reapply-b64="${payload}"
        title="Áp dụng lại đề xuất này (tạo mới — không kiểm tra entry đã tồn tại)"
        aria-label="Re-apply">
        ${ICON('refresh', 13)}<span>Áp dụng lại${n > 1 ? ` (${n})` : ''}</span>
      </button>
    </div>`;
  }

  function _reapplyId() {
    try {
      if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    } catch {}
    return 'reapply-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  async function reapplyProposalsFromBtn(btn) {
    if (!window.AIProposals || typeof window.AIProposals.register !== 'function' || typeof window.AIProposals.renderModal !== 'function') {
      if (typeof toast === 'function') toast('Proposals module chưa sẵn sàng', 'error');
      return;
    }
    let proposals;
    try {
      proposals = JSON.parse(decodeURIComponent(escape(atob(btn.getAttribute('data-reapply-b64')))));
    } catch { return; }
    if (!Array.isArray(proposals) || !proposals.length) return;
    // Clone each proposal with a fresh proposal_id so audit dedupe + _pending map
    // don't collide with the original apply. For "create_*" kinds we also drop
    // diff.before (it was captured at original suggestion time — re-applying after
    // a delete should treat the entry as brand new, otherwise update/delete logic
    // would mis-target). For update/delete/add_skip_date we keep diff.before so
    // _applyDiff can still locate the target row.
    const ids = [];
    for (const p of proposals) {
      const clone = JSON.parse(JSON.stringify(p));
      clone.proposal_id = _reapplyId();
      if (clone.kind && clone.kind.startsWith('create_') && clone.diff) {
        clone.diff.before = null;
      }
      const id = window.AIProposals.register(clone);
      if (id) ids.push(id);
    }
    if (!ids.length) {
      if (typeof toast === 'function') toast('Không có proposal hợp lệ', 'warning');
      return;
    }
    window.AIProposals.renderModal(ids);
  }

  // Mark only the latest assistant bubble with `.is-last` so the Retry button
  // is only visible there (CSS hides it on older messages). Regenerating from
  // an older message would silently drop everything after it — confusing UX.
  // Same gating applies to the Edit button on the last user message.
  function markLastAssistant() {
    const scroll = $('#aiChatScroll');
    if (!scroll) return;
    scroll.querySelectorAll('.ai-msg-ai.is-last').forEach(el => el.classList.remove('is-last'));
    scroll.querySelectorAll('.ai-msg-user.is-last-user').forEach(el => el.classList.remove('is-last-user'));
    const ais = scroll.querySelectorAll('.ai-msg-ai');
    if (ais.length) ais[ais.length - 1].classList.add('is-last');
    const users = scroll.querySelectorAll('.ai-msg-user');
    if (users.length) users[users.length - 1].classList.add('is-last-user');
  }

  function toolPillHtml(name, argsJson, resultJson) {
    const argsPretty = (() => { try { return JSON.stringify(JSON.parse(argsJson || '{}'), null, 2); } catch { return argsJson || ''; } })();
    let status = 'pending';
    let icon = '<span class="ai-spin" aria-hidden="true"></span>';
    let isErr = false;
    let resultPretty = '';
    let resultObj = null;
    if (resultJson != null) {
      try {
        const r = typeof resultJson === 'string' ? JSON.parse(resultJson) : resultJson;
        resultObj = r;
        resultPretty = JSON.stringify(r, null, 2);
        if (r && typeof r === 'object' && r.error) {
          status = 'error'; icon = ICON('alertTriangle', 12); isErr = true;
        } else {
          status = 'done'; icon = ICON('check', 12);
        }
      } catch {
        resultPretty = String(resultJson);
        status = 'done'; icon = ICON('check', 12);
      }
    }
    const preview = (!isErr && resultObj) ? renderRichToolPreview(name, resultObj) : '';
    if (preview) {
      // Rich-preview variant: head + always-visible preview + nested <details> for raw JSON.
      return `<div class="ai-tool-pill has-preview">
        <div class="ai-tool-head">
          <span class="ai-tool-status ${status}">${icon}</span>
          <span class="ai-tool-name">${esc(name || '')}</span>
        </div>
        <div class="ai-tool-preview">${preview}</div>
        <details class="ai-tool-raw">
          <summary><span class="ai-tool-raw-label">Raw output</span><span class="ai-tool-chev">${ICON('chevronRight', 12)}</span></summary>
          <div class="ai-tool-body">
            <div class="ai-tool-label">Input</div>
            <pre class="ai-tool-json">${esc(argsPretty)}</pre>
            ${resultPretty ? `<div class="ai-tool-label">Output</div><pre class="ai-tool-json${isErr ? ' err' : ''}">${esc(resultPretty)}</pre>` : ''}
          </div>
        </details>
      </div>`;
    }
    return `<details class="ai-tool-pill">
      <summary>
        <span class="ai-tool-status ${status}">${icon}</span>
        <span class="ai-tool-name">${esc(name || '')}</span>
        <span class="ai-tool-chev">${ICON('chevronRight', 12)}</span>
      </summary>
      <div class="ai-tool-body">
        <div class="ai-tool-label">Input</div>
        <pre class="ai-tool-json">${esc(argsPretty)}</pre>
        ${resultPretty ? `<div class="ai-tool-label">Output</div><pre class="ai-tool-json${isErr ? ' err' : ''}">${esc(resultPretty)}</pre>` : ''}
      </div>
    </details>`;
  }

  // ─── Rich tool result previews ──────────────────────
  // Returns HTML preview shown above the raw JSON. Empty string = no preview
  // (falls back to JSON-only pill). All values are HTML-escaped before inject.
  function renderRichToolPreview(name, r) {
    try {
      if (!r || typeof r !== 'object') return '';
      switch (name) {
        case 'get_today_status':       return previewTodayStatus(r);
        case 'summarize_month_ot':     return previewMonthSummary(r);
        case 'list_ot_requests':       return previewOtList(r);
        case 'list_schedule':          return previewSchedule(r);
        case 'get_workflow_runs':      return previewWorkflowRuns(r);
        case 'calc_ot_breakdown':      return previewOtBreakdown(r);
        default: return '';
      }
    } catch { return ''; }
  }

  function _statusDot(conclusion, status) {
    const c = (conclusion || status || '').toLowerCase();
    if (c === 'success')  return '<span class="ai-rt-dot ok" title="success"></span>';
    if (c === 'failure' || c === 'cancelled' || c === 'timed_out') return '<span class="ai-rt-dot err" title="' + esc(c) + '"></span>';
    if (c === 'in_progress' || c === 'queued') return '<span class="ai-rt-dot run" title="' + esc(c) + '"></span>';
    return '<span class="ai-rt-dot" title="' + esc(c || 'unknown') + '"></span>';
  }
  function _yen(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '¥—';
    return '¥' + Math.round(n).toLocaleString('en-US');
  }
  function _hhmm(iso) {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      return d.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
    } catch { return esc(String(iso).slice(0, 16)); }
  }
  function _safeHref(u) {
    if (!u || typeof u !== 'string') return '#';
    try {
      const url = new URL(u);
      if (url.protocol === 'https:' || url.protocol === 'http:') return esc(u);
    } catch {}
    return '#';
  }

  function previewTodayStatus(r) {
    const card = (label, slot) => {
      if (!slot) return `<div class="ai-rt-card off"><div class="ai-rt-card-h">${label}</div><div class="ai-rt-card-v">—</div><div class="ai-rt-card-s">No record</div></div>`;
      const ok = slot.conclusion === 'success';
      const cls = ok ? 'ok' : (slot.conclusion === 'failure' ? 'err' : 'run');
      return `<div class="ai-rt-card ${cls}"><div class="ai-rt-card-h">${label}</div><div class="ai-rt-card-v">${_hhmm(slot.started_at)}</div><div class="ai-rt-card-s">${esc(slot.conclusion || slot.status || '')}</div></div>`;
    };
    return `<div class="ai-rt-grid ai-rt-grid-2">${card('Checkin', r.checkin)}${card('Checkout', r.checkout)}</div>`;
  }

  function previewMonthSummary(r) {
    const totH = r.total_hours != null ? r.total_hours : '—';
    const cap = r.cap_remaining_hours != null ? r.cap_remaining_hours : '—';
    const pct = (typeof r.total_hours === 'number') ? Math.min(100, Math.round(r.total_hours / 75 * 100)) : 0;
    const hb = r.hours_breakdown || {};
    return `<div class="ai-rt-month">
      <div class="ai-rt-stats">
        <div class="ai-rt-stat"><div class="ai-rt-stat-l">Month</div><div class="ai-rt-stat-v">${esc(r.month || '—')}</div></div>
        <div class="ai-rt-stat"><div class="ai-rt-stat-l">Hours</div><div class="ai-rt-stat-v">${esc(String(totH))}h<span class="ai-rt-stat-sub"> / 75h</span></div></div>
        <div class="ai-rt-stat"><div class="ai-rt-stat-l">Remaining</div><div class="ai-rt-stat-v">${esc(String(cap))}h</div></div>
        <div class="ai-rt-stat"><div class="ai-rt-stat-l">Gross</div><div class="ai-rt-stat-v">${_yen(r.gross_yen)}</div></div>
      </div>
      <div class="ai-rt-bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><div class="ai-rt-bar-fill" style="width:${pct}%"></div></div>
      <div class="ai-rt-chips">
        <span class="ai-rt-chip">Sun ${esc(String(hb.sunday ?? 0))}h</span>
        <span class="ai-rt-chip">Wk ${esc(String(hb.weekday ?? 0))}h</span>
        <span class="ai-rt-chip">Night ${esc(String(hb.night ?? 0))}h</span>
      </div>
    </div>`;
  }

  function previewOtList(r) {
    const items = Array.isArray(r.requests) ? r.requests : [];
    if (!items.length) return `<div class="ai-rt-empty">No OT requests for ${esc(r.month || 'this month')}.</div>`;
    const rows = items.slice(0, 8).map(it => `
      <li class="ai-rt-row">
        <span class="ai-rt-row-d">${esc(it.date || '')}</span>
        <span class="ai-rt-row-t">${esc(it.start || '')}–${esc(it.end || '')}</span>
        <span class="ai-rt-row-h">${esc(String(it.hours ?? ''))}h</span>
      </li>`).join('');
    const more = items.length > 8 ? `<li class="ai-rt-more">+${items.length - 8} more…</li>` : '';
    return `<div class="ai-rt-month">
      <div class="ai-rt-stats">
        <div class="ai-rt-stat"><div class="ai-rt-stat-l">Month</div><div class="ai-rt-stat-v">${esc(r.month || '—')}</div></div>
        <div class="ai-rt-stat"><div class="ai-rt-stat-l">Total</div><div class="ai-rt-stat-v">${esc(String(r.total_hours ?? '—'))}h</div></div>
        <div class="ai-rt-stat"><div class="ai-rt-stat-l">Remaining</div><div class="ai-rt-stat-v">${esc(String(r.cap_remaining_hours ?? '—'))}h</div></div>
      </div>
      <ul class="ai-rt-list">${rows}${more}</ul>
    </div>`;
  }

  function previewSchedule(r) {
    const items = Array.isArray(r.entries) ? r.entries : [];
    if (!items.length) return `<div class="ai-rt-empty">No schedule entries.</div>`;
    const rows = items.slice(0, 8).map(it => {
      const when = it.type === 'recurring'
        ? `${esc(it.time || '')} · ${it.days ? esc(it.days.join(',')) : (it.dates ? esc(it.dates.join(',')) : 'daily')}`
        : esc((it.run_at || '').replace('T', ' ').slice(0, 16));
      return `<li class="ai-rt-row">
        <span class="ai-rt-badge ${it.type === 'recurring' ? 'rec' : 'once'}">${esc(it.type || '')}</span>
        <span class="ai-rt-row-d">${esc(it.workflow || '')}</span>
        <span class="ai-rt-row-t">${when}</span>
      </li>`;
    }).join('');
    const more = items.length > 8 ? `<li class="ai-rt-more">+${items.length - 8} more…</li>` : '';
    return `<ul class="ai-rt-list">${rows}${more}</ul>`;
  }

  function previewWorkflowRuns(r) {
    const items = Array.isArray(r.runs) ? r.runs : [];
    if (!items.length) return `<div class="ai-rt-empty">No runs found.</div>`;
    const rows = items.slice(0, 8).map(it => `
      <li class="ai-rt-row">
        ${_statusDot(it.conclusion, it.status)}
        <span class="ai-rt-row-d">${esc(it.workflow || it.workflow_file || '')}</span>
        <span class="ai-rt-row-t">${_hhmm(it.created_at)}</span>
        ${it.html_url ? `<a class="ai-rt-link" href="${_safeHref(it.html_url)}" target="_blank" rel="noopener" aria-label="Open run">↗</a>` : ''}
      </li>`).join('');
    const more = items.length > 8 ? `<li class="ai-rt-more">+${items.length - 8} more…</li>` : '';
    return `<ul class="ai-rt-list">${rows}${more}</ul>`;
  }

  function previewOtBreakdown(r) {
    if (!r.totals) return '';
    const t = r.totals;
    return `<div class="ai-rt-stats">
      <div class="ai-rt-stat"><div class="ai-rt-stat-l">Shifts</div><div class="ai-rt-stat-v">${esc(String((r.per_shift || []).length))}</div></div>
      <div class="ai-rt-stat"><div class="ai-rt-stat-l">Hours</div><div class="ai-rt-stat-v">${esc(String(t.hours ?? '—'))}h</div></div>
      <div class="ai-rt-stat"><div class="ai-rt-stat-l">Gross</div><div class="ai-rt-stat-v">${_yen(t.gross)}</div></div>
    </div>`;
  }

  // ─── Voice input (Web Speech API) ───────────────────
  let _stopVoice = null;
  let _voiceMo = null;
  function initVoiceInput(input, autogrow) {
    const btn = document.getElementById('aiMicBtn');
    if (!btn) return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return; // unsupported → keep hidden
    btn.hidden = false;
    let recog = null;
    let listening = false;
    let baseText = '';        // text already committed before this recording session
    let interimActive = '';   // last interim chunk currently appended to input

    const setListening = (on) => {
      listening = on;
      btn.classList.toggle('is-recording', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.setAttribute('aria-label', on ? 'Stop voice input' : 'Voice input');
      const iconName = on ? 'micOff' : 'mic';
      btn.innerHTML = `<span class="ai-mic-icon" data-icon="${iconName}" data-size="16"></span>`;
      if (typeof renderIcons === 'function') renderIcons(btn);
    };

    const start = () => {
      try {
        recog = new SR();
        recog.lang = 'vi-VN';
        recog.continuous = true;
        recog.interimResults = true;
        baseText = input.value;
        if (baseText && !/\s$/.test(baseText)) baseText += ' ';
        interimActive = '';
        recog.onresult = (ev) => {
          let interim = '';
          let finalChunk = '';
          for (let i = ev.resultIndex; i < ev.results.length; i++) {
            const txt = ev.results[i][0].transcript;
            if (ev.results[i].isFinal) finalChunk += txt;
            else interim += txt;
          }
          if (finalChunk) {
            baseText += finalChunk;
            if (!/\s$/.test(baseText)) baseText += ' ';
          }
          interimActive = interim;
          input.value = baseText + interim;
          try { autogrow(); } catch {}
        };
        recog.onerror = (e) => {
          if (e && (e.error === 'not-allowed' || e.error === 'service-not-allowed')) {
            try { window.toast && window.toast('Mic permission denied', 'error'); } catch {}
          }
          setListening(false);
        };
        recog.onend = () => { setListening(false); };
        recog.start();
        setListening(true);
      } catch (e) {
        setListening(false);
      }
    };
    const stop = () => {
      // Detach handlers BEFORE calling stop/abort so any pending async
      // onresult event the engine may still fire after stop() doesn't
      // re-populate input.value. This was the bug where voice text
      // reappeared in the textarea right after submit cleared it
      // (recog.stop is async; final onresult races the submit handler).
      if (recog) {
        try { recog.onresult = null; recog.onerror = null; recog.onend = null; } catch {}
        try { recog.stop(); } catch {}
        try { recog.abort && recog.abort(); } catch {}
      }
      recog = null;
      baseText = '';
      interimActive = '';
      setListening(false);
    };
    _stopVoice = stop;

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      if (listening) stop(); else start();
    });

    // Stop if the user manually types/edits while recording — prevents stale
    // baseText snapshot from clobbering their typing on next interim result.
    input.addEventListener('beforeinput', (e) => {
      if (!listening) return;
      // Programmatic input.value = ... does NOT fire beforeinput, so any event
      // here is a real user keypress/paste → snap voice off.
      if (e && e.inputType) stop();
    });

    // Stop voice when leaving AI tab (in-app navigation) — observe page
    // active class. Cleaner than coupling to navigate().
    const pageEl = document.getElementById('page-ai');
    if (pageEl) {
      if (_voiceMo) { try { _voiceMo.disconnect(); } catch {} }
      _voiceMo = new MutationObserver(() => {
        if (listening && !pageEl.classList.contains('active')) stop();
      });
      _voiceMo.observe(pageEl, { attributes: true, attributeFilter: ['class'] });
    }

    // Stop on tab hide / page navigate away
    document.addEventListener('visibilitychange', () => { if (document.hidden && listening) stop(); });
    window.addEventListener('pagehide', () => { if (listening) stop(); });
  }


  // ─── Streaming SSE parser ───────────────────────────
  async function streamRequest(body, { onDelta, onToolCallDelta, signal }) {
    const token = sessionToken;
    if (!token) throw new Error('Chưa đăng nhập (không có session token)');
    const res = await fetch(API_URL, {
      method: 'POST',
      signal,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`API ${res.status}: ${text.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let finishReason = null;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return { finishReason };
        let json;
        try { json = JSON.parse(data); } catch { continue; }
        const choice = json.choices && json.choices[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        if (delta.content) onDelta(delta.content);
        if (Array.isArray(delta.tool_calls)) onToolCallDelta(delta.tool_calls);
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
    }
    return { finishReason };
  }

  // ─── Tool call accumulator (across delta chunks) ────
  function accumulateToolCalls(accum, deltas) {
    for (const d of deltas) {
      const idx = d.index ?? 0;
      if (!accum[idx]) accum[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
      const slot = accum[idx];
      if (d.id) slot.id = d.id;
      if (d.type) slot.type = d.type;
      if (d.function) {
        if (d.function.name) slot.function.name += d.function.name;
        if (d.function.arguments) slot.function.arguments += d.function.arguments;
      }
    }
  }

  // ─── Send message + tool-loop ───────────────────────
  async function sendMessage(text) {
    if (isStreaming) return;
    const rate = await rateConsume();
    if (!rate.ok) {
      setComposerMeta(`⏳ Hết quota cục bộ — thử lại sau ${Math.ceil(rate.waitMs / 1000)}s`, 'warn');
      return;
    }
    text = String(text || '').trim();
    if (!text) return;

    // Reset proposal counter for new user turn
    if (window.AIProposals) window.AIProposals.resetTurnCounter();

    // Append user message
    messages.push({ role: 'user', content: text });
    renderMessage(messages[messages.length - 1]);
    renderEmpty();
    markLastAssistant();
    const scroll = $('#aiChatScroll');
    scrollToBottomIfPinned(scroll, true);
    saveConv();

    await _runStreamForCurrentMessages();
  }

  // Regenerate the last assistant response. Pops everything after the last
  // user message (the trailing assistant + any tool messages it produced)
  // and re-runs the tool loop with the same prompt. Mirrors ChatGPT/Claude
  // "Regenerate" behavior. No-op if there's no preceding user message or a
  // stream is currently in flight.
  async function retryLastResponse() {
    if (isStreaming) return;
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') { lastUserIdx = i; break; }
    }
    if (lastUserIdx === -1) return;
    const rate = await rateConsume();
    if (!rate.ok) {
      setComposerMeta(`⏳ Hết quota cục bộ — thử lại sau ${Math.ceil(rate.waitMs / 1000)}s`, 'warn');
      return;
    }
    // Drop trailing assistant + tool messages so the loop starts fresh.
    messages = messages.slice(0, lastUserIdx + 1);
    saveConv();
    renderAll();
    await _runStreamForCurrentMessages();
  }

  async function _runStreamForCurrentMessages() {
    if (isStreaming) return;
    isStreaming = true;
    setSendingState(true);
    setComposerMeta('');
    const myVersion = convVersion;
    try {
      await runToolLoop();
    } catch (e) {
      if (myVersion === convVersion) handleError(e);
    } finally {
      if (myVersion === convVersion) {
        isStreaming = false;
        setSendingState(false);
        currentAbort = null;
        saveConv();
        markLastAssistant();
        // Phase 3: auto-open proposal modal if there are pending proposals
        if (window.AIProposals && window.AIProposals.getActive().length > 0) {
          try { window.AIProposals.renderModal(); } catch (e) { console.error('[proposals] modal render error', e); }
        }
      }
    }
  }

  // ─── Edit user message (any position) — tans-agent pattern ────
  // In-bubble inline editing on ANY user message (hover-reveal on desktop,
  // always-visible on mobile). Saving truncates the conversation from this
  // message onward (the "branch off" — older history after this point is
  // discarded), then resubmits the new content. This mirrors the
  // ChatGPT/Claude/tans-agent UX where editing a past message creates a new
  // conversation branch.
  function enterEditMode(msgEl, idx) {
    if (isStreaming) return;
    if (!msgEl || msgEl.classList.contains('is-editing')) return;
    const original = (messages[idx] && messages[idx].content) || '';
    msgEl.classList.add('is-editing');
    const inner = msgEl.querySelector('.ai-msg-inner');
    if (!inner) return;
    const prevHTML = inner.innerHTML;
    inner.innerHTML = `
      <textarea class="ai-edit-textarea" aria-label="Chỉnh sửa câu hỏi">${esc(original)}</textarea>
      <div class="ai-edit-actions">
        <button type="button" class="btn ghost sm" data-edit-cancel>Hủy</button>
        <button type="button" class="btn primary sm" data-edit-save disabled>Gửi</button>
      </div>`;
    const ta = inner.querySelector('.ai-edit-textarea');
    const saveBtn = inner.querySelector('[data-edit-save]');
    const autosize = () => {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 240) + 'px';
    };
    const refreshSave = () => {
      const v = ta.value.trim();
      saveBtn.disabled = !v || v === original.trim();
    };
    ta.addEventListener('input', () => { autosize(); refreshSave(); });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); exitEditMode(msgEl, prevHTML); }
      else if ((e.key === 'Enter') && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (!saveBtn.disabled) commitEdit(idx, ta.value);
      }
    });
    autosize();
    // Focus + place cursor at end
    try { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } catch {}
  }
  function exitEditMode(msgEl, prevHTML) {
    if (!msgEl) return;
    msgEl.classList.remove('is-editing');
    const inner = msgEl.querySelector('.ai-msg-inner');
    if (inner) inner.innerHTML = prevHTML;
  }
  async function commitEdit(idx, newText) {
    if (isStreaming) return;
    const t = String(newText || '').trim();
    if (!t) return;
    if (currentAbort) { try { currentAbort.abort(); } catch {} }
    convVersion++;
    // Truncate the message at idx + everything after (the branch-off).
    messages = messages.slice(0, idx);
    saveConv();
    renderAll();
    await sendMessage(t);
  }

  // ─── Slash commands ─────────────────────────────────
  const SLASH_CMDS = [
    { cmd: '/clear',  desc: 'Xóa toàn bộ conversation' },
    { cmd: '/model',  desc: 'Đổi model — VD: /model gpt-4o' },
    { cmd: '/export', desc: 'Tải conversation về markdown' },
    { cmd: '/help',   desc: 'Hiện danh sách commands' },
  ];

  function maybeShowSlashMenu(value) {
    const menu = $('#aiSlashMenu');
    if (!menu) return;
    const v = String(value || '');
    if (!v.startsWith('/') || v.includes('\n')) {
      menu.classList.remove('show');
      menu.innerHTML = '';
      return;
    }
    const head = v.split(/\s/)[0].toLowerCase();
    // Once the user has typed past a recognized command + whitespace
    // (e.g. "/model gpt-4o"), they're typing args — hide the menu so Enter
    // submits the command instead of re-selecting it and wiping the args.
    if (/\s/.test(v) && SLASH_CMDS.some(c => c.cmd === head)) {
      menu.classList.remove('show');
      menu.innerHTML = '';
      return;
    }
    // Hide menu for bare "/" + whitespace (no command typed) — user is in
    // an invalid state, suggestions would be misleading.
    if (head === '/' && /\s/.test(v)) {
      menu.classList.remove('show');
      menu.innerHTML = '';
      return;
    }
    const matches = SLASH_CMDS.filter(c => c.cmd.startsWith(head));
    if (!matches.length) {
      menu.classList.remove('show');
      menu.innerHTML = '';
      return;
    }
    menu.innerHTML = matches.map((c, i) =>
      `<button type="button" class="ai-slash-item${i === 0 ? ' selected' : ''}" data-cmd="${c.cmd}" role="option">
        <span class="ai-slash-cmd">${c.cmd}</span>
        <span class="ai-slash-desc">${esc(c.desc)}</span>
      </button>`
    ).join('');
    menu.classList.add('show');
  }

  function hideSlashMenu() {
    const menu = $('#aiSlashMenu');
    if (menu) { menu.classList.remove('show'); menu.innerHTML = ''; }
  }

  function slashMenuNavigate(delta) {
    const menu = $('#aiSlashMenu');
    if (!menu || !menu.classList.contains('show')) return false;
    const items = [...menu.querySelectorAll('.ai-slash-item')];
    if (!items.length) return false;
    const cur = items.findIndex(b => b.classList.contains('selected'));
    const next = (cur + delta + items.length) % items.length;
    items.forEach(b => b.classList.remove('selected'));
    items[next].classList.add('selected');
    return true;
  }

  function slashMenuConfirm() {
    const menu = $('#aiSlashMenu');
    if (!menu || !menu.classList.contains('show')) return false;
    const sel = menu.querySelector('.ai-slash-item.selected') || menu.querySelector('.ai-slash-item');
    if (!sel) return false;
    const cmd = sel.getAttribute('data-cmd');
    const input = $('#aiComposerInput');
    if (input) {
      input.value = cmd + (cmd === '/model' ? ' ' : '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
      try { input.setSelectionRange(input.value.length, input.value.length); } catch {}
    }
    // Single-token commands → execute immediately (better UX than 2-step).
    if (cmd !== '/model') {
      tryExecuteSlash(cmd);
      if (input) { input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); }
    }
    hideSlashMenu();
    return true;
  }

  function tryExecuteSlash(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed.startsWith('/')) return false;
    const parts = trimmed.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);
    switch (cmd) {
      case '/clear':
        clearConv();
        return true;
      case '/model': {
        const select = $('#aiModelSelect');
        if (!args.length) {
          const opts = select ? [...select.options].map(o => o.value).join(', ') : '';
          setComposerMeta(`Model: ${model}. Cách dùng: /model <${opts}>`, 'warn');
          return true;
        }
        const target = args.join(' ');
        const optExists = select && [...select.options].some(o => o.value === target);
        if (!optExists) {
          const opts = select ? [...select.options].map(o => o.value).join(', ') : '';
          setComposerMeta(`Model không hợp lệ. Chọn: ${opts}`, 'err');
          return true;
        }
        if (select) select.value = target;
        saveModel(target);
        const d = document.getElementById('aiModelDisplay');
        if (d) d.textContent = target;
        setComposerMeta(`✓ Đã đổi model sang ${target}`);
        return true;
      }
      case '/export':
        exportConversation();
        return true;
      case '/help':
        setComposerMeta(`Commands: ${SLASH_CMDS.map(c => c.cmd).join(' · ')}`, 'warn');
        return true;
      default:
        setComposerMeta(`Unknown command: ${cmd} — thử /help`, 'err');
        return true;
    }
  }

  function exportConversation() {
    if (!messages.length) {
      setComposerMeta('Conversation rỗng — không có gì để export.', 'warn');
      return;
    }
    const lines = [
      '# AI Coach Conversation',
      '',
      `_Exported: ${new Date().toISOString()}_`,
      `_Model: ${model}_`,
      '',
    ];
    for (const m of messages) {
      if (m.role === 'user') {
        // Quote user content so any embedded markdown headings (e.g. "## ")
        // don't break the document structure of the export.
        const quoted = String(m.content || '').split('\n').map(l => '> ' + l).join('\n');
        lines.push('## You', '', quoted, '');
      } else if (m.role === 'assistant' && (m.content || '').trim()) {
        lines.push('## Assistant', '', String(m.content || ''), '');
      }
    }
    const md = lines.join('\n');
    const filename = `ai-conv-${new Date().toISOString().slice(0, 10)}.md`;
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const file = new File([blob], filename, { type: 'text/markdown' });
    // Prefer Web Share API on mobile (especially iOS PWA), fall back to download link.
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: 'AI Coach Conversation' })
        .then(() => setComposerMeta('✓ Đã share conversation'))
        .catch(() => { /* user cancelled — silent */ });
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setComposerMeta('✓ Đã tải conversation về');
  }

  async function runToolLoop() {
    const scroll = $('#aiChatScroll');
    const myVersion = convVersion;
    const isStale = () => myVersion !== convVersion;
    for (let hop = 0; hop < MAX_TOOL_HOPS; hop++) {
      if (isStale()) return;
      // Prepare assistant placeholder
      const assistantMsg = { role: 'assistant', content: '', tool_calls: null, _tool_results: {} };
      messages.push(assistantMsg);
      const node = renderMessage(assistantMsg);
      // Typing indicator inside .ai-msg-inner (replaces empty content until first delta arrives)
      if (node) {
        const inner = node.querySelector('.ai-msg-inner');
        if (inner) inner.innerHTML = `<div class="ai-thinking" role="status" aria-label="Đang suy nghĩ"><span class="ai-thinking-spinner" aria-hidden="true"></span><span class="ai-thinking-label">Đang suy nghĩ</span></div>`;
      }
      scrollToBottomIfPinned(scroll, true);

      const toolAccum = [];
      let streamedContent = '';
      currentAbort = new AbortController();

      const isLastHop = hop === MAX_TOOL_HOPS - 1;
      const body = {
        model: apiModelId(model),
        messages: [{ role: 'system', content: systemPrompt() }, ...messages.map(stripInternal)],
        tools: window.AITools ? window.AITools.getToolSchemas() : [],
        tool_choice: isLastHop ? 'none' : 'auto',
        temperature: 0.3,
        max_tokens: 1500,
        stream: true,
      };

      let bodyEl = null;
      let typer = null;
      const { finishReason } = await streamRequest(body, {
        signal: currentAbort.signal,
        onDelta: (chunk) => {
          if (isStale()) return;
          streamedContent += chunk;
          assistantMsg.content = streamedContent;
          if (!bodyEl) {
            // First content token — replace typing indicator with prose container.
            if (node) {
              const inner = node.querySelector('.ai-msg-inner');
              if (inner) {
                const pillsHtml = (assistantMsg.tool_calls && assistantMsg.tool_calls.length)
                  ? `<div class="ai-tool-pills">${renderToolPillsHtml(assistantMsg)}</div>` : '';
                inner.innerHTML = pillsHtml + `<div class="prose-chat prose-chat-streaming" data-stream="1"></div>`;
                bodyEl = inner.querySelector('[data-stream="1"]');
                typer = createTypewriter(bodyEl, () => convVersion);
              }
            }
          }
          if (typer) {
            // Push chunk into typewriter buffer; rAF pump drains char-by-char (~180 cps).
            typer.push(chunk);
          }
        },
        onToolCallDelta: (deltas) => {
          if (isStale()) return;
          accumulateToolCalls(toolAccum, deltas);
          assistantMsg.tool_calls = toolAccum;
          if (node) {
            const inner = node.querySelector('.ai-msg-inner');
            if (!inner) return;
            const pillsHtml = `<div class="ai-tool-pills">${renderToolPillsHtml(assistantMsg)}</div>`;
            if (bodyEl) {
              // Preserve in-progress prose body, just refresh pills above it.
              const existingBody = bodyEl.outerHTML;
              inner.innerHTML = pillsHtml + existingBody;
              bodyEl = inner.querySelector('[data-stream="1"]');
              // The new bodyEl reference needs typewriter rebinding so future pumps target it.
              if (typer && bodyEl) typer.reseed(bodyEl, streamedContent);
            } else {
              // No content yet — show pills + thinking dots
              inner.innerHTML = pillsHtml + `<div class="ai-thinking" role="status" aria-label="Đang suy nghĩ"><span class="ai-thinking-spinner" aria-hidden="true"></span><span class="ai-thinking-label">Đang suy nghĩ</span></div>`;
            }
            scrollToBottomIfPinned(scroll, false);
          }
        },
      });
      // SSE finished — let typewriter know so it can resolve drain promise once buffer empties.
      if (typer) {
        typer.finishStream();
        await typer.waitForDrain();
      }
      if (isStale()) return;

      // If finished with tool_calls → execute and loop
      if (finishReason === 'tool_calls' && toolAccum.length > 0 && !isLastHop) {
        if (isStale()) return;
        assistantMsg.tool_calls = toolAccum;
        // Execute each tool sequentially
        for (const tc of toolAccum) {
          if (isStale()) return;
          let args = {};
          try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}
          const result = await window.AITools.executeTool(tc.function.name, args);
          if (isStale()) return;
          const resultStr = JSON.stringify(result);
          assistantMsg._tool_results[tc.id] = resultStr;
          // Append tool message into conversation
          messages.push({ role: 'tool', tool_call_id: tc.id, content: resultStr });
          // Re-render this assistant msg's pills with results
          if (node) {
            const inner = node.querySelector('.ai-msg-inner');
            if (inner) {
              const pillsHtml = `<div class="ai-tool-pills">${renderToolPillsHtml(assistantMsg)}</div>`;
              const proseHtml = streamedContent ? `<div class="prose-chat">${renderMarkdown(streamedContent)}</div>` : '';
              inner.innerHTML = pillsHtml + proseHtml;
              bodyEl = null;
              scrollToBottomIfPinned(scroll, false);
            }
          }
        }
        saveConv();
        continue; // next hop with tool results
      }

      // Final answer — finalize render
      if (isStale()) return;
      if (node) {
        const inner = node.querySelector('.ai-msg-inner');
        if (inner) {
          const pillsHtml = (assistantMsg.tool_calls && assistantMsg.tool_calls.length)
            ? `<div class="ai-tool-pills">${renderToolPillsHtml(assistantMsg)}</div>` : '';
          const proseHtml = streamedContent
            ? `<div class="prose-chat">${renderMarkdown(streamedContent)}</div>`
            : `<div class="prose-chat"><p><em>(không có nội dung)</em></p></div>`;
          const copyBtn = streamedContent ? renderCopyActions(streamedContent) : '';
          inner.innerHTML = pillsHtml + proseHtml + copyBtn;
          scrollToBottomIfPinned(scroll, true);
        }
      }
      return;
    }
  }

  // Strip browser-only internals before sending to API
  function stripInternal(m) {
    if (m.role === 'assistant') {
      const o = { role: 'assistant', content: m.content || '' };
      if (m.tool_calls && m.tool_calls.length) o.tool_calls = m.tool_calls.map(tc => ({ id: tc.id, type: tc.type || 'function', function: { name: tc.function.name, arguments: tc.function.arguments } }));
      return o;
    }
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.tool_call_id, content: m.content };
    if (m.role === 'user') return { role: 'user', content: m.content };
    return m;
  }

  function renderMessage_pills(m) {
    // legacy alias — kept for any external callers
    return renderToolPillsHtml(m);
  }

  // ─── Error handling ─────────────────────────────────
  function handleError(e) {
    console.error('[AI]', e);
    const scroll = $('#aiChatScroll');
    // If a stream was in flight, strip the live caret from any in-progress
    // bubble so we don't leave a phantom "still typing" marker behind.
    if (scroll) {
      scroll.querySelectorAll('.prose-chat-streaming').forEach(el => {
        el.classList.remove('prose-chat-streaming');
        el.removeAttribute('data-stream');
      });
    }
    // Replace last assistant placeholder if it's still empty
    const last = messages[messages.length - 1];
    if (last && last.role === 'assistant' && !last.content && !(last.tool_calls && last.tool_calls.length)) {
      messages.pop();
      const nodes = scroll ? scroll.querySelectorAll('.ai-msg-ai') : [];
      if (nodes.length) nodes[nodes.length - 1].remove();
    }
    let userMsg = 'Lỗi gọi AI.';
    if (e.name === 'AbortError') userMsg = 'Đã hủy.';
    else if (e.status === 400) {
      // GitHub Models returns useful JSON in the body — surface it briefly.
      const detail = (e.message || '').replace(/^API 400:\s*/, '').slice(0, 160);
      userMsg = detail
        ? `Yêu cầu sai format. ${detail}`
        : 'Yêu cầu sai format — model name có thể không hợp lệ (cần `publisher/model`).';
    }
    else if (e.status === 401 || e.status === 403) userMsg = 'PAT không có quyền GitHub Models. Check token scope (cần `repo`).';
    else if (e.status === 404) userMsg = 'Endpoint hoặc model không tồn tại. Có thể model đã bị deprecate.';
    else if (e.status === 408) userMsg = 'Server timeout. Thử lại với câu hỏi ngắn hơn.';
    else if (e.status === 413) userMsg = 'Conversation quá dài. Dùng /clear để reset.';
    else if (e.status === 429) userMsg = 'Bị rate-limit từ server. Đợi vài giây rồi thử lại.';
    else if (e.status >= 500 && e.status < 600) userMsg = 'Server AI lỗi tạm thời. Thử lại sau.';
    else if (e.message && e.message.includes('Failed to fetch')) {
      if (navigator.onLine === false) {
        userMsg = 'Mất kết nối mạng — bạn đang offline.';
      } else {
        // Browser blocked the request BEFORE it hit the network → almost
        // always CSP/proxy/firewall/adblocker. Generic "Failed to fetch" gives
        // no status code because the fetch never left the renderer.
        userMsg = 'Request bị chặn trước khi gửi. Có thể CSP / adblocker / proxy company. Mở DevTools Console để xem chi tiết.';
      }
    }
    else if (e.message) userMsg = e.message;
    setComposerMeta(`❌ ${userMsg}`, 'err');
    // If there's still a user message to retry from, surface an inline Retry
    // button next to the error so the user doesn't have to re-type.
    const hasUserToRetry = messages.some(m => m.role === 'user');
    const meta = $('#aiComposerMeta');
    if (meta && hasUserToRetry && e.name !== 'AbortError') {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ai-meta-retry';
      btn.innerHTML = `${ICON('refresh', 12)}<span>Retry</span>`;
      btn.addEventListener('click', () => {
        setComposerMeta('');
        retryLastResponse();
      });
      meta.appendChild(btn);
    }
    if (typeof toast === 'function' && e.name !== 'AbortError') toast(userMsg, 'error');
  }

  // ─── Composer state ─────────────────────────────────
  function setSendingState(sending) {
    const send = $('#aiComposerSend');
    const input = $('#aiComposerInput');
    if (!send || !input) return;
    if (sending) {
      // Swap to STOP button — enabled, click triggers abort.
      send.disabled = false;
      send.classList.add('is-stop');
      send.setAttribute('aria-label', 'Stop');
      send.setAttribute('title', 'Dừng');
      send.innerHTML = `<span class="ai-send-icon">${ICON('square', 14)}</span>`;
      input.disabled = false;
    } else {
      send.classList.remove('is-stop');
      send.setAttribute('aria-label', 'Send');
      send.setAttribute('title', 'Gửi');
      send.innerHTML = `<span class="ai-send-icon">${ICON('arrowUp', 16)}</span>`;
      send.disabled = !input.value.trim();
    }
  }
  function setComposerMeta(text, cls) {
    const meta = $('#aiComposerMeta');
    if (!meta) return;
    if (text) {
      meta.textContent = text;
    } else {
      // Restore default footer (model display)
      const m = model || 'gpt-4o-mini';
      meta.innerHTML = `AI có thể trả lời sai · Powered by <span class="ai-monolite" id="aiModelDisplay">${esc(m)}</span>`;
    }
    meta.className = 'ai-composer-meta' + (cls ? ' ' + cls : '');
  }

  // ─── Mount (idempotent) ─────────────────────────────
  function mount() {
    if (mounted) {
      // Re-render in case messages mutated elsewhere (logout/clear)
      renderAll();
      return;
    }
    loadModel();
    loadConv();
    // Async: open IDB, migrate, switch to last conv if different.
    _initConvStore();

    const form = $('#aiComposer');
    const input = $('#aiComposerInput');
    const send = $('#aiComposerSend');
    const modelSelect = $('#aiModelSelect');
    const clearBtn = $('#aiClearBtn');
    const convBtn = $('#aiConvBtn');
    const convSheet = $('#aiConvSheet');
    const convNewBtn = $('#aiConvNewBtn');
    if (!form || !input) return;

    modelSelect.value = model;
    const updateModelDisplay = () => {
      const d = document.getElementById('aiModelDisplay');
      if (d) d.textContent = model;
    };
    updateModelDisplay();
    modelSelect.addEventListener('change', () => { saveModel(modelSelect.value); updateModelDisplay(); });

    clearBtn.addEventListener('click', () => {
      // clearConv() handles abort + version bump internally.
      clearConv();
    });

    // Phase 3: Undo last apply button
    const undoBtn = document.getElementById('aiUndoBtn');

    function _updateUndoBtnVisibility() {
      const has = !!(window.AIAudit && window.AIAudit.getLast && window.AIAudit.getLast());
      if (undoBtn) undoBtn.hidden = !has;
    }
    if (undoBtn) {
      undoBtn.addEventListener('click', () => {
        if (window.AIProposals) window.AIProposals.rollbackLast();
        setTimeout(_updateUndoBtnVisibility, 500);
      });
    }
    _updateUndoBtnVisibility();
    setInterval(_updateUndoBtnVisibility, 5000);

    // Conversations sheet wiring
    if (convBtn) convBtn.addEventListener('click', () => _toggleConvSheet());
    const newChatBtn = document.getElementById('aiNewChatBtn');
    if (newChatBtn) newChatBtn.addEventListener('click', () => { createConv(); });
    try { if (convNewBtn) convNewBtn.addEventListener('click', () => createConv()); } catch (_) {}
    const convSearch = document.getElementById('aiConvSearch');
    if (convSearch) {
      convSearch.addEventListener('input', () => {
        _convFilter = convSearch.value || '';
        _renderConvList();
      });
    }
    if (convSheet) {
      convSheet.addEventListener('click', (e) => {
        const t = e.target;
        if (!t || !t.closest) return;
        // Click on overlay itself (not inside content) closes
        if (t === convSheet) { _hideConvSheet(); return; }
        if (t.closest('[data-conv-close]')) { _hideConvSheet(); return; }
        const switchEl = t.closest('[data-conv-switch]');
        if (switchEl) { switchConv(switchEl.getAttribute('data-conv-switch')); return; }
        const renameEl = t.closest('[data-conv-rename]');
        if (renameEl) {
          _convEditingId = renameEl.getAttribute('data-conv-rename');
          _renderConvList().then(() => {
            const inp = convSheet.querySelector('.ai-conv-rename-input');
            if (inp) { inp.focus(); inp.select(); }
          });
          return;
        }
        const saveEl = t.closest('[data-conv-rename-save]');
        if (saveEl) {
          const id = saveEl.getAttribute('data-conv-rename-save');
          const inp = convSheet.querySelector(`[data-conv-rename-input="${id}"]`);
          const next = inp ? inp.value.trim() : '';
          _convEditingId = null;
          if (next) renameConv(id, next); else _renderConvList();
          return;
        }
        if (t.closest('[data-conv-rename-cancel]')) {
          _convEditingId = null;
          _renderConvList();
          return;
        }
        const delEl = t.closest('[data-conv-del]');
        if (delEl) {
          const id = delEl.getAttribute('data-conv-del');
          (typeof uiConfirm === 'function'
            ? uiConfirm({ title: 'Xóa cuộc trò chuyện?', message: 'Hành động này không thể hoàn tác.', confirmText: 'Xóa', cancelText: 'Hủy', danger: true })
            : Promise.resolve(window.confirm('Xóa cuộc trò chuyện này?'))
          ).then(ok => { if (ok) deleteConvById(id); });
          return;
        }
      });
      // Rename input: Enter saves, Esc cancels
      convSheet.addEventListener('keydown', (e) => {
        const inp = e.target && e.target.matches && e.target.matches('.ai-conv-rename-input') ? e.target : null;
        if (!inp) return;
        if (e.key === 'Enter') {
          e.preventDefault();
          const id = inp.getAttribute('data-conv-rename-input');
          const next = inp.value.trim();
          _convEditingId = null;
          if (next) renameConv(id, next); else _renderConvList();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          _convEditingId = null;
          _renderConvList();
        }
      });
      // Esc to close (when not editing)
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && convSheet.classList.contains('open') && !_convEditingId) { _hideConvSheet(); }
      });
    }
    const clearAllBtn = document.getElementById('aiConvClearAllBtn');
    if (clearAllBtn) {
      clearAllBtn.addEventListener('click', () => {
        (typeof uiConfirm === 'function'
          ? uiConfirm({ title: 'Xóa toàn bộ lịch sử?', message: 'Tất cả các cuộc trò chuyện sẽ bị xóa vĩnh viễn.', confirmText: 'Xóa hết', cancelText: 'Hủy', danger: true })
          : Promise.resolve(window.confirm('Xóa toàn bộ lịch sử trò chuyện?'))
        ).then(ok => { if (ok) clearAllConvs(); });
      });
    }

    // Custom Model picker (shadcn-style dropdown, ref: tans-agent persona-picker)
    const modelTrigger = document.getElementById('aiModelTrigger');
    const modelMenu = document.getElementById('aiModelMenu');
    const modelTriggerLabel = document.getElementById('aiModelTriggerLabel');
    const modelEmoji = modelTrigger ? modelTrigger.querySelector('.ai-model-trigger-emoji') : null;
    const MODEL_META = {
      'gpt-4o-mini': { emoji: '⚡' },
      'gpt-4o':      { emoji: '🧠' },
    };
    function _syncModelPickerUI() {
      if (modelTriggerLabel) modelTriggerLabel.textContent = model;
      if (modelEmoji && MODEL_META[model]) modelEmoji.textContent = MODEL_META[model].emoji;
      if (modelMenu) {
        modelMenu.querySelectorAll('.ai-model-menu-item').forEach(it => {
          it.setAttribute('aria-checked', String(it.getAttribute('data-model') === model));
        });
      }
    }
    function _openModelMenu() {
      if (!modelMenu || !modelTrigger) return;
      modelMenu.classList.remove('closing');
      modelMenu.hidden = false;
      modelTrigger.setAttribute('aria-expanded', 'true');
    }
    function _closeModelMenu() {
      if (!modelMenu || !modelTrigger) return;
      if (modelMenu.hidden) return;
      modelTrigger.setAttribute('aria-expanded', 'false');
      modelMenu.classList.add('closing');
      const done = () => {
        modelMenu.removeEventListener('animationend', done);
        if (modelMenu.classList.contains('closing')) {
          modelMenu.hidden = true;
          modelMenu.classList.remove('closing');
        }
      };
      modelMenu.addEventListener('animationend', done);
      setTimeout(done, 200);
    }
    if (modelTrigger && modelMenu) {
      _syncModelPickerUI();
      modelTrigger.addEventListener('click', (e) => {
        e.stopPropagation();
        if (modelMenu.hidden) _openModelMenu(); else _closeModelMenu();
      });
      modelMenu.addEventListener('click', (e) => {
        const it = e.target && e.target.closest && e.target.closest('.ai-model-menu-item');
        if (!it) return;
        const m = it.getAttribute('data-model');
        if (m && m !== model) {
          saveModel(m);
          if (modelSelect) modelSelect.value = m;
          updateModelDisplay();
          _syncModelPickerUI();
        }
        _closeModelMenu();
      });
      document.addEventListener('click', (e) => {
        if (modelMenu.hidden) return;
        if (!modelMenu.contains(e.target) && !modelTrigger.contains(e.target)) _closeModelMenu();
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !modelMenu.hidden) _closeModelMenu();
      });
    }

    // Auto-grow textarea
    const autogrow = () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 180) + 'px';
      if (!send.classList.contains('is-stop')) {
        send.disabled = !input.value.trim();
      }
    };
    input.addEventListener('input', () => { autogrow(); maybeShowSlashMenu(input.value); });
    input.addEventListener('blur', () => {
      // Delay so click on slash item fires first.
      setTimeout(hideSlashMenu, 150);
    });
    input.addEventListener('keydown', (e) => {
      const menu = $('#aiSlashMenu');
      const menuOpen = menu && menu.classList.contains('show');
      if (menuOpen) {
        if (e.key === 'ArrowDown')   { e.preventDefault(); slashMenuNavigate(1);  return; }
        if (e.key === 'ArrowUp')     { e.preventDefault(); slashMenuNavigate(-1); return; }
        if (e.key === 'Escape')      { e.preventDefault(); hideSlashMenu();       return; }
        if (e.key === 'Tab')         { e.preventDefault(); slashMenuConfirm();    return; }
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault(); slashMenuConfirm(); return;
        }
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        form.requestSubmit();
      }
    });

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      // Stop voice recording before submit so no late interim event resurrects text.
      try { if (_stopVoice) _stopVoice(); } catch {}
      // If button is in STOP state, abort current stream instead of submitting.
      if (send.classList.contains('is-stop')) {
        try { if (currentAbort) currentAbort.abort(); } catch {}
        return;
      }
      const text = input.value.trim();
      if (!text) return;
      // Slash command: execute locally, never sent to model.
      if (text.startsWith('/')) {
        input.value = '';
        autogrow();
        hideSlashMenu();
        tryExecuteSlash(text);
        return;
      }
      input.value = '';
      autogrow();
      hideSlashMenu();
      sendMessage(text);
    });

    // Slash menu click delegation
    const slashMenu = $('#aiSlashMenu');
    if (slashMenu) {
      slashMenu.addEventListener('mousedown', (e) => {
        // mousedown (not click) so input doesn't blur-hide the menu first
        const item = e.target && e.target.closest && e.target.closest('.ai-slash-item');
        if (!item) return;
        e.preventDefault();
        slashMenu.querySelectorAll('.ai-slash-item').forEach(b => b.classList.remove('selected'));
        item.classList.add('selected');
        slashMenuConfirm();
      });
    }

    // Suggested prompts (tans-agent card style)
    document.querySelectorAll('.ai-suggest-card, .ai-suggest-chip').forEach(card => {
      card.addEventListener('click', () => {
        const prompt = card.getAttribute('data-prompt');
        if (!prompt) return;
        input.value = prompt;
        autogrow();
        form.requestSubmit();
      });
    });

    // Click delegation: Retry (assistant) / Edit (user) / Copy
    const scrollContainer = $('#aiChatScroll');
    if (scrollContainer) {
      scrollContainer.addEventListener('click', (e) => {
        const t = e.target;
        if (!t || !t.closest) return;
        const retryBtn = t.closest('.ai-action-btn[data-retry]');
        if (retryBtn) {
          if (isStreaming) return;
          retryLastResponse();
          return;
        }
        const reapplyBtn = t.closest('.ai-action-btn[data-reapply-b64]');
        if (reapplyBtn) {
          reapplyProposalsFromBtn(reapplyBtn);
          return;
        }
        const editBtn = t.closest('.ai-action-btn[data-edit-user]');
        if (editBtn) {
          if (isStreaming) return;
          const msgEl = editBtn.closest('.ai-msg-user');
          if (!msgEl) return;
          const idx = parseInt(msgEl.getAttribute('data-msg-idx') || '-1', 10);
          if (idx < 0 || !messages[idx]) return;
          enterEditMode(msgEl, idx);
          return;
        }
        // Inline edit-mode controls (delegated)
        const cancelBtn = t.closest('[data-edit-cancel]');
        if (cancelBtn) {
          const msgEl = cancelBtn.closest('.ai-msg-user');
          if (msgEl) {
            const idx = parseInt(msgEl.getAttribute('data-msg-idx') || '-1', 10);
            const original = (messages[idx] && messages[idx].content) || '';
            const enc = btoa(unescape(encodeURIComponent(String(original))));
            const prevHTML = `
              <div class="ai-bubble-user">${esc(original)}</div>
              <div class="ai-msg-actions ai-msg-user-actions">
                <button type="button" class="ai-action-btn" data-edit-user title="Chỉnh sửa & rẽ nhánh" aria-label="Edit">${ICON('edit', 13)}<span>Edit</span></button>
                <button type="button" class="ai-action-btn" data-copy-b64="${enc}" title="Copy" aria-label="Copy">${ICON('copy', 13)}<span>Copy</span></button>
              </div>`;
            exitEditMode(msgEl, prevHTML);
          }
          return;
        }
        const saveBtn = t.closest('[data-edit-save]');
        if (saveBtn) {
          if (saveBtn.disabled) return;
          const msgEl = saveBtn.closest('.ai-msg-user');
          if (!msgEl) return;
          const idx = parseInt(msgEl.getAttribute('data-msg-idx') || '-1', 10);
          const ta = msgEl.querySelector('.ai-edit-textarea');
          if (idx < 0 || !ta) return;
          commitEdit(idx, ta.value);
          return;
        }
        const btn = t.closest('.ai-action-btn[data-copy-b64]');
        if (!btn) return;
        try {
          const text = decodeURIComponent(escape(atob(btn.getAttribute('data-copy-b64'))));
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(() => {
              const orig = btn.innerHTML;
              btn.innerHTML = `${ICON('check', 13)}<span>Copied</span>`;
              setTimeout(() => { if (btn.isConnected) btn.innerHTML = orig; }, 1500);
            });
          }
        } catch {}
      });
    }

    // ─── Voice input (Web Speech API) ───────────────────
    initVoiceInput(input, autogrow);

    // Render initial send-button icon
    setSendingState(false);
    setComposerMeta('');

    renderAll();
    if (typeof renderIcons === 'function') renderIcons(document.getElementById('page-ai'));
    attachScrollObserver();

    // Autofocus the composer on non-touch (desktop) so the user can start
    // typing immediately. Skip on touch devices — popping the keyboard
    // unprompted is intrusive.
    try {
      const isTouch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
      if (!isTouch && input && typeof input.focus === 'function') {
        // Delay one frame so layout settles before focus (prevents scroll jump)
        requestAnimationFrame(() => { try { input.focus({ preventScroll: true }); } catch { input.focus(); } });
      }
    } catch {}

    // Land on the latest message on first mount (no _tabScroll memory yet).
    const sc = document.getElementById('aiChatScroll');
    if (sc) sc.scrollTop = sc.scrollHeight;

    mounted = true;
  }

  function clearConv() {
    _flushPendingSave();
    if (currentAbort) { try { currentAbort.abort(); } catch {} }
    convVersion++;                  // invalidate any in-flight loop
    isStreaming = false;
    currentAbort = null;
    messages = [];
    saveConv();
    setComposerMeta('');
    setSendingState(false);
    renderAll();
    _renderConvList();
  }

  // Clear conv on logout — hook into app.js if a logout event exists.
  window.addEventListener('beforeunload', () => { /* sessionStorage clears with tab close anyway */ });

  // ─── Dev self-test for renderMarkdown XSS hardening ──
  // Activate with `#test=ai-md` (or `?test=ai-md`) in URL. Runs once at load
  // and logs pass/fail to console. No-op in production navigation.
  try {
    const probe = (typeof location !== 'undefined')
      ? ((location.hash || '') + '|' + (location.search || ''))
      : '';
    if (/[#&?|]test=ai-md\b/.test(probe)) {
      const cases = [
        { name: 'raw img tag escaped',
          src: '<img src=x onerror=alert(1)>',
          // Active tag form forbidden; escaped text form is fine.
          forbid: ['<img ', '<img>'] },
        { name: 'link attr injection (with space)',
          src: '[xss](https://example.com" onclick="alert(1))',
          forbidRe: /<a\b[^>]*\bonclick\b/i },
        { name: 'link attr injection (no space)',
          src: '[a](https://x.com"onclick=alert(1))',
          // Must NOT emit an <a> tag — URL contains &quot; after esc → rejected.
          forbid: ['<a href='],
          // Entities should survive as plain text.
          require: ['&quot;'] },
        { name: 'link with angle-bracket smuggle',
          src: '[a](https://x.com#"><svg/onload=alert(1))',
          forbid: ['<a href=', '<svg'] },
        { name: 'valid github link',
          src: '[ok](https://github.com/foo)',
          require: ['<a href="https://github.com/foo"', 'target="_blank"'] },
        { name: 'valid url with query &',
          src: '[q](https://x.com/?a=1&b=2)',
          require: ['href="https://x.com/?a=1&amp;b=2"'] },
        { name: 'script in code block',
          src: '```\n<script>alert(1)</script>\n```',
          forbid: ['<script>'] },
        { name: 'script in inline code',
          src: 'try `<script>alert(1)</script>` now',
          forbid: ['<script>'] },
        { name: 'script in table cell',
          src: '| <script>alert(1)</script> | x |\n| --- | --- |\n| a | b |\n',
          forbid: ['<script>'] },
        { name: 'javascript: url rejected',
          src: '[x](javascript:alert(1))',
          forbid: ['<a href='] },
        { name: 'data: url rejected',
          src: '[x](data:text/html,<script>alert(1)</script>)',
          forbid: ['<a href='] },
      ];
      const results = cases.map(c => {
        let out = '';
        let err = null;
        try { out = renderMarkdown(c.src); } catch (e) { err = String(e); }
        const badStr = (c.forbid || []).find(f => out.includes(f));
        const badRe  = c.forbidRe && c.forbidRe.test(out) ? c.forbidRe.source : null;
        const miss   = (c.require || []).find(r => !out.includes(r));
        const ok = !err && !badStr && !badRe && !miss;
        return { name: c.name, ok, err, badStr, badRe, miss, out };
      });
      const failed = results.filter(r => !r.ok);
      if (failed.length) console.error('[AIAgent.renderMarkdown] %d FAIL', failed.length, failed);
      else console.log('[AIAgent.renderMarkdown] %d/%d tests passed', results.length, results.length);
    }
  } catch (_) { /* test harness must never break app */ }

  return { mount, sendMessage, clearConv, clearAllConvs, switchConv, createConv, deleteConv: deleteConvById, renameConv, get messages() { return messages.slice(); }, get currentConvId() { return currentConvId; } };
})();
