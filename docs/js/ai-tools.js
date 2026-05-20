// ═══════════════════════════════════════════════════
//  AI TOOLS — Read-only tool registry for OT Coach (P1)
//  Each tool: { schema: <openai function spec>, exec: async (args) => json }
//  Reuses existing modules: apiFetch, GIST_ID, WORKFLOWS, OT_SALARY
// ═══════════════════════════════════════════════════
(function () {
  'use strict';

  const OT_FILE = 'ot-requests.json';
  const SCHED_FILE = 'scheduled-runs.json';

  // ─── Helpers ─────────────────────────────────────────
  const JST_OFFSET_MIN = 9 * 60;
  function jstNow() {
    const d = new Date();
    return new Date(d.getTime() + (d.getTimezoneOffset() + JST_OFFSET_MIN) * 60000);
  }
  function todayJST() { return jstNow().toISOString().slice(0, 10); }
  function currentMonthJST() { return jstNow().toISOString().slice(0, 7); }
  function inMonth(dateStr, monthYYYYMM) {
    return typeof dateStr === 'string' && dateStr.slice(0, 7) === monthYYYYMM;
  }

  async function _loadGist() {
    if (typeof apiFetch !== 'function' || typeof GIST_ID === 'undefined') {
      throw new Error('Gist API not available');
    }
    return apiFetch(`/gists/${GIST_ID}`);
  }
  function _parseFile(gist, fname) {
    const f = gist.files && gist.files[fname];
    if (!f || !f.content) return null;
    try { return JSON.parse(f.content); } catch { return null; }
  }

  // ─── 1. get_today_status ────────────────────────────
  // Reads workflow_runs for auto-checkin/checkout TODAY (JST).
  // True DokoKin state is server-side only; this is the closest proxy.
  async function exec_get_today_status() {
    const today = todayJST();
    const todayPrefix = today;
    const out = { date_jst: today, checkin: null, checkout: null, source: 'workflow_runs' };
    if (typeof apiFetch !== 'function' || typeof WORKFLOWS === 'undefined') {
      return { ...out, error: 'apiFetch/WORKFLOWS not loaded' };
    }
    const wfMap = { checkin: 'auto-checkin.yml', checkout: 'auto-checkout.yml' };
    for (const [key, wfFile] of Object.entries(wfMap)) {
      try {
        const data = await apiFetch(`/repos/${OWNER}/${REPO}/actions/workflows/${wfFile}/runs?per_page=10`);
        const runs = (data.workflow_runs || []).filter(r => {
          const t = r.run_started_at || r.created_at;
          return t && t.startsWith(todayPrefix.slice(0, 4)) && (
            // server is UTC; today JST might span 2 UTC days. Be inclusive.
            new Date(t).getTime() >= new Date(today + 'T00:00:00+09:00').getTime() - 3600000
          );
        });
        const latest = runs[0];
        if (latest) {
          out[key] = {
            status: latest.status,
            conclusion: latest.conclusion,
            started_at: latest.run_started_at || latest.created_at,
            html_url: latest.html_url,
          };
        }
      } catch (e) { out[key + '_error'] = String(e.message || e); }
    }
    out.note = 'Status reflects workflow-run success/failure, not the live DokoKin record. For 100% accuracy, check DokoKin app directly.';
    return out;
  }

  // ─── 2. list_schedule ───────────────────────────────
  async function exec_list_schedule(args) {
    const { from, to, workflow } = args || {};
    const gist = await _loadGist();
    const parsed = _parseFile(gist, SCHED_FILE);
    let entries = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.entries) ? parsed.entries : []);
    if (workflow) entries = entries.filter(e => e.workflow === workflow);
    if (from) entries = entries.filter(e => (e.run_at || '').slice(0, 10) >= from || e.type === 'recurring');
    if (to) entries = entries.filter(e => (e.run_at || '').slice(0, 10) <= to || e.type === 'recurring');
    return {
      count: entries.length,
      entries: entries.map(e => ({
        id: e.id, type: e.type, workflow: e.workflow,
        run_at: e.run_at || null,
        time: e.time || null,
        days: e.days || null,
        dates: e.dates || null,
        skip_dates: e.skip_dates || null,
        enabled: e.enabled !== false,
        location: e.location || null,
        dispatched: e.dispatched || false,
        last_run: e.last_run || null,
      })),
    };
  }

  // ─── 3. list_ot_requests ────────────────────────────
  async function exec_list_ot_requests(args) {
    const month = (args && args.month) || currentMonthJST();
    const gist = await _loadGist();
    const raw = _parseFile(gist, OT_FILE);
    const all = Array.isArray(raw) ? raw : (Array.isArray(raw?.requests) ? raw.requests : []);
    const filtered = all.filter(r => inMonth(r.date, month));
    const totalHours = filtered.reduce((s, r) => s + (Number(r.hours) || 0), 0);
    const CAP = 75;
    return {
      month,
      count: filtered.length,
      total_hours: Math.round(totalHours * 100) / 100,
      cap_hours: CAP,
      cap_remaining_hours: Math.max(0, Math.round((CAP - totalHours) * 100) / 100),
      requests: filtered.map(r => ({
        id: r.id, date: r.date, start: r.start, end: r.end,
        hours: r.hours, reason: r.reason,
        kintai_created_at: r.kintai_created_at || null,
      })),
    };
  }

  // ─── 4. calc_ot_breakdown ───────────────────────────
  async function exec_calc_ot_breakdown(args) {
    if (!window.OT_SALARY) return { error: 'OT_SALARY module not loaded' };
    const reqs = (args && args.requests) || [];
    const perShift = [];
    let totalGross = 0, totalHours = 0;
    for (const r of reqs) {
      if (!r.date || !r.start || !r.end) continue;
      const b = window.OT_SALARY.calcOtBreakdown(r);
      perShift.push({
        date: r.date, start: r.start, end: r.end,
        hours: Math.round(b.totalHours * 100) / 100,
        gross_yen: b.gross,
        sunday_hours: Math.round(b.sundayHours * 100) / 100,
        night_hours: Math.round(b.nightHours * 100) / 100,
      });
      totalGross += b.gross;
      totalHours += b.totalHours;
    }
    return {
      count: perShift.length,
      total_hours: Math.round(totalHours * 100) / 100,
      total_gross_yen: totalGross,
      per_shift: perShift,
    };
  }

  // ─── 5. summarize_month_ot ──────────────────────────
  // Fetches month requests + computes summary (gross, hours, breakdown).
  async function exec_summarize_month_ot(args) {
    const list = await exec_list_ot_requests(args);
    if (!window.OT_SALARY) {
      return { ...list, salary: null, error: 'OT_SALARY module not loaded' };
    }
    const sal = window.OT_SALARY.calcMonthlySummary(list.requests);
    return {
      month: list.month,
      count: list.count,
      total_hours: list.total_hours,
      cap_remaining_hours: list.cap_remaining_hours,
      gross_yen: sal.gross,
      breakdown_yen: {
        base_ot_125pct: sal.baseOTLine,
        sunday_premium_10pct: sal.sundayLine,
        night_premium_25pct: sal.nightLine,
      },
      hours_breakdown: {
        sunday: Math.round(sal.sundayHours * 100) / 100,
        weekday: Math.round(sal.weekdayHours * 100) / 100,
        night: Math.round(sal.nightHours * 100) / 100,
      },
      note: 'Gross OT income only. Fixed allowance ¥20,000/mo paid separately.',
    };
  }

  // ─── 6. get_workflow_runs ───────────────────────────
  async function exec_get_workflow_runs(args) {
    const { workflow, limit = 10 } = args || {};
    if (typeof apiFetch !== 'function' || typeof WORKFLOWS === 'undefined') {
      return { error: 'apiFetch/WORKFLOWS not loaded' };
    }
    const wfList = workflow
      ? WORKFLOWS.filter(w => w.file === workflow || w.name === workflow)
      : WORKFLOWS;
    if (!wfList.length) return { error: 'Workflow not found', requested: workflow };
    const all = [];
    for (const wf of wfList) {
      try {
        const data = await apiFetch(`/repos/${OWNER}/${REPO}/actions/workflows/${wf.file}/runs?per_page=${Math.min(limit, 20)}`);
        for (const r of (data.workflow_runs || [])) {
          all.push({
            workflow: wf.name, workflow_file: wf.file,
            status: r.status, conclusion: r.conclusion,
            event: r.event, run_number: r.run_number,
            created_at: r.created_at, updated_at: r.updated_at,
            html_url: r.html_url,
          });
        }
      } catch (e) { all.push({ workflow: wf.name, error: String(e.message || e) }); }
    }
    all.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    return { count: all.length, runs: all.slice(0, limit) };
  }

  // ─── Tool registry ──────────────────────────────────
  const TOOLS = [
    {
      schema: {
        type: 'function',
        function: {
          name: 'get_today_status',
          description: 'Check whether today\'s auto-checkin and auto-checkout workflows ran successfully. Reflects workflow-run outcome (proxy for actual DokoKin record).',
          parameters: { type: 'object', properties: {} },
        },
      },
      exec: exec_get_today_status,
    },
    {
      schema: {
        type: 'function',
        function: {
          name: 'list_schedule',
          description: 'List scheduled workflow runs (one-time + recurring) from the Gist. Use to answer questions about upcoming/past schedule entries.',
          parameters: {
            type: 'object',
            properties: {
              from: { type: 'string', description: 'YYYY-MM-DD JST inclusive lower bound (applies to one-time entries only)' },
              to:   { type: 'string', description: 'YYYY-MM-DD JST inclusive upper bound (applies to one-time entries only)' },
              workflow: { type: 'string', description: 'Filter by workflow file (e.g. auto-checkin.yml)' },
            },
          },
        },
      },
      exec: exec_list_schedule,
    },
    {
      schema: {
        type: 'function',
        function: {
          name: 'list_ot_requests',
          description: 'List OT requests for a given month (defaults to current month JST). Returns hours, cap remaining, and full request list.',
          parameters: {
            type: 'object',
            properties: {
              month: { type: 'string', description: 'YYYY-MM in JST. Defaults to current month if omitted.' },
            },
          },
        },
      },
      exec: exec_list_ot_requests,
    },
    {
      schema: {
        type: 'function',
        function: {
          name: 'calc_ot_breakdown',
          description: 'Calculate gross JPY breakdown for a list of OT shifts (per-shift + total). Use for "how much would I earn if I worked X" questions.',
          parameters: {
            type: 'object',
            properties: {
              requests: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    date:  { type: 'string', description: 'YYYY-MM-DD JST' },
                    start: { type: 'string', description: 'HH:MM start time' },
                    end:   { type: 'string', description: 'HH:MM end time (may be past midnight)' },
                  },
                  required: ['date', 'start', 'end'],
                },
              },
            },
            required: ['requests'],
          },
        },
      },
      exec: exec_calc_ot_breakdown,
    },
    {
      schema: {
        type: 'function',
        function: {
          name: 'summarize_month_ot',
          description: 'Summarize an entire month of existing OT (gross JPY + hours breakdown + cap remaining). Cheaper than list+calc for status questions.',
          parameters: {
            type: 'object',
            properties: { month: { type: 'string', description: 'YYYY-MM JST. Defaults to current month.' } },
          },
        },
      },
      exec: exec_summarize_month_ot,
    },
    {
      schema: {
        type: 'function',
        function: {
          name: 'get_workflow_runs',
          description: 'Fetch recent workflow runs for diagnosis (status, conclusion, html_url). Use for "did X run? did it fail?" questions.',
          parameters: {
            type: 'object',
            properties: {
              workflow: { type: 'string', description: 'Workflow file (e.g. auto-checkin.yml) or display name. Omit for all workflows.' },
              limit:    { type: 'integer', minimum: 1, maximum: 20, description: 'Max runs to return (default 10).' },
            },
          },
        },
      },
      exec: exec_get_workflow_runs,
    },
  ];

  // ─── Tool executor with timeout + arg validation ────
  const TOOL_TIMEOUT_MS = 8000;
  async function executeTool(name, args) {
    const tool = TOOLS.find(t => t.schema.function.name === name);
    if (!tool) return { error: `Unknown tool: ${name}` };
    const validated = _validateArgs(args || {}, tool.schema.function.parameters);
    if (validated.error) return { error: validated.error };
    try {
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error(`Tool ${name} timed out after ${TOOL_TIMEOUT_MS}ms`)), TOOL_TIMEOUT_MS));
      const result = await Promise.race([tool.exec(validated.args), timeout]);
      return result;
    } catch (e) {
      return { error: String(e.message || e) };
    }
  }

  // Minimal JSON schema validator (type + required only — enough for AI inputs)
  function _validateArgs(args, schema) {
    if (!schema || schema.type !== 'object') return { args };
    const out = {};
    const props = schema.properties || {};
    for (const [k, v] of Object.entries(args)) {
      if (!(k in props)) continue; // silently drop unknown
      const expected = props[k].type;
      const actual = Array.isArray(v) ? 'array' : typeof v;
      if (expected && expected !== actual && !(expected === 'integer' && actual === 'number')) {
        return { error: `Arg "${k}" expected ${expected}, got ${actual}` };
      }
      out[k] = v;
    }
    for (const req of (schema.required || [])) {
      if (!(req in out)) return { error: `Missing required arg: ${req}` };
    }
    return { args: out };
  }

  function getToolSchemas() {
    return TOOLS.map(t => t.schema);
  }

  // ═══════════════════════════════════════════════════
  //  PHASE 3 — Mutation tools (propose-then-apply)
  //  These return proposal objects; NEVER mutate Gist directly.
  // ═══════════════════════════════════════════════════

  function _uuid() { return 'p-' + crypto.randomUUID(); }
  function _expiresAt() { return Date.now() + 5 * 60 * 1000; }

  function _checkRateLimit() {
    if (window.AIProposals && window.AIProposals.isAtLimit()) {
      return { error: 'rate_limit', message: 'Max 5 proposals per message. Please send a new message to propose more.' };
    }
    return null;
  }

  function _registerProposal(proposal) {
    if (window.AIProposals) window.AIProposals.register(proposal);
    return {
      proposal_id: proposal.proposal_id,
      summary: _proposalSummary(proposal),
      warning_count: (proposal.warnings || []).length,
      error_count: (proposal.errors || []).length,
    };
  }

  function _proposalSummary(p) {
    switch (p.kind) {
      case 'create_once': return `Schedule once: ${p.diff.after.workflow} at ${p.diff.after.run_at}`;
      case 'create_recurring': return `Schedule recurring: ${p.diff.after.workflow} ${p.diff.after.recurrence?.pattern} at ${p.diff.after.recurrence?.time}`;
      case 'create_ot': return `OT request: ${p.diff.after.date} ${p.diff.after.start}-${p.diff.after.end} (${p.diff.after.hours}h)`;
      case 'update_schedule': return `Update schedule entry ${p.diff.after?.id || ''}`;
      case 'delete_schedule': return `Delete schedule entry ${p.diff.before?.id || ''}`;
      case 'add_skip_date': return `Add skip_date ${p.diff.after?.skip_dates?.slice(-1)?.[0] || ''} to ${p.diff.after?.id || ''}`;
      default: return p.kind;
    }
  }

  // ─── 7. propose_create_schedule_once ────────────────
  async function exec_propose_create_schedule_once(args) {
    const rl = _checkRateLimit(); if (rl) return rl;
    const { workflow, datetime, location, latitude, longitude, note } = args || {};
    const v = window.AIValidators.validateOnceSchedule({ workflow, datetime, latitude, longitude });

    const entry = {
      id: crypto.randomUUID(),
      type: 'once',
      workflow: workflow || '',
      run_at: datetime || '',
      location: location || undefined,
      location_lat: latitude ? String(latitude) : undefined,
      location_lon: longitude ? String(longitude) : undefined,
      note: note || undefined,
      dispatched: false,
      last_run: null,
      enabled: true,
      created_at: new Date().toISOString(),
    };
    // Clean undefined
    Object.keys(entry).forEach(k => entry[k] === undefined && delete entry[k]);

    const proposal = {
      proposal_id: _uuid(),
      kind: 'create_once',
      target_file: SCHED_FILE,
      diff: { before: null, after: entry },
      sub_actions: [],
      warnings: v.warnings,
      errors: v.errors,
      expires_at: _expiresAt(),
    };
    return _registerProposal(proposal);
  }

  // ─── 8. propose_create_schedule_recurring ───────────
  async function exec_propose_create_schedule_recurring(args) {
    const rl = _checkRateLimit(); if (rl) return rl;
    const { workflow, pattern, time, days, dates, location, latitude, longitude, start_date, end_date } = args || {};
    const v = window.AIValidators.validateRecurringSchedule({ workflow, pattern, time, days, dates });

    const entry = {
      id: crypto.randomUUID(),
      type: 'recurring',
      workflow: workflow || '',
      recurrence: {
        pattern: pattern || '',
        time: time || '',
        days: (pattern === 'weekly' && Array.isArray(days)) ? days : undefined,
        dates: (pattern === 'monthly' && Array.isArray(dates)) ? dates : undefined,
        skip_dates: [],
      },
      location: location || undefined,
      location_lat: latitude ? String(latitude) : undefined,
      location_lon: longitude ? String(longitude) : undefined,
      enabled: true,
      start_date: start_date || undefined,
      end_date: end_date || undefined,
      last_run: null,
      created_at: new Date().toISOString(),
    };
    Object.keys(entry).forEach(k => entry[k] === undefined && delete entry[k]);
    if (entry.recurrence) Object.keys(entry.recurrence).forEach(k => entry.recurrence[k] === undefined && delete entry.recurrence[k]);

    const proposal = {
      proposal_id: _uuid(),
      kind: 'create_recurring',
      target_file: SCHED_FILE,
      diff: { before: null, after: entry },
      sub_actions: [],
      warnings: v.warnings,
      errors: v.errors,
      expires_at: _expiresAt(),
    };
    return _registerProposal(proposal);
  }

  // ─── 9. propose_create_ot_request ───────────────────
  async function exec_propose_create_ot_request(args) {
    const rl = _checkRateLimit(); if (rl) return rl;
    const { date, start, end, reason } = args || {};

    // Load current data for validation
    let existingOts = [], schedEntries = [];
    try {
      const gist = await _loadGist();
      const otRaw = _parseFile(gist, OT_FILE);
      existingOts = Array.isArray(otRaw) ? otRaw : (Array.isArray(otRaw?.requests) ? otRaw.requests : []);
      const schedRaw = _parseFile(gist, SCHED_FILE);
      schedEntries = Array.isArray(schedRaw) ? schedRaw : (Array.isArray(schedRaw?.entries) ? schedRaw.entries : []);
    } catch (e) {
      return { error: `Failed to load Gist: ${e.message}` };
    }

    const v = window.AIValidators.validateOtRequest({ date, start, end }, existingOts, schedEntries);

    // Calculate hours
    const [sh, sm] = (start || '00:00').split(':').map(Number);
    const [eh, em] = (end || '00:00').split(':').map(Number);
    let mins = (eh * 60 + em) - (sh * 60 + sm);
    if (mins <= 0) mins += 24 * 60;
    const hours = Math.round(mins / 60 * 100) / 100;

    const entry = {
      id: crypto.randomUUID(),
      date: date || '',
      start: start || '',
      end: end || '',
      hours,
      reason: reason || 'OT work',
      created_at: new Date().toISOString(),
    };

    const subActions = [];
    // Auto-detect Rule 2 conflict — add skip_date sub-action
    if (window.AIValidators.detectCrossMidnight(start, end)) {
      const conflicts = window.AIValidators.findConflictingRecurringCO(date, schedEntries);
      for (const conflict of conflicts) {
        const rec = conflict.recurrence || {};
        const skipDates = [...(rec.skip_dates || []), date];
        subActions.push({
          kind: 'add_skip_date',
          target_file: SCHED_FILE,
          summary: `Add skip_date ${date} to recurring CO (${conflict.id})`,
          diff: {
            before: { id: conflict.id, skip_dates: rec.skip_dates || [] },
            after: { id: conflict.id, skip_dates: skipDates },
          },
        });
      }
    }

    const proposal = {
      proposal_id: _uuid(),
      kind: 'create_ot',
      target_file: OT_FILE,
      diff: { before: null, after: entry },
      sub_actions: subActions,
      warnings: v.warnings,
      errors: v.errors,
      expires_at: _expiresAt(),
    };
    return _registerProposal(proposal);
  }

  // ─── 10. propose_update_schedule ────────────────────
  async function exec_propose_update_schedule(args) {
    const rl = _checkRateLimit(); if (rl) return rl;
    const { id, updates } = args || {};
    if (!id) return { error: 'id is required' };
    if (!updates || typeof updates !== 'object') return { error: 'updates object is required' };

    let schedEntries = [];
    try {
      const gist = await _loadGist();
      const raw = _parseFile(gist, SCHED_FILE);
      schedEntries = Array.isArray(raw) ? raw : (Array.isArray(raw?.entries) ? raw.entries : []);
    } catch (e) { return { error: `Failed to load Gist: ${e.message}` }; }

    const entry = schedEntries.find(e => e.id === id);
    if (!entry) return { error: `Entry ${id} not found` };

    const after = { ...entry, ...updates, id };
    const warnings = [], errors = [];
    // Cannot update dispatched once entry
    if (entry.dispatched && entry.type === 'once') {
      errors.push('Cannot update a dispatched once entry');
    }

    const proposal = {
      proposal_id: _uuid(),
      kind: 'update_schedule',
      target_file: SCHED_FILE,
      diff: { before: entry, after },
      sub_actions: [],
      warnings,
      errors,
      expires_at: _expiresAt(),
    };
    return _registerProposal(proposal);
  }

  // ─── 11. propose_delete_schedule ────────────────────
  async function exec_propose_delete_schedule(args) {
    const rl = _checkRateLimit(); if (rl) return rl;
    const { id } = args || {};
    if (!id) return { error: 'id is required' };

    let schedEntries = [];
    try {
      const gist = await _loadGist();
      const raw = _parseFile(gist, SCHED_FILE);
      schedEntries = Array.isArray(raw) ? raw : (Array.isArray(raw?.entries) ? raw.entries : []);
    } catch (e) { return { error: `Failed to load Gist: ${e.message}` }; }

    const entry = schedEntries.find(e => e.id === id);
    if (!entry) return { error: `Entry ${id} not found` };

    // Hard refuse: cannot delete dispatched entry
    if (entry.dispatched) {
      return { error: 'Cannot delete a dispatched entry (dispatched=true). This entry has already run.' };
    }

    const proposal = {
      proposal_id: _uuid(),
      kind: 'delete_schedule',
      target_file: SCHED_FILE,
      diff: { before: entry, after: null },
      sub_actions: [],
      warnings: [],
      errors: [],
      expires_at: _expiresAt(),
    };
    return _registerProposal(proposal);
  }

  // ─── 12. propose_add_skip_date ──────────────────────
  async function exec_propose_add_skip_date(args) {
    const rl = _checkRateLimit(); if (rl) return rl;
    const { recurring_id, date } = args || {};

    let schedEntries = [];
    try {
      const gist = await _loadGist();
      const raw = _parseFile(gist, SCHED_FILE);
      schedEntries = Array.isArray(raw) ? raw : (Array.isArray(raw?.entries) ? raw.entries : []);
    } catch (e) { return { error: `Failed to load Gist: ${e.message}` }; }

    const v = window.AIValidators.validateSkipDate(schedEntries, recurring_id, date);
    if (v.errors.length) return { error: v.errors[0] };

    const entry = schedEntries.find(e => e.id === recurring_id);
    const rec = entry.recurrence || {};
    const currentSkips = rec.skip_dates || [];
    const newSkips = [...currentSkips, date];

    const proposal = {
      proposal_id: _uuid(),
      kind: 'add_skip_date',
      target_file: SCHED_FILE,
      diff: {
        before: { id: recurring_id, skip_dates: currentSkips },
        after: { id: recurring_id, skip_dates: newSkips },
      },
      sub_actions: [],
      warnings: v.warnings,
      errors: [],
      expires_at: _expiresAt(),
    };
    return _registerProposal(proposal);
  }

  // ─── Register mutation tools ──────────────────────────
  TOOLS.push(
    {
      schema: {
        type: 'function',
        function: {
          name: 'propose_create_schedule_once',
          description: 'Propose creating a one-time scheduled workflow run. Returns a proposal for user confirmation — does NOT execute immediately.',
          parameters: {
            type: 'object',
            properties: {
              workflow: { type: 'string', description: 'Workflow file name (e.g. auto-checkin.yml)' },
              datetime: { type: 'string', description: 'ISO 8601 datetime with timezone (e.g. 2026-05-22T09:00:00+09:00)' },
              location: { type: 'string', description: 'Location name (optional)' },
              latitude: { type: 'string', description: 'GPS latitude override (optional)' },
              longitude: { type: 'string', description: 'GPS longitude override (optional)' },
              note: { type: 'string', description: 'Optional note' },
            },
            required: ['workflow', 'datetime'],
          },
        },
      },
      exec: exec_propose_create_schedule_once,
    },
    {
      schema: {
        type: 'function',
        function: {
          name: 'propose_create_schedule_recurring',
          description: 'Propose creating a recurring scheduled workflow run. Returns a proposal for user confirmation.',
          parameters: {
            type: 'object',
            properties: {
              workflow: { type: 'string', description: 'Workflow file name' },
              pattern: { type: 'string', enum: ['daily', 'weekdays', 'weekly', 'monthly'], description: 'Recurrence pattern' },
              time: { type: 'string', description: 'HH:MM time in JST' },
              days: { type: 'array', items: { type: 'integer' }, description: 'Days of week for weekly (0=Sun..6=Sat)' },
              dates: { type: 'array', items: { type: 'integer' }, description: 'Days of month for monthly (1-31)' },
              location: { type: 'string', description: 'Location name (optional)' },
              latitude: { type: 'string', description: 'GPS latitude (optional)' },
              longitude: { type: 'string', description: 'GPS longitude (optional)' },
              start_date: { type: 'string', description: 'Start date YYYY-MM-DD (optional)' },
              end_date: { type: 'string', description: 'End date YYYY-MM-DD (optional)' },
            },
            required: ['workflow', 'pattern', 'time'],
          },
        },
      },
      exec: exec_propose_create_schedule_recurring,
    },
    {
      schema: {
        type: 'function',
        function: {
          name: 'propose_create_ot_request',
          description: 'Propose creating an OT (overtime) request. Auto-detects cross-midnight Rule 2 conflicts and includes skip_date sub-actions. Returns proposal for user confirmation.',
          parameters: {
            type: 'object',
            properties: {
              date: { type: 'string', description: 'YYYY-MM-DD JST date for OT' },
              start: { type: 'string', description: 'HH:MM start time' },
              end: { type: 'string', description: 'HH:MM end time (can be past midnight, e.g. 03:30)' },
              reason: { type: 'string', description: 'Reason for OT (optional, defaults to "OT work")' },
            },
            required: ['date', 'start', 'end'],
          },
        },
      },
      exec: exec_propose_create_ot_request,
    },
    {
      schema: {
        type: 'function',
        function: {
          name: 'propose_update_schedule',
          description: 'Propose updating an existing schedule entry by ID. Returns proposal for user confirmation.',
          parameters: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Entry UUID to update' },
              updates: { type: 'object', description: 'Key-value pairs to update (e.g. {time: "09:30", location: "wfh"})' },
            },
            required: ['id', 'updates'],
          },
        },
      },
      exec: exec_propose_update_schedule,
    },
    {
      schema: {
        type: 'function',
        function: {
          name: 'propose_delete_schedule',
          description: 'Propose deleting a schedule entry. REFUSES if entry has dispatched=true.',
          parameters: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Entry UUID to delete' },
            },
            required: ['id'],
          },
        },
      },
      exec: exec_propose_delete_schedule,
    },
    {
      schema: {
        type: 'function',
        function: {
          name: 'propose_add_skip_date',
          description: 'Propose adding a skip_date to a recurring schedule entry (e.g. to prevent recurring CO from clipping cross-midnight OT).',
          parameters: {
            type: 'object',
            properties: {
              recurring_id: { type: 'string', description: 'ID of the recurring entry' },
              date: { type: 'string', description: 'YYYY-MM-DD date to skip' },
            },
            required: ['recurring_id', 'date'],
          },
        },
      },
      exec: exec_propose_add_skip_date,
    },
  );

  window.AITools = { executeTool, getToolSchemas, TOOLS };
})();
