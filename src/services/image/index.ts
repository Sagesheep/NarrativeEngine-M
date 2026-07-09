import type { NPCEntry, CharacterProfileState, SceneSteer } from '../../types';
import { generateImage } from './imageClient';
import { composeImagePrompt } from './composePrompt';
import { imageStorage } from '../storage/imageStorage';
import { notify } from '../../ports/notification';
import { settings } from '../../ports/settings';
import { messaging } from '../../ports/messaging';
import { npc } from '../../ports/npc';

export async function illustrateMessage(messageId: string, steer?: SceneSteer): Promise<void> {
    const preset = settings.getActivePreset();
    if (!preset) {
        notify.warning('No active preset found');
        return;
    }

    const imageProvider = settings.getActiveImageEndpoint();
    if (!imageProvider) {
        notify.warning('No Image Generation AI configured in this preset. Add one in Settings → Presets.');
        return;
    }

    const s = settings.getSettings();
    const campaignId = (s as unknown as { activeCampaignId: string | null }).activeCampaignId;
    if (!campaignId) return;

    const message = messaging.getMessageById(messageId);
    if (!message || message.role !== 'assistant') return;

    if (message.image?.status === 'pending') return;

    const npcLedger = npc.getNPCLedger() as NPCEntry[];
    const onStageNpcIds = [...npc.getOnStageNPCIds()];
    const pc = (s as unknown as { context?: { characterProfile?: CharacterProfileState } }).context?.characterProfile?.identity;

    const composed = composeImagePrompt({
        sceneText: message.displayContent || message.content,
        npcLedger,
        pc,
        onStageNpcIds,
        stylePrompt: s.imageStylePrompt,
        negativePrompt: s.imageNegativePrompt,
        steer,
    });

    if (!composed.prompt) {
        notify.warning('No text to illustrate');
        return;
    }

    messaging.attachImage(messageId, {
        status: 'pending',
        prompt: composed.prompt,
        createdAt: Date.now(),
        steer,
    });

    try {
        const dataUrl = await generateImage(imageProvider, composed.prompt, {
            negativePrompt: composed.negativePrompt,
            ...(composed.seed !== undefined ? { seed: composed.seed } : {}),
        });

        await imageStorage.store(campaignId, messageId, dataUrl);

        messaging.attachImage(messageId, {
            status: 'ready',
            prompt: composed.prompt,
            createdAt: Date.now(),
            steer,
        });
    } catch (e) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        messaging.attachImage(messageId, {
            status: 'error',
            prompt: composed.prompt,
            createdAt: Date.now(),
            error: errorMessage,
            steer,
        });
        notify.error(`Illustration failed: ${errorMessage}`);
    }
}
