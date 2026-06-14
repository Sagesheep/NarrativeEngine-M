import { useState, useRef, useCallback } from 'react';
import type { ChatMessage } from '../../types';
import { useAppStore } from '../../store/useAppStore';
import { api } from '../../services/apiClient';
import { toast } from '../Toast';

interface UseMessageEditorDeps {
    messages: ChatMessage[];
    activeCampaignId: string | null;
    archiveIndex: ReturnType<typeof useAppStore.getState>['archiveIndex'];
    condenser: { condensedUpToIndex: number };
    setArchiveIndex: (entries: any[]) => void;
    setChapters: (chapters: any[]) => void;
    setTimeline: (events: any[]) => void;
    resetCondenser: () => void;
    deleteMessagesFrom: (id: string) => void;
    onAfterEdit: (text: string) => void;
    onAfterRegenerate: (text: string) => void;
}

export function useMessageEditor(deps: UseMessageEditorDeps) {
    const [editingMessageId, setEditingMessageId] = useState<string | null>(null);

    // Keep latest deps in a ref so the handlers below can have stable identities
    // (empty dep arrays). This lets React.memo on MessageBubble actually hold —
    // otherwise these handlers get a new reference every render and, during
    // streaming, defeat the memo so every bubble re-renders/re-parses per token.
    const depsRef = useRef(deps);
    depsRef.current = deps;

    const startEditing = useCallback((msg: ChatMessage) => {
        setEditingMessageId(msg.id);
    }, []);

    const cancelEditing = useCallback(() => {
        setEditingMessageId(null);
    }, []);

    const rollbackArchiveFrom = useCallback(async (fromTimestamp: number) => {
        const deps = depsRef.current;
        if (!deps.activeCampaignId) return;
        const sorted = [...deps.archiveIndex].sort((a, b) => parseInt(a.sceneId) - parseInt(b.sceneId));
        const target = sorted.find((e: any) => e.timestamp >= fromTimestamp);
        if (!target) return;
        try {
            await api.backup.create(deps.activeCampaignId, { trigger: 'pre-rollback', isAuto: true }).catch(() => {});
            await api.archive.deleteFrom(deps.activeCampaignId, target.sceneId);
            const [freshIndex, freshTimeline, updatedChapters] = await Promise.all([
                api.archive.getIndex(deps.activeCampaignId),
                api.timeline.get(deps.activeCampaignId),
                api.chapters.list(deps.activeCampaignId).catch(() => []),
            ]);
            deps.setArchiveIndex(freshIndex);
            deps.setTimeline(freshTimeline);
            deps.setChapters(updatedChapters);

            const currentCondenser = useAppStore.getState().condenser;
            const currentMessages = useAppStore.getState().messages;
            const lastCondensedMsg = currentCondenser.condensedUpToIndex >= 0
                ? currentMessages[currentCondenser.condensedUpToIndex]
                : null;
            const rollbackAffectsCondensed = !lastCondensedMsg || fromTimestamp <= lastCondensedMsg.timestamp;
            if (rollbackAffectsCondensed) {
                deps.resetCondenser();
                console.log('[Archive] Condenser reset — rollback affected condensed portion');
            } else {
                console.log('[Archive] Condenser preserved — rollback was after condensed portion');
            }

            console.log(`[Archive] Rolled back from scene #${target.sceneId}`);
        } catch (err) {
            toast.warning('Archive rollback failed');
        }
    }, []);

    const handleEditSubmit = useCallback((id: string, newContent: string) => {
        const deps = depsRef.current;
        const msg = deps.messages.find(m => m.id === id);
        if (!msg) return;

        if (msg.role === 'user') {
            rollbackArchiveFrom(msg.timestamp);
            deps.deleteMessagesFrom(msg.id);
            setEditingMessageId(null);
            setTimeout(() => {
                deps.onAfterEdit(newContent.trim());
            }, 50);
        } else {
            useAppStore.getState().updateMessageContent(msg.id, newContent.trim());
            setEditingMessageId(null);
        }
    }, [rollbackArchiveFrom]);

    const handleRegenerate = useCallback((id: string) => {
        const deps = depsRef.current;
        const msgs = deps.messages;
        const idx = msgs.findIndex(m => m.id === id);
        if (idx === -1) return;
        const prevMsgs = msgs.slice(0, idx);
        const lastUser = [...prevMsgs].reverse().find(m => m.role === 'user');
        if (lastUser) {
            rollbackArchiveFrom(lastUser.timestamp);
            deps.deleteMessagesFrom(lastUser.id);
            setTimeout(() => {
                deps.onAfterRegenerate(lastUser.displayContent || lastUser.content);
            }, 50);
        }
    }, [rollbackArchiveFrom]);

    return {
        editingMessageId,
        startEditing,
        cancelEditing,
        handleEditSubmit,
        handleRegenerate,
        rollbackArchiveFrom,
    };
}