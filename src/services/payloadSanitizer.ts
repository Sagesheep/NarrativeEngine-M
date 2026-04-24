export const sanitizePayloadForApi = (rawPayload: any[], allowTools: boolean) => {
    const cleaned: any[] = [];
    const openToolCalls = new Set<string>();

    for (const msg of rawPayload) {
        if (!msg || typeof msg !== 'object') continue;

        if (msg.role === 'assistant') {
            if (!allowTools || !Array.isArray(msg.tool_calls) || msg.tool_calls.length === 0) {
                const { tool_calls, ...assistantNoTools } = msg;
                cleaned.push(assistantNoTools);
                continue;
            }

            const validCalls = msg.tool_calls.filter((tc: any) => {
                if (!tc || tc.type !== 'function' || typeof tc.id !== 'string' ||
                    !tc.function || typeof tc.function.name !== 'string') return false;
                if (tc.function.arguments !== undefined) {
                    try { JSON.parse(tc.function.arguments); } catch { return false; }
                }
                return true;
            });

            if (validCalls.length === 0) {
                const { tool_calls, ...assistantNoTools } = msg;
                cleaned.push(assistantNoTools);
                continue;
            }

            cleaned.push({ ...msg, tool_calls: validCalls });
            for (const tc of validCalls) openToolCalls.add(tc.id);
            continue;
        }

        if (msg.role === 'tool') {
            if (!allowTools) continue;

            const callId = typeof msg.tool_call_id === 'string' ? msg.tool_call_id : '';
            if (!callId || !openToolCalls.has(callId)) {
                console.warn('[Payload] Dropping orphan tool message:', msg.tool_call_id);
                continue;
            }

            openToolCalls.delete(callId);
            cleaned.push(msg);
            continue;
        }

        cleaned.push(msg);
    }

    return cleaned;
};
