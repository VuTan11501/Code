// ─────────────────────────────────────────────────────────────────────────
//  build-js.mjs — concat → minify → (optional) obfuscate page scripts
//
//  All page scripts in docs/js/*.js are written in legacy script-mode
//  (no ESM imports; share globals via window). We concatenate them in
//  the exact order they were loaded in index.html, then run esbuild's
//  minifier (preserving top-level names so window.X handlers survive),
//  then optionally pipe through javascript-obfuscator with a moderate
//  config (string-array + locals only; renameGlobals=false).
//
//  Usage:
//    node scripts/build-js.mjs            → minify only
//    node scripts/build-js.mjs --obfuscate → minify + obfuscate
//
//  Output: docs/dist/app.bundle.min.js
// ─────────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';
import JavaScriptObfuscator from 'javascript-obfuscator';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC_DIR = join(ROOT, 'docs', 'js');
const OUT_DIR = join(ROOT, 'docs', 'dist');
const OUT_FILE = join(OUT_DIR, 'app.bundle.min.js');

// Must match the order in index.html. Dependencies that come later in
// the array can rely on earlier files (e.g. ot-planner depends on
// ot-salary; ai-agent depends on ai-tools).
const SCRIPT_ORDER = [
  'icons.js',
  'no-autofill.js',
  'theme.js',
  'ui-toast.js',
  'locations.js',
  'biometric.js',
  'cloud-sync.js',
  'app.js',
  'dashboard.js',
  'schedule.js',
  'ot-salary.js',
  'ot-planner.js',
  'timesheet.js',
  'ai-validators.js',
  'ai-audit.js',
  'ai-proposals.js',
  'ai-tools.js',
  'ai-agent.js',
  'insights.js',
  'settings.js',
];

const OBFUSCATE = process.argv.includes('--obfuscate');

async function main() {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  // 1. Concatenate in order, each wrapped in its own "// ── file ──"
  //    banner comment so any runtime stack trace still hints at origin.
  let bytesIn = 0;
  const parts = [];
  for (const name of SCRIPT_ORDER) {
    const p = join(SRC_DIR, name);
    if (!existsSync(p)) {
      console.warn(`[build-js] missing ${name}, skipping`);
      continue;
    }
    const src = readFileSync(p, 'utf8');
    bytesIn += statSync(p).size;
    parts.push(`/* === ${name} === */\n${src}\n`);
  }
  const concatenated = parts.join('\n;\n');
  console.log(`[build-js] concatenated ${parts.length} files → ${(bytesIn / 1024).toFixed(1)} KB raw`);

  // 2. Minify via esbuild. format:'iife' wraps everything in a function
  //    scope which would break window.X access — so we use 'script'
  //    which preserves top-level identifiers as globals. minifyIdentifiers
  //    only renames LOCAL names (esbuild doesn't rename script-mode
  //    top-level vars).
  const minified = await transform(concatenated, {
    loader: 'js',
    minify: true,
    target: ['es2019'],     // good support: Chrome 71, Safari 12.1, FF 64, Edge 79
    legalComments: 'none',
    sourcemap: false,
    keepNames: true,        // preserve fn.name for code that introspects
  });
  console.log(`[build-js] minified → ${(minified.code.length / 1024).toFixed(1)} KB`);

  let finalCode = minified.code;

  // 3. Optional obfuscation pass. Settings tuned to NOT explode size or
  //    runtime cost: string-array + base64 (cheap), no control-flow
  //    flattening, no dead-code injection, no self-defending (which
  //    breaks if anything format-pretty-prints the bundle).
  if (OBFUSCATE) {
    console.log('[build-js] obfuscating …');
    const t0 = Date.now();
    const result = JavaScriptObfuscator.obfuscate(finalCode, {
      compact: true,
      controlFlowFlattening: false,
      deadCodeInjection: false,
      debugProtection: false,
      disableConsoleOutput: false,
      identifierNamesGenerator: 'mangled',
      log: false,
      numbersToExpressions: false,
      renameGlobals: false,        // CRITICAL: keeps window.X function names
      selfDefending: false,
      simplify: true,
      splitStrings: false,
      stringArray: true,
      stringArrayEncoding: ['base64'],
      stringArrayThreshold: 0.75,
      transformObjectKeys: false,
      unicodeEscapeSequence: false,
      reservedStrings: [
        // keep workflow filenames and gist filenames readable so server-
        // side scripts that grep for them still work
        '\\.yml$', '^timesheet-history', '^scheduled-runs', '^ot-requests',
      ],
    });
    finalCode = result.getObfuscatedCode();
    console.log(`[build-js] obfuscated in ${Date.now() - t0}ms → ${(finalCode.length / 1024).toFixed(1)} KB`);
  }

  writeFileSync(OUT_FILE, finalCode, 'utf8');
  const reduction = ((1 - finalCode.length / bytesIn) * 100).toFixed(1);
  console.log(`[build-js] wrote ${OUT_FILE}`);
  console.log(`[build-js] size: ${(bytesIn / 1024).toFixed(1)} KB → ${(finalCode.length / 1024).toFixed(1)} KB (${reduction}% smaller)`);
}

main().catch(e => { console.error(e); process.exit(1); });
