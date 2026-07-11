/**
 * @refactor RF-001, RF-004, RF-006 (infrastructure)
 * @waves W0(advance)/W1(close)
 * @see architecture/phase3-refactor-planning/3.1-refactor-case-catalog.md#RF-001
 * @see REFACTOR-MAP.md
 *
 * MessagingPort — contract between domain services and chat state.
 *
 * Fixes 9 domain→state violations (services importing useAppStore
 * to append/update messages, manage streaming, condense history).
 *
 * Adapters live in src/adapters/messagingAdapter.ts.
 * Wiring happens in src/main.tsx via wireAllAdapters().
 */

import type { ChatMessage, CondenserState, PipelinePhase, StreamingStats, PayloadTrace } from '../types';

export interface MessagingPort {
  /** Append a message to the chat history. */
  appendMessage(msg: ChatMessage): void;

  /** Update the last assistant message's content (streaming). */
  updateLastAssistant(content: string): void;

  /** Patch an arbitrary field on the last message. */
  updateLastMessage(patch: Partial<ChatMessage>): void;

  /** Attach an image to an existing message. */
  attachImage(messageId: string, image: ChatMessage['image']): void;

  /** Mark history as condensed up to (and including) the given index. */
  condenseHistory(upToIndex: number): void;

  /** Replace the entire message list (used by pendingCommit on rollback). */
  replaceMessages(messages: ChatMessage[]): void;

  /** Toggle the streaming flag. */
  setStreaming(v: boolean): void;

  /** Read the current message list. */
  getMessages(): ChatMessage[];

  /** Read the current condenser state. */
  getCondenserState(): CondenserState;

  /** Look up a single message by id. */
  getMessageById(id: string): ChatMessage | undefined;

  /** Set the last payload trace (UI state for debugging). */
  setLastPayloadTrace(trace: PayloadTrace): void;

  /** Set the current pipeline phase (UI state). */
  setPipelinePhase(phase: PipelinePhase): void;

  /** Set the streaming stats (UI state). */
  setStreamingStats(stats: StreamingStats | null): void;

  /** Read the current settings. */
  getSettings(): import('../types').AppSettings;

  /** Read the active campaign id. */
  getActiveCampaignId(): string | null;

  /** Read the current context. */
  getContext(): import('../types').GameContext;

  /** Read the condenser state. */
  getCondenser(): CondenserState;

  /** Read the pinned excerpts. */
  getPinnedExcerpts(): import('../types').PinnedExcerpt[];

  /** Read the NPC ledger. */
  getNpcLedger(): import('../types').NPCEntry[];

  /** Read the archive index. */
  getArchiveIndex(): import('../types').ArchiveIndexEntry[];

  /** Read the chapters. */
  getChapters(): import('../types').ArchiveChapter[];

  /** Read the semantic facts. */
  getSemanticFacts(): import('../types').SemanticFact[];

  /** Read the timeline. */
  getTimeline(): import('../types').TimelineEvent[];

  /** Read the entities. */
  getEntities(): import('../types').EntityEntry[];

  /** Read the lore chunks. */
  getLoreChunks(): import('../types').LoreChunk[];

  /** Read the on-stage NPC ids. */
  getOnStageNpcIds(): string[];

  /** Read the NPC pressure map. */
  getNpcPressure(): Record<string, import('../types').NPCPressure>;

  /** Read the divergence register. */
  getDivergenceRegister(): import('../types').DivergenceRegister;

  /** Read the pinned chapter ids. */
  getPinnedChapterIds(): string[];

  /** Clear the pinned chapters. */
  clearPinnedChapters(): void;

  /** Read the auto bookkeeping interval. */
  getAutoBookkeepingInterval(): number;

  /** Increment the bookkeeping turn counter. */
  incrementBookkeepingTurnCounter(): number;

  /** Reset the bookkeeping turn counter. */
  resetBookkeepingTurnCounter(): void;

  /** Read the active story endpoint. */
  getActiveStoryEndpoint(): import('../types').LLMProvider | undefined;

  /** Read the active summarizer endpoint. */
  getActiveSummarizerEndpoint(): import('../types').LLMProvider | undefined;

  /** Read the active utility endpoint. */
  getActiveUtilityEndpoint(): import('../types').LLMProvider | undefined;

