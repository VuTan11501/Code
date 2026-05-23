(function () {
  const KEY = 'wf_dash_session';

  // Token persists only within the browser session (sessionStorage) — same
  // lifetime as the main dashboard. Closing the tab / PWA clears it on
  // purpose (security: don't leave PAT in long-term storage).
  function getToken() {
    try { return sessionStorage.getItem(KEY) || null; } catch (_) { return null; }
  }

  // Redirect to the login screen (index.html). Preserves the current URL in
  // ?next= so we can bounce back after a successful unlock.
  function redirectToLogin(reason) {
    try {
      const next = encodeURIComponent(location.pathname + location.search + location.hash);
      const url = '/?next=' + next + (reason ? '&reason=' + encodeURIComponent(reason) : '');
      location.replace(url);
    } catch (_) {
      try { location.replace('/'); } catch (e) {}
    }
  }

  // Guard the current page: if no session token, redirect to login.
  // Call this at the top of pages that require auth.
  function requireLogin(reason) {
    if (!getToken()) { redirectToLogin(reason || 'required'); return false; }
    return true;
  }

  window.Auth = { getToken, redirectToLogin, requireLogin, KEY };
})();

