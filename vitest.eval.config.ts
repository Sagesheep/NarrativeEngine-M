import { defineConfig } from 'vitest/config';

// Isolated config for the retrieval eval harness (Plan 3). Kept separate from the
// main test config so `npm run test` never picks up eval suites and vice-versa:
// eval files are named `*.eval.ts`, the main config only includes `*.test.ts`.
// Runs in the node environment (no DOM needed) against cached fixture vectors,
// so it is deterministic and offline.
export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['src/services/__evals__/**/*.eval.ts'],
        // Embedding cosine math over ~13 vectors is fast, but leave generous room.
        testTimeout: 30000,
        hookTimeout: 30000,
    },
});
