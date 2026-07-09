#!/usr/bin/env node
/**
 * Strict gate check — runs after each refactor wave.
 *
 * Passes only if ALL of the following hold:
 *   GATE 4: no runtime cycle in store/slices/*
 *   GATE 5: no services/* imports from components/*
 *           no store/* imports from components/*
 *   GATE 6: no new services/* imports from store/* (compared to baseline)
 *
 * Catches BOTH static imports (`from '...'`) AND dynamic imports
 * (`import('...')`). Type-only imports (`import type`) are excluded.
 *
 * Run: node scripts/gate.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(p)) out.push(p);
  }
  return out;
}

const files = walk(SRC);

/**
 * Extract all import paths from a source file — both static
 * (`from '...'`) and dynamic (`import('...')`). Excludes type-only
 * imports. Returns a Set of module specifiers.
 */
function extractImports(content) {
  const imports = new Set();
  const lines = content.split('\n');
  for (const line of lines) {
    // Skip type-only imports
    if (line.match(/^\s*import\s+type\s/)) continue;
    // Static imports: from '...'
    const staticMatches = [...line.matchAll(/from\s+['"]([^'"]+)['"]/g)];
    for (const m of staticMatches) imports.add(m[1]);
    // Dynamic imports: import('...') — may be inline, not on own line
    const dynamicMatches = [...line.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)];
    for (const m of dynamicMatches) imports.add(m[1]);
  }
  return imports;
}

// ── GATE 4: runtime cycle in store/slices/* ──────────────────────────
console.log('═══════════════════════════════════════════════════════');
console.log('  GATE 4/6: no runtime cycle in store/slices/*');
console.log('═══════════════════════════════════════════════════════');

const sliceDir = join(SRC, 'store/slices');
const sliceFiles = walk(sliceDir).filter(f => !f.includes('__tests__') && !f.endsWith('saveController.ts'));

const adj = new Map();
for (const f of sliceFiles) {
  const name = f.replace(sliceDir + '/', '').replace(/\.(ts|tsx)$/, '');
  const content = readFileSync(f, 'utf8');
  const valueImports = [];
  const allImports = extractImports(content);
  for (const imp of allImports) {
    // Only look at relative imports between slices
    const m = imp.match(/^\.\/([^'"]+)$/);
    if (m) {
      const target = m[1].replace(/\.(ts|tsx)$/, '');
      if (target !== name) valueImports.push(target);
    }
  }
  adj.set(name, valueImports);
}

let cycleFound = null;
function dfs(node, visited, stack) {
  if (stack.has(node)) {
    cycleFound = [...stack, node].join(' → ');
    return true;
  }
  if (visited.has(node)) return false;
  visited.add(node);
  stack.add(node);
  for (const next of adj.get(node) || []) {
    if (dfs(next, visited, stack)) return true;
  }
  stack.delete(node);
  return false;
}
const visited = new Set();
for (const name of adj.keys()) {
  if (dfs(name, visited, new Set())) break;
}
if (cycleFound) {
  console.log(`❌ FAIL: runtime cycle detected: ${cycleFound}`);
  process.exit(1);
} else {
  console.log('✓ no runtime cycle in store/slices/*');
}

// ── GATE 5: layer violations (services/store → components) ───────────
// Now catches dynamic imports too.
console.log('\n═══════════════════════════════════════════════════════');
console.log('  GATE 5/6: no services/store → components imports (static + dynamic)');
console.log('═══════════════════════════════════════════════════════');

const layerLeaks = [];
for (const f of files) {
  const rel = relative(ROOT, f);
  if (rel.includes('__tests__')) continue;
  let content;
  try { content = readFileSync(f, 'utf8'); } catch { continue; }
  const isService = rel.startsWith('src/services/');
  const isStore = rel.startsWith('src/store/');
  if (!isService && !isStore) continue;
  const allImports = extractImports(content);
  for (const imp of allImports) {
    if (imp.includes('/components/')) {
      layerLeaks.push(`${rel} → ${imp}`);
    }
  }
}
if (layerLeaks.length > 0) {
  console.log(`❌ FAIL: ${layerLeaks.length} layer violations:`);
  layerLeaks.forEach(l => console.log(`  ${l}`));
  process.exit(1);
} else {
  console.log('✓ no services/store → components imports');
}

// ── GATE 6: no new services → store leak ──────────────────────────────
// Now catches dynamic imports too. Counts unique file → store pairs.
console.log('\n═══════════════════════════════════════════════════════');
console.log('  GATE 6/6: services → store leak (static + dynamic, non-test)');
console.log('═══════════════════════════════════════════════════════');

const svcToStore = [];
for (const f of files) {
  const rel = relative(ROOT, f);
  if (!rel.startsWith('src/services/')) continue;
  if (rel.includes('__tests__')) continue;
  let content;
  try { content = readFileSync(f, 'utf8'); } catch { continue; }
  const allImports = extractImports(content);
  for (const imp of allImports) {
    if (imp.includes('/store/useAppStore') || imp.includes('/store/campaignStore') || imp.includes('/store/slices/')) {
      svcToStore.push(`${rel} → ${imp}`);
    }
  }
}
console.log(`Current services → store leak count: ${svcToStore.length}`);
svcToStore.forEach(l => console.log(`  ${l}`));
// Baseline is 7 (6 files, 7 import paths — pendingCommit has 2).
// Gate 6 fails if the count INCREASES from this baseline.
const BASELINE = 7;
if (svcToStore.length > BASELINE) {
  console.log(`❌ FAIL: leak count grew from ${BASELINE} to ${svcToStore.length}`);
  process.exit(1);
} else {
  console.log(`✓ no new services → store leak introduced (count: ${svcToStore.length} ≤ baseline ${BASELINE})`);
}

console.log('\n═══════════════════════════════════════════════════════');
console.log('  ALL STRUCTURAL GATES PASSED');
console.log('═══════════════════════════════════════════════════════');
