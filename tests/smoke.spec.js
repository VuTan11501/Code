// Playwright smoke test — boots the static PWA against a local file server
// and asserts the unlock UI is reachable without any console errors.
// Catches regressions like a broken bundle, missing CSP capability, or
// inline-handler globals that got obfuscated away.

import { test, expect } from '@playwright/test';

test.describe('PWA boot smoke', () => {
  test('home page loads with unlock UI and no console errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const txt = msg.text();
        // Ignore third-party / expected noise:
        //   - Google Fonts CORS preflight (harmless)
        //   - Manifest icon 404s (we ship multiple sizes; some may be missing locally)
        //   - WebAuthn `NotAllowedError` (no platform authenticator in headless)
        if (/fonts\.gstatic|favicon|manifest|webauthn|notallowederror/i.test(txt)) return;
        errors.push(`console.error: ${txt}`);
      }
    });

    await page.goto('/');
    await expect(page).toHaveTitle(/workflow dashboard/i);

    // Auth section should be visible — either Unlock form (returning user)
    // or Setup form (first run). We don't know which; assert ONE is showing.
    const unlockVisible = await page.locator('#passphrase').isVisible().catch(() => false);
    const setupVisible  = await page.locator('#newToken').isVisible().catch(() => false);
    expect(unlockVisible || setupVisible).toBeTruthy();

    // Bundle must have loaded — `toast` is exposed on window by app.js.
    const hasToast = await page.evaluate(() => typeof window.toast === 'function');
    expect(hasToast).toBeTruthy();

    // CloudSync.fetchGist must exist (regression guard for the gist-cache
    // refactor we just shipped).
    const hasFetchGist = await page.evaluate(
      () => !!(window.CloudSync && typeof window.CloudSync.fetchGist === 'function')
    );
    expect(hasFetchGist).toBeTruthy();

    if (errors.length) {
      throw new Error('Unexpected console errors during boot:\n' + errors.join('\n'));
    }
  });

  test('profile switch card skeleton exists in settings DOM', async ({ page }) => {
    await page.goto('/');
    const hasCard = await page.evaluate(() => !!document.getElementById('profileSwitchCard'));
    expect(hasCard).toBeTruthy();
  });

  test('CSP meta tag is present', async ({ page }) => {
    await page.goto('/');
    const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
    expect(csp).toContain("connect-src 'self' https://api.github.com");
    expect(csp).toContain("base-uri 'self'");
  });

  test('service worker registers', async ({ page }) => {
    await page.goto('/');
    // Wait up to 5s for registration. SW can take a tick.
    const registered = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return false;
      // Wait briefly for SW.register() to resolve
      for (let i = 0; i < 20; i++) {
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg) return true;
        await new Promise(r => setTimeout(r, 250));
      }
      return false;
    });
    if (page.url().startsWith('http')) {
      expect(registered).toBeTruthy();
    }
  });
});
