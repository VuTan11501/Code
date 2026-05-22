// Helpers for loading docs/js/*.js script-mode files into a sandbox context
// for unit testing. The files are loaded as <script> tags in the browser,
// so they expose globals like `window.OT_SALARY` rather than ES exports.
//
// We use Node's `vm` module to evaluate the source in a fresh context with
// a stubbed `window` and `document` so pure functions become callable.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_JS = resolve(__dirname, '..', 'docs', 'js');

export function loadDocsScripts(files) {
  const win = {};
  const doc = {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    createElement: () => ({ style: {}, classList: { add(){}, remove(){}, toggle(){} }, setAttribute(){}, appendChild(){} }),
    body: { appendChild(){}, classList: { add(){}, remove(){}, toggle(){} } },
    documentElement: { scrollTop: 0 },
  };
  const ctx = vm.createContext({
    window: win,
    document: doc,
    navigator: { userAgent: 'node' },
    location: { hash: '', href: '' },
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, JSON,
  });
  // self-reference so `window.X = ...` is reachable as ctx.window.X
  for (const f of files) {
    const src = readFileSync(resolve(DOCS_JS, f), 'utf8');
    vm.runInContext(src, ctx, { filename: f });
  }
  return ctx;
}
