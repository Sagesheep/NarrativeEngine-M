#!/usr/bin/env node
// scripts/gate.mjs — Layer-boundary gate (report-only until WO-04).
// Rules (SPEC §1):
//   1. src/services/** importing src/store/** at RUNTIME → VIOLATION
//   2. src/services/** or src/store/** importing src/components/** at RUNTIME → VIOLATION
// `import type` and dynamic `await import()` / `import()` are allowed.
// store → services is allowed.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve, sep, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');
const SRC = resolve(ROOT, 'src');

const BLOCK = true; // WO-04: gate is now blocking.

// ── Walk .ts/.tsx under src/, excluding tests ─────────────────────────────
function walk(dir, out = []) {
    for (const name of readdirSync(dir)) {
        const p = resolve(dir, name);
        const st = statSync(p);
        if (st.isDirectory()) {
            if (name === '__tests__' || name === 'test' || name === 'node_modules') continue;
            walk(p, out);
        } else if (/\.[tj]sx?$/.test(name) && !/\.test\.[tj]sx?$/.test(name) && !/\.d\.ts$/.test(name)) {
            out.push(p);
        }
    }
    return out;
}

// ── Classify which top-level src/ folder a resolved path lives in ─────────
function topFolder(absPath) {
    const rel = relative(SRC, absPath).replace(/\\/g, '/');
    const seg = rel.split('/')[0];
    return seg; // 'components' | 'store' | 'services' | 'hooks' | ...
}

// ── Resolve a specifier relative to a file; only handle relative specifiers ─
function resolveSpecifier(spec, fromFile) {
    if (!spec.startsWith('.')) return null; // bare / alias imports: skip
    const base = resolve(dirname(fromFile), spec);
    for (const ext of ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js']) {
        try {
            const cand = base + ext;
            statSync(cand);
            return cand;
        } catch { /* try next */ }
    }
    return null;
}

// ── Extract runtime import specifiers from a source file ─────────────────
// Handles multi-line import statements. A statement is runtime if it starts
// with `import` (not `import type`) and contains a `from '...'` clause OR a
// bare side-effect `import '...'`. `import type` (whole-statement) is skipped.
// Inline `import { type X, Y }` mixed lines: the statement is still a runtime
// edge for value binding Y — we flag it (conservative); WO-03 notes allow
// converting to `import type` to satisfy the gate.
const STMT_RE = /import\s+(type\s+)?(?:[^'"]+?\s+from\s+)?['"]([^'"]+)['"]/gs;

function runtimeImports(text) {
    const out = [];
    // Pre-compute line starts for line-number lookup.
    const lineStarts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
    function lineOf(offset) {
        let lo = 0, hi = lineStarts.length - 1;
        while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= offset) lo = mid; else hi = mid - 1; }
        return lo + 1;
    }
    let m;
    STMT_RE.lastIndex = 0;
    while ((m = STMT_RE.exec(text)) !== null) {
        if (m[1]) continue; // `import type` — skip
        out.push({ lineNo: lineOf(m.index), specifier: m[2] });
    }
    return out;
}

// ── Scan ──────────────────────────────────────────────────────────────────
const files = walk(SRC);
const servicesToStore = [];
const toComponents = [];

for (const f of files) {
    const srcFolder = topFolder(f);
    if (srcFolder !== 'services' && srcFolder !== 'store') continue;

    const text = readFileSync(f, 'utf8');
    const imports = runtimeImports(text);

    for (const imp of imports) {
        const resolved = resolveSpecifier(imp.specifier, f);
        if (!resolved) continue;
        const targetFolder = topFolder(resolved);
        if (targetFolder === 'store' && srcFolder === 'services') {
            servicesToStore.push({ file: relative(ROOT, f).replace(/\\/g, '/'), line: imp.lineNo, target: relative(SRC, resolved).replace(/\\/g, '/') });
        }
        if (targetFolder === 'components' && (srcFolder === 'services' || srcFolder === 'store')) {
            toComponents.push({ file: relative(ROOT, f).replace(/\\/g, '/'), line: imp.lineNo, target: relative(SRC, resolved).replace(/\\/g, '/') });
        }
    }
}

// ── Print ─────────────────────────────────────────────────────────────────
console.log('GATE: layer boundaries');
console.log(`  services→store   (${servicesToStore.length})`);
for (const v of servicesToStore) console.log(`    ${v.file}:${v.line}   → ${v.target}`);
console.log(`  *→components     (${toComponents.length})`);
for (const v of toComponents) console.log(`    ${v.file}:${v.line} → ${v.target}`);
const total = servicesToStore.length + toComponents.length;
console.log(`TOTAL: ${total} violation(s)`);

if (total > 0) {
    process.exit(1);
}
console.log('GATE OK');
process.exit(0);