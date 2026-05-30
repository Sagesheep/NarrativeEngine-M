export { warmupEmbedder, switchEmbeddingModel, embedText, embedBatch, isEmbedderReady, getEmbedDims, getCurrentModelId, getLastInitError } from './embedder';
export type { DownloadProgress } from './embedder';
export { searchVectors, semanticSearch, semanticSearchScored, cosineSimilarity, mmrSelect } from './vectorSearch';
export type { SearchHit } from './vectorSearch';
export { runBackfill, getBackfillCursor, backfillScenes, backfillNPCs, rebuildAllEmbeddings, runFullReindex } from './backfillRunner';
export type { BackfillProgress } from './backfillRunner';
export { enqueueProgressive, enqueueProgressiveWithExistingCheck, abortForCampaignSwitch, abortForModelSwitch, getQueueStats } from './embeddingScheduler';
export type { ProgressiveChunk } from './embeddingScheduler';
export { getForegroundPoolSize, poolEmbed, terminatePool, getActivePoolSize } from './embedderPool';
