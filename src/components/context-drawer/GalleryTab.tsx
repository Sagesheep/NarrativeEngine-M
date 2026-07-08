import { useState, useEffect, useMemo } from 'react';
import { Images, XCircle, Trash2, CornerUpRight, Loader2 } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { imageStorage } from '../../services/storage/imageStorage';
import { useBackHandler } from '../../hooks/useBackHandler';

type SceneImage = {
    messageId: string;
    prompt?: string;
    createdAt: number;
    url: string;
};

function formatDate(ts: number): string {
    try {
        return new Date(ts).toLocaleString(undefined, {
            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
        });
    } catch {
        return '';
    }
}

export function GalleryTab() {
    const activeCampaignId = useAppStore(s => s.activeCampaignId);
    const messages = useAppStore(s => s.messages);
    const setMessageImage = useAppStore(s => s.setMessageImage);
    const toggleDrawer = useAppStore(s => s.toggleDrawer);
    const setMobileView = useAppStore(s => s.setMobileView);
    const drawerOpen = useAppStore(s => s.drawerOpen);
    const imageProvider = useAppStore(s => s.getActiveImageEndpoint?.());

    const [images, setImages] = useState<SceneImage[]>([]);
    const [loading, setLoading] = useState(false);
    const [lightbox, setLightbox] = useState<SceneImage | null>(null);

    // Hardware back closes the image lightbox before the drawer.
    useBackHandler(lightbox !== null, () => setLightbox(null));

    // Newest-first list of messages that have a ready illustration.
    const readyMessages = useMemo(
        () => messages.filter(m => m.image?.status === 'ready'),
        [messages],
    );

    // A signature so the effect re-runs only when the set of ready images changes.
    const readySig = readyMessages.map(m => m.id).join(',');

    useEffect(() => {
        if (!activeCampaignId) {
            setImages([]);
            return;
        }
        let cancelled = false;
        setLoading(true);
        Promise.all(
            readyMessages.map(async (m): Promise<SceneImage | null> => {
                const url = await imageStorage.get(activeCampaignId, m.id);
                if (!url) return null;
                return { messageId: m.id, prompt: m.image?.prompt, createdAt: m.image?.createdAt ?? 0, url };
            }),
        ).then(results => {
            if (cancelled) return;
            const list = results.filter((x): x is SceneImage => x !== null);
            list.sort((a, b) => b.createdAt - a.createdAt);
            setImages(list);
            setLoading(false);
        });
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeCampaignId, readySig]);

    const handleDelete = async (img: SceneImage) => {
        if (!activeCampaignId) return;
        await imageStorage.delete(activeCampaignId, img.messageId);
        setMessageImage(img.messageId, undefined);
        setLightbox(prev => (prev?.messageId === img.messageId ? null : prev));
    };

    const handleJump = (img: SceneImage) => {
        setLightbox(null);
        if (drawerOpen) toggleDrawer();
        setMobileView('chat');
        setTimeout(() => {
            const el = document.querySelector(`[data-message-id="${img.messageId}"]`);
            el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 150);
    };

    if (!activeCampaignId) {
        return (
            <div className="p-6 text-center text-text-dim text-xs uppercase tracking-wider">
                No active campaign.
            </div>
        );
    }

    if (loading && images.length === 0) {
        return (
            <div className="p-6 flex items-center justify-center gap-2 text-text-dim">
                <Loader2 size={14} className="animate-spin" />
                <span className="text-xs uppercase tracking-wider">Loading gallery…</span>
            </div>
        );
    }

    if (images.length === 0) {
        return (
            <div className="p-6 text-center text-text-dim">
                <Images size={28} className="mx-auto mb-3 opacity-50" />
                <p className="text-xs uppercase tracking-wider mb-1">No scene images yet</p>
                <p className="text-[11px] leading-relaxed opacity-70">
                    {imageProvider
                        ? 'Tap the illustrate icon on a narration to generate one.'
                        : 'Configure an Image Generation AI in Settings → Presets to start illustrating scenes.'}
                </p>
            </div>
        );
    }

    return (
        <div className="p-3">
            <div className="flex items-center justify-between mb-3">
                <span className="text-[10px] font-bold uppercase tracking-widest text-terminal">
                    ◆ Scene Gallery
                </span>
                <span className="text-[10px] text-text-dim uppercase tracking-wider">
                    {images.length} {images.length === 1 ? 'image' : 'images'}
                </span>
            </div>

            <div className="grid grid-cols-2 gap-2">
                {images.map(img => (
                    <button
                        key={img.messageId}
                        onClick={() => setLightbox(img)}
                        className="group relative aspect-square overflow-hidden rounded border border-border bg-void-darker hover:border-ice/40 transition-colors"
                    >
                        <img
                            src={img.url}
                            alt={img.prompt || 'Scene illustration'}
                            className="w-full h-full object-cover"
                            loading="lazy"
                        />
                        <span className="absolute bottom-0 inset-x-0 px-1.5 py-1 text-[9px] text-text-primary/90 bg-gradient-to-t from-black/80 to-transparent opacity-0 group-hover:opacity-100 transition-opacity truncate text-left">
                            {formatDate(img.createdAt)}
                        </span>
                    </button>
                ))}
            </div>

            {lightbox && (
                <div
                    className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
                    onClick={() => setLightbox(null)}
                >
                    <button
                        className="absolute top-4 right-4 p-2 bg-void-darker/80 border border-border rounded-full text-text-dim hover:text-text-primary transition-colors z-10"
                        onClick={() => setLightbox(null)}
                    >
                        <XCircle size={24} />
                    </button>

                    <div
                        className="flex flex-col max-w-[calc(95*var(--app-vw))] max-h-[calc(90*var(--app-vh))]"
                        onClick={e => e.stopPropagation()}
                    >
                        <img
                            src={lightbox.url}
                            alt={lightbox.prompt || 'Scene illustration'}
                            className="max-w-[calc(95*var(--app-vw))] max-h-[calc(70*var(--app-vh))] object-contain rounded"
                        />
                        <div className="mt-3 bg-void-darker/90 border border-border rounded p-3 text-left">
                            {lightbox.prompt && (
                                <p className="text-[11px] text-text-dim leading-relaxed mb-2 line-clamp-4">
                                    {lightbox.prompt}
                                </p>
                            )}
                            <div className="flex items-center justify-between gap-2">
                                <span className="text-[10px] text-text-dim uppercase tracking-wider">
                                    {formatDate(lightbox.createdAt)}
                                </span>
                                <div className="flex items-center gap-2">
                                    <button
                                        onClick={() => handleJump(lightbox)}
                                        className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-text-dim hover:text-ice transition-colors"
                                    >
                                        <CornerUpRight size={13} /> Jump to scene
                                    </button>
                                    <button
                                        onClick={() => handleDelete(lightbox)}
                                        className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-text-dim hover:text-red-400 transition-colors"
                                    >
                                        <Trash2 size={13} /> Delete
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
