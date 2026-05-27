// Barrel file — re-exports from focused modules for backward compatibility.
// All existing imports like `import { buildPayload, sendMessage } from './chatEngine'` continue to work.

export { extractJson, buildPayload } from './payload';
export { sendMessage, testConnection } from './llmService';
export type { OpenAIMessage } from './llmService';
export { generateNPCProfile, updateExistingNPCs, backfillNPCDrives } from './npc';
export { populateEngineTags } from './engine';
export { shouldAutoSeal, sealChapter, recallWithChapterFunnel } from './archive';
