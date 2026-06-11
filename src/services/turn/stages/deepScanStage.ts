import type { TurnCallbacks, TurnState, UtilityLLM } from '../turnTypes';
import { deepArchiveScan } from '../../archive';
import { tierAllows } from '../aiTier';

/**
 * Deep Archive Scan — a one-shot, opt-in (GM long-presses Send) multi-round LLM
 * sweep over sealed chapters that returns a continuity brief. Gated on the
 * deepScan tier + an explicit request. Returns undefined when not requested,
 * gated off, or on failure (the turn falls back to standard recall).
 */
export async function deepScanStage(params: {
    state: TurnState;
    callbacks: TurnCallbacks;
    finalInput: string;
    userMsgId: string;
    utilityLLM: UtilityLLM;
}): Promise<string | undefined> {
    const { state, callbacks, finalInput, userMsgId, utilityLLM } = params;
    const { settings, archiveIndex, activeCampaignId } = state;

    if (state.deepContextSearch && tierAllows(settings.aiTier, 'deepScan') && activeCampaignId) {
        const utilityForDeep = utilityLLM.endpoint();
        if (utilityForDeep?.endpoint) {
            try {
                const sealedChapters = (state.chapters ?? []).filter(c => c.sealedAt !== undefined);
                const deepBudget = Math.floor((settings.contextLimit || 8192) * 0.45);
                const brief = await deepArchiveScan(
                    utilityForDeep,
                    archiveIndex,
                    sealedChapters,
                    activeCampaignId,
                    state.getMessages().filter(m => m.id !== userMsgId),
                    finalInput,
                    deepBudget,
                    (msg) => callbacks.setLoadingStatus?.(msg),
                );
                if (brief) return brief;
            } catch (err) {
                console.warn('[DeepArchiveSearch] Failed, using standard recall:', err);
            }
        } else {
            console.warn('[DeepArchiveSearch] No utility endpoint configured — deep scan skipped.');
        }
    }
    return undefined;
}
