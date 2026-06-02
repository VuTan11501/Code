// suica-export.js — manual-editor export bridge.
//
// Responsibilities:
//   1. Normalize manual-editor state (entries + range + settings) into the
//      history JSON shape consumed by suica-history.js / suica-planner.js.
//   2. Always download a JSON backup before any PDF attempt so the user keeps
//      a deterministic artifact even when the heavyweight PDF pipeline is
//      unavailable or fails.
//   3. Hand the history off to the existing planner-driven PDF generator via
//      one of two opt-in globals, in priority order:
//        a) window.SuicaPlannerManualExport(history)        // preferred
//        b) window.SuicaPlannerExport.exportPdfFromHistory  // legacy
//      If neither exists, return a structured failure instead of throwing.
//
// Zero external deps. Pure DOM + IIFE.
;(function () {
  'use strict';

  // ───── kind constants (mirror suica-editor-store) ───────
  var KIND_IN     = '入';
  var KIND_OUT    = '出';
  var KIND_SHOP   = '物販';
  var KIND_CHARGE = 'オートチャージ';

  // ───── tiny helpers ─────────────────────────────────────
  function isYmd(s) {
    return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s);
  }
  function toInt(n) {
    var v = Number(n);
    return Number.isFinite(v) ? Math.round(v) : 0;
  }
  function safeFilename(s) {
    return String(s || 'manual-history')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'manual-history';
  }

  // Derive the report "month" (YYYY-MM) from range.from or, failing that, the
  // first entry's datetime. Returns null when nothing is parseable.
  function deriveMonth(payload, sortedEntries) {
    var r = payload && payload.range;
    if (r && isYmd(r.from)) return r.from.slice(0, 7);
    if (sortedEntries && sortedEntries.length) {
      var first = sortedEntries[0];
      if (first && typeof first.datetime === 'string' && first.datetime.length >= 7) {
        return first.datetime.slice(0, 7);
      }
    }
    return null;
  }

  // ───── normalization ────────────────────────────────────
  //
  // buildHistory({entries, range, settings}) → history-shaped object.
  //
  // - Sorts entries chronologically by datetime string (lexicographic works
  //   because the store guarantees `YYYY-MM-DDTHH:mm[:ss]` JST-naive format).
  // - Strips store-internal fields (`id`) and surfaces only the viewer schema.
  // - Computes initial_balance / final_balance / total_spent / total_charged
  //   from the entry stream so the export is self-consistent even if upstream
  //   recompute logic drifts.
  function buildHistory(payload) {
    if (!payload || typeof payload !== 'object') {
      throw new Error('SuicaExport.buildHistory: payload must be an object');
    }
    var entriesIn = Array.isArray(payload.entries) ? payload.entries : [];
    var settings  = (payload.settings && typeof payload.settings === 'object') ? payload.settings : {};

    // Sort a shallow copy so we never mutate caller state.
    var sorted = entriesIn.slice().sort(function (a, b) {
      var ad = (a && a.datetime) || '';
      var bd = (b && b.datetime) || '';
      if (ad < bd) return -1;
      if (ad > bd) return 1;
      return 0;
    });

    // Project to viewer schema. Preserve datetime as the store's local JST
    // string — the viewer treats it as a string label, not a Date instance.
    var out = [];
    var totalSpent = 0;
    var totalCharged = 0;
    for (var i = 0; i < sorted.length; i++) {
      var e = sorted[i] || {};
      var kind = e.kind;
      var fare = toInt(e.fare_yen);
      var balance = toInt(e.balance_yen);
      var datetime = (typeof e.datetime === 'string') ? e.datetime : '';
      var station = (typeof e.station === 'string') ? e.station : '';

      if (kind === KIND_OUT || kind === KIND_SHOP) totalSpent += fare;
      else if (kind === KIND_CHARGE) totalCharged += fare;

      out.push({
        kind:        kind,
        datetime:    datetime,
        station:     station,
        fare_yen:    fare,
        balance_yen: balance
      });
    }

    var initialBalance = toInt(settings.initial_balance);
    var finalBalance   = out.length ? toInt(out[out.length - 1].balance_yen) : initialBalance;
    var month          = deriveMonth(payload, sorted);

    return {
      month:           month,
      initial_balance: initialBalance,
      final_balance:   finalBalance,
      total_spent:     totalSpent,
      total_charged:   totalCharged,
      entries:         out
    };
  }

  // ───── JSON download ────────────────────────────────────
  //
  // Triggers a browser download of `history` as JSON. Returns the filename
  // actually used. Throws if the DOM/Blob/URL plumbing is unavailable (the
  // caller is expected to surface this to the user — no silent swallow).
  function downloadHistoryJson(history, filename) {
    if (!history || typeof history !== 'object') {
      throw new Error('SuicaExport.downloadHistoryJson: history must be an object');
    }
    if (typeof Blob === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) {
      throw new Error('SuicaExport.downloadHistoryJson: Blob/URL API unavailable in this environment');
    }
    var name = filename;
    if (!name) {
      var month = history.month || 'unknown';
      name = 'manual-history-' + safeFilename(month) + '.json';
    } else {
      name = safeFilename(name);
      if (!/\.json$/i.test(name)) name += '.json';
    }

    var json = JSON.stringify(history, null, 2);
    var blob = new Blob([json], { type: 'application/json' });
    var url  = URL.createObjectURL(blob);
    try {
      var a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.rel = 'noopener';
      // Some browsers require the anchor be in the DOM for `.click()` to work.
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } finally {
      // Defer revoke so the browser has time to start the download.
      setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} }, 1500);
    }
    return name;
  }

  // ───── PDF handoff ──────────────────────────────────────
  //
  // Coerce whatever the downstream PDF bridge returns into a uniform
  // `{ok, message?}` shape. The downstream may return:
  //   - a Promise resolving to anything,
  //   - a sync truthy/falsy/object value,
  //   - or throw.
  // We always return a Promise so the caller can `.then()` uniformly.
  function coercePdfResult(rawReturn) {
    return Promise.resolve(rawReturn).then(function (val) {
      if (val && typeof val === 'object') {
        // Already structured — pass through but ensure `ok` is boolean.
        var ok = (val.ok !== false && val.pdfGenerated !== false);
        return { ok: ok, message: val.message || null, raw: val };
      }
      if (val === false) return { ok: false, message: 'PDF bridge reported failure.', raw: val };
      return { ok: true, message: null, raw: val };
    });
  }

  // Pragmatic fallback: trigger the existing #planner-generate-pdf button.
  // This reuses the planner's CURRENT state/UI (NOT the manual-editor history),
  // so the message must be explicit about that limitation.
  //
  // Implemented as a standalone function (NOT auto-installed onto window) so
  // that it cannot shadow the legacy SuicaPlannerExport.exportPdfFromHistory
  // bridge during the priority chain. Installed on `window` only as a
  // last-resort step inside tryPdfHandoff after A and B miss.
  function defaultManualExportShim(/* history */) {
    var btn = (typeof document !== 'undefined') ? document.getElementById('planner-generate-pdf') : null;
    if (!btn) {
      return {
        ok: false,
        message: 'Default shim: #planner-generate-pdf button not found in DOM — cannot trigger PDF generation.'
      };
    }
    if (btn.disabled) {
      return {
        ok: false,
        message: 'Default shim: #planner-generate-pdf is disabled (planner state not ready). JSON backup saved.'
      };
    }
    try {
      btn.click();
    } catch (err) {
      var emsg = (err && err.message) ? err.message : String(err);
      return { ok: false, message: 'Default shim: click() threw: ' + emsg };
    }
    // The planner button dispatches a long-running GitHub workflow that
    // builds the PDF off the planner's OWN state, not from the history we
    // just exported. Be explicit so the user is not misled.
    return {
      ok: true,
      message: 'Default shim: triggered planner PDF workflow using current planner state (NOT the manual-editor entries). JSON backup is the authoritative artifact for the manual session.'
    };
  }

  function tryPdfHandoff(history) {
    // Priority A: explicit manual-export hook registered by the planner.
    // Detect by checking it's a function AND is NOT our own shim (so an
    // earlier export call that auto-installed the shim doesn't get treated
    // as a "real" planner-registered bridge on the next call).
    if (typeof window.SuicaPlannerManualExport === 'function' &&
        window.SuicaPlannerManualExport.__suicaDefaultShim !== true) {
      try {
        return coercePdfResult(window.SuicaPlannerManualExport(history))
          .then(function (r) {
            return {
              pdfGenerated: !!r.ok,
              message: r.message || (r.ok ? 'PDF generated via SuicaPlannerManualExport.' : 'SuicaPlannerManualExport reported failure.')
            };
          });
      } catch (err) {
        var msgA = (err && err.message) ? err.message : String(err);
        return Promise.resolve({ pdfGenerated: false, message: 'SuicaPlannerManualExport threw: ' + msgA });
      }
    }
    // Priority B: legacy planner export.
    if (window.SuicaPlannerExport && typeof window.SuicaPlannerExport.exportPdfFromHistory === 'function') {
      try {
        return coercePdfResult(window.SuicaPlannerExport.exportPdfFromHistory(history))
          .then(function (r) {
            return {
              pdfGenerated: !!r.ok,
              message: r.message || (r.ok ? 'PDF generated via SuicaPlannerExport.' : 'SuicaPlannerExport reported failure.')
            };
          });
      } catch (err) {
        var msgB = (err && err.message) ? err.message : String(err);
        return Promise.resolve({ pdfGenerated: false, message: 'SuicaPlannerExport.exportPdfFromHistory threw: ' + msgB });
      }
    }
    // Priority C: install + invoke the default shim (last resort).
    // Installing on `window` makes the fallback discoverable to other modules
    // and to future calls, but the __suicaDefaultShim tag ensures it cannot
    // shadow a real bridge registered later.
    if (typeof window.SuicaPlannerManualExport !== 'function') {
      defaultManualExportShim.__suicaDefaultShim = true;
      window.SuicaPlannerManualExport = defaultManualExportShim;
    }
    try {
      return coercePdfResult(defaultManualExportShim(history))
        .then(function (r) {
          return {
            pdfGenerated: !!r.ok,
            message: r.message || (r.ok ? 'PDF generated via default shim.' : 'Default shim reported failure.')
          };
        });
    } catch (err) {
      var msgC = (err && err.message) ? err.message : String(err);
      return Promise.resolve({ pdfGenerated: false, message: 'Default shim threw: ' + msgC });
    }
  }

  // ───── public exportPdf ─────────────────────────────────
  //
  // Always:
  //   1. Build history.
  //   2. Download JSON backup (best-effort; failure here is reported but does
  //      NOT short-circuit the PDF attempt — the user may still want the PDF).
  //   3. Attempt PDF handoff.
  //
  // Returns: Promise<{ ok, historyDownloaded, pdfGenerated, message, history }>
  //   ok               := historyDownloaded || pdfGenerated  (at least one artifact produced)
  //   historyDownloaded:= JSON backup actually triggered
  //   pdfGenerated     := PDF bridge reported success
  //   message          := human-readable summary
  //   history          := the normalized history object (for caller inspection)
  function exportPdf(payload) {
    return new Promise(function (resolve) {
      var history;
      try {
        history = buildHistory(payload);
      } catch (err) {
        var msg = (err && err.message) ? err.message : String(err);
        resolve({
          ok:                false,
          historyDownloaded: false,
          pdfGenerated:      false,
          message:           'Failed to build history: ' + msg,
          history:           null
        });
        return;
      }

      var downloaded = false;
      var jsonMsg = null;
      try {
        downloadHistoryJson(history);
        downloaded = true;
      } catch (err) {
        jsonMsg = (err && err.message) ? err.message : String(err);
      }

      tryPdfHandoff(history).then(function (pdfRes) {
        var parts = [];
        if (downloaded) parts.push('JSON backup saved');
        else if (jsonMsg) parts.push('JSON backup FAILED (' + jsonMsg + ')');
        if (pdfRes.pdfGenerated) parts.push('PDF generated');
        else if (pdfRes.message) parts.push(pdfRes.message);

        resolve({
          ok:                downloaded || pdfRes.pdfGenerated,
          historyDownloaded: downloaded,
          pdfGenerated:      !!pdfRes.pdfGenerated,
          message:           parts.join(' · '),
          history:           history
        });
      }).catch(function (err) {
        // Defensive: tryPdfHandoff is structured to never reject, but if any
        // future bridge returns a rejecting promise that escapes its wrapper,
        // we must still resolve so the wizard's await never hangs.
        var emsg = (err && err.message) ? err.message : String(err);
        var parts = [];
        if (downloaded) parts.push('JSON backup saved');
        else if (jsonMsg) parts.push('JSON backup FAILED (' + jsonMsg + ')');
        parts.push('PDF bridge rejected: ' + emsg);
        resolve({
          ok:                downloaded,
          historyDownloaded: downloaded,
          pdfGenerated:      false,
          message:           parts.join(' · '),
          history:           history
        });
      });
    });
  }

  // ───── public surface ───────────────────────────────────
  window.SuicaExport = {
    buildHistory:        buildHistory,
    downloadHistoryJson: downloadHistoryJson,
    exportPdf:           exportPdf
  };
})();
