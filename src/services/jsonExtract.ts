/**
 * Shared JSON extraction helper for LLM responses.
 * Handles <think> blocks, markdown fences, and truncated JSON recovery.
 *
 * Returns { value, parseOk }:
 *   - parseOk: true  → parsed successfully (possibly via truncation recovery)
 *   - parseOk: false → unrecoverable; value is the caller-supplied fallback
 */
export function extractJsonRobust<T>(raw: string, fallback: T): { value: T; parseOk: boolean } {
    let clean = raw.replace(/<think[\s\S]*?<\/think>/gi, '');
    const mdMatch = clean.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (mdMatch) clean = mdMatch[1];

    const start = clean.indexOf('{');
    if (start === -1) return { value: fallback, parseOk: false };

    let text = clean.slice(start);

    try {
        return { value: JSON.parse(text) as T, parseOk: true };
    } catch {
        // Truncated response — recover by finding last complete item at depth 1
        let depth = 0;
        let inString = false;
        let escape = false;
        let lastCompleteItemEnd = -1;

        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            if (escape) { escape = false; continue; }
            if (ch === '\\' && inString) { escape = true; continue; }
            if (ch === '"') { inString = !inString; continue; }
            if (inString) continue;
            if (ch === '{' || ch === '[') depth++;
            if (ch === '}' || ch === ']') {
                depth--;
                if (depth === 1) lastCompleteItemEnd = i;
            }
        }

        if (lastCompleteItemEnd > 0) {
            const recovered = text.slice(0, lastCompleteItemEnd + 1) + ']}';
            try {
                return { value: JSON.parse(recovered) as T, parseOk: true };
            } catch { /* fall through */ }
        }

        return { value: fallback, parseOk: false };
    }
}
