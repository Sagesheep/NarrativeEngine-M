import fs from 'node:fs';
import path from 'node:path';
import type { EvalCampaign, VectorsCache } from './evalTypes';

// Loads fixture campaigns + their cached vectors (per embedding preset), and
// builds the deterministic substitutes the eval suite injects in place of the
// live embedder and storage. Caches are produced offline by `npm run eval:build`
// (the real models). Presets mirror the app's settings.embeddingModel.

export const PRESETS = {
    standard: { model: 'Xenova/all-MiniLM-L6-v2', dims: 384 },
    high: { model: 'Xenova/bge-base-en-v1.5', dims: 768 },
    highPrefix: { model: 'Xenova/bge-base-en-v1.5', dims: 768 },
} as const;

export type PresetKey = keyof typeof PRESETS;

const campaignDir = (id: string) => path.resolve(process.cwd(), 'src/services/__evals__/fixtures', id);
const vectorsPath = (id: string, preset: PresetKey) => path.join(campaignDir(id), `vectors.${preset}.json`);

export function loadCampaign(id: string): EvalCampaign {
    return JSON.parse(fs.readFileSync(path.join(campaignDir(id), 'campaign.json'), 'utf8'));
}

/** Preset keys that have a built vector cache for this campaign (standard is always present). */
export function availablePresets(id: string): PresetKey[] {
    return (Object.keys(PRESETS) as PresetKey[]).filter(p => fs.existsSync(vectorsPath(id, p)));
}

const cacheMemo = new Map<string, VectorsCache>();
export function loadVectors(id: string, preset: PresetKey): VectorsCache {
    const key = `${id}:${preset}`;
    if (!cacheMemo.has(key)) {
        const p = vectorsPath(id, preset);
        if (!fs.existsSync(p)) {
            throw new Error(`[eval] missing ${p} — run \`npm run eval:build${preset === 'high' ? ':high' : ''}\` to generate it.`);
        }
        cacheMemo.set(key, JSON.parse(fs.readFileSync(p, 'utf8')));
    }
    return cacheMemo.get(key)!;
}

// The injected mocks resolve vectors against the *active* (campaign, preset) pair,
// read at call time — so a single suite file can iterate presets by flipping this.
let active: { id: string; preset: PresetKey } = { id: '', preset: 'standard' };
export function setActivePreset(id: string, preset: PresetKey): void {
    active = { id, preset };
}
const currentCache = (): VectorsCache => loadVectors(active.id, active.preset);

/** Replacement for `../embedding/embedder` — embedText resolves the cached query vector by exact text. */
export function buildEmbedderMock(scoreFloorFor: (modelId: string, floor: number) => number) {
    return {
        isEmbedderReady: () => true,
        embedText: async (text: string): Promise<Float32Array | null> => {
            const v = currentCache().queries[text];
            return v ? Float32Array.from(v) : null;
        },
        embedBatch: async (texts: string[]): Promise<(Float32Array | null)[]> =>
            texts.map(t => (currentCache().queries[t] ? Float32Array.from(currentCache().queries[t]) : null)),
        getEmbedDims: () => currentCache().dims,
        getCurrentModelId: () => currentCache().model,
        calibrateScoreFloor: (floor: number) => scoreFloorFor(currentCache().model, floor),
        warmupEmbedder: async () => {},
    };
}

/** Replacement for `../storage` — embeddings.getAll returns the cached doc vectors for the active preset. */
export function buildStorageMock() {
    return {
        offlineStorage: {
            embeddings: {
                getAll: async (_campaignId: string, type?: 'scene' | 'lore' | 'npc' | 'rule') =>
                    type ? (currentCache().docs[type] ?? []) : Object.values(currentCache().docs).flat(),
            },
        },
    };
}
