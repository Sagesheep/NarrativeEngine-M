// Eval fixture builder (Plan 3). Embeds every fixture campaign's scenes/lore and
// queries with the REAL bundled MiniLM model (Node, offline) and caches the
// vectors to `vectors.json` next to each `campaign.json`. The eval suite then
// runs entirely offline against the cache, so it is deterministic and fast.
//
// Run: npm run eval:build   (re-run only when fixture text changes)
//
// The embedding call mirrors src/services/embedding/embedder.worker.ts exactly
// (mean pooling, L2-normalize, 1500-char single-pass limit + windowed pooling
// for longer text) so cached vectors match what the app would produce.
import { pipeline, env } from '@huggingface/transformers';
import fs from 'node:fs';
import path from 'node:path';

const MODEL = 'Xenova/all-MiniLM-L6-v2';
const SINGLE_PASS_LIMIT = 1500;
const WINDOW_SIZE = 1000;
const WINDOW_STRIDE = 700;

env.allowRemoteModels = false;
env.localModelPath = path.resolve('public/models');

const FIXTURES_ROOT = path.resolve('src/services/__evals__/fixtures');

const round = (v) => Math.round(v * 1e6) / 1e6;

const pipe = await pipeline('feature-extraction', MODEL, { dtype: 'q8' });

async function embedOnce(text) {
    const out = await pipe(text, { pooling: 'mean', normalize: true });
    return Array.from(out.data);
}

async function embed(text) {
    if (text.length <= SINGLE_PASS_LIMIT) return (await embedOnce(text)).map(round);

    const windows = [];
    let i = 0;
    while (i < text.length) {
        windows.push(text.slice(i, i + WINDOW_SIZE));
        if (i + WINDOW_SIZE >= text.length) break;
        i += WINDOW_STRIDE;
    }
    const vecs = [];
    for (const w of windows) vecs.push(await embedOnce(w));
    const dim = vecs[0].length;
    const pooled = new Array(dim).fill(0);
    for (const v of vecs) for (let j = 0; j < dim; j++) pooled[j] += v[j];
    for (let j = 0; j < dim; j++) pooled[j] /= vecs.length;
    let norm = 0;
    for (let j = 0; j < dim; j++) norm += pooled[j] * pooled[j];
    norm = Math.sqrt(norm);
    if (norm > 0) for (let j = 0; j < dim; j++) pooled[j] /= norm;
    return pooled.map(round);
}

const dirs = fs.readdirSync(FIXTURES_ROOT).filter(d => fs.existsSync(path.join(FIXTURES_ROOT, d, 'campaign.json')));

for (const dir of dirs) {
    const campaign = JSON.parse(fs.readFileSync(path.join(FIXTURES_ROOT, dir, 'campaign.json'), 'utf8'));
    const docs = { scene: [], lore: [], npc: [], rule: [] };
    for (const s of campaign.scenes ?? []) docs.scene.push({ id: s.sceneId, vector: await embed(s.content) });
    for (const l of campaign.lore ?? []) docs.lore.push({ id: l.id, vector: await embed(l.content) });
    for (const n of campaign.npcs ?? []) docs.npc.push({ id: n.id, vector: await embed(n.profile ?? n.content ?? '') });

    const queries = {};
    for (const q of campaign.queries ?? []) queries[q.query] = await embed(q.query);

    const out = {
        model: MODEL,
        generatedAt: new Date().toISOString(),
        dims: docs.scene[0]?.vector.length ?? docs.lore[0]?.vector.length ?? 0,
        docs,
        queries,
    };
    fs.writeFileSync(path.join(FIXTURES_ROOT, dir, 'vectors.json'), JSON.stringify(out));
    console.log(`[eval:build] ${dir}: ${docs.scene.length} scenes, ${docs.lore.length} lore, ${Object.keys(queries).length} queries -> vectors.json`);
}

console.log('[eval:build] done.');
