/**
 * Shared JSON extraction helper for LLM responses.
 * Handles think blocks, markdown fences, and truncated JSON recovery.
 *
 * Returns { value, parseOk }:
 *   - parseOk: true  -> parsed successfully (possibly via truncation recovery)
 *   - parseOk: false -> unrecoverable; value is the caller-supplied fallback
 */

function stripUnclosedThinkTag(text: string): string {
    const thinkIdx = text.search(/<think\b/i);
    if (thinkIdx === -1) return text;
    const jsonStart = text.indexOf('{', thinkIdx);
    const arrStart = text.indexOf('[', thinkIdx);
    let nextJson = -1;
    if (jsonStart !== -1 && arrStart !== -1) nextJson = Math.min(jsonStart, arrStart);
    else if (jsonStart !== -1) nextJson = jsonStart;
    else if (arrStart !== -1) nextJson = arrStart;
    if (nextJson === -1) return '';
    return text.slice(0, thinkIdx) + text.slice(nextJson);
}

export function extractJsonRobust<T>(raw: string, fallback: T): { value: T; parseOk: boolean } {
    let clean = raw.replace(/<think[\s\S]*?<\/think>/gi, '');
    clean = stripUnclosedThinkTag(clean);
    const mdMatch = clean.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (mdMatch) clean = mdMatch[1];

    const start = clean.indexOf('{');
    if (start === -1) return { value: fallback, parseOk: false };

    const text = clean.slice(start);

    try {
        return { value: JSON.parse(text) as T, parseOk: true };
    } catch {
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

/**
 * Robustly extracts the first JSON object or array found in a text string.
 * Handles think tags, markdown code blocks, and leading/trailing chatter.
 */
export function extractJson(text: string): string {
    let clean = text.replace(/<think[\s\S]*?<\/think>/gi, '');
    clean = stripUnclosedThinkTag(clean);

    const markdownMatch = clean.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (markdownMatch) {
        clean = markdownMatch[1];
    }

    const firstObj = clean.indexOf('{');
    const firstArr = clean.indexOf('[');
    const start = (firstObj !== -1 && (firstArr === -1 || firstObj < firstArr)) ? firstObj : firstArr;

    if (start !== -1) {
        const lastObj = clean.lastIndexOf('}');
        const lastArr = clean.lastIndexOf(']');
        const end = (lastObj !== -1 && (lastArr === -1 || lastObj > lastArr)) ? lastObj : lastArr;

        if (end !== -1 && end > start) {
            return clean.substring(start, end + 1).trim();
        }
    }

    return clean.trim();
}