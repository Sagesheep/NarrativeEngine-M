/**
 * @refactor RF-001 (infrastructure)
 * @waves W0(advance)/W1(close)
 * @see ../ports/MessagingPort.ts
 *
 * MessagingAdapter — thin delegate from MessagingPort to useAppStore.
 */

import { useAppStore } from '../store/useAppStore';
import type { MessagingPort } from '../ports/MessagingPort';
import type { PipelinePhase, StreamingStats, PayloadTrace, ReindexState } from '../types';

export function createMessagingAdapter(): MessagingPort {
  const get = () => useAppStore.getState();

  return {
    appendMessage: (msg) => get().addMessage(msg),
    updateLastAssistant: (content) => get().updateLastAssistant(content),
    updateLastMessage: (patch) => get().updateLastMessage(patch),
    attachImage: (messageId, image) => get().setMessageImage(messageId, image),
    condenseHistory: (upToIndex) => get().setCondensed(upToIndex),
    replaceMessages: (messages) => useAppStore.setState({ messages }),
    setStreaming: (v) => get().setStreaming(v),
    getMessages: () => get().messages,
    getCondenserState: () => get().condenser,
    getMessageById: (id) => get().messages.find((m) => m.id === id),
    setLastPayloadTrace: (trace: PayloadTrace) => get().setLastPayloadTrace([trace]),
    setPipelinePhase: (phase: PipelinePhase) => get().setPipelinePhase(phase),
    setStreamingStats: (stats: StreamingStats | null) => get().setStreamingStats(stats),
    getSettings: () => get().settings,
    getActiveCampaignId: () => get().activeCampaignId,
    getContext: () => get().context,
    getCondenser: () => get().condenser,
    getPinnedExcerpts: () => get().pinnedExcerpts ?? [],
    getNpcLedger: () => get().npcLedger,
    getArchiveIndex: () => get().archiveIndex,
    getChapters: () => get().chapters ?? [],
    getSemanticFacts: () => get().semanticFacts ?? [],
    getTimeline: () => get().timeline ?? [],
    getEntities: () => get().entities ?? [],
    getLoreChunks: () => get().loreChunks ?? [],
    getOnStageNpcIds: () => get().onStageNpcIds ?? [],
    getNpcPressure: () => get().npcPressure ?? {},
    getDivergenceRegister: () => get().divergenceRegister,
    getPinnedChapterIds: () => get().pinnedChapterIds ?? [],
    clearPinnedChapters: () => get().clearPinnedChapters(),
    getAutoBookkeepingInterval: () => get().autoBookkeepingInterval,
    incrementBookkeepingTurnCounter: () => get().incrementBookkeepingTurnCounter(),
    resetBookkeepingTurnCounter: () => get().resetBookkeepingTurnCounter(),
    getActiveStoryEndpoint: () => get().getActiveStoryEndpoint(),
    getActiveSummarizerEndpoint: () => get().getActiveSummarizerEndpoint?.(),
    getActiveUtilityEndpoint: () => get().getActiveUtilityEndpoint?.(),
    getActiveAuxiliaryEndpoint: () => get().getActiveAuxiliaryEndpoint?.(),
    getActiveImageEndpoint: () => get().getActiveImageEndpoint(),
    setEmbeddingsReindexing: (state: ReindexState) => get().setEmbeddingsReindexing(state),
  };
}
