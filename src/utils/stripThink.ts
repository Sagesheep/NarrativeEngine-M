/**
 * stripThink.ts
 * -------------
 * A non-blocking utility to strip <think>...</think> tags from model outputs
 * without causing synchronous regex backtracking locks on large inputs.
 * CPU spikes are mitigated by yielding to the event loop.
 */

export async function stripThink(text: string): Promise<string> {
    if (!text || typeof text !== 'string') return text;

    let result = '';
    let currentIndex = 0;
    const lowerText = text.toLowerCase();

    while (currentIndex < text.length) {
        const startTagIndex = lowerText.indexOf('<think>', currentIndex);

        if (startTagIndex === -1) {
            result += text.slice(currentIndex);
            break;
        }

        result += text.slice(currentIndex, startTagIndex);

        const endTagIndex = lowerText.indexOf('</think>', startTagIndex + 7);

        if (endTagIndex === -1) {
            // Unclosed tag, just drop the rest or keep it? The regex `[\s\S]*?<\/think>` drops up to the end tag.
            // If there's no end tag, the regex would not match because it expects `</think>`.
            // Wait, the regex `/[\s\S]*?<\/think>/gi` REQUIRES the closing tag to match.
            // If there is no closing tag, the regex doesn't match and replaces nothing.
            // So if no closing tag, we should just append the rest.
            result += text.slice(startTagIndex);
            break;
        }

        currentIndex = endTagIndex + 8; // length of '</think>'

        // Yield to the event loop to prevent blocking the main thread
        await new Promise(resolve => setTimeout(resolve, 0));
    }

    return result;
}
