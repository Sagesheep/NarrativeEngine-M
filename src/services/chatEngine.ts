// Barrel file — re-exports from focused modules for backward compatibility.
// All existing imports like `import { buildPayload, sendMessage } from './chatEngine'` continue to work.

export { extractJson, buildPayload } from './payloadBuilder';
export { sendMessage, testConnection } from './llmService';
export type { OpenAIMessage } from './llmService';
export { generateNPCProfile, updateExistingNPCs } from './npcGeneration';
export { populateEngineTags } from './tagGeneration';
export { shouldAutoSeal, sealChapter, recallWithChapterFunnel } from './archiveChapterEngine';
