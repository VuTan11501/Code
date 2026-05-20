// ═══════════════════════════════════════════════════
//  AI VALIDATORS — Pure validation functions for schedule + OT proposals
//  No DOM, no Gist access. Pass data in, get { errors, warnings } out.
// ═══════════════════════════════════════════════════
(function () {
  'use strict';

  const OT_CAP_MONTHLY = 75;
  const OT_CAP_DAILY = 12;
  const VALID_WORKFLOWS = ['auto-checkin.yml', 'auto-checkout.yml', 'auto-ot-creator.yml', 'jpy-forecast.yml', 'ot-report.yml', 'schedule-generator.yml'];
  const VALID_PATTERNS = ['daily', 'weekdays', 'weekly', 'monthly'];

  function _isValidDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00+09:00')); }
  function _isValidTime(s) { return /^\d{2}:\d{2}$/.test(s); }
  function _isValidISO(s) { try { return !isNaN(new Date(s).getTime()); } catch { return false; } }

  function _parseHHMM(t) {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  }

  function _hoursForShift(start, end) {
    let s = _parseHHMM(start), e = _parseHHMM(end);
    if (e <= s) e += 24 * 60; // cross-midnight
    return (e - s) / 60;
  }

  // Detect if OT shift crosses midnight (start >= 22:00 and end < start in 24h clock)
  function detectCrossMidnight(start, end) {
    if (!start || !end) return false;
    const s = _parseHHMM(start), e = _parseHHMM(end);
    return e <= s; // end is next day
  }

  function validateOnceSchedule(entry) {
    const errors = [], warnings = [];
    if (!entry.workflow) errors.push('workflow is required');
    else if (!VALID_WORKFLOWS.includes(entry.workflow)) warnings.push(`Unknown workflow: ${entry.workflow}`);
    if (!entry.datetime) errors.push('datetime is required');
    else if (!_isValidISO(entry.datetime)) errors.push('datetime must be valid ISO');
    else {
      const dt = new Date(entry.datetime);
      if (dt.getTime() < Date.now() - 60000) warnings.push('datetime is in the past');
    }
    if (entry.latitude && isNaN(Number(entry.latitude))) errors.push('latitude must be numeric');
    if (entry.longitude && isNaN(Number(entry.longitude))) errors.push('longitude must be numeric');
    return { errors, warnings };
  }

  function validateRecurringSchedule(entry) {
    const errors = [], warnings = [];
    if (!entry.workflow) errors.push('workflow is required');
    else if (!VALID_WORKFLOWS.includes(entry.workflow)) warnings.push(`Unknown workflow: ${entry.workflow}`);
    if (!entry.pattern) errors.push('pattern is required');
    else if (!VALID_PATTERNS.includes(entry.pattern)) errors.push(`Invalid pattern: ${entry.pattern}. Must be one of: ${VALID_PATTERNS.join(', ')}`);
    if (!entry.time) errors.push('time is required (HH:MM)');
    else if (!_isValidTime(entry.time)) errors.push('time must be HH:MM format');
    if (entry.pattern === 'weekly') {
      if (!Array.isArray(entry.days) || !entry.days.length) errors.push('weekly pattern requires days array (0=Sun..6=Sat)');
      else if (entry.days.some(d => d < 0 || d > 6)) errors.push('days must be 0-6 (Sun=0)');
    }
    if (entry.pattern === 'monthly') {
      if (!Array.isArray(entry.dates) || !entry.dates.length) errors.push('monthly pattern requires dates array (1-31)');
      else if (entry.dates.some(d => d < 1 || d > 31)) errors.push('dates must be 1-31');
    }
    return { errors, warnings };
  }

  function validateOtRequest(entry, existingOts, existingSchedule) {
    const errors = [], warnings = [];
    if (!entry.date) errors.push('date is required (YYYY-MM-DD)');
    else if (!_isValidDate(entry.date)) errors.push('date format invalid');
    if (!entry.start) errors.push('start time is required (HH:MM)');
    else if (!_isValidTime(entry.start)) errors.push('start time format invalid');
    if (!entry.end) errors.push('end time is required (HH:MM)');
    else if (!_isValidTime(entry.end)) errors.push('end time format invalid');

    if (errors.length) return { errors, warnings };

    const hours = _hoursForShift(entry.start, entry.end);
    if (hours <= 0 || hours > OT_CAP_DAILY) errors.push(`Hours (${hours.toFixed(1)}) must be between 0 and ${OT_CAP_DAILY}`);

    // Labor Law §34: > 6h strictly requires 60min break (6h exactly is OK)
    if (hours > 6) warnings.push(`Shift > 6h (${hours.toFixed(1)}h) — 60min break will be deducted per Labor Law §34`);

    // Monthly cap check
    const month = entry.date.slice(0, 7);
    const existingHours = (existingOts || [])
      .filter(r => r.date && r.date.slice(0, 7) === month)
      .reduce((sum, r) => sum + (Number(r.hours) || _hoursForShift(r.start || '00:00', r.end || '00:00')), 0);
    if (existingHours + hours > OT_CAP_MONTHLY) {
      errors.push(`Monthly cap exceeded: existing ${existingHours.toFixed(1)}h + new ${hours.toFixed(1)}h = ${(existingHours + hours).toFixed(1)}h > ${OT_CAP_MONTHLY}h`);
    }

    // Daily cap check
    const sameDayOts = (existingOts || []).filter(r => r.date === entry.date);
    const dayHours = sameDayOts.reduce((s, r) => s + (Number(r.hours) || 0), 0);
    if (dayHours + hours > OT_CAP_DAILY) {
      errors.push(`Daily cap exceeded on ${entry.date}: existing ${dayHours.toFixed(1)}h + new ${hours.toFixed(1)}h > ${OT_CAP_DAILY}h`);
    }

    // Cross-midnight + Rule 2 conflict detection
    const isCrossMidnight = detectCrossMidnight(entry.start, entry.end);
    if (isCrossMidnight) {
      warnings.push('Cross-midnight OT detected — will check for recurring CO conflicts (Rule 2)');
      const conflicts = findConflictingRecurringCO(entry.date, existingSchedule || []);
      if (conflicts.length) {
        warnings.push(`Found ${conflicts.length} recurring CO entry that may clip this OT. A skip_date will be proposed.`);
      }
    }

    // Duplicate check
    const dup = (existingOts || []).find(r => r.date === entry.date && r.start === entry.start && r.end === entry.end);
    if (dup) errors.push(`Duplicate OT request exists for ${entry.date} ${entry.start}-${entry.end}`);

    return { errors, warnings };
  }

  function validateSkipDate(scheduleEntries, recurringId, date) {
    const errors = [], warnings = [];
    if (!recurringId) { errors.push('recurring_id is required'); return { errors, warnings }; }
    if (!date || !_isValidDate(date)) { errors.push('date must be valid YYYY-MM-DD'); return { errors, warnings }; }
    const entry = (scheduleEntries || []).find(e => e.id === recurringId);
    if (!entry) { errors.push(`Entry ${recurringId} not found`); return { errors, warnings }; }
    if (entry.type !== 'recurring') { errors.push(`Entry ${recurringId} is not recurring (type=${entry.type})`); return { errors, warnings }; }
    const rec = entry.recurrence || {};
    if (Array.isArray(rec.skip_dates) && rec.skip_dates.includes(date)) {
      warnings.push(`Date ${date} is already in skip_dates`);
    }
    return { errors, warnings };
  }

  // Find recurring CO entries (auto-checkout.yml) whose fire time on a given date
  // would be BEFORE midnight (and thus clip cross-midnight OT starting that day).
  function findConflictingRecurringCO(otDate, scheduleEntries) {
    if (!otDate || !Array.isArray(scheduleEntries)) return [];
    const d = new Date(otDate + 'T00:00:00+09:00');
    const dow = d.getDay(); // JS convention Sun=0
    return scheduleEntries.filter(e => {
      if (e.type !== 'recurring') return false;
      if (e.enabled === false) return false;
      if (e.workflow !== 'auto-checkout.yml') return false;
      const rec = e.recurrence || {};
      // Check if this recurring fires on otDate's day-of-week
      let fires = false;
      if (rec.pattern === 'daily') fires = true;
      else if (rec.pattern === 'weekdays') fires = [1, 2, 3, 4, 5].includes(dow);
      else if (rec.pattern === 'weekly') fires = (rec.days || []).includes(dow);
      else if (rec.pattern === 'monthly') fires = (rec.dates || []).includes(d.getDate());
      if (!fires) return false;
      // Check skip_dates — if already skipped, no conflict
      if (Array.isArray(rec.skip_dates) && rec.skip_dates.includes(otDate)) return false;
      // CO time < 22:00 is a potential conflict (would close session before OT)
      const time = rec.time || '18:00';
      const mins = _parseHHMM(time);
      return mins < 22 * 60; // fires before typical OT start
    });
  }

  window.AIValidators = {
    validateOnceSchedule,
    validateRecurringSchedule,
    validateOtRequest,
    validateSkipDate,
    detectCrossMidnight,
    findConflictingRecurringCO,
  };
})();
