/**
 * MessagingPort — state access for chat messages.
 *
 * Services that need to read/write messages (image/index.ts for
 * setMessageImage, pendingCommit for addMessage/updateLastAssistant)
 * used to call useAppStore.getState() directly.
 */

import type { ChatMessage, CondenserState } from '../types';

export interface MessagingPort {
    // Commands
    appendUserMessage(msg: ChatMessage): void;
    recordAssistantReply(final: ChatMessage): void;
    attachImage(messageId: string, image: ChatMessage['image']): void;
    condenseHistory(upToIndex: number): void;
    flagDivergence(messageId: string, divergenceIds: string[]): void;
    replaceMessageText(id: string, oldText: string, newText: string): boolean;
    editMessage(id: string, patch: Partial<ChatMessage>): void;
    deleteMessage(id: string): void;
    deleteMessagesFrom(id: string): void;
    setStreaming(v: boolean): void;

    // Queries
    getMessages(): readonly ChatMessage[];
    getCondenserState(): CondenserState;
    isStreaming(): boolean;
    getMessageById(id: string): ChatMessage | undefined;
}

let _impl: MessagingPort | null = null;

export function registerMessaging(impl: MessagingPort): void { _impl = impl; }

function impl(): MessagingPort {
    if (!_impl) throw new Error('MessagingPort not wired. Call registerMessaging() from app bootstrap.');
    return _impl;
}

export const messaging: MessagingPort = {
    appendUserMessage:  (msg) => impl().appendUserMessage(msg),
    recordAssistantReply: (final) => impl().recordAssistantReply(final),
    attachImage:        (id, img) => impl().attachImage(id, img),
    condenseHistory:    (idx) => impl().condenseHistory(idx),
    flagDivergence:     (id, divs) => impl().flagDivergence(id, divs),
    replaceMessageText: (id, old, newText) => impl().replaceMessageText(id, old, newText),
    editMessage:        (id, patch) => impl().editMessage(id, patch),
    deleteMessage:      (id) => impl().deleteMessage(id),
    deleteMessagesFrom: (id) => impl().deleteMessagesFrom(id),
    setStreaming:       (v) => impl().setStreaming(v),
    getMessages:        () => impl().getMessages(),
    getCondenserState:  () => impl().getCondenserState(),
    isStreaming:        () => impl().isStreaming(),
    getMessageById:     (id) => impl().getMessageById(id),
};
