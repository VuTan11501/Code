// Vitest config — only run *.test.mjs files in tests/. Playwright smoke
// tests live alongside them but use a different runner.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.mjs'],
    exclude: ['node_modules', 'tests/smoke.spec.js', 'playwright.config.js'],
  },
});
