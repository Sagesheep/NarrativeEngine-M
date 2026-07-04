/**
 * Strip GM narration down to pure prose for TTS consumption.
 *
 * Removes: scene headers, NPC name brackets, system tags (SCENE_STAKES, LOOT DROP,
 * SURPRISE, ENCOUNTER, WORLD_EVENT), thinking blocks, markdown symbols, and
 * collapses whitespace. Keeps sentence punctuation (commas, periods, etc.) for
 * natural prosody.
 */
export function proseForTTS(input: string): string {
    let s = input;

    // Strip <think>...</think> blocks (kept in content for display, not speech).
    s = s.replace(/<think[\s\S]*?<\/think>/gi, '');

    // Strip scene header prefix: "Scene #12 | ..." -> "..."
    s = s.replace(/^Scene\s*#\d+\s*\|?\s*/i, '');

    // Strip NPC name brackets: [Aldric] / [**Aldric**] -> Aldric
    s = s.replace(/\[\*{0,2}\s*([A-Za-z][A-Za-z0-9 _.'-]*[A-Za-z0-9.])\s*\*{0,2}\]/g, '$1');

    // Strip system tags inline: [SCENE_STAKES: ...], [LOOT DROP: ...], etc.
    s = s.replace(/\[(?:SCENE_STAKES|LOOT DROP|SURPRISE|ENCOUNTER|WORLD_EVENT)[^\]]*\]/gi, '');

    // Strip markdown structural symbols. Keep word characters, punctuation, and spaces.
    s = s
        .replace(/^#{1,6}\s+/gm, '')        // heading markers
        .replace(/^\s*[-*+]\s+/gm, '')      // list bullets
        .replace(/^\s*\d+\.\s+/gm, '')      // numbered list
        .replace(/^\s*>\s?/gm, '')          // blockquote
        .replace(/`{1,3}[^`]*`{1,3}/g, '')  // inline/block code
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // markdown links -> label text
        .replace(/[*_~]/g, '')              // emphasis markers
        .replace(/\s*\|\s*/g, ' ');         // table pipes

    // Collapse whitespace.
    s = s.replace(/\s+/g, ' ').trim();

    return s;
}

/**
 * Split stripped prose into TTS-safe chunks. Android WebView speechSynthesis
 * notoriously stops after ~200 chars if fed one big utterance, so we split on
 * sentence boundaries and merge short sentences up to ~200 chars.
 */
export function chunkSentencesForTTS(prose: string, maxLen = 200): string[] {
    if (!prose) return [];
    // Split on sentence-ending punctuation, keeping the delimiter.
    const raw = prose.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [prose];
    const chunks: string[] = [];
    let buf = '';
    for (const sentence of raw) {
        const t = sentence.trim();
        if (!t) continue;
        if (buf.length + t.length + 1 <= maxLen) {
            buf = buf ? `${buf} ${t}` : t;
        } else {
            if (buf) chunks.push(buf);
            // If a single sentence exceeds maxLen, hard-split on commas/spaces.
            if (t.length > maxLen) {
                const parts = t.match(/[^,]+,|[^,]+$/g) || [t];
                let sub = '';
                for (const p of parts) {
                    if (sub.length + p.length + 1 <= maxLen) {
                        sub = sub ? `${sub}${p}` : p;
                    } else {
                        if (sub) chunks.push(sub.trim());
                        sub = p;
                    }
                }
                if (sub) buf = sub.trim();
                else buf = '';
            } else {
                buf = t;
            }
        }
    }
    if (buf) chunks.push(buf);
    return chunks;
}

/** Split a sentence into words. */
export function splitWords(sentence: string): string[] {
    return sentence.match(/\S+/g) || [];
}