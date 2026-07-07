import { useState, useRef, useCallback } from 'react';
import type { ChatMessage } from '../../types';
import { useAppStore } from '../../store/useAppStore';
import { api } from '../../services/apiClient';
import { toast } from '../Toast';
import { clearPendingTurnSnapshot, findPendingCommitMessage, findRetryableMessage, getActiveSnapshotId, getCachedSwipePayload, patchCachedUserPrompt } from '../../services/turn';

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

/** Find the sceneId for a message by scanning forward to the nearest
 *  scene-marker system message. Returns null if none (turn not yet archived). */
export function findSceneIdForMessage(messages: ChatMessage[], messageId: string): string | null {
    const idx = messages.findIndex(m => m.id === messageId);
    if (idx === -1) return null;
    for (let i = idx; i < messages.length; i++) {
        const m = messages[i];
        if (m.role === 'system' && m.name === 'scene-marker' && typeof m.content === 'string') {
            const match = m.content.match(/Scene\s+(\d+)/i);
            if (match) return match[1].padStart(3, '0');
        }
        // Stop if we hit the NEXT turn's user message before any marker — means
        // this turn was never archived (e.g. mid-stream). Don't borrow a later id.
        if (i > idx && m.role === 'user') return null;
    }
    return null;
}

export function useMessageEditor(deps: UseMessageEditorDeps) {
    const [editingMessageId, setEditingMessageId] = useState<string | null>(null);

    // Keep latest deps in a ref so the handlers below can have stable identities
    // (empty dep arrays). This lets React.memo on MessageBubble actually hold —
    // otherwise these handlers get a new reference every render and, during
    // streaming, defeat the memo so every bubble re-renders/re-parses per token.
    const depsRef = useRef(deps);
    // eslint-disable-next-line react-hooks/refs -- intentional: latest deps mirrored into a ref so the memoized handlers stay stable and don't defeat MessageBubble's React.memo during streaming
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
        } catch {
            toast.warning('Archive rollback failed');
        }
    }, []);

    const handleDeleteOutput = useCallback(async (id: string) => {
        const deps = depsRef.current;
        const sceneId = findSceneIdForMessage(deps.messages, id);

        // Swipe Generation v1: if we're deleting the latest GM message (the one
        // carrying the pendingCommit), discard the swipe set AND the pendingCommit
        // marker. Nothing commits — the turn is thrown away. findSceneIdForMessage
        // returns null for a pending turn (no scene-marker exists yet), so the
        // archive-skip below already handles the "no archive to delete" case.
        const deletingPending = findPendingCommitMessage(deps.messages)?.id === id;
        if (deletingPending) {
            clearPendingTurnSnapshot();
        }

        // Smart Retry v1: if we're deleting a retryable bubble (story AI was
        // aborted/failed), clear the in-memory snapshot — it's the only consumer
        // of the cached precontext. Also handles the case where the deleted
        // message is a user msg whose paired assistant carries `precontext` —
        // per the orphan rule, deleting the user prompt orphans the precontext.
        const deletingRetryable = findRetryableMessage(deps.messages)?.id === id;
        if (deletingRetryable) {
            clearPendingTurnSnapshot();
        }
        if (!deletingRetryable) {
            // Maybe the deleted message is a user msg whose NEXT assistant carries
            // precontext (orphan cleanup per the rule: precontext without its
            // triggering user prompt is meaningless).
            const idx = deps.messages.findIndex(m => m.id === id);
            const nextAssistant = idx !== -1
                ? deps.messages.slice(idx + 1).find(m => m.role === 'assistant')
                : undefined;
            if (nextAssistant?.precontext || nextAssistant?.retryable) {
                if (nextAssistant.precontext?.capturedPayloadRef === getActiveSnapshotId()) {
                    clearPendingTurnSnapshot();
                }
                useAppStore.getState().updateMessage(nextAssistant.id, { retryable: undefined, precontext: undefined });
            }
        }

        // Remove the GM/user bubble + its trailing scene-marker from chat.
        const idx = deps.messages.findIndex(m => m.id === id);
        const markerId = idx !== -1
            ? deps.messages.slice(idx).find(m => m.role === 'system' && m.name === 'scene-marker')?.id
            : undefined;
        useAppStore.getState().deleteMessage(id);
        if (markerId) useAppStore.getState().deleteMessage(markerId);

        // A pending turn has no scene in the archive (handlePostTurn was deferred),
        // so there's nothing to delete from IndexedDB. Bail early.
        if (deletingPending || !sceneId || !deps.activeCampaignId) {
            if (deletingPending) return;
            if (!sceneId || !deps.activeCampaignId) return;
        }
        // A retryable bubble also has no archived scene (story AI never finished,
        // handlePostTurn never ran). Bail the same way.
        if (deletingRetryable) return;
        try {
            await api.backup.create(deps.activeCampaignId, { trigger: 'pre-scene-delete', isAuto: true }).catch(() => {});
            await api.archive.deleteScene(deps.activeCampaignId, sceneId);
            const [freshIndex, freshTimeline, updatedChapters] = await Promise.all([
                api.archive.getIndex(deps.activeCampaignId),
                api.timeline.get(deps.activeCampaignId),
                api.chapters.list(deps.activeCampaignId).catch(() => []),
            ]);
            deps.setArchiveIndex(freshIndex);
            deps.setTimeline(freshTimeline);
            deps.setChapters(updatedChapters);
            console.log(`[Archive] Surgically deleted scene #${sceneId}`);
        } catch {
            toast.warning('Archive scene delete failed');
        }
    }, []);

    const syncEditedSceneText = useCallback(async (messageId: string, newAssistant: string) => {
        const deps = depsRef.current;
        if (!deps.activeCampaignId) return;
        const sceneId = findSceneIdForMessage(deps.messages, messageId);
        if (!sceneId) return;
        try {
            await api.archive.updateSceneAssistant(deps.activeCampaignId, sceneId, newAssistant);
            const freshIndex = await api.archive.getIndex(deps.activeCampaignId);
            deps.setArchiveIndex(freshIndex);
        } catch {
            toast.warning('Archive scene update failed');
        }
    }, []);

    const handleEditSubmit = useCallback((id: string, newContent: string) => {
        const deps = depsRef.current;
        const msg = deps.messages.find(m => m.id === id);
        if (!msg) return;

        if (msg.role === 'user') {
            // Smart Retry v1: soft-edit path. If the NEXT assistant message
            // carries `retryable` (story AI was aborted/failed, precontext is
            // cached), patch the cached payload's user-msg slot in place —
            // preserving engine appendages — and update the live user message
            // content. The user then taps Retry to regenerate with the new
            // prompt + the cached precontext (no regather, no archive rollback).
            // If no cached precontext exists, fall through to the hard-rewind
            // path (today's behavior).
            const idx = deps.messages.findIndex(m => m.id === id);
            const nextAssistant = idx !== -1
                ? deps.messages.slice(idx + 1).find(m => m.role === 'assistant')
                : undefined;
            const canSoftEdit = !!(nextAssistant?.retryable && getCachedSwipePayload());
            if (canSoftEdit) {
                // Patch the cached payload in place (preserves engine tags).
                patchCachedUserPrompt(newContent.trim());
                // Update the live user message content so the chat reflects the edit.
                useAppStore.getState().updateMessageContent(msg.id, newContent.trim());
                // Wipe any stale swipeSet on the assistant bubble (prior variants
                // answered the old prompt). Keep retryable so the Retry button shows.
                if (nextAssistant!.swipeSet) {
                    useAppStore.getState().updateMessage(nextAssistant!.id, {
                        swipeSet: undefined,
                        swipeActiveIndex: undefined,
                        content: '',
                        displayContent: '',
                        reasoning_content: undefined,
                    });
                }
                setEditingMessageId(null);
                return;
            }
            // Hard-rewind path (today's behavior): archive rollback + delete + resend.
            rollbackArchiveFrom(msg.timestamp);
            deps.deleteMessagesFrom(msg.id);
            setEditingMessageId(null);
            setTimeout(() => {
                deps.onAfterEdit(newContent.trim());
            }, 50);
        } else {
            // Swipe Generation v1: if this is a pending swipe message, the edit
            // applies to the visible variant ONLY. Update the variant's text in
            // the swipeSet so commit reads the edited text. findSceneIdForMessage
            // returns null for a pending turn (no scene-marker exists yet), so
            // syncEditedSceneText is already a no-op — no archive to update.
            if (msg.swipeSet && msg.pendingCommit) {
                const activeIdx = msg.swipeActiveIndex ?? 0;
                const updatedSwipeSet = msg.swipeSet.map((v, i) =>
                    i === activeIdx ? { ...v, text: newContent.trim() } : v
                );
                const store = useAppStore.getState();
                const idx = store.messages.findIndex(m => m.id === id);
                if (idx !== -1) {
                    const updated = [...store.messages];
                    updated[idx] = {
                        ...updated[idx],
                        content: newContent.trim(),
                        displayContent: newContent.trim(),
                        swipeSet: updatedSwipeSet,
                    };
                    useAppStore.setState({ messages: updated });
                }
            } else {
                useAppStore.getState().updateMessageContent(msg.id, newContent.trim());
            }
            setEditingMessageId(null);
            syncEditedSceneText(msg.id, newContent.trim());
        }
    }, [rollbackArchiveFrom, syncEditedSceneText]);

    const handleRegenerate = useCallback((id: string) => {
        const deps = depsRef.current;
        const msgs = deps.messages;
        const idx = msgs.findIndex(m => m.id === id);
        if (idx === -1) return;
        const prevMsgs = msgs.slice(0, idx);
        const lastUser = [...prevMsgs].reverse().find(m => m.role === 'user');

        // Swipe Generation v1: a historical rewind that rolls back past the
        // pending GM message discards the swipe set AND the pendingCommit.
        // Nothing commits. The pending message is in `msgs` after `idx` (or IS
        // the message at `idx` if the user is regenerating the GM bubble itself).
        const pending = findPendingCommitMessage(msgs);
        if (pending) {
            const pendingIdx = msgs.findIndex(m => m.id === pending.id);
            if (pendingIdx >= idx) {
                // The pending turn is being rolled back — discard it without commit.
                clearPendingTurnSnapshot();
            }
        }
        // Smart Retry v1: a retryable bubble being rolled back also discards the
        // cached precontext (the snapshot was captured pre-story-AI for retry).
        // Same leak-prevention as the pending path above.
        const retryable = findRetryableMessage(msgs);
        if (retryable) {
            const retryableIdx = msgs.findIndex(m => m.id === retryable.id);
            if (retryableIdx >= idx) {
                clearPendingTurnSnapshot();
            }
        }

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
        handleDeleteOutput,
        rollbackArchiveFrom,
    };
}