// ═══════════════════════════════════════════════════
//  Suica Date Range Picker
//  Vanilla shadcn/Calendar clone, mode="range" semantics.
//  Usage:
//    SuicaDateRange.mount(triggerEl, {
//      label: 'Filter dates',
//      onChange: ({ from, to }) => { ... }   // both may be null for cleared
//    });
//  No dependencies. Popover positioned under trigger, closes on outside
//  click / Esc. Range state lives inside the closure; trigger label
//  auto-updates to show "MMM d – MMM d".
// ═══════════════════════════════════════════════════
window.SuicaDateRange = (function () {
  'use strict';

  const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const DAY_LABELS  = ['Su','Mo','Tu','We','Th','Fr','Sa'];

  function ymd(d) {
    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  }
  function sameDay(a, b) { return a && b && a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate(); }
  function fmtLabel(from, to) {
    if (!from && !to) return null;
    if (from && !to) return `${MONTH_SHORT[from.getMonth()]} ${from.getDate()}, ${from.getFullYear()}`;
    const sameYear = from.getFullYear() === to.getFullYear();
    const left  = `${MONTH_SHORT[from.getMonth()]} ${from.getDate()}` + (sameYear ? '' : `, ${from.getFullYear()}`);
    const right = `${MONTH_SHORT[to.getMonth()]} ${to.getDate()}, ${to.getFullYear()}`;
    return `${left} – ${right}`;
  }
  function addMonths(d, n) { const x = new Date(d.getFullYear(), d.getMonth()+n, 1); return x; }

  function mount(trigger, opts) {
    opts = opts || {};
    const state = {
      from: opts.initialFrom || null,
      to:   opts.initialTo   || null,
      viewMonth: opts.initialFrom ? new Date(opts.initialFrom.getFullYear(), opts.initialFrom.getMonth(), 1) : new Date(new Date().getFullYear(), new Date().getMonth(), 1),
      open: false,
      pickStage: 'start', // 'start' or 'end'
    };

    // ─── Build popover element (once) ────────────────────────
    const popover = document.createElement('div');
    popover.className = 'suica-dr-popover';
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('aria-label', opts.label || 'Date range');
    popover.hidden = true;
    document.body.appendChild(popover);

    // Stop ALL clicks inside the popover from bubbling to document.
    // Without this, clicking a day cell triggers render() which replaces
    // the cell's DOM node; by the time the click bubbles up to document,
    // e.target is detached and popover.contains(e.target) is false,
    // so the outside-click handler incorrectly closes the popover.
    popover.addEventListener('mousedown', (e) => e.stopPropagation());
    popover.addEventListener('click',     (e) => e.stopPropagation());

    function buildMonth(viewDate, isRight) {
      const y = viewDate.getFullYear();
      const m = viewDate.getMonth();
      const firstDow = new Date(y, m, 1).getDay();
      const daysInMonth = new Date(y, m+1, 0).getDate();
      const today = new Date();
      const cells = [];
      // Leading blanks (prev-month days shown faintly)
      const prevMonthDays = new Date(y, m, 0).getDate();
      for (let i = firstDow; i > 0; i--) {
        const d = new Date(y, m-1, prevMonthDays - i + 1);
        cells.push({ date: d, outside: true });
      }
      for (let d = 1; d <= daysInMonth; d++) {
        cells.push({ date: new Date(y, m, d), outside: false });
      }
      // Trailing blanks to fill 6 rows
      const targetCells = Math.ceil(cells.length / 7) * 7;
      let n = 1;
      while (cells.length < targetCells) {
        cells.push({ date: new Date(y, m+1, n++), outside: true });
      }

      const headerHtml = `
        <div class="suica-dr-head">
          <button type="button" class="suica-dr-nav" data-nav="${isRight ? 'none-left' : 'prev'}" ${isRight ? 'style="visibility:hidden"' : ''} aria-label="Previous month">‹</button>
          <span class="suica-dr-title">${MONTH_NAMES[m]} ${y}</span>
          <button type="button" class="suica-dr-nav" data-nav="${isRight ? 'next' : 'none-right'}" ${isRight ? '' : 'style="visibility:hidden"'} aria-label="Next month">›</button>
        </div>`;
      const dowHtml = '<div class="suica-dr-dow">' + DAY_LABELS.map(l => `<span>${l}</span>`).join('') + '</div>';
      const gridHtml = '<div class="suica-dr-grid">' + cells.map(c => {
        const inRange = state.from && state.to && c.date >= state.from && c.date <= state.to;
        const isStart = sameDay(c.date, state.from);
        const isEnd   = sameDay(c.date, state.to);
        const isToday = sameDay(c.date, today);
        const classes = [
          c.outside ? 'is-outside' : '',
          inRange   ? 'is-in-range' : '',
          isStart   ? 'is-start' : '',
          isEnd     ? 'is-end' : '',
          isToday   ? 'is-today' : '',
        ].filter(Boolean).join(' ');
        return `<button type="button" class="suica-dr-day ${classes}" data-date="${ymd(c.date)}" tabindex="-1" aria-label="${c.date.toDateString()}">${c.date.getDate()}</button>`;
      }).join('') + '</div>';
      return `<div class="suica-dr-month">${headerHtml}${dowHtml}${gridHtml}</div>`;
    }

    function render() {
      const left  = state.viewMonth;
      const right = addMonths(left, 1);
      const labelText = fmtLabel(state.from, state.to);
      popover.innerHTML = `
        <div class="suica-dr-months">
          ${buildMonth(left, false)}
          ${buildMonth(right, true)}
        </div>
        <div class="suica-dr-foot">
          <div class="suica-dr-status">${labelText ? labelText : '<span class="text-muted-foreground">Pick a range</span>'}</div>
          <div class="suica-dr-actions">
            <button type="button" class="btn btn-ghost sm" data-action="clear">Clear</button>
            <button type="button" class="btn primary sm" data-action="apply" ${state.from && state.to ? '' : 'disabled'}>Apply</button>
          </div>
        </div>`;
      // Attach handlers (delegation would also work; direct is fine for this size)
      popover.querySelectorAll('[data-nav]').forEach(btn => {
        btn.addEventListener('click', () => {
          const dir = btn.dataset.nav === 'next' ? 1 : (btn.dataset.nav === 'prev' ? -1 : 0);
          if (dir) {
            state.viewMonth = addMonths(state.viewMonth, dir);
            render();
          }
        });
      });
      popover.querySelectorAll('.suica-dr-day').forEach(cell => {
        cell.addEventListener('click', () => {
          const d = new Date(cell.dataset.date + 'T00:00:00');
          if (state.pickStage === 'start' || !state.from) {
            state.from = d; state.to = null; state.pickStage = 'end';
          } else {
            // Second click — set end (swap if before start)
            if (d < state.from) { state.to = state.from; state.from = d; }
            else { state.to = d; }
            state.pickStage = 'start';
          }
          render();
        });
        cell.addEventListener('mouseenter', () => {
          if (!state.from || state.to || state.pickStage !== 'end') return;
          // Preview range from start to hovered
          const d = new Date(cell.dataset.date + 'T00:00:00');
          popover.querySelectorAll('.suica-dr-day').forEach(c => {
            const cd = new Date(c.dataset.date + 'T00:00:00');
            const inHover = (d >= state.from ? (cd >= state.from && cd <= d) : (cd >= d && cd <= state.from));
            c.classList.toggle('is-hover-range', inHover);
          });
        });
      });
      popover.querySelector('[data-action="clear"]').addEventListener('click', () => {
        state.from = null; state.to = null; state.pickStage = 'start';
        render();
      });
      popover.querySelector('[data-action="apply"]').addEventListener('click', commit);
    }

    function position() {
      const r = trigger.getBoundingClientRect();
      popover.style.position = 'fixed';
      popover.style.top  = (r.bottom + 6) + 'px';
      popover.style.left = Math.max(8, Math.min(r.left, window.innerWidth - popover.offsetWidth - 8)) + 'px';
      // If would overflow bottom, place above
      requestAnimationFrame(() => {
        const p = popover.getBoundingClientRect();
        if (p.bottom > window.innerHeight - 8) {
          popover.style.top = Math.max(8, r.top - p.height - 6) + 'px';
        }
      });
    }
    function open() {
      state.open = true; popover.hidden = false;
      render(); position();
      trigger.setAttribute('aria-expanded', 'true');
    }
    function close() {
      state.open = false; popover.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
    }
    function commit() {
      updateTriggerLabel();
      if (opts.onChange) opts.onChange({ from: state.from, to: state.to });
      close();
    }
    function updateTriggerLabel() {
      const labelEl = trigger.querySelector('[data-dr-label]') || trigger;
      const txt = fmtLabel(state.from, state.to);
      labelEl.textContent = txt || (opts.placeholder || 'Pick a date range');
      trigger.classList.toggle('has-value', !!txt);
    }
    trigger.setAttribute('aria-haspopup', 'dialog');
    trigger.setAttribute('aria-expanded', 'false');
    updateTriggerLabel();

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      state.open ? close() : open();
    });
    document.addEventListener('click', (e) => {
      if (!state.open) return;
      if (popover.contains(e.target) || trigger.contains(e.target)) return;
      close();
    });
    document.addEventListener('keydown', (e) => {
      if (state.open && e.key === 'Escape') { e.preventDefault(); close(); }
    });
    window.addEventListener('resize', () => { if (state.open) position(); });
    window.addEventListener('scroll', () => { if (state.open) position(); }, true);

    return {
      setRange(from, to) { state.from = from; state.to = to; updateTriggerLabel(); },
      clear() { state.from = null; state.to = null; updateTriggerLabel(); if (opts.onChange) opts.onChange({ from: null, to: null }); },
      getRange() { return { from: state.from, to: state.to }; },
    };
  }

  return { mount };
})();
