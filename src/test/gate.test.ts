import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const here = dirname(__filename);
const GATE_SCRIPT = resolve(here, '..', '..', 'scripts', 'gate.mjs');
const REAL_GATE_SRC = readFileSync(GATE_SCRIPT, 'utf8');

// Run gate.mjs against a temp tree whose layout mirrors a real project:
//   <root>/src/services/...  and  <root>/src/store/...  and  <root>/src/components/...
// gate.mjs resolves SRC relative to its own __dirname, so copying scripts/gate.mjs
// into <tmp>/scripts/gate.mjs makes it scan <tmp>/src.
function runGateInTempTree(tree: Record<string, string>): { status: number | null; stdout: string; stderr: string } {
    const root = mkdtempSync(join(tmpdir(), 'gate-test-'));
    try {
        mkdirSync(join(root, 'scripts'), { recursive: true });
        writeFileSync(join(root, 'scripts', 'gate.mjs'), REAL_GATE_SRC);

        for (const [rel, content] of Object.entries(tree)) {
            const abs = join(root, rel);
            mkdirSync(dirname(abs), { recursive: true });
            writeFileSync(abs, content);
        }

        const res = spawnSync(process.execPath, [join(root, 'scripts', 'gate.mjs')], {
            cwd: root,
            encoding: 'utf8',
            timeout: 15000,
        });
        return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

describe('scripts/gate.mjs — layer boundary gate', () => {
    it('exits 0 and prints GATE OK on a clean tree', () => {
        const tree = {
            'src/services/a.ts': `export const x = 1;\nimport { b } from './b';\nexport { x };\n`,
            'src/services/b.ts': `export const b = 2;\n`,
            'src/store/s.ts': `import { b } from '../services/b';\nexport const s = b;\n`, // store→services allowed
            'src/components/c.tsx': `import { s } from '../store/s';\nexport const c = s;\n`, // components→store allowed
        };
        const res = runGateInTempTree(tree);
        expect(res.status).toBe(0);
        expect(res.stdout).toContain('GATE OK');
        expect(res.stdout).toContain('TOTAL: 0');
    });

    it('flags a runtime services→store import and exits 1', () => {
        const tree = {
            'src/store/useAppStore.ts': `export const useAppStore = {};\n`,
            'src/services/offender.ts': `import { useAppStore } from '../store/useAppStore';\nexport const f = useAppStore;\n`,
        };
        const res = runGateInTempTree(tree);
        expect(res.status).toBe(1);
        expect(res.stdout).toContain('services→store');
        expect(res.stdout).toContain('offender.ts');
        expect(res.stdout).not.toContain('GATE OK');
    });

    it('flags a runtime services→components import and exits 1', () => {
        const tree = {
            'src/components/Toast.tsx': `export const toast = {};\n`,
            'src/services/offender.ts': `import { toast } from '../components/Toast';\nexport const f = toast;\n`,
        };
        const res = runGateInTempTree(tree);
        expect(res.status).toBe(1);
        expect(res.stdout).toContain('*→components');
        expect(res.stdout).toContain('offender.ts');
    });

    it('does NOT flag import type (services→store type-only import)', () => {
        const tree = {
            'src/store/types.ts': `export type State = { x: number };\n`,
            'src/services/typed.ts': `import type { State } from '../store/types';\nexport const f = (s: State) => s.x;\n`,
        };
        const res = runGateInTempTree(tree);
        expect(res.status).toBe(0);
        expect(res.stdout).toContain('GATE OK');
    });

    it('does NOT flag import type (services→components type-only import)', () => {
        const tree = {
            'src/components/Foo.tsx': `export type Props = { x: number };\n`,
            'src/services/typed.ts': `import type { Props } from '../components/Foo';\nexport const f = (p: Props) => p.x;\n`,
        };
        const res = runGateInTempTree(tree);
        expect(res.status).toBe(0);
        expect(res.stdout).toContain('GATE OK');
    });

    it('does NOT flag store→services (allowed direction)', () => {
        const tree = {
            'src/services/svc.ts': `export const svc = 1;\n`,
            'src/store/slice.ts': `import { svc } from '../services/svc';\nexport const s = svc;\n`,
        };
        const res = runGateInTempTree(tree);
        expect(res.status).toBe(0);
        expect(res.stdout).toContain('GATE OK');
    });

    it('flags a multi-line runtime import (newline-spanning import statement)', () => {
        const tree = {
            'src/store/slices/settingsSlice.ts': `export const DEFAULT_FOO = ['a'];\nexport const DEFAULT_BAR = ['b'];\n`,
            'src/services/engine/engineRolls.ts': [
                `import {`,
                `    DEFAULT_FOO,`,
                `    DEFAULT_BAR,`,
                `} from '../../store/slices/settingsSlice';`,
                `export const r = () => DEFAULT_FOO.concat(DEFAULT_BAR);`,
            ].join('\n'),
        };
        const res = runGateInTempTree(tree);
        expect(res.status).toBe(1);
        expect(res.stdout).toContain('engineRolls.ts');
        expect(res.stdout).toContain('services→store');
    });
});