import type { NPCEntry } from '../../types';
import { generateImage } from './imageClient';
import { composeImagePrompt } from './composePrompt';
import { imageStorage } from '../storage/imageStorage';
import { notify } from '../../ports/notification';
import { settings } from '../../ports/settings';
import { npc as npcPort } from '../../ports/npc';

export async function generateNPCPortrait(npcId: string): Promise<void> {
    const provider = settings.getActiveImageEndpoint();
    if (!provider) {
        notify.warning('No Image Generation AI configured. Add one in Settings \u2192 Presets.');
        return;
    }

    const s = settings.getSettings();
    const campaignId = (s as unknown as { activeCampaignId: string | null }).activeCampaignId;
    if (!campaignId) {
        notify.warning('No active campaign');
        return;
    }

    const npcLedger = npcPort.getNPCLedger() as NPCEntry[];
    const target = npcLedger.find(n => n.id === npcId);
    if (!target) {
        notify.warning('NPC not found');
        return;
    }

    if (!target.appearance?.trim() && !target.appearanceTags?.trim()) {
        notify.warning('Add an appearance description before generating a portrait');
        return;
    }

    const composed = composeImagePrompt({
        portraitNpcId: npcId,
        npcLedger,
        stylePrompt: s.imageStylePrompt,
        negativePrompt: s.imageNegativePrompt,
    });

    const dataUrl = await generateImage(provider, composed.prompt, {
        size: '1024x1536',
        negativePrompt: composed.negativePrompt,
        ...(composed.seed !== undefined ? { seed: composed.seed } : {}),
    });

    await imageStorage.storePortrait(campaignId, npcId, dataUrl);
    npcPort.updateNPC(npcId, { portrait: true });
}
