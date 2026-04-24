import { useState } from 'react';
import type { ChatMessage } from '../../types';
import { useAppStore } from '../../store/useAppStore';
import { api } from '../../services/apiClient';
import { toast } from '../Toast';

interface UseMessageEditorDeps {
    messages: ChatMessage[];
    input: string;
    setInput: (v: string) => void;
    inputRef: React.RefObject<HTMLTextAreaElement | null>;
    resetTextareaHeight: () => void;
    activeCampaignId: string | null;
    archiveIndex: ReturnType<typeof useAppStore.getState>['archiveIndex'];
    condenser: { condensedSummary: string; condensedUpToIndex: number; isCondensing: boolean };
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

    const startEditing = (msg: ChatMessage) => {
        setEditingMessageId(msg.id);
        deps.setInput(msg.displayContent || msg.content);
        deps.inputRef.current?.focus();
    };

    const cancelEditing = () => {
        setEditingMessageId(null);
        deps.setInput('');
    };

    const rollbackArchiveFrom = async (fromTimestamp: number) => {
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
    };

    const handleEditSubmit = () => {
        if (!editingMessageId) return;
        const msg = deps.messages.find(m => m.id === editingMessageId);
        if (!msg) return;

        if (msg.role === 'user') {
            rollbackArchiveFrom(msg.timestamp);
            deps.deleteMessagesFrom(msg.id);
            const textToResend = deps.input.trim();
            deps.setInput('');
            deps.resetTextareaHeight();
            setEditingMessageId(null);
            setTimeout(() => {
                deps.onAfterEdit(textToResend);
            }, 50);
        } else {
            useAppStore.getState().updateMessageContent(msg.id, deps.input.trim());
            deps.setInput('');
            deps.resetTextareaHeight();
            setEditingMessageId(null);
        }
    };

    const handleRegenerate = (id: string) => {
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
    };

    return {
        editingMessageId,
        startEditing,
        cancelEditing,
        handleEditSubmit,
        handleRegenerate,
        rollbackArchiveFrom,
    };
}