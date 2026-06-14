import type { NPCEntry } from '../../types';
import { useAppStore } from '../../store/useAppStore';
import { generateImage } from './imageClient';
import { imageStorage } from '../storage/imageStorage';
import { toast } from '../../components/Toast';

const CHIP_RE = /\[[\s\S]*?\]/g;
const THINK_OPEN = /<think/gi;
const MAX_PROMPT_LEN = 1000;

const DEFAULT_STYLE = 'fantasy illustration, cinematic lighting, detailed, no text, no watermark, no UI, no speech bubbles';

function stripMarkup(text: string): string {
    let cleaned = text.replace(THINK_OPEN, '').replace(/<\/think>/gi, '').trim();
    cleaned = cleaned.replace(CHIP_RE, '').trim();
    cleaned = cleaned.replace(/[*_~`#>]/g, '').trim();
    cleaned = cleaned.replace(/\n{2,}/g, '\n').trim();
    return cleaned;
}

function gatherNPCAppearances(text: string, npcLedger: NPCEntry[]): string {
    const mentioned = npcLedger.filter(npc => {
        const name = npc.name.toLowerCase();
        return text.toLowerCase().includes(name);
    });
    if (mentioned.length === 0) return '';
    const parts = mentioned.slice(0, 5).map(npc => {
        const desc = npc.appearance?.trim();
        return desc ? `${npc.name}: ${desc}` : npc.name;
    });
    return `Characters present: ${parts.join('; ')}.`;
}

function buildImagePrompt(
    sceneText: string,
    npcLedger: NPCEntry[],
    stylePrompt?: string,
): string {
    const scene = stripMarkup(sceneText);
    if (!scene) return '';

    const npcs = gatherNPCAppearances(sceneText, npcLedger);
    const style = stylePrompt?.trim() || DEFAULT_STYLE;

    const parts = [style, npcs, scene].filter(Boolean);
    let prompt = parts.join('. ');

    if (prompt.length > MAX_PROMPT_LEN) {
        const overhead = style.length + npcs.length + 4;
        const sceneTruncated = scene.slice(0, MAX_PROMPT_LEN - overhead) + '…';
        prompt = [style, npcs, sceneTruncated].filter(Boolean).join('. ');
    }

    return prompt.slice(0, MAX_PROMPT_LEN);
}

export async function illustrateMessage(messageId: string): Promise<void> {
    const state = useAppStore.getState();
    const preset = state.settings.presets.find(p => p.id === state.settings.activePresetId);
    if (!preset) {
        toast.warning('No active preset found');
        return;
    }

    const imageProvider = state.getActiveImageEndpoint();
    if (!imageProvider) {
        toast.warning('No Image Generation AI configured in this preset. Add one in Settings \u2192 Presets.');
        return;
    }

    const campaignId = state.activeCampaignId;
    if (!campaignId) return;

    const message = state.messages.find(m => m.id === messageId);
    if (!message || message.role !== 'assistant') return;

    if (message.image?.status === 'pending') return;

    const npcLedger = (state as unknown as { npcLedger: NPCEntry[] }).npcLedger ?? [];
    const prompt = buildImagePrompt(
        message.displayContent || message.content,
        npcLedger,
        state.settings.imageStylePrompt,
    );
    if (!prompt) {
        toast.warning('No text to illustrate');
        return;
    }

    useAppStore.getState().setMessageImage(messageId, {
        status: 'pending',
        prompt,
        createdAt: Date.now(),
    });

    try {
        const negativePrompt = state.settings.imageNegativePrompt || undefined;
        const dataUrl = await generateImage(imageProvider, prompt, { negativePrompt });

        await imageStorage.store(campaignId, messageId, dataUrl);

        useAppStore.getState().setMessageImage(messageId, {
            status: 'ready',
            prompt,
            createdAt: Date.now(),
        });
    } catch (e) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        useAppStore.getState().setMessageImage(messageId, {
            status: 'error',
            prompt,
            createdAt: Date.now(),
            error: errorMessage,
        });
        toast.error(`Illustration failed: ${errorMessage}`);
    }
}