import { useState, useEffect } from 'react';
import { User, Loader2, Image as ImageIcon, XCircle } from 'lucide-react';
import type { NPCEntry } from '../../types';
import { useAppStore } from '../../store/useAppStore';
import { imageStorage } from '../../services/storage/imageStorage';
import { generateNPCPortrait } from '../../services/image/portrait';
import { useBackHandler } from '../../hooks/useBackHandler';
import { toast } from '../Toast';

type Props = {
    npc: NPCEntry;
    isEditing: boolean;
};

export function NPCPortraitSection({ npc }: Props) {
    const activeCampaignId = useAppStore(s => s.activeCampaignId);
    const [portraitUrl, setPortraitUrl] = useState<string | null>(null);
    const [isGenerating, setIsGenerating] = useState(false);
    const [lightboxOpen, setLightboxOpen] = useState(false);

    // Hardware back closes the portrait lightbox first.
    useBackHandler(lightboxOpen, () => setLightboxOpen(false));

    useEffect(() => {
        if (!npc.portrait || !activeCampaignId) {
            setPortraitUrl(null);
            return;
        }
        let cancelled = false;
        imageStorage.getPortrait(activeCampaignId, npc.id).then(url => {
            if (!cancelled) setPortraitUrl(url);
        });
        return () => { cancelled = true; };
    }, [npc.id, npc.portrait, activeCampaignId]);

    const handleGenerate = async () => {
        setIsGenerating(true);
        try {
            await generateNPCPortrait(npc.id);
            if (activeCampaignId) {
                const url = await imageStorage.getPortrait(activeCampaignId, npc.id);
                setPortraitUrl(url);
            }
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            toast.error(`Portrait generation failed: ${msg}`);
        } finally {
            setIsGenerating(false);
        }
    };

    const canGenerate = npc.name?.trim() && npc.appearance?.trim();

    return (
        <div className="mb-4">
            {portraitUrl ? (
                <div className="relative group rounded overflow-hidden border border-border">
                    <img
                        src={portraitUrl}
                        alt={npc.name || 'NPC Portrait'}
                        className="w-full aspect-[3/4] object-cover object-top cursor-pointer"
                        onClick={() => setLightboxOpen(true)}
                    />
                    <button
                        type="button"
                        onClick={handleGenerate}
                        disabled={isGenerating || !canGenerate}
                        className="absolute bottom-2 right-2 flex items-center gap-1.5 px-2.5 py-1 bg-void/80 border border-border hover:border-terminal text-terminal text-[10px] uppercase tracking-wider rounded transition-colors disabled:opacity-50 opacity-0 group-hover:opacity-100"
                    >
                            {isGenerating ? <Loader2 size={11} className="animate-spin" /> : <ImageIcon size={11} />}
                            Regenerate
                        </button>
                </div>
            ) : (
                <div className="w-full aspect-[3/4] bg-void-lighter border border-border rounded flex flex-col items-center justify-center gap-3">
                    <User size={40} className="text-text-dim/30" />
                    <button
                        type="button"
                        onClick={handleGenerate}
                        disabled={isGenerating || !canGenerate}
                        className="flex items-center gap-1.5 px-3 py-1.5 border border-terminal/30 hover:border-terminal text-terminal text-[10px] uppercase tracking-wider rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        title={!canGenerate ? 'Name and appearance required' : 'Generate portrait'}
                    >
                        {isGenerating ? <Loader2 size={12} className="animate-spin" /> : <ImageIcon size={12} />}
                        {isGenerating ? 'Generating\u2026' : 'Generate Portrait'}
                    </button>
                </div>
            )}

            {lightboxOpen && portraitUrl && (
                <div
                    className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
                    onClick={() => setLightboxOpen(false)}
                >
                    <button
                        className="absolute top-4 right-4 p-2 bg-void-darker/80 border border-border rounded-full text-text-dim hover:text-text-primary transition-colors z-10"
                        onClick={() => setLightboxOpen(false)}
                    >
                        <XCircle size={24} />
                    </button>
                    <img
                        src={portraitUrl}
                        alt={npc.name || 'NPC Portrait'}
                        className="max-w-[calc(95*var(--app-vw))] max-h-[calc(90*var(--app-vh))] object-contain rounded"
                        onClick={e => e.stopPropagation()}
                    />
                </div>
            )}
        </div>
    );
}