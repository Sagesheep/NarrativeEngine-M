import { useAppStore } from '../store/useAppStore';
import { registerMessaging, type MessagingPort } from '../ports/messaging';

export const messagingAdapter: MessagingPort = {
    appendUserMessage:  (msg) => useAppStore.getState().addMessage(msg),
    recordAssistantReply: (final) => useAppStore.getState().addMessage(final),
    attachImage:        (id, img) => useAppStore.getState().setMessageImage(id, img),
    condenseHistory:    (idx) => useAppStore.getState().setCondensed(idx),
    flagDivergence:     (id, divs) => useAppStore.getState().updateMessageDivergence(id, divs),
    replaceMessageText: (id, old, newText) => useAppStore.getState().replaceMessageText(id, old, newText),
    editMessage:        (id, patch) => useAppStore.getState().updateMessage(id, patch),
    deleteMessage:      (id) => useAppStore.getState().deleteMessage(id),
    deleteMessagesFrom: (id) => useAppStore.getState().deleteMessagesFrom(id),
    setStreaming:       (v) => useAppStore.getState().setStreaming(v),
    getMessages:        () => useAppStore.getState().messages,
    getCondenserState:  () => useAppStore.getState().condenser,
    isStreaming:        () => useAppStore.getState().isStreaming,
    getMessageById:     (id) => useAppStore.getState().messages.find(m => m.id === id),
};

export function wireMessaging(): void { registerMessaging(messagingAdapter); }
