/**
 * npcGeneration.ts — barrel re-export (W10 God File split).
 *
 * All functions extracted to focused modules:
 * - npcShared.ts: llmParseJson, checkNameCollision, buildDefaultFieldTags, legacyAffinityDescriptor
 * - npcValidator.ts: validatePersonalityHex, validateTraits, HEX constants
 * - npcEmbedding.ts: buildNPCEmbeddingText, embedAndStoreNPC
 * - npcDrives.ts: translatePersonalityToHex, generateLongWant, backfillNPCDrives, topUpWants
 * - npcGenerator.ts: generateNPCProfile (propose → roll → render)
 * - npcUpdater.ts: updateExistingNPCs (attribute drift)
 * - pcCreator.ts: generatePCProfile, mergePCWithLLMProfile, PCCreationOverrides
 * - npcAgencyFill.ts: populateAgencyFields, bulkNpcUpdate
 */

export { buildNPCEmbeddingText, embedAndStoreNPC } from './npcEmbedding';
export { validatePersonalityHex, validateTraits } from './npcValidator';
export { translatePersonalityToHex, generateLongWant, backfillNPCDrives } from './npcDrives';
export { generateNPCProfile } from './npcGenerator';
export { updateExistingNPCs } from './npcUpdater';
export { generatePCProfile, mergePCWithLLMProfile } from './pcCreator';
export type { PCCreationOverrides } from './pcCreator';
export { populateAgencyFields, bulkNpcUpdate } from './npcAgencyFill';
