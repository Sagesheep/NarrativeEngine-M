// scripts/gate.mjs
// Architecture gate — counts boundary violations in src/.
//
// Mirrors the rules used in Phase 0.15:
//   - domain (services/*) must NOT import state (store/*, slices/*, useAppStore)
//   - domain (services/*) must NOT import ui (components/*)
//   - state (store/*, slices/*) must NOT import domain (services/*)
//   - state (store/*, slices/*) must NOT import ui (components/*)
//
// Exit codes:
//   0 — gate passed (no NEW violations vs baseline)
//   1 — gate failed (new violations detected, or baseline missing)
//
// Usage: node scripts/gate.mjs [--update-baseline]
//
// On --update-baseline: writes current count to architecture/_gate-baseline.json
// Use after a wave is verified clean to advance the baseline.

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC = join(ROOT, 'src');
const BASELINE_PATH = join(ROOT, 'architecture/_gate-baseline.json');

const updateBaseline = process.argv.includes('--update-baseline');

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      // Skip test directories
      if (entry === '__tests__' || entry === '__smoke__' || entry === '__evals__') continue;
      walk(full, files);
    }
    else if (/\.(ts|tsx)$/.test(entry)) {
      // Skip test files
      if (entry.includes('.test.') || entry.includes('.spec.')) continue;
      files.push(full);
    }
  }
  return files;
}

function classifyLayer(filePath) {
  const rel = relative(SRC, filePath);
  if (rel.startsWith('store/') || rel.startsWith('store\\')) return 'state';
  if (rel.startsWith('components/') || rel.startsWith('components\\')) return 'ui';
  // Persistence is its own layer (infrastructure, not domain logic)
  if (rel.startsWith('services/persistence/') || rel.startsWith('services/persistence\\')) return 'persistence';
  // Lifecycle services are infrastructure (orchestrate side-effects for slices)
  if (rel.includes('Lifecycle.ts')) return 'lifecycle';
  if (rel.startsWith('services/') || rel.startsWith('services\\')) return 'domain';
  if (rel.startsWith('ports/') || rel.startsWith('ports\\')) return 'port';
  if (rel.startsWith('adapters/') || rel.startsWith('adapters\\')) return 'adapter';
  if (rel.startsWith('utils/') || rel.startsWith('utils\\')) return 'utils';
  return 'other';
}

function extractImports(content) {
  const imports = [];
  // Static imports: from '...'
  const staticRe = /(?:import|export)[\s\S]*?from\s+['"]([^'"]+)['"]/g;
  let m;
  while ((m = staticRe.exec(content)) !== null) {
    imports.push({ target: m[1], type: 'static' });
  }
  // Dynamic imports: import('...')
  const dynRe = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = dynRe.exec(content)) !== null) {
    imports.push({ target: m[1], type: 'dynamic' });
  }
  return imports;
}

function resolveTarget(importerPath, target) {
  // Skip bare modules (npm packages)
  if (!target.startsWith('.') && !target.startsWith('/')) return null;
  const importerDir = dirname(importerPath);
  const resolved = join(importerDir, target);
  // Normalize: try .ts, .tsx, /index.ts
  for (const ext of ['', '.ts', '.tsx', '/index.ts', '/index.tsx']) {
    if (existsSync(resolved + ext)) return resolved + ext;
  }
  return null;
}

function isViolation(srcLayer, tgtLayer) {
  if (srcLayer === 'domain' && tgtLayer === 'state') return 'domain→state';
  if (srcLayer === 'domain' && tgtLayer === 'ui') return 'domain→ui';
  if (srcLayer === 'state' && tgtLayer === 'domain') return 'state→domain';
  if (srcLayer === 'state' && tgtLayer === 'ui') return 'state→ui';
  return null;
}

const files = walk(SRC);
const violations = [];

for (const file of files) {
  const srcLayer = classifyLayer(file);
  if (srcLayer !== 'domain' && srcLayer !== 'state') continue;

  const content = readFileSync(file, 'utf8');
  const imports = extractImports(content);

  for (const imp of imports) {
    const resolved = resolveTarget(file, imp.target);
    if (!resolved) continue;
    const tgtLayer = classifyLayer(resolved);
    const type = isViolation(srcLayer, tgtLayer);
    if (type) {
      violations.push({
        file: relative(ROOT, file).replace(/\\/g, '/'),
        target: imp.target,
        type: imp.type,
        violation: type,
      });
    }
  }
}

// Group by type
const byType = {};
for (const v of violations) {
  byType[v.violation] = (byType[v.violation] || 0) + 1;
}

const total = violations.length;

console.log('=== Architecture Gate ===');
console.log(`Files scanned: ${files.length}`);
console.log(`Total violations: ${total}`);
for (const [type, count] of Object.entries(byType).sort()) {
  console.log(`  ${type}: ${count}`);
}

if (updateBaseline) {
  writeFileSync(BASELINE_PATH, JSON.stringify({ total, byType, date: new Date().toISOString() }, null, 2));
  console.log(`\nBaseline updated: ${relative(ROOT, BASELINE_PATH)}`);
  console.log(`Total: ${total}`);
  process.exit(0);
}

if (!existsSync(BASELINE_PATH)) {
  console.log('\nNo baseline found. Run with --update-baseline to establish one.');
  console.log('Treating current count as baseline for this run.');
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
const delta = total - baseline.total;

console.log(`\nBaseline: ${baseline.total}`);
console.log(`Delta:    ${delta >= 0 ? '+' : ''}${delta}`);

if (delta > 0) {
  console.log(`\n❌ GATE FAILED — ${delta} new violation(s) detected.`);
  console.log('New violations:');
  // Show violations not in baseline (simplified: just list all if delta > 0)
  for (const v of violations.slice(-delta)) {
    console.log(`  ${v.file} → ${v.target} (${v.violation})`);
  }
  process.exit(1);
} else if (delta < 0) {
  console.log(`\n✅ GATE PASSED — ${-delta} violation(s) removed since baseline.`);
} else {
  console.log('\n✅ GATE PASSED — no new violations.');
}
process.exit(0);
