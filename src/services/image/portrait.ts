import { generateImage } from './imageClient';
import { composeImagePrompt } from './composePrompt';
import { imageStorage } from '../storage/imageStorage';
import { notify } from '../ports/notify';
import { storeAccess } from '../ports/store';

export async function generateNPCPortrait(npcId: string): Promise<void> {
    const state = storeAccess().getState();
    const provider = state.getActiveImageEndpoint();
    if (!provider) {
        notify.warning('No Image Generation AI configured. Add one in Settings \u2192 Presets.');
        return;
    }

    const campaignId = state.activeCampaignId;
    if (!campaignId) {
        notify.warning('No active campaign');
        return;
    }

    const npcLedger = (state as unknown as { npcLedger: import('../../types').NPCEntry[] }).npcLedger;
    const npc = npcLedger.find(n => n.id === npcId);
    if (!npc) {
        notify.warning('NPC not found');
        return;
    }

    if (!npc.appearance?.trim() && !npc.appearanceTags?.trim()) {
        notify.warning('Add an appearance description before generating a portrait');
        return;
    }

    const composed = composeImagePrompt({
        portraitNpcId: npcId,
        npcLedger,
        stylePrompt: state.settings.imageStylePrompt,
        negativePrompt: state.settings.imageNegativePrompt,
    });

    const dataUrl = await generateImage(provider, composed.prompt, {
        size: '1024x1536',
        negativePrompt: composed.negativePrompt,
        ...(composed.seed !== undefined ? { seed: composed.seed } : {}),
    });

    await imageStorage.storePortrait(campaignId, npcId, dataUrl);
    storeAccess().getState().updateNPC(npcId, { portrait: true });
}