  /** Read the active auxiliary endpoint. */
  getActiveAuxiliaryEndpoint(): import('../types').LLMProvider | undefined;

  /** Read the active image endpoint. */
  getActiveImageEndpoint(): import('../types').LLMProvider | undefined;

  /** Set the embeddings reindexing state. */
  setEmbeddingsReindexing(state: import('../types').ReindexState): void;
}

export const messagingPort: MessagingPort = {
  appendMessage: () => throwNotWired('MessagingPort.appendMessage'),
  updateLastAssistant: () => throwNotWired('MessagingPort.updateLastAssistant'),
  updateLastMessage: () => throwNotWired('MessagingPort.updateLastMessage'),
  attachImage: () => throwNotWired('MessagingPort.attachImage'),
  condenseHistory: () => throwNotWired('MessagingPort.condenseHistory'),
  replaceMessages: () => throwNotWired('MessagingPort.replaceMessages'),
  setStreaming: () => throwNotWired('MessagingPort.setStreaming'),
  getMessages: () => throwNotWired('MessagingPort.getMessages'),
  getCondenserState: () => throwNotWired('MessagingPort.getCondenserState'),
  getMessageById: () => throwNotWired('MessagingPort.getMessageById'),
  setLastPayloadTrace: () => throwNotWired('MessagingPort.setLastPayloadTrace'),
  setPipelinePhase: () => throwNotWired('MessagingPort.setPipelinePhase'),
  setStreamingStats: () => throwNotWired('MessagingPort.setStreamingStats'),
  getSettings: () => throwNotWired('MessagingPort.getSettings'),
  getActiveCampaignId: () => throwNotWired('MessagingPort.getActiveCampaignId'),
  getContext: () => throwNotWired('MessagingPort.getContext'),
  getCondenser: () => throwNotWired('MessagingPort.getCondenser'),
  getPinnedExcerpts: () => throwNotWired('MessagingPort.getPinnedExcerpts'),
  getNpcLedger: () => throwNotWired('MessagingPort.getNpcLedger'),
  getArchiveIndex: () => throwNotWired('MessagingPort.getArchiveIndex'),
  getChapters: () => throwNotWired('MessagingPort.getChapters'),
  getSemanticFacts: () => throwNotWired('MessagingPort.getSemanticFacts'),
  getTimeline: () => throwNotWired('MessagingPort.getTimeline'),
  getEntities: () => throwNotWired('MessagingPort.getEntities'),
  getLoreChunks: () => throwNotWired('MessagingPort.getLoreChunks'),
  getOnStageNpcIds: () => throwNotWired('MessagingPort.getOnStageNpcIds'),
  getNpcPressure: () => throwNotWired('MessagingPort.getNpcPressure'),
  getDivergenceRegister: () => throwNotWired('MessagingPort.getDivergenceRegister'),
  getPinnedChapterIds: () => throwNotWired('MessagingPort.getPinnedChapterIds'),
  clearPinnedChapters: () => throwNotWired('MessagingPort.clearPinnedChapters'),
  getAutoBookkeepingInterval: () => throwNotWired('MessagingPort.getAutoBookkeepingInterval'),
  incrementBookkeepingTurnCounter: () => throwNotWired('MessagingPort.incrementBookkeepingTurnCounter'),
  resetBookkeepingTurnCounter: () => throwNotWired('MessagingPort.resetBookkeepingTurnCounter'),
  getActiveStoryEndpoint: () => throwNotWired('MessagingPort.getActiveStoryEndpoint'),
  getActiveSummarizerEndpoint: () => throwNotWired('MessagingPort.getActiveSummarizerEndpoint'),
  getActiveUtilityEndpoint: () => throwNotWired('MessagingPort.getActiveUtilityEndpoint'),
  getActiveAuxiliaryEndpoint: () => throwNotWired('MessagingPort.getActiveAuxiliaryEndpoint'),
  getActiveImageEndpoint: () => throwNotWired('MessagingPort.getActiveImageEndpoint'),
  setEmbeddingsReindexing: () => throwNotWired('MessagingPort.setEmbeddingsReindexing'),
};

export function wireMessaging(impl: MessagingPort): void {
  Object.assign(messagingPort, impl);
}

function throwNotWired(method: string): never {
  throw new Error(
    `${method} called before wireMessaging(). ` +
    `Ensure wireAllAdapters() runs in main.tsx before React mounts.`
  );
}
