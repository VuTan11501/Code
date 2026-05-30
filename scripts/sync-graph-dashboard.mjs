#!/usr/bin/env node
/**
 * sync-graph-dashboard.mjs
 *
 * Mirrors the freshly generated knowledge graph into the static dashboard
 * directory served by Cloudflare Pages.
 *
 * The dashboard SHELL (HTML/JS/CSS in graph-dashboard/) is built once from the
 * understand-anything plugin and rarely changes. The graph DATA, however, is
 * regenerated every time you run `/understand`. This script copies the latest
 * graph JSON from `.understand-anything/` into `graph-dashboard/` so a plain
 * push redeploys the updated graph (Cloudflare Pages serves the directory as-is,
 * no build step).
 *
 * Usage:
 *   node scripts/sync-graph-dashboard.mjs
 *
 * Run it after regenerating the graph (locally via the agent) or let the
 * `sync-graph-dashboard.yml` workflow run it automatically on push.
 */
import { existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(repoRoot, '.understand-anything');
const outDir = join(repoRoot, 'graph-dashboard');

// fileName -> required? (optional files are skipped silently when absent)
const FILES = [
  ['knowledge-graph.json', true],
  ['meta.json', true],
  ['domain-graph.json', false],
  ['diff-overlay.json', false],
];

if (!existsSync(srcDir)) {
  console.error(`[sync] ERROR: ${srcDir} not found. Run /understand first.`);
  process.exit(1);
}
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

let copied = 0;
let missingRequired = false;
for (const [name, required] of FILES) {
  const src = join(srcDir, name);
  if (!existsSync(src)) {
    if (required) {
      console.error(`[sync] ERROR: required file missing: ${src}`);
      missingRequired = true;
    }
    continue;
  }
  copyFileSync(src, join(outDir, name));
  console.log(`[sync] copied ${name}`);
  copied++;
}

if (missingRequired) process.exit(1);
console.log(`[sync] done — ${copied} file(s) mirrored into graph-dashboard/`);